import asyncio
import base64
import json
import re
import traceback
import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File
from backend.models.schemas import ImageGenerateRequest, PanoramaGenerateRequest
from backend.api.config_router import get_config_list
from backend.core.request_client import async_http_request, split_api_base, base_has_version, build_endpoint_url, is_chat_as_image_host
from backend.core.config_handler import (
    get_cached_strategy, set_cached_strategy, clear_cached_strategy
)

router = APIRouter(prefix="/api/image", tags=["图片生成"])


# ═══════════════════════════════════════════════════
#  API 格式策略定义
# ═══════════════════════════════════════════════════

STRATEGIES = [
    {
        "id": "openai_b64",
        "url_suffix": "/images/generations",
        "request_format": "b64_data_url",
        "response_format_field": "b64_json",
        "response_type": "b64_json",
        "async_poll": False,
    },
    {
        "id": "openai_url",
        "url_suffix": "/images/generations",
        "request_format": "b64_data_url",
        "response_format_field": "url",
        "response_type": "auto",
        "async_poll": False,
    },
    {
        "id": "async_task_no_ref",
        "url_suffix": "",
        "request_format": "none",
        "response_format_field": None,
        "response_type": "auto",
        "async_poll": True,
    },
    {
        "id": "async_task_pure_b64",
        "url_suffix": "",
        "request_format": "pure_b64",
        "response_format_field": None,
        "response_type": "auto",
        "async_poll": True,
    },
    {
        "id": "custom_no_ref",
        "url_suffix": "",
        "request_format": "none",
        "response_format_field": None,
        "response_type": "auto",
        "async_poll": False,
    },
    {
        "id": "custom_pure_b64",
        "url_suffix": "",
        "request_format": "pure_b64",
        "response_format_field": None,
        "response_type": "auto",
        "async_poll": False,
    },
    {
        "id": "custom_data_url_ref",
        "url_suffix": "",
        "request_format": "b64_data_url",
        "response_format_field": None,
        "response_type": "auto",
        "async_poll": False,
    },
]

STRATEGY_MAP = {s["id"]: s for s in STRATEGIES}


# ═══════════════════════════════════════════════════
#  白名单：所有模型（含图像）都走 /chat/completions，
#  图片以 markdown ![](url) 形式塞在 choices[0].message.content 里
# ═══════════════════════════════════════════════════

CHAT_AS_IMAGE_HOSTS = {
    "aiapi.up.railway.app",
}

CHAT_AS_IMAGE_STRATEGY = {
    "id": "chat_as_image",
    "url_suffix": "/chat/completions",
    "request_format": "chat_multimodal",
    "response_format_field": None,
    "response_type": "chat_markdown",
    "async_poll": False,
}
STRATEGY_MAP["chat_as_image"] = CHAT_AS_IMAGE_STRATEGY


# ═══════════════════════════════════════════════════
#  工具函数
# ═══════════════════════════════════════════════════

def _strip_image_base64(value: str) -> str:
    if not value:
        return ""
    if value.startswith("data:image"):
        mime_and_rest = value.split(";base64,", 1)
        mime = mime_and_rest[0].replace("data:", "") if len(mime_and_rest) == 2 else "image/png"
        raw = mime_and_rest[1] if len(mime_and_rest) == 2 else value.split(",", 1)[-1]
    else:
        mime = "image/png"
        raw = value
    raw = re.sub(r'\s+', '', raw)
    if not raw:
        return ""
    return f"data:{mime};base64,{raw}"


def _get_applicable_strategies(api_base: str) -> list:
    """根据 api_base 形态决定策略尝试顺序。
    - 白名单 host（chat-as-image 网关）→ 只返回 [{"id": "chat_as_image", ...}] 哨兵
    - 用户填了完整 endpoint（以 /images/generations 等结尾）→ 只试 standard 策略
    - 用户填了 /vN 结尾 → 只试 standard 策略
    - 其他（裸 host 或自定义路径）→ custom 优先、standard 降级
    standard 策略用 build_endpoint_url 自动补 /v1。
    """
    if is_chat_as_image_host(api_base):
        return [CHAT_AS_IMAGE_STRATEGY]
    base, trailing = split_api_base(api_base)
    if trailing or base_has_version(base):
        return [s for s in STRATEGIES if s["url_suffix"]]
    custom_first = [s for s in STRATEGIES if not s["url_suffix"]]
    standard = [s for s in STRATEGIES if s["url_suffix"]]
    return custom_first + standard


