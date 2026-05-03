import json
import re
import os
import base64
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from backend.models.schemas import ChatRequest, SmartChatRequest, ImageGenerateRequest
from backend.api.config_router import config_list
from backend.api.image_router import generate_image
from backend.core.request_client import async_http_request
from backend.core.canvas_storage import get_data_root

router = APIRouter(prefix="/api/chat", tags=["聊天对话"])

CHAT_IMAGES_DIR = os.path.join(get_data_root(), "chat_images")
os.makedirs(CHAT_IMAGES_DIR, exist_ok=True)

ALLOWED_IMAGE_SIZES = {
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "2048x2048",
    "2048x1152",
    "2160x3840",
    "3840x2160",
}


def get_config_by_id(config_id: str):
    return next((c for c in config_list if c["id"] == config_id), None)


def get_first_config(config_type: str):
    allowed = {config_type, "both"}
    return next((c for c in config_list if c.get("config_type") in allowed), None)


def parse_image_request_rules(message: str) -> dict:
    text = (message or "").lower()
    size = None
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
        size = "1024x1536"
    if any(k in text for k in ["高清壁纸", "超清壁纸", "手机桌面"]):
        size = "2160x3840"
    if any(k in text for k in ["横版", "横图", "banner", "海报横版"]):
        size = "1536x1024"
    if any(k in text for k in ["宽屏", "电脑壁纸", "桌面壁纸", "landscape"]):
        size = "3840x2160"
    if any(k in text for k in ["头像", "方图", "方形", "icon", "logo"]):
        size = "1024x1024"
    if any(k in text for k in ["超清", "8k", "4k"]):
        if size in {None, "1024x1024"}:
            size = "2048x2048"
        elif size == "1536x1024":
            size = "2048x1152"
        elif size == "1024x1536":
            size = "2160x3840"

    return {"image_size": size, "image_count": max(1, min(count, 4))}


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
        chat_url = config["api_base"].rstrip("/") + "/messages"
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

    chat_url = config["api_base"].rstrip("/") + "/chat/completions"

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


async def classify_task(message: str, has_files: bool, file_names: list, messages: list, classifier_config: dict) -> dict:
    rule_result = parse_image_request_rules(message)
    normalized_message = (message or "").strip()
    lower_message = normalized_message.lower()

    simple_chat_patterns = [
        "你好", "hi", "hello", "在吗", "介绍一下", "解释一下", "帮我写", "帮我改", "翻译", "润色", "总结", "怎么", "为什么", "如何", "是什么", "啥意思", "代码", "报错", "排查", "优化", "修复"
    ]
    if not has_files and len(normalized_message) <= 120 and any(k in lower_message or k in normalized_message for k in simple_chat_patterns):
        return {
            "task_type": "chat",
            "reason": "普通短文本问答，跳过分类模型直通聊天",
            "rewritten_prompt": None,
            "image_size": rule_result.get("image_size") or "1024x1024",
            "image_count": rule_result.get("image_count") or 1,
        }

    files_hint = ""
    if has_files and file_names:
        files_hint = f"\n用户同时上传了以下文件：{', '.join(file_names)}。判断任务类型时只看用户文字意图，文件会作为辅助材料一并发送给对应模型。"

    system_prompt = (
        "你是任务路由器。根据用户文字输入判断任务类型，只能返回 JSON，不要输出多余文字。"
        "\n任务类型:"
        " chat = 普通问答、写作、分析、翻译、代码讨论、总结文件、读取文件、分析文件内容等;"
        " image = 明确要求生成/画/绘制/创作一张具体的图片（包括参考已有素材来生成新图片、分镜图、多场景图等）。"
        " 注意：要求写提示词、描述画面等属于chat而非image。"
        f"{files_hint}"
        "\n如果是图片任务，根据用户描述提取image_size和image_count。用户可能说横屏/竖屏/正方形/4K/2K/比例等，请合理映射到对应尺寸。"
        " image_size 只能取 1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / 2048x1152 / 2160x3840 / 3840x2160 中一个。"
        " image_count 取 1-4 的整数。"
        "\n输出格式: {\"task_type\":\"chat|image\",\"reason\":\"简短原因\",\"rewritten_prompt\":\"如果是image，给出适合绘图模型的优化提示词，否则可为空\",\"image_size\":\"可为空\",\"image_count\":1}"
    )

    if has_files:
        routing_messages = [{"role": "system", "content": system_prompt}]
        routing_messages.append({
            "role": "user",
            "content": f"用户最新输入:\n{message}"
        })
    else:
        context_messages = messages[-8:] if messages else []
        routing_messages = [{"role": "system", "content": system_prompt}]
        routing_messages.extend(context_messages)
        routing_messages.append({
            "role": "user",
            "content": f"用户最新输入:\n{message}"
        })

    request_data = {
        "model": classifier_config["model_name"],
        "messages": routing_messages,
        "temperature": 0.1,
        "stream": False,
        "max_tokens": 400,
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
            "image_size": rule_result.get("image_size") or "1024x1024",
            "image_count": rule_result.get("image_count") or 1,
        }
    parsed.setdefault("task_type", "chat")
    parsed.setdefault("reason", "默认聊天")
    parsed.setdefault("rewritten_prompt", None)
    parsed.setdefault("image_size", "1024x1024")
    parsed.setdefault("image_count", 1)

    if parsed.get("task_type") not in ("chat", "image"):
        parsed["task_type"] = "chat"

    rule_result = parse_image_request_rules(message)
    if parsed.get("task_type") == "image":
        if rule_result.get("image_size") in ALLOWED_IMAGE_SIZES:
            parsed["image_size"] = rule_result["image_size"]
        parsed["image_count"] = rule_result.get("image_count") or parsed.get("image_count") or 1

    if parsed.get("image_size") not in ALLOWED_IMAGE_SIZES:
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
