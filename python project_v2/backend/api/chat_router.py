import json
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from backend.models.schemas import ChatRequest
from backend.api.config_router import config_list
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/chat", tags=["聊天对话"])


# 聊天对话接口（支持流式输出）
@router.post("")
async def chat_completions(req: ChatRequest):
    # 查找配置
    config = next((c for c in config_list if c["id"] == req.config_id), None)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}"
    }
    chat_url = config["api_base"].rstrip("/") + "/chat/completions"

    # 构建请求体（补全缺失的流式参数，确保和前端对齐）
    request_data = {
        "model": config["model_name"],
        "messages": req.messages,
        "temperature": req.temperature if req.temperature is not None else 0.7,
        "stream": req.stream,
        "max_tokens": req.max_tokens if req.max_tokens else None
    }
    # 过滤空值，避免接口报错
    request_data = {k: v for k, v in request_data.items() if v is not None}

    # 流式响应处理（优化格式，严格遵循SSE规范）
    async def stream_generator():
        try:
            async with await async_http_request(
                    "POST", chat_url, headers, request_data, timeout=120.0, stream=True
            ) as response:
                if response.status_code != 200:
                    error_text = await response.atext()
                    # 严格SSE格式返回错误
                    yield f"data: {json.dumps({'error': f'API请求失败: {error_text}'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:]
                        # 透传原始数据，确保前端能正确解析
                        yield f"{line}\n\n"
                        if data_str == "[DONE]":
                            break
        except Exception as e:
            # 异常时返回标准SSE格式
            yield f"data: {json.dumps({'error': f'请求异常: {str(e)}'})}\n\n"
            yield "data: [DONE]\n\n"

    if req.stream:
        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"  # 禁用nginx缓冲，确保流式实时性
            }
        )
    else:
        # 非流式请求（优化错误处理）
        response = await async_http_request("POST", chat_url, headers, request_data, timeout=120.0)
        if response.status_code != 200:
            error_detail = await response.atext()
            raise HTTPException(status_code=response.status_code, detail=error_detail)
        return response.json()