def _build_url(api_base: str, strategy: dict) -> str:
    """按 strategy 拼 URL：
    - 没有 suffix（自定义策略）→ 用户填的是完整地址，原样使用
    - 有 suffix（标准 OpenAI 风格）→ 用 build_endpoint_url 自适应
    """
    suffix = strategy.get("url_suffix")
    if not suffix:
        return (api_base or "").rstrip("/")
    return build_endpoint_url(api_base, suffix)


def _build_request_data(strategy: dict, model: str, prompt: str, width: int, height: int, n: int,
                        negative_prompt: str, normalized_images: list, quality: str = None) -> dict:
    req_fmt = strategy["request_format"]
    data = {
        "model": model,
        "prompt": prompt,
        "size": f"{width}x{height}" if width and height else "1024x1024",
        "n": n if n and n > 0 else 1,
    }
    if quality:
        data["quality"] = quality
    if strategy["response_format_field"]:
        data["response_format"] = strategy["response_format_field"]
    if negative_prompt:
        data["negative_prompt"] = negative_prompt
    if normalized_images and req_fmt != "none":
        if req_fmt == "b64_data_url":
            data["image"] = normalized_images[:10]
        elif req_fmt == "pure_b64":
            pure = []
            for img in normalized_images[:10]:
                if ";base64," in img:
                    pure.append(img.split(";base64,", 1)[1])
                else:
                    pure.append(img)
            data["image"] = pure
    return data


async def _download_image_as_b64(url: str) -> str:
    """下载图片 URL 并返回 base64 字符串，失败返回空"""
    try:
        resp = await async_http_request("GET", url, {}, None, timeout=120)
        if resp.status_code == 200 and resp.content:
            return base64.b64encode(resp.content).decode("utf-8")
    except Exception:
        pass
    return ""


async def _parse_response(strategy: dict, result: dict) -> list:
    """解析响应，统一返回 [{"b64_json": "..."}] 格式"""
    data = result.get("data")
    if not isinstance(data, list) or not data:
        return []
    resp_type = strategy["response_type"]
    if resp_type == "auto":
        first = data[0]
        if isinstance(first, dict) and first.get("b64_json"):
            resp_type = "b64_json"
        elif isinstance(first, dict) and (first.get("url") or first.get("image_url")):
            resp_type = "url"
        elif isinstance(first, str) and first.startswith("http"):
            resp_type = "url_string"
        else:
            resp_type = "b64_json"
    if resp_type == "b64_json":
        if isinstance(data[0], dict) and data[0].get("b64_json"):
            return data
        return []
    converted = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url") or item.get("image_url") or ""
        elif isinstance(item, str):
            url = item
        else:
            continue
        if url and url.startswith("http"):
            b64 = await _download_image_as_b64(url)
            if b64:
                converted.append({"b64_json": b64})
        elif isinstance(item, dict) and item.get("b64_json"):
            converted.append(item)
    return converted


# ═══════════════════════════════════════════════════
#  轮询异步任务
# ═══════════════════════════════════════════════════

async def _poll_task_result(config: dict, headers: dict, task_id: str) -> list | None:
    """轮询指定 task_id 直到完成，返回图片数据。每个调用独立轮询自己的 task_id。"""
    # 轮询接口始终落在 /v1/media/status，不论用户填的是裸 host、/v1 还是完整 endpoint
    from urllib.parse import urlparse
    parsed = urlparse(config["api_base"])
    scheme = parsed.scheme or "https"
    host = parsed.netloc
    status_url = f"{scheme}://{host}/v1/media/status"

    print(f"[图片生成] 开始轮询 task_id={task_id}")
    for attempt in range(180):
        await asyncio.sleep(10)
        try:
            resp = await async_http_request("GET", f"{status_url}?task_id={task_id}", headers, None, timeout=30)
            if resp.status_code != 200:
                continue
            status_data = resp.json()
            state = status_data.get("state", "")
            is_final = status_data.get("is_final", False)

            if not is_final:
                if attempt % 6 == 5:
                    print(f"[图片生成] task_id={task_id} 仍在处理中 (第{attempt+1}次轮询)")
                continue

            if state == "success":
                result_url = status_data.get("result_url", "")
                if not result_url:
                    print(f"[图片生成] task_id={task_id} 成功但无 result_url")
                    return None
                print(f"[图片生成] task_id={task_id} 完成, 下载结果...")
                b64 = await _download_image_as_b64(result_url)
                if b64:
                    return [{"b64_json": b64}]
                print(f"[图片生成] task_id={task_id} 下载结果失败")
                return None
            else:
                error = status_data.get("error", "未知错误")
                print(f"[图片生成] task_id={task_id} 失败: {error}")
                return None
        except Exception as e:
            print(f"[图片生成] task_id={task_id} 轮询异常: {e}")
            continue

    print(f"[图片生成] task_id={task_id} 超时")
    return None


