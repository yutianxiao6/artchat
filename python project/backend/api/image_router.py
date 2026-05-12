import asyncio
import base64
import json
import re
import traceback
from fastapi import APIRouter, HTTPException, UploadFile, File
from backend.models.schemas import ImageGenerateRequest
from backend.api.config_router import get_config_list
from backend.core.request_client import async_http_request, split_api_base, base_has_version, build_endpoint_url
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
    - 用户填了完整 endpoint（以 /images/generations 等结尾）→ 只试 standard 策略
    - 用户填了 /vN 结尾 → 只试 standard 策略
    - 其他（裸 host 或自定义路径）→ custom 优先、standard 降级
    standard 策略用 build_endpoint_url 自动补 /v1。
    """
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
                        negative_prompt: str, normalized_images: list) -> dict:
    req_fmt = strategy["request_format"]
    data = {
        "model": model,
        "prompt": prompt,
        "size": f"{width}x{height}" if width and height else "1024x1024",
        "n": n if n and n > 0 else 1,
    }
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
#  核心：尝试单个策略
# ═══════════════════════════════════════════════════

# PLACEHOLDER_TRY_STRATEGY

async def _try_strategy(strategy: dict, config: dict, headers: dict, prompt: str,
                        width: int, height: int, n: int, negative_prompt: str,
                        normalized_images: list) -> list | None:
    """尝试一个策略。每次调用完全独立，不共享任何状态。"""
    try:
        image_url = _build_url(config["api_base"], strategy)
        request_data = _build_request_data(
            strategy, config["model_name"], prompt, width, height, n,
            negative_prompt, normalized_images
        )

        print(f"[图片生成] POST {image_url} | 策略={strategy['id']} | prompt={prompt[:40]}...")
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

    width = req.width
    height = req.height
    n = req.n if req.n and req.n > 0 else 1
    prompt = req.prompt or ""
    negative_prompt = req.negative_prompt or ""

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
