import json
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from backend.models.schemas import ChatRequest, SmartChatRequest, ImageGenerateRequest
from backend.api.config_router import config_list
from backend.api.image_router import generate_image
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/chat", tags=["聊天对话"])

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


async def create_chat_response(config: dict, request_data: dict, stream: bool):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}"
    }
    chat_url = config["api_base"].rstrip("/") + "/chat/completions"

    async def stream_generator():
        try:
            async with await async_http_request(
                "POST", chat_url, headers, request_data, timeout=120.0, stream=True
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

    response = await async_http_request("POST", chat_url, headers, request_data, timeout=120.0)
    if response.status_code != 200:
        error_detail = await response.atext()
        raise HTTPException(status_code=response.status_code, detail=error_detail)
    return response.json()


async def classify_task(message: str, files_summary: str, messages: list, classifier_config: dict) -> dict:
    rule_result = parse_image_request_rules(message)
    normalized_message = (message or "").strip()
    lower_message = normalized_message.lower()

    image_keywords = ["生成", "画", "绘制", "图片", "海报", "插画", "头像", "壁纸", "配图", "来一张", "做一张"]
    if any(k in normalized_message for k in image_keywords):
        return {
            "task_type": "image",
            "reason": "命中图片关键词，走规则优先",
            "rewritten_prompt": message,
            "image_size": rule_result.get("image_size") or "1024x1024",
            "image_count": rule_result.get("image_count") or 1,
        }

    file_keywords = ["总结文件", "总结一下文件", "分析文件", "读取文件", "根据文件", "结合文件", "基于文件", "提取文件"]
    if files_summary and any(k in normalized_message for k in file_keywords):
        return {
            "task_type": "file",
            "reason": "存在文件且命中文件任务关键词，走规则直通",
            "rewritten_prompt": None,
            "image_size": rule_result.get("image_size") or "1024x1024",
            "image_count": rule_result.get("image_count") or 1,
        }

    simple_chat_patterns = [
        "你好", "hi", "hello", "在吗", "介绍一下", "解释一下", "帮我写", "帮我改", "翻译", "润色", "总结", "怎么", "为什么", "如何", "是什么", "啥意思", "代码", "报错", "排查", "优化", "修复"
    ]
    if not files_summary and len(normalized_message) <= 120 and any(k in lower_message or k in normalized_message for k in simple_chat_patterns):
        return {
            "task_type": "chat",
            "reason": "普通短文本问答，跳过分类模型直通聊天",
            "rewritten_prompt": None,
            "image_size": rule_result.get("image_size") or "1024x1024",
            "image_count": rule_result.get("image_count") or 1,
        }

    system_prompt = (
        "你是任务路由器。根据用户最新输入判断任务类型，只能返回 JSON，不要输出多余文字。"
        "\n任务类型:"
        " chat = 普通问答、写作、分析、翻译、代码讨论等;"
        " image = 明确要求生成图片、画图、海报、插画、头像、壁纸、配图等;"
        " file = 明确要求读取、总结、提取、改写、分析已上传文件内容。"
        "\n如果是图片任务，还要尽量补充 image_size 和 image_count。"
        " image_size 只能取 1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / 2048x1152 / 2160x3840 / 3840x2160 中一个。"
        " image_count 取 1-4 的整数。"
        "\n输出格式: {\"task_type\":\"chat|image|file\",\"reason\":\"简短原因\",\"rewritten_prompt\":\"如果是image，给出适合绘图模型的优化提示词，否则可为空\",\"image_size\":\"可为空\",\"image_count\":1}"
    )

    context_messages = messages[-8:] if messages else []
    routing_messages = [{"role": "system", "content": system_prompt}]
    routing_messages.extend(context_messages)
    routing_messages.append({
        "role": "user",
        "content": f"用户最新输入:\n{message}\n\n已上传文件摘要:\n{files_summary or '无'}"
    })

    request_data = {
        "model": classifier_config["model_name"],
        "messages": routing_messages,
        "temperature": 0.1,
        "stream": False,
        "max_tokens": 400,
        "response_format": {"type": "json_object"}
    }

    response = await create_chat_response(classifier_config, request_data, stream=False)
    content = response["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    parsed.setdefault("task_type", "chat")
    parsed.setdefault("reason", "默认聊天")
    parsed.setdefault("rewritten_prompt", None)
    parsed.setdefault("image_size", "1024x1024")
    parsed.setdefault("image_count", 1)

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
    
    for item in req.files:
        # 检查是否是图片文件
        is_image = item.content_type and item.content_type.startswith("image/")
        
        if is_image and item.image_url:
            # 图片文件：收集用于视觉模型
            image_files.append({
                "filename": item.filename,
                "image_url": item.image_url,
                "content_type": item.content_type
            })
            # 在文本摘要中简要说明
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n说明: 图片文件已上传"
            )
        elif item.text_content:
            # 文本文件：使用完整的 text_content（限制 50MB 字符）
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n内容:\n{item.text_content[:50000000]}"
            )
        else:
            file_blocks.append(
                f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n说明: 无法读取文件内容"
            )
    
    files_summary = "\n\n---\n\n".join(file_blocks)

    route = await classify_task(req.message, files_summary, req.messages, classifier_config)
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

        try:
            width, height = [int(x) for x in image_size.split("x")]
            image_response = await generate_image(ImageGenerateRequest(
                config_id=image_config["id"],
                prompt=prompt,
                negative_prompt="",
                width=width,
                height=height,
                n=image_count,
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
        composed_messages.extend(req.messages[-12:])

    if files_summary:
        composed_messages.append({
            "role": "system",
            "content": f"以下是用户上传文件的可用文本内容，请在回答时结合使用:\n\n{files_summary}"
        })

    # 构建用户消息：如果有图片文件，使用多模态格式
    if image_files:
        # 多模态消息格式（支持 OpenAI Vision API 格式）
        user_message_content = [{"type": "text", "text": req.message}]
        for img in image_files:
            user_message_content.append({
                "type": "image_url",
                "image_url": {"url": img["image_url"]}
            })
        composed_messages.append({"role": "user", "content": user_message_content})
    else:
        # 纯文本消息
        composed_messages.append({"role": "user", "content": req.message})

    request_data = {
        "model": classifier_config["model_name"],
        "messages": composed_messages,
        "temperature": req.temperature if req.temperature is not None else 0.7,
        "stream": req.stream,
        "max_tokens": req.max_tokens if req.max_tokens else None
    }
    request_data = {k: v for k, v in request_data.items() if v is not None}

    response = await create_chat_response(classifier_config, request_data, req.stream)
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