# ═══════════════════════════════════════════════════
#  局部重绘：/images/edits
# ═══════════════════════════════════════════════════

async def _try_inpaint_edit(config: dict, headers: dict, prompt: str,
                            width: int, height: int, n: int,
                            image_b64: str, mask_b64: str) -> list | None:
    """调用 /images/edits 进行局部重绘。使用 multipart/form-data 上传 image 和 mask。"""
    api_base = (config.get("api_base") or "").rstrip("/")
    edit_url = f"{api_base}/images/edits"

    def to_pure(b):
        return b.split(";base64,", 1)[1] if ";base64," in b else b

    image_bytes = base64.b64decode(to_pure(image_b64))
    mask_bytes = base64.b64decode(to_pure(mask_b64))

    try:
        print(f"[局部重绘] POST {edit_url} | prompt={prompt[:40]}...")
        timeout_config = httpx.Timeout(600, connect=10.0)
        async with httpx.AsyncClient(verify=False, timeout=timeout_config) as client:
            response = await client.post(
                edit_url,
                headers={k: v for k, v in headers.items() if k.lower() != "content-type"},
                data={
                    "model": config.get("model_name", ""),
                    "prompt": prompt,
                    "size": f"{width}x{height}" if width and height else "1024x1024",
                    "n": str(n if n and n > 0 else 1),
                },
                files={
                    "image": ("image.png", image_bytes, "image/png"),
                    "mask": ("mask.png", mask_bytes, "image/png"),
                },
            )
        if response.status_code != 200:
            print(f"[局部重绘] 返回 {response.status_code}: {response.text[:300]}")
            return None
        result = response.json()
        resp_data = result.get("data") or []
        if not resp_data:
            print(f"[局部重绘] 响应无 data: {str(result)[:200]}")
            return None
        parsed = []
        for item in resp_data:
            if isinstance(item, dict) and item.get("b64_json"):
                parsed.append(item)
            elif isinstance(item, dict) and (item.get("url") or item.get("image_url")):
                url = item.get("url") or item.get("image_url")
                b64 = await _download_image_as_b64(url)
                if b64:
                    parsed.append({"b64_json": b64})
        if parsed:
            print(f"[局部重绘] 成功, {len(parsed)} 张图片")
            return parsed
        print(f"[局部重绘] 解析为空: {str(result)[:200]}")
        return None
    except Exception as e:
        print(f"[局部重绘] 异常: {e}")
        return None


# ═══════════════════════════════════════════════════
#  核心：尝试单个策略
# ═══════════════════════════════════════════════════

# PLACEHOLDER_TRY_STRATEGY

# ═══════════════════════════════════════════════════
#  chat-as-image：把 /chat/completions 当图像接口
#  响应 content 里是 markdown ![](url)，提取 URL 下载为 b64
# ═══════════════════════════════════════════════════

