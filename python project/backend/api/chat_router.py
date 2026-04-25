import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from backend.models.schemas import ChatRequest, SmartChatRequest
from backend.api.config_router import config_list
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/chat", tags=["聊天对话"])


def get_config_by_id(config_id: str):
    return next((c for c in config_list if c["id"] == config_id), None)


def get_first_config(config_type: str):
    allowed = {config_type, "both"}
    return next((c for c in config_list if c.get("config_type") in allowed), None)


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
    system_prompt = (
        "你是任务路由器。根据用户最新输入判断任务类型，只能返回 JSON，不要输出多余文字。"
        "\n任务类型:"
        " chat = 普通问答、写作、分析、翻译、代码讨论等;"
        " image = 明确要求生成图片、画图、海报、插画、头像、壁纸、配图等;"
        " file = 明确要求读取、总结、提取、改写、分析已上传文件内容。"
        "\n输出格式: {\"task_type\":\"chat|image|file\",\"reason\":\"简短原因\",\"rewritten_prompt\":\"如果是image，给出适合绘图模型的优化提示词，否则可为空\"}"
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
        "max_tokens": 300,
        "response_format": {"type": "json_object"}
    }

    response = await create_chat_response(classifier_config, request_data, stream=False)
    content = response["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    parsed.setdefault("task_type", "chat")
    parsed.setdefault("reason", "默认聊天")
    parsed.setdefault("rewritten_prompt", None)
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
    for item in req.files:
        file_blocks.append(
            f"文件名: {item.filename}\n类型: {item.content_type}\n大小: {item.size} bytes\n内容:\n{item.text_content[:12000]}"
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
        return JSONResponse({
            "code": 0,
            "mode": "image",
            "route": route,
            "data": {
                "config_id": image_config["id"],
                "prompt": route.get("rewritten_prompt") or req.message,
                "original_prompt": req.message
            }
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
