import json
import re
import os
import base64
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from backend.models.schemas import ChatRequest, SmartChatRequest, ImageGenerateRequest, VideoChatRequest
from backend.api.config_router import get_config_list
from backend.api.image_router import generate_image
from backend.core.request_client import async_http_request, build_endpoint_url
from backend.core.canvas_storage import get_data_root

router = APIRouter(prefix="/api/chat", tags=["聊天对话"])

CHAT_IMAGES_DIR = os.path.join(get_data_root(), "chat_images")
os.makedirs(CHAT_IMAGES_DIR, exist_ok=True)

MAX_IMAGE_EDGE = 3840
MIN_IMAGE_EDGE = 256
MAX_RATIO = 3.0
MIN_PIXELS = 655360
MAX_PIXELS = 8294400


def _align16(n: int) -> int:
    """对齐到 16 的倍数（向下取整，最小 MIN_IMAGE_EDGE）。"""
    v = max(MIN_IMAGE_EDGE, (int(n) // 16) * 16)
    return min(v, MAX_IMAGE_EDGE)


def _clamp_image_size(w: int, h: int) -> tuple:
    """确保满足：最长边≤3840、16倍数、长短边比≤3:1、总像素在[655360, 8294400]。"""
    w, h = int(w), int(h)
    if w <= 0 or h <= 0:
        return 1024, 1024

    # 1) 最长边不超过 MAX_IMAGE_EDGE
    longest = max(w, h)
    if longest > MAX_IMAGE_EDGE:
        scale = MAX_IMAGE_EDGE / longest
        w = int(w * scale)
        h = int(h * scale)

    # 2) 对齐到 16 的倍数
    w = _align16(w)
    h = _align16(h)

    # 3) 长短边比不超过 3:1
    long_side = max(w, h)
    short_side = min(w, h)
    if short_side > 0 and long_side / short_side > MAX_RATIO:
        new_short = _align16(int(long_side / MAX_RATIO))
        if w >= h:
            h = new_short
        else:
            w = new_short

    # 4) 总像素不超过 MAX_PIXELS（等比缩小）
    pixels = w * h
    if pixels > MAX_PIXELS:
        scale = (MAX_PIXELS / pixels) ** 0.5
        w = _align16(int(w * scale))
        h = _align16(int(h * scale))

    # 5) 总像素不少于 MIN_PIXELS（等比放大，对齐后可能偏小则再补一档）
    pixels = w * h
    if pixels < MIN_PIXELS:
        scale = (MIN_PIXELS / pixels) ** 0.5
        w = _align16(max(MIN_IMAGE_EDGE, int(w * scale) + 15))
        h = _align16(max(MIN_IMAGE_EDGE, int(h * scale) + 15))
        if w * h < MIN_PIXELS:
            if w <= h:
                w += 16
            else:
                h += 16

    return w, h


def get_config_by_id(config_id: str):
    return next((c for c in get_config_list() if c["id"] == config_id), None)


def get_first_config(config_type: str):
    allowed = {config_type, "both"}
    return next((c for c in get_config_list() if c.get("config_type") in allowed), None)


def parse_image_request_rules(message: str) -> dict:
    text = (message or "").lower()
    width, height = None, None
    count = 1

    match = re.search(r"([1-4])\s*[张个幅版]", text)
    if match:
        count = int(match.group(1))
    else:
        cn_map = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4}
        for k, v in cn_map.items():
            if re.search(rf"{k}\s*[张个幅版]", text):
                count = v
                break

    if any(k in text for k in ["手机壁纸", "竖版", "竖图", "封面", "story", "stories"]):
        width, height = 1024, 1536
    if any(k in text for k in ["高清壁纸", "超清壁纸", "手机桌面"]):
        width, height = 2160, 3840
    if any(k in text for k in ["横版", "横图", "banner", "海报横版"]):
        width, height = 1536, 1024
    if any(k in text for k in ["宽屏", "电脑壁纸", "桌面壁纸", "landscape"]):
        width, height = 3840, 2160
    if any(k in text for k in ["头像", "方图", "方形", "icon", "logo"]):
        width, height = 1024, 1024
    if any(k in text for k in ["超清", "8k", "4k"]):
        if width is None:
            width, height = 2048, 2048
        else:
            width = min(width * 2, MAX_IMAGE_EDGE)
            height = min(height * 2, MAX_IMAGE_EDGE)
            width, height = _clamp_image_size(width, height)

    return {"image_width": width, "image_height": height, "image_count": max(1, min(count, 4))}


def _resolve_image_url(url: str) -> str:
    if not url:
        return ""
    if url.startswith("data:image"):
        return url
    if url.startswith("/chat-images/"):
        local_path = os.path.join(CHAT_IMAGES_DIR, url.split("/chat-images/", 1)[1])
        if os.path.isfile(local_path):
            try:
                with open(local_path, "rb") as f:
                    raw = f.read()
                    mime = "image/jpeg" if raw[:3] == b'\xff\xd8\xff' else "image/png"
                    b64 = base64.b64encode(raw).decode("utf-8")
                return f"data:{mime};base64,{b64}"
            except Exception:
                pass
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return ""


def _is_claude_model(config: dict) -> bool:
    model = (config.get("model_name") or "").lower()
    api_base = (config.get("api_base") or "").lower()
    return "claude" in model or "anthropic" in api_base


def _openai_img_to_claude(data_url: str) -> dict:
    if data_url.startswith("data:"):
        header, raw = data_url.split(",", 1)
        media_type = header.split(";")[0].replace("data:", "")
    else:
        raw = data_url
        media_type = "image/jpeg"
    raw_bytes = base64.b64decode(raw)
    if len(raw_bytes) > 4_000_000:
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(raw_bytes))
            if img.mode == "RGBA":
                img = img.convert("RGB")
            max_dim = 1024
            if max(img.size) > max_dim:
                img.thumbnail((max_dim, max_dim), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            raw = base64.b64encode(buf.getvalue()).decode()
            media_type = "image/jpeg"
        except Exception:
            pass
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": raw}}


def _convert_messages_for_claude(messages: list) -> tuple:
    system_text = ""
    converted = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system":
            if isinstance(content, str):
                system_text += ("\n" if system_text else "") + content
            continue
        if isinstance(content, list):
            parts = []
            for part in content:
                if part.get("type") == "text":
                    parts.append({"type": "text", "text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    if url:
                        parts.append(_openai_img_to_claude(url))
            converted.append({"role": role, "content": parts})
        else:
            converted.append({"role": role, "content": str(content)})
    return system_text, converted


async def create_chat_response(config: dict, request_data: dict, stream: bool, timeout: float = 120.0):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}"
    }

    has_images = False
    for msg in request_data.get("messages", []):
        c = msg.get("content")
        if isinstance(c, list):
            for part in c:
                if part.get("type") in ("image_url", "image"):
                    has_images = True
                    break

    use_claude_native = _is_claude_model(config) and has_images

    if use_claude_native:
        chat_url = build_endpoint_url(config["api_base"], "/messages")
        headers["x-api-key"] = config["api_key"]
        headers["anthropic-version"] = "2023-06-01"
        system_text, claude_msgs = _convert_messages_for_claude(request_data.get("messages", []))
        claude_data = {
            "model": request_data.get("model", config["model_name"]),
            "max_tokens": request_data.get("max_tokens") or 20000,
            "messages": claude_msgs,
        }
        if system_text:
            claude_data["system"] = system_text
        if stream:
            claude_data["stream"] = True

        if stream:
            async def claude_stream_generator():
                try:
                    async with await async_http_request(
                        "POST", chat_url, headers, claude_data, timeout=timeout, stream=True
                    ) as response:
                        if response.status_code != 200:
                            error_text = await response.atext()
                            yield f"data: {json.dumps({'error': f'API请求失败: {error_text}'}, ensure_ascii=False)}\n\n"
                            yield "data: [DONE]\n\n"
                            return
                        async for line in response.aiter_lines():
                            line = line.strip()
                            if not line or line.startswith(":"):
                                continue
                            if line.startswith("data: "):
                                raw = line[6:]
                                if raw == "[DONE]":
                                    yield "data: [DONE]\n\n"
                                    break
                                try:
                                    evt = json.loads(raw)
                                    evt_type = evt.get("type", "")
                                    if evt_type == "content_block_delta":
                                        delta_text = evt.get("delta", {}).get("text", "")
                                        if delta_text:
                                            openai_chunk = {"choices": [{"delta": {"content": delta_text}, "index": 0}]}
                                            yield f"data: {json.dumps(openai_chunk, ensure_ascii=False)}\n\n"
                                    elif evt_type == "message_stop":
                                        yield "data: [DONE]\n\n"
                                        break
                                except json.JSONDecodeError:
                                    yield f"{line}\n\n"
                except Exception as e:
                    print(f"[smart_chat] Claude流式请求异常: {repr(e)}")
                    yield f"data: {json.dumps({'error': f'请求异常: {str(e)}'}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"

            return StreamingResponse(
                claude_stream_generator(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
            )
        else:
            response = await async_http_request("POST", chat_url, headers, claude_data, timeout=timeout)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text[:500])
            result = response.json()
            content = ""
            for block in result.get("content", []):
                if block.get("type") == "text":
                    content += block.get("text", "")
            return {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": result.get("stop_reason", "end_turn")}]}

    chat_url = build_endpoint_url(config["api_base"], "/chat/completions")

    async def stream_generator():
        try:
            async with await async_http_request(
                "POST", chat_url, headers, request_data, timeout=timeout, stream=True
            ) as response:
                if response.status_code != 200:
                    error_text = await response.atext()
                    yield f"data: {json.dumps({'error': f'API请求失败: {error_text}'}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        yield f"{line}\n\n"
                        if line[6:] == "[DONE]":
                            break
        except Exception as e:
            print(f"[smart_chat] 流式请求异常: {repr(e)}")
            yield f"data: {json.dumps({'error': f'请求异常: {str(e)}'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    if stream:
        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )

    response = await async_http_request("POST", chat_url, headers, request_data, timeout=timeout)
    if response.status_code != 200:
        error_detail = await response.atext()
        raise HTTPException(status_code=response.status_code, detail=error_detail)
    return response.json()


_GREETING_ONLY_RE = re.compile(
    r"^\s*(你好|您好|hi|hello|hey|在吗|嗨|哈喽|早上好|中午好|下午好|晚上好)[\s!?。！？~.]*$",
    re.IGNORECASE,
)

_IMAGE_KEYWORD_RE = re.compile(
    r"画|绘|生成|图片|图像|插画|海报|封面|壁纸|头像|立绘|画面|出图|渲染|示意图|可视化|一张|一幅|"
    r"draw|paint|sketch|render|illustrat|image|picture|photo|poster|wallpaper|avatar",
    re.IGNORECASE,
)

_CONFIRMATION_RE = re.compile(
    r"^\s*(是|对|好|好的|好啊|可以|行|没错|确认|确定|ok|okay|yes|sure|go|嗯|嗯嗯|来吧|那就|就这样|麻烦了?|帮我|请|需要|要)"
    r"[\s!?。！？~.,]*$",
    re.IGNORECASE,
)


def _recent_history_has_image_topic(messages) -> bool:
    """最近 ~6 条消息里是否出现过任何图像相关语义。"""
    window = (messages or [])[-6:]
    for m in window:
        txt = str(m.get("content") or "")
        if _IMAGE_KEYWORD_RE.search(txt):
            return True
    return False


async def classify_task(message: str, has_files: bool, file_names: list, messages: list, classifier_config: dict) -> dict:
    rule_result = parse_image_request_rules(message)
    normalized_message = (message or "").strip()
    has_history = bool(messages)

    if (not has_files
            and not has_history
            and len(normalized_message) <= 20
            and _GREETING_ONLY_RE.match(normalized_message)):
        return {
            "task_type": "chat",
            "reason": "纯打招呼且无历史，直通聊天",
            "rewritten_prompt": None,
            "image_size": "1024x1024",
            "image_count": 1,
        }

    # 快速闸门：本轮 + 近 6 轮历史均无图像信号 → 明确是 chat，跳过分类器
    msg_has_image_keyword = bool(_IMAGE_KEYWORD_RE.search(normalized_message))
    msg_is_confirmation = bool(_CONFIRMATION_RE.match(normalized_message))
    history_has_image_topic = _recent_history_has_image_topic(messages)

    if (not has_files
            and not msg_has_image_keyword
            and not history_has_image_topic
            and not msg_is_confirmation):
        return {
            "task_type": "chat",
            "reason": "本轮与近 6 轮历史均无图像相关信号，跳过分类器",
            "rewritten_prompt": None,
            "image_size": "1024x1024",
            "image_count": 1,
        }

    files_hint = ""
    if has_files and file_names:
        files_hint = f"\n\n用户本轮同时上传了文件：{', '.join(file_names)}。文件本身会作为材料一并发送给对应模型，不影响你判断任务类型。"

    system_prompt = (
        "你是一个多模态意图识别代理。用户在一个同时支持『聊天』和『图像生成』的助手里发消息。"
        "你的任务：结合【完整对话历史 + 用户本轮消息】，像一个真正的助手那样先在心里理解整个对话脉络，再判断用户这一轮到底想要什么。"
        "你只能输出一个 JSON 对象，不要输出任何多余文字。"
        "\n\n== 判断流程（必须这样思考，但不要输出思考过程） =="
        "\n1) 先在心里简要概括整段历史：用户此前在聊什么主题、有没有提到画面/角色/场景/风格；助手有没有提议、承诺、或正在引导用户去生图。"
        "\n2) 识别用户本轮消息的真实意图。本轮消息可能是：全新请求；延续之前话题的补充描述；对助手提议的确认（是/好/可以/来吧/那就/行/嗯/ok 等）；对之前图像结果的修改请求（再画一张、换个风格、改成竖版、加点光效）；纯聊天。"
        "\n3) 本轮消息语义可能不完整。比如用户只说『是』或『就这样』，必须结合历史补全：助手承诺要画什么、用户之前描述的画面元素、已经约定的风格和尺寸——把这些信息全部吸收后再判定。"
        "\n4) 做最终判断。"
        "\n\n== 两种任务类型 =="
        "\n• chat：普通问答、分析、代码、翻译、写作、总结/分析文件、解释概念、帮写文案或绘图提示词文本但不要出图、描述某张画但不要求生成、只是讨论画面构思等。"
        "\n• image：用户想要一张实际生成的图片。包括直接命令（画一张…/生成…/给我出一张…）、隐含意图（想看看长什么样、可视化一下、给我个封面/海报/壁纸/头像/立绘/插画/示意图）、对助手主动提议的肯定或确认、对既有图像的修改/变体请求。"
        "\n\n== 当你判定为 image 时，rewritten_prompt 的要求 =="
        "\n必须生成一段可以直接喂给绘图模型的中文（或中英混合）提示词。语义来源：融合『用户本轮消息 + 整段历史中与画面相关的所有约定信息（主体/角色/风格/场景/氛围/视角/尺寸/参考图意图）』。"
        "\n即便用户本轮只说『是』『好』『继续』，也必须回溯历史把画面补齐——不得只写用户那一个字。"
        "\n结构建议依次包含：主体与角色、风格（写实/二次元/国风/赛博朋克/水彩/3D/吉卜力…）、场景与环境、构图与视角（特写/全景/俯视/第一视角…）、光影与氛围、关键细节、画质词（高清/8K/电影感/精致细节）。"
        "\n不要加『Prompt:』『提示词：』等前缀；不要解释；直接写内容。"
        "\n\n== image_size（宽x高）判定 =="
        "\n输出格式为 \"宽x高\"（如 1024x1024）。规则："
        "\n• 宽和高都必须是 16 的倍数，最长边不超过 3840，最短边不小于 256。"
        "\n• 如果用户明确给了数字尺寸（如 1920x1080、512x768），直接使用（你来校验是否合法，不合法则按比例缩放到合法范围）。"
        "\n• 如果用户给了比例（如 16:9、4:3、3:2、9:16、1:1），按该比例选一个合理分辨率。"
        "\n• 常用参考：1:1→1024x1024；16:9→1536x864；9:16→864x1536；4:3→1024x768；3:4→768x1024；3:2→1536x1024；2:3→1024x1536。"
        "\n• 如果用户说了场景关键词但没给数字："
        "\n  - 头像/icon/logo/方图 → 1024x1024"
        "\n  - 横版/banner/海报横版/风景 → 1536x1024"
        "\n  - 竖版/手机壁纸/封面/立绘/story → 1024x1536"
        "\n  - 电脑壁纸/桌面/宽屏 → 1920x1080"
        "\n• 如果用户提到超清/4K/8K，在保持比例的前提下放大（最长边可到 3840）。"
        "\n• 如果什么都没提，默认 1024x1024。"
        "\n• 判定依据同样要看完整对话历史中约定过的尺寸/比例。"
        "\n\n== image_count =="
        "\n1-4 的整数。用户或历史未明确说『几张/多版』则填 1。"
        "\n\n== 输出格式 =="
        '\n{"task_type":"chat|image","reason":"一句话写出你的判断依据，可以引用历史中的关键片段","rewritten_prompt":"image 必填；chat 填空字符串","image_size":"宽x高","image_count":1}'
        f"{files_hint}"
    )

    history_limit = 30
    context_messages = (messages or [])[-history_limit:]
    routing_messages = [{"role": "system", "content": system_prompt}]
    if not has_files and context_messages:
        routing_messages.extend(context_messages)
    routing_messages.append({
        "role": "user",
        "content": f"【用户本轮消息】\n{message}\n\n请先在心里梳理以上完整对话历史，再判断本轮意图并输出 JSON。"
    })

    request_data = {
        "model": classifier_config["model_name"],
        "messages": routing_messages,
        "temperature": 0.1,
        "stream": False,
        "max_tokens": 800,
        "response_format": {"type": "json_object"}
    }

    try:
        response = await create_chat_response(classifier_config, request_data, stream=False)
        content = response.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content or not content.strip():
            raise ValueError("分类器返回空内容")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            cleaned = content.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            parsed = json.loads(cleaned)
    except Exception as e:
        print(f"[分类器] 调用失败，fallback to chat: {repr(e)}")
        return {
            "task_type": "chat",
            "reason": f"分类器调用失败: {str(e)[:100]}",
            "rewritten_prompt": None,
            "image_size": "1024x1024",
            "image_count": 1,
        }
    parsed.setdefault("task_type", "chat")
    parsed.setdefault("reason", "默认聊天")
    parsed.setdefault("rewritten_prompt", None)
    parsed.setdefault("image_size", "1024x1024")
    parsed.setdefault("image_count", 1)

    if parsed.get("task_type") not in ("chat", "image"):
        parsed["task_type"] = "chat"

    if parsed.get("task_type") == "image":
        model_size = str(parsed.get("image_size") or "").strip()
        w, h = 1024, 1024
        if "x" in model_size:
            try:
                parts = model_size.split("x")
                w, h = int(parts[0]), int(parts[1])
            except (ValueError, IndexError):
                pass
        elif rule_result.get("image_width"):
            w, h = rule_result["image_width"], rule_result["image_height"]
        w, h = _clamp_image_size(w, h)
        parsed["image_size"] = f"{w}x{h}"
        parsed["image_count"] = int(parsed.get("image_count") or rule_result.get("image_count") or 1)
        rewritten = str(parsed.get("rewritten_prompt") or "").strip()
        if not rewritten:
            parsed["rewritten_prompt"] = normalized_message or None

    # 最终兜底
    size_str = str(parsed.get("image_size") or "").strip()
    if "x" not in size_str:
        parsed["image_size"] = "1024x1024"
    else:
        try:
            fw, fh = [int(x) for x in size_str.split("x")]
            fw, fh = _clamp_image_size(fw, fh)
            parsed["image_size"] = f"{fw}x{fh}"
        except (ValueError, IndexError):
            parsed["image_size"] = "1024x1024"
    parsed["image_count"] = max(1, min(int(parsed.get("image_count") or 1), 4))
    return parsed


@router.post("")
async def chat_completions(req: ChatRequest):
    config = get_config_by_id(req.config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    request_data = {
        "model": config["model_name"],
        "messages": req.messages,
        "temperature": req.temperature if req.temperature is not None else 0.7,
        "stream": req.stream,
        "max_tokens": req.max_tokens if req.max_tokens else None
    }
    request_data = {k: v for k, v in request_data.items() if v is not None}
    return await create_chat_response(config, request_data, req.stream)


@router.post("/smart")
async def smart_chat(req: SmartChatRequest):
    classifier_config = get_config_by_id(req.chat_config_id) if req.chat_config_id else get_first_config("chat")
    if not classifier_config:
        raise HTTPException(status_code=400, detail="未找到可用的聊天配置，无法进行任务判断")

    file_blocks = []
    image_files = []
    text_file_contents = []

    for item in req.files:
        is_image = item.content_type and item.content_type.startswith("image/")

        resolved_image_url = ""
        if is_image:
            resolved_image_url = _resolve_image_url(item.image_url or "") or _resolve_image_url(item.preview_url or "")

        if is_image and resolved_image_url:
            image_files.append({
                "filename": item.filename,
                "image_url": resolved_image_url,
                "content_type": item.content_type
            })
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n说明: 图片文件已上传"
            )
        elif item.text_content:
            text_file_contents.append({
                "filename": item.filename,
                "text": item.text_content[:50000000]
            })
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n内容:\n{item.text_content[:50000000]}"
            )
        else:
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n说明: 无法读取文件内容"
            )

    files_summary = "\n\n---\n\n".join(file_blocks)
    has_files = bool(req.files)
    file_names = [item.filename for item in req.files if item.filename]

    route = await classify_task(req.message, has_files, file_names, req.messages, classifier_config)
    task_type = route.get("task_type", "chat")

    if task_type == "image":
        image_config = get_config_by_id(req.image_config_id) if req.image_config_id else get_first_config("image")
        if not image_config:
            return JSONResponse({
                "code": -1,
                "route": route,
                "message": "识别为图片生成任务，但当前没有可用的图片模型配置"
            })

        prompt = route.get("rewritten_prompt") or req.message
        image_size = route.get("image_size") or "1024x1024"
        image_count = route.get("image_count") or 1

        if text_file_contents:
            text_parts = []
            for tf in text_file_contents:
                text_parts.append(f"[{tf['filename']}]:\n{tf['text'][:20000]}")
            prompt = prompt + "\n\n参考材料:\n" + "\n\n".join(text_parts)

        ref_image_base64_list = []
        for img in image_files:
            url = img.get("image_url", "")
            resolved = _resolve_image_url(url)
            if resolved and resolved.startswith("data:image"):
                ref_image_base64_list.append(resolved)

        if not ref_image_base64_list and req.messages:
            for hist_msg in reversed(req.messages[-12:]):
                for url in (hist_msg.get("image_urls") or []):
                    resolved = _resolve_image_url(url)
                    if resolved and resolved.startswith("data:image"):
                        ref_image_base64_list.append(resolved)
                    if len(ref_image_base64_list) >= 4:
                        break
                if len(ref_image_base64_list) >= 4:
                    break

        try:
            width, height = [int(x) for x in image_size.split("x")]
            image_response = await generate_image(ImageGenerateRequest(
                config_id=image_config["id"],
                prompt=prompt,
                negative_prompt="",
                width=width,
                height=height,
                n=image_count,
                image_base64_list=ref_image_base64_list,
            ))
            data_items = image_response.get("data", [])
            normalized = []
            for item in data_items:
                img_src = None
                if item.get("b64_json"):
                    b64 = item["b64_json"]
                    img_src = b64 if str(b64).startswith("data:image") else f"data:image/png;base64,{b64}"
                elif item.get("url"):
                    img_src = item["url"]
                if img_src:
                    normalized.append({"url": img_src})

            if not normalized:
                return JSONResponse({
                    "code": -1,
                    "mode": "image",
                    "route": route,
                    "message": "图片接口已返回，但没有可显示的图片数据"
                })

            return JSONResponse({
                "code": 0,
                "mode": "image",
                "route": route,
                "data": {
                    "config_id": image_config["id"],
                    "prompt": prompt,
                    "original_prompt": req.message,
                    "image_size": image_size,
                    "image_count": image_count,
                    "images": normalized
                }
            })
        except HTTPException as e:
            return JSONResponse({
                "code": -1,
                "mode": "image",
                "route": route,
                "message": f"图片生成失败：{e.detail}"
            })
        except Exception as e:
            return JSONResponse({
                "code": -1,
                "mode": "image",
                "route": route,
                "message": f"图片生成异常：{str(e)}"
            })

    system_prompt = (
        "你是一个中文 AI 助手。"
        "如果用户上传了文件，请优先基于文件内容回答，并明确说明依据。"
        "如果文件内容不足以回答，要明确指出缺失信息。"
    )

    composed_messages = [{"role": "system", "content": system_prompt}]
    if req.messages:
        for hist_msg in req.messages[-12:]:
            role = hist_msg.get("role", "")
            content = hist_msg.get("content", "")
            hist_image_urls = hist_msg.get("image_urls") or []
            resolved_hist_images = []
            for url in hist_image_urls:
                resolved = _resolve_image_url(url)
                if resolved:
                    resolved_hist_images.append(resolved)
            if resolved_hist_images:
                parts = [{"type": "text", "text": str(content)}]
                for img_url in resolved_hist_images:
                    parts.append({"type": "image_url", "image_url": {"url": img_url}})
                composed_messages.append({"role": role, "content": parts})
            elif content:
                composed_messages.append({"role": role, "content": str(content)})

    if files_summary:
        composed_messages.append({
            "role": "system",
            "content": f"以下是用户上传文件的可用文本内容，请在回答时结合使用:\n\n{files_summary}"
        })

    if image_files:
        print(f"[smart_chat] 多模态消息: {len(image_files)} 张图片, 各大小: {[len(img['image_url']) for img in image_files]}")
        user_message_content = [{"type": "text", "text": req.message}]
        for img in image_files:
            user_message_content.append({
                "type": "image_url",
                "image_url": {"url": img["image_url"]}
            })
        composed_messages.append({"role": "user", "content": user_message_content})
    else:
        composed_messages.append({"role": "user", "content": req.message})

    request_data = {
        "model": classifier_config["model_name"],
        "messages": composed_messages,
        "temperature": req.temperature if req.temperature is not None else 0.7,
        "stream": req.stream,
        "max_tokens": req.max_tokens if req.max_tokens else None
    }
    request_data = {k: v for k, v in request_data.items() if v is not None}

    chat_timeout = 300.0 if image_files else 120.0
    response = await create_chat_response(classifier_config, request_data, req.stream, timeout=chat_timeout)
    if req.stream:
        return response

    return JSONResponse({
        "code": 0,
        "mode": "chat",
        "route": route,
        "data": response
    })