_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((https?://[^\s)]+)\)")
_BARE_URL_RE = re.compile(r"https?://[^\s)\"'<>]+\.(?:png|jpe?g|webp|gif|bmp)(?:\?[^\s)\"'<>]*)?", re.IGNORECASE)
_DATA_URL_RE = re.compile(r"data:image/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+")


async def _extract_images_from_chat_content(content: str) -> list:
    """从 chat content 字符串里提取图片，返回 [{"b64_json": "..."}]"""
    if not content:
        return []
    out = []

    for m in _DATA_URL_RE.findall(content):
        pure = m.split(";base64,", 1)[1]
        out.append({"b64_json": pure})

    seen_urls = set()
    for url in _MD_IMAGE_RE.findall(content):
        if url not in seen_urls:
            seen_urls.add(url)
            b64 = await _download_image_as_b64(url)
            if b64:
                out.append({"b64_json": b64})

    if not out:
        for url in _BARE_URL_RE.findall(content):
            if url not in seen_urls:
                seen_urls.add(url)
                b64 = await _download_image_as_b64(url)
                if b64:
                    out.append({"b64_json": b64})

    return out


async def _try_chat_as_image(config: dict, headers: dict, prompt: str,
                             width: int, height: int, n: int,
                             normalized_images: list) -> list | None:
    """把 chat/completions 当图像接口调用。失败返回 None；成功返回 [{"b64_json": ...}]"""
    chat_url = build_endpoint_url(config["api_base"], "/chat/completions")
    model = config.get("model_name", "")

    text_prompt = prompt or ""
    if width and height and (width != 1024 or height != 1024):
        text_prompt = f"{text_prompt} (size: {width}x{height})"

    if normalized_images:
        user_content = [{"type": "text", "text": text_prompt}]
        for img in normalized_images[:10]:
            user_content.append({"type": "image_url", "image_url": {"url": img}})
        messages = [{"role": "user", "content": user_content}]
    else:
        messages = [{"role": "user", "content": text_prompt}]

    request_data = {"model": model, "messages": messages}
    if n and n > 1:
        request_data["n"] = n

    max_retries = 3
    for attempt in range(max_retries):
        try:
            print(f"[图片生成] POST {chat_url} | 策略=chat_as_image | prompt={text_prompt[:40]}... (第{attempt+1}次)")
            response = await async_http_request("POST", chat_url, headers, request_data, timeout=600)

            if response.status_code != 200:
                print(f"[图片生成] chat_as_image 返回 {response.status_code}: {response.text[:300]}")
                return None

            try:
                result = response.json()
            except Exception:
                print(f"[图片生成] chat_as_image 响应非JSON")
                return None

            choices = result.get("choices") or []
            if not choices:
                print(f"[图片生成] chat_as_image 无 choices: {str(result)[:200]}")
                return None

            all_images = []
            for choice in choices:
                content = (choice.get("message") or {}).get("content") or ""
                imgs = await _extract_images_from_chat_content(content)
                all_images.extend(imgs)

            if not all_images:
                first_content = (choices[0].get("message") or {}).get("content") or ""
                print(f"[图片生成] chat_as_image 未提取到图片，content预览: {first_content[:200]}")
                return None

            print(f"[图片生成] chat_as_image 成功, {len(all_images)} 张图片")
            return all_images
        except Exception as e:
            print(f"[图片生成] chat_as_image 第{attempt+1}次异常: {e}")
            if attempt < max_retries - 1:
                wait = 3 * (attempt + 1)
                print(f"[图片生成] {wait}秒后重试...")
                await asyncio.sleep(wait)
            else:
                traceback.print_exc()
                return None


async def _try_strategy(strategy: dict, config: dict, headers: dict, prompt: str,
                        width: int, height: int, n: int, negative_prompt: str,
                        normalized_images: list) -> list | None:
    """尝试一个策略。每次调用完全独立，不共享任何状态。"""
    if strategy.get("id") == "chat_as_image":
        return await _try_chat_as_image(config, headers, prompt, width, height, n, normalized_images)

    model = config.get("model_name", "")
    is_gpt_image_2 = "gpt-image" in model.lower()

    # gpt-image-2 专属：先 high，失败降 medium
    quality_attempts = ["high", "medium"] if is_gpt_image_2 else [None]

    for quality in quality_attempts:
        result = await _try_strategy_once(strategy, config, headers, prompt, width, height, n,
                                          negative_prompt, normalized_images, quality)
        if result is not None:
            return result
        if is_gpt_image_2 and quality == "high":
            print(f"[图片生成] gpt-image-2 quality=high 失败，降级为 medium 重试")
    return None


async def _try_strategy_once(strategy: dict, config: dict, headers: dict, prompt: str,
                             width: int, height: int, n: int, negative_prompt: str,
                             normalized_images: list, quality: str = None) -> list | None:
    """单次尝试一个策略+quality组合。"""
    if strategy.get("id") == "chat_as_image":
        return await _try_chat_as_image(config, headers, prompt, width, height, n, normalized_images)
    try:
        image_url = _build_url(config["api_base"], strategy)
        request_data = _build_request_data(
            strategy, config["model_name"], prompt, width, height, n,
            negative_prompt, normalized_images, quality
        )

        quality_tag = f" quality={quality}" if quality else ""
        print(f"[图片生成] POST {image_url} | 策略={strategy['id']}{quality_tag} | prompt={prompt[:40]}...")
        response = await async_http_request("POST", image_url, headers, request_data, timeout=600)

        if response.status_code != 200:
            print(f"[图片生成] 策略 {strategy['id']} 返回 {response.status_code}: {response.text[:300]}")
            return None

        try:
            result = response.json()
        except Exception:
            print(f"[图片生成] 策略 {strategy['id']} 响应非JSON")
            return None

        # 异步轮询模式
        if strategy.get("async_poll"):
            task_id = None
            if isinstance(result, dict):
                task_id = result.get("task_id")
                if not task_id and isinstance(result.get("data"), dict):
                    task_id = result["data"].get("task_id")
            if not task_id:
                print(f"[图片生成] 策略 {strategy['id']} 无 task_id: {str(result)[:200]}")
                return None
            print(f"[图片生成] 已提交异步任务 task_id={task_id} (prompt={prompt[:30]}...)")
            return await _poll_task_result(config, headers, task_id)

        # 同步模式
        data = await _parse_response(strategy, result)
        if not data:
            print(f"[图片生成] 策略 {strategy['id']} 解析为空: {str(result)[:200]}")
            return None
        print(f"[图片生成] 策略 {strategy['id']} 成功, {len(data)} 张图片")
        return data
    except Exception as e:
        print(f"[图片生成] 策略 {strategy['id']} 异常: {e}")
        traceback.print_exc()
        return None


# ═══════════════════════════════════════════════════
#  API 路由
# ═══════════════════════════════════════════════════

@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    try:
        content = await file.read()
        base64_data = base64.b64encode(content).decode("utf-8")
        mime_type = file.content_type or "image/png"
        base64_url = f"data:{mime_type};base64,{base64_data}"
        return {"code": 0, "data": {"base64_url": base64_url, "base64_data": base64_data}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"图片上传失败: {str(e)}")


@router.post("/generate")
async def generate_image(req: ImageGenerateRequest):
    """图片生成入口。每次调用完全独立，支持多个并发调用互不干扰。"""
    config = next((c for c in get_config_list() if c["id"] == req.config_id), None)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}"
    }

    # 准备参考图（每次调用独立拷贝，不共享）
    normalized_images = [
        x for x in (_strip_image_base64(item) for item in (req.image_base64_list or []) if item) if x
    ]
    if not normalized_images and req.image_base64:
        stripped = _strip_image_base64(req.image_base64)
        if stripped:
            normalized_images = [stripped]

    # 准备遮罩（局部重绘）
    mask_image = ""
    if req.mask_base64:
        mask_image = _strip_image_base64(req.mask_base64) or ""

    width = req.width
    height = req.height
    n = req.n if req.n and req.n > 0 else 1
    prompt = req.prompt or ""
    negative_prompt = req.negative_prompt or ""

    # ── 有 mask 时走 /images/edits 局部重绘路径（白名单 host 不支持） ──
    if mask_image and normalized_images and not is_chat_as_image_host(config["api_base"]):
        result = await _try_inpaint_edit(config, headers, prompt, width, height, n, normalized_images[0], mask_image)
        if result is not None:
            return {"code": 0, "data": result}
        raise HTTPException(status_code=500, detail="局部重绘失败（edit 接口不可用）")

    # ── 白名单 host 强制走 chat_as_image，跳过缓存和探测 ──
    if is_chat_as_image_host(config["api_base"]):
        result = await _try_chat_as_image(config, headers, prompt, width, height, n, normalized_images)
        if result is not None:
            return {"code": 0, "data": result}
        raise HTTPException(status_code=500, detail="图片生成失败（chat-as-image 网关不可用）")

    # 1. 查缓存策略
    cached_sid = get_cached_strategy(req.config_id)
    # 有参考图但缓存策略不支持传图时，跳过缓存走探测流程
    if cached_sid and cached_sid in STRATEGY_MAP:
        strategy = STRATEGY_MAP[cached_sid]
        if normalized_images and strategy["request_format"] == "none":
            pass  # 跳过缓存，走下面的探测流程找支持传图的策略
        else:
            result = await _try_strategy(
                strategy, config, headers, prompt, width, height, n,
                negative_prompt, normalized_images
            )
            if result is not None:
                return {"code": 0, "data": result}
            raise HTTPException(status_code=500, detail="图片生成失败（接口暂时不可用，请稍后重试）")

    # 2. 探测流程
    strategies = _get_applicable_strategies(config["api_base"])
    # 有参考图时，跳过不传图的策略
    if normalized_images:
        strategies = [s for s in strategies if s["request_format"] != "none"]
    last_error = "无可用策略"
    for strategy in strategies:
        result = await _try_strategy(
            strategy, config, headers, prompt, width, height, n,
            negative_prompt, normalized_images
        )
        if result is not None:
            # 不覆盖缓存——有图和无图走不同策略，缓存保留给无图场景
            if not get_cached_strategy(req.config_id):
                set_cached_strategy(req.config_id, strategy["id"])
            return {"code": 0, "data": result}
        last_error = f"策略 {strategy['id']} 失败"

    raise HTTPException(status_code=500, detail=f"图片生成失败: {last_error}")


