import base64
from fastapi import APIRouter, HTTPException, UploadFile, File
from backend.models.schemas import ImageGenerateRequest
from backend.api.config_router import config_list
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/image", tags=["图片生成"])


# 图片上传转Base64接口
# 图片上传转Base64接口（确认版）
@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    try:
        print(f"[图片上传] 收到文件: {file.filename}, 类型: {file.content_type}")
        content = await file.read()
        print(f"[图片上传] 文件大小: {len(content)} bytes")

        base64_data = base64.b64encode(content).decode("utf-8")
        mime_type = file.content_type or "image/png"
        base64_url = f"data:{mime_type};base64,{base64_data}"

        print(f"[图片上传] 转换成功")
        return {"code": 0, "data": {"base64_url": base64_url, "base64_data": base64_data}}
    except Exception as e:
        print(f"[图片上传] 错误: {str(e)}")
        raise HTTPException(status_code=500, detail=f"图片上传失败: {str(e)}")


# 图片生成接口（完美兼容 gpt-image-2）
@router.post("/generate")
async def generate_image(req: ImageGenerateRequest):
    config = next((c for c in config_list if c["id"] == req.config_id), None)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}"
    }
    image_url = config["api_base"].rstrip("/") + "/images/generations"

    request_data = {
        "model": config["model_name"],
        "prompt": req.prompt,
        "response_format": "b64_json",
    }

    if req.width and req.height:
        request_data["size"] = f"{req.width}x{req.height}"

    if req.negative_prompt:
        request_data["negative_prompt"] = req.negative_prompt

    if req.n and req.n > 0:
        request_data["n"] = req.n

    if req.image_base64:
        try:
            if req.image_base64.startswith("data:image"):
                req.image_base64 = req.image_base64.split(",")[1]
            request_data["image"] = [req.image_base64]
        except:
            pass

    try:
        print(f"[图片生成] 模型: {config['model_name']}")
        print(f"[图片生成] 尺寸: {request_data.get('size')}")
        print(f"[图片生成] 请求URL: {image_url}")

        response = await async_http_request("POST", image_url, headers, request_data, timeout=300)

        raw_text = response.text
        print(f"[图片生成] 响应原始内容: {raw_text[:200]}")

        result = response.json()

        return {"code": 0, "data": result["data"]}

    except Exception as e:
        print(f"[图片生成] 错误: {str(e)}")
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")