@router.post("/parse-pdf")
async def parse_pdf(file: UploadFile = File(...)):
    try:
        import pymupdf
    except ImportError:
        raise HTTPException(status_code=500, detail="服务端未安装 PDF 解析库")

    content = await file.read()
    print(f"[PDF解析] 收到文件: {file.filename}, 大小: {len(content)} bytes")
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")

    try:
        doc = pymupdf.open(stream=content, filetype="pdf")
        pages = []
        for page in doc:
            pages.append(page.get_text())
        doc.close()
        text = "\n\n".join(pages).strip()
        print(f"[PDF解析] 解析完成: {len(pages)} 页, 文本长度: {len(text)}, 预览: {text[:120]}")
        return JSONResponse({"code": 0, "data": {"text": text, "pages": len(pages)}})
    except Exception as e:
        print(f"[PDF解析] 解析失败: {repr(e)}")
        raise HTTPException(status_code=500, detail=f"PDF 解析失败: {str(e)}")



@router.post("/upload-image")
async def upload_chat_image(file: UploadFile = File(...)):
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="文件内容为空")
        ext = os.path.splitext(file.filename or "")[1] or ".png"
        if ext.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"):
            ext = ".png"
        filename = f"{uuid.uuid4().hex}{ext}"
        filepath = os.path.join(CHAT_IMAGES_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(content)
        url = f"/chat-images/{filename}"
        return JSONResponse({"code": 0, "data": {"url": url, "filename": filename}})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"图片保存失败: {str(e)}")


