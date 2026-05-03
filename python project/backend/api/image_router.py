import base64
import json
import re
import traceback
from fastapi import APIRouter, HTTPException, UploadFile, File
from backend.models.schemas import ImageGenerateRequest
from backend.api.config_router import config_list
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/image", tags=["图片生成"])


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
        "size": f"{req.width}x{req.height}" if req.width and req.height else "1024x1024",
        "n": req.n if req.n and req.n > 0 else 1,
    }

    if req.negative_prompt:
        request_data["negative_prompt"] = req.negative_prompt

    normalized_images = [x for x in (_strip_image_base64(item) for item in (req.image_base64_list or []) if item) if x]
    if not normalized_images and req.image_base64:
        stripped = _strip_image_base64(req.image_base64)
        if stripped:
            normalized_images = [stripped]

    if len(normalized_images) >= 1:
        request_data["image"] = normalized_images

    safe_request_log = {
        "model": request_data.get("model"),
        "size": request_data.get("size"),
        "has_negative_prompt": bool(request_data.get("negative_prompt")),
        "n": request_data.get("n"),
        "image_field_type": type(request_data.get("image")).__name__ if request_data.get("image") is not None else "none",
        "downstream_image_count": len(request_data.get("image")) if isinstance(request_data.get("image"), list) else (1 if request_data.get("image") else 0),
        "received_image_base64_list_count": len(req.image_base64_list or []),
        "received_image_base64_list_lengths": [len(item or "") for item in (req.image_base64_list or [])],
        "prompt_preview": (req.prompt or "")[:200],
    }

    try:
        print("[图片生成] ===== 请求开始 =====")
        print(f"[图片生成] 配置ID: {req.config_id}")
        print(f"[图片生成] 模型: {config['model_name']}")
        print(f"[图片生成] 请求URL: {image_url}")
        print(f"[图片生成] 请求摘要: {json.dumps(safe_request_log, ensure_ascii=False)}")
        if request_data.get("image"):
            img = request_data["image"]
            preview = img[0][:80] if isinstance(img, list) else str(img)[:80]
            print(f"[图片生成] image字段预览(前80字符): {preview}")
        print(f"[图片生成] 实际请求体: {json.dumps({k: ('<base64 omitted>' if k == 'image' else v) for k, v in request_data.items()}, ensure_ascii=False)}")

        response = await async_http_request("POST", image_url, headers, request_data, timeout=600)
        raw_text = response.text
        print(f"[图片生成] 状态码: {response.status_code}")
        print(f"[图片生成] 响应原始内容(前2000): {raw_text[:2000]}")

        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=raw_text or "图片接口返回非200")

        try:
            result = response.json()
        except Exception:
            raise HTTPException(status_code=500, detail=f"图片接口返回了非 JSON 内容: {raw_text[:800]}")

        data = result.get("data")
        if not isinstance(data, list):
            raise HTTPException(status_code=500, detail=f"图片接口返回格式异常: {str(result)[:800]}")

        print(f"[图片生成] 成功返回 {len(data)} 张图片")
        print("[图片生成] ===== 请求结束 =====")
        return {"code": 0, "data": data}

    except HTTPException as e:
        print(f"[图片生成] HTTPException: status={e.status_code}, detail={e.detail}")
        print(traceback.format_exc())
        raise
    except Exception as e:
        print(f"[图片生成] 错误详情: {repr(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"生成失败: {repr(e)}")