# ═══════════════════════════════════════════════════
#  全景图生成（cubemap → equirectangular）
# ═══════════════════════════════════════════════════

# 6 个 cubemap 方位的 prompt 后缀。forward 用上传图，其余 5 个用图生图生成
PANORAMA_FACE_PROMPTS = {
    "right":  "same scene continuation, camera rotated exactly 90 degrees to the right, horizon kept perfectly level, same time of day, same lighting and style, seamless side view of the same environment",
    "back":   "same scene continuation, camera rotated 180 degrees facing the opposite direction, horizon kept perfectly level, same time of day, same lighting and style, seamless back view of the same environment",
    "left":   "same scene continuation, camera rotated exactly 90 degrees to the left, horizon kept perfectly level, same time of day, same lighting and style, seamless side view of the same environment",
    "up":     "looking straight up at the sky/ceiling of the same scene, fisheye-like top-down-from-below view, same lighting and style, no horizon visible, fills entire frame",
    "down":   "looking straight down at the ground/floor of the same scene, top-down view of the surface directly below the camera, same lighting and style, no horizon visible, fills entire frame",
}

PANORAMA_NEG_PROMPT = "text, watermark, logo, signature, frame, border, split screen, collage, different scene, different style, different time of day"


def _decode_b64_image_to_rgb(b64_data: str):
    """把 data:image base64 解成 RGB ndarray (H,W,3) uint8"""
    import numpy as np
    from PIL import Image
    import io
    if not b64_data:
        return None
    raw = b64_data
    if raw.startswith("data:image"):
        raw = raw.split(",", 1)[-1]
    raw = re.sub(r"\s+", "", raw)
    missing = len(raw) % 4
    if missing:
        raw += "=" * (4 - missing)
    try:
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        if img.mode != "RGB":
            img = img.convert("RGB")
        return np.asarray(img)
    except Exception as e:
        print(f"[全景] base64 → 图片解码失败: {e}")
        return None