@router.post("/upload-image-base64")
async def upload_chat_image_base64(req: dict):
    try:
        data_url = req.get("image_base64", "")
        if not data_url:
            raise HTTPException(status_code=400, detail="缺少 image_base64")
        if data_url.startswith("data:image"):
            parts = data_url.split(",", 1)
            raw = parts[1] if len(parts) > 1 else ""
            mime_match = re.match(r"data:(image/\w+)", parts[0])
            mime = mime_match.group(1) if mime_match else "image/png"
        else:
            raw = data_url
            mime = "image/png"
        ext_map = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
        ext = ext_map.get(mime, ".png")
        filename = f"{uuid.uuid4().hex}{ext}"
        filepath = os.path.join(CHAT_IMAGES_DIR, filename)
        with open(filepath, "wb") as f:
            f.write(base64.b64decode(raw))
        url = f"/chat-images/{filename}"
        return JSONResponse({"code": 0, "data": {"url": url, "filename": filename}})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"图片保存失败: {str(e)}")


@router.post("/video")
async def video_chat(req: VideoChatRequest):
    config = get_config_by_id(req.config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    if not req.video_url or not req.video_url.startswith("http"):
        raise HTTPException(status_code=400, detail="video_url 必须是有效的 HTTP/HTTPS 链接")

    composed_messages = []
    for hist_msg in (req.messages or [])[-12:]:
        role = hist_msg.get("role", "")
        content = hist_msg.get("content", "")
        if role and content:
            composed_messages.append({"role": role, "content": str(content)})

    user_content = [
        {"type": "text", "text": req.message},
        {"type": "image_url", "image_url": {"url": req.video_url}},
    ]
    composed_messages.append({"role": "user", "content": user_content})

    request_data = {
        "model": config["model_name"],
        "messages": composed_messages,
        "temperature": req.temperature,
        "stream": req.stream,
        "max_tokens": req.max_tokens,
    }

    return await create_chat_response(config, request_data, req.stream, timeout=300.0)