def _resize_to_square(rgb, size: int):
    """中心裁剪 + resize 到 size×size。cubemap 每个面必须是正方形。"""
    import numpy as np
    import cv2
    h, w = rgb.shape[:2]
    side = min(h, w)
    y0 = (h - side) // 2
    x0 = (w - side) // 2
    cropped = rgb[y0:y0 + side, x0:x0 + side]
    if cropped.shape[0] != size:
        cropped = cv2.resize(cropped, (size, size), interpolation=cv2.INTER_AREA if cropped.shape[0] > size else cv2.INTER_CUBIC)
    return cropped


def _rgb_to_b64_png(rgb) -> str:
    """RGB ndarray → 不含前缀的 base64 PNG"""
    from PIL import Image
    import io
    img = Image.fromarray(rgb)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _build_cubemap_to_equirect_maps(out_w: int, out_h: int, face_size: int):
    """预计算 equirectangular 每个像素 → cubemap(face, u, v) 的查表。
    返回 6 个 face 的 (map_x, map_y, mask) 三元组，mask 标记该像素属于该 face。
    """
    import numpy as np
    # 输出像素坐标 → 经纬度
    j = np.arange(out_h, dtype=np.float32)
    i = np.arange(out_w, dtype=np.float32)
    ii, jj = np.meshgrid(i, j)
    # 经度 lon ∈ [-π, π)，纬度 lat ∈ [π/2, -π/2]
    lon = (ii / out_w) * (2 * np.pi) - np.pi
    lat = np.pi / 2 - (jj / out_h) * np.pi
    # 单位方向向量（与 panorama-viewer.js 的着色器约定保持一致）
    # 着色器：lon = atan2(x, -z), lat = asin(y)
    # 反推：x = cos(lat)*sin(lon), y = sin(lat), z = -cos(lat)*cos(lon)
    cos_lat = np.cos(lat)
    x = cos_lat * np.sin(lon)
    y = np.sin(lat)
    z = -cos_lat * np.cos(lon)
    # 选择主导分量 → 决定属于哪个 face
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    max_axis = np.maximum(np.maximum(ax, ay), az)

    faces = {}
    s = face_size

    # +X = right （x 最大且 x>0）
    sel = (ax >= ay) & (ax >= az) & (x > 0)
    u = -z[sel] / x[sel]
    v = -y[sel] / x[sel]
    faces["right"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    # -X = left
    sel = (ax >= ay) & (ax >= az) & (x < 0)
    u = -z[sel] / x[sel]
    v = y[sel] / x[sel]
    faces["left"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    # +Y = up（y 最大且 y>0）
    sel = (ay >= ax) & (ay >= az) & (y > 0)
    u = x[sel] / y[sel]
    v = -z[sel] / y[sel]
    faces["up"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    # -Y = down
    sel = (ay >= ax) & (ay >= az) & (y < 0)
    u = x[sel] / (-y[sel])
    v = -z[sel] / (-y[sel])
    faces["down"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    # -Z = forward（z 最大负，约定 forward 是 -z 方向）
    sel = (az >= ax) & (az >= ay) & (z < 0)
    u = x[sel] / (-z[sel])
    v = -y[sel] / (-z[sel])
    faces["forward"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    # +Z = back
    sel = (az >= ax) & (az >= ay) & (z > 0)
    u = -x[sel] / z[sel]
    v = -y[sel] / z[sel]
    faces["back"] = (sel, (u + 1) * 0.5 * (s - 1), (v + 1) * 0.5 * (s - 1))

    return faces


def _composite_cubemap_to_equirect(faces_rgb: dict, out_w: int = 4096) -> "np.ndarray":
    """faces_rgb: {face_name: HxWx3 uint8}, 6 个面齐全。返回 equirectangular RGB。"""
    import numpy as np
    out_h = out_w // 2
    face_size = next(iter(faces_rgb.values())).shape[0]
    panorama = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    face_maps = _build_cubemap_to_equirect_maps(out_w, out_h, face_size)
    for name, (sel, u, v) in face_maps.items():
        face = faces_rgb.get(name)
        if face is None:
            continue
        # numpy 双线性采样（cv2.remap 对 N×1 形状有 SHRT_MAX 行数限制，不能直接用）
        u = np.clip(u, 0, face_size - 1)
        v = np.clip(v, 0, face_size - 1)
        u0 = np.floor(u).astype(np.int32)
        v0 = np.floor(v).astype(np.int32)
        u1 = np.minimum(u0 + 1, face_size - 1)
        v1 = np.minimum(v0 + 1, face_size - 1)
        fu = (u - u0).astype(np.float32)[:, None]
        fv = (v - v0).astype(np.float32)[:, None]
        p00 = face[v0, u0].astype(np.float32)
        p10 = face[v0, u1].astype(np.float32)
        p01 = face[v1, u0].astype(np.float32)
        p11 = face[v1, u1].astype(np.float32)
        sampled = (p00 * (1 - fu) * (1 - fv)
                   + p10 * fu * (1 - fv)
                   + p01 * (1 - fu) * fv
                   + p11 * fu * fv)
        panorama[sel] = np.clip(sampled, 0, 255).astype(np.uint8)
    return panorama


async def _gen_one_face_via_internal(config: dict, headers: dict, prompt: str,
                                      negative_prompt: str, face_size: int,
                                      ref_b64_data_url: str):
    """复用现有探测/缓存逻辑生成单个 face。返回 RGB ndarray 或 None。"""
    normalized_images = [_strip_image_base64(ref_b64_data_url)] if ref_b64_data_url else []

    cached_sid = get_cached_strategy(config["id"])
    strategies_to_try = []
    if cached_sid and cached_sid in STRATEGY_MAP:
        s = STRATEGY_MAP[cached_sid]
        if not (normalized_images and s["request_format"] == "none"):
            strategies_to_try.append(s)
    explore = _get_applicable_strategies(config["api_base"])
    if normalized_images:
        explore = [s for s in explore if s["request_format"] != "none"]
    for s in explore:
        if s not in strategies_to_try:
            strategies_to_try.append(s)

    for strategy in strategies_to_try:
        result = await _try_strategy(
            strategy, config, headers, prompt, face_size, face_size, 1,
            negative_prompt, normalized_images,
        )
        if result:
            b64 = (result[0] or {}).get("b64_json", "")
            if b64:
                return _decode_b64_image_to_rgb(b64)
    return None


@router.post("/generate-panorama")
async def generate_panorama(req: PanoramaGenerateRequest):
    """以 forward 图为基准，生成另外 5 个方位面，OpenCV 合成 equirectangular 全景。"""
    config = next((c for c in get_config_list() if c["id"] == req.config_id), None)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    forward_rgb = _decode_b64_image_to_rgb(req.image_base64)
    if forward_rgb is None:
        raise HTTPException(status_code=400, detail="参考图解码失败")

    face_size = max(512, min(2048, int(req.face_size or 1024)))
    out_w = max(1024, min(8192, int(req.out_width or 4096)))
    if out_w % 2:
        out_w -= 1
    out_h = out_w // 2

    forward_face = _resize_to_square(forward_rgb, face_size)
    ref_b64 = "data:image/png;base64," + _rgb_to_b64_png(forward_face)
    scene_hint = (req.prompt or "").strip()
    neg = (req.negative_prompt or "").strip() or PANORAMA_NEG_PROMPT

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}",
    }

    async def gen_face(name: str):
        base_prompt = PANORAMA_FACE_PROMPTS[name]
        prompt = f"{scene_hint}. {base_prompt}" if scene_hint else base_prompt
        rgb = await _gen_one_face_via_internal(config, headers, prompt, neg, face_size, ref_b64)
        if rgb is None:
            print(f"[全景] face={name} 生成失败")
            return name, None
        return name, _resize_to_square(rgb, face_size)

    other_faces = ["right", "back", "left", "up", "down"]
    print(f"[全景] 开始生成 5 个方位面 (face_size={face_size}, out={out_w}x{out_h})")
    results = await asyncio.gather(*[gen_face(n) for n in other_faces], return_exceptions=True)

    faces_rgb = {"forward": forward_face}
    failed = []
    for item in results:
        if isinstance(item, Exception):
            print(f"[全景] face 异常: {item}")
            continue
        name, rgb = item
        if rgb is not None:
            faces_rgb[name] = rgb
        else:
            failed.append(name)

    # 缺失的面用 forward 兜底（差但不会黑屏）
    for name in other_faces:
        if name not in faces_rgb:
            faces_rgb[name] = forward_face

    if failed:
        print(f"[全景] 警告：以下面生成失败已用 forward 兜底: {failed}")

    print(f"[全景] 合成 equirectangular {out_w}x{out_h}")
    try:
        panorama_rgb = _composite_cubemap_to_equirect(faces_rgb, out_w=out_w)
        b64_png = _rgb_to_b64_png(panorama_rgb)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"全景合成失败: {e}")

    return {
        "code": 0,
        "data": [{"b64_json": b64_png}],
        "meta": {
            "width": out_w,
            "height": out_h,
            "face_size": face_size,
            "failed_faces": failed,
        },
    }
