"""
recreate_router.py — 二创影视剧工作流专用路由
各接口解耦，职责单一，便于后续扩展。
"""

import os
import json
import math
import base64 as b64mod
import asyncio
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from backend.core.workflow_storage import (
    get_workflow_dir, save_workflow_image, WORKFLOW_ROOT
)
from backend.core.video_processor import (
    check_ffmpeg, get_video_metadata, pipeline_extract_keyframes, recommend_max_frames
)
from backend.core.request_client import async_http_request
from backend.api.image_router import generate_image
from backend.models.schemas import ImageGenerateRequest

router = APIRouter(prefix="/api/recreate", tags=["二创工作流"])

VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"}
MAX_VIDEO_SIZE = 500 * 1024 * 1024  # 500MB


# ═══════════════════════════════════════════════════
#  工具函数（复用 workflow_router 中的模式）
# ═══════════════════════════════════════════════════

def _get_config_by_id(config_id: str):
    from backend.api.config_router import get_config_list
    for c in get_config_list():
        if c.get("id") == config_id:
            return c
    return None


def _get_first_config(config_type: str):
    from backend.api.config_router import get_config_list
    allowed = [config_type, "both"]
    for c in get_config_list():
        if c.get("config_type") in allowed:
            return c
    return None


def _parse_json_robust(content: str) -> dict:
    """从 AI 返回的文本中提取 JSON，支持截断恢复 + 未转义换行/智能引号修复。"""
    content = content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    if content.startswith("```"):
        content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass
    start = content.find("{")
    end = content.rfind("}")
    if start >= 0 and end > start:
        fragment = content[start:end + 1]
        try:
            return json.loads(fragment)
        except json.JSONDecodeError:
            pass
        fixed = _fix_json_quotes(fragment)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError as e:
            print(f"[recreate JSON] 修复后仍失败: {e}")
            print(f"[recreate JSON] 原始前500: {content[:500]}")
    elif start >= 0 and end <= start:
        recovered = _recover_truncated_json(content[start:])
        if recovered:
            return recovered
        print(f"[recreate JSON] 截断恢复失败，原始前500: {content[:500]}")
    else:
        # 兜底尝试数组
        import re
        m = re.search(r'\[[\s\S]*\]', content)
        if m:
            try:
                return {"items": json.loads(m.group())}
            except json.JSONDecodeError:
                pass
        print(f"[recreate JSON] 未找到JSON结构，原始前500: {content[:500]}")
    raise HTTPException(status_code=500, detail=f"模型返回内容无法解析为JSON，前200字符: {content[:200]}")


def _recover_truncated_json(text: str) -> "dict | None":
    """尝试恢复被截断的 JSON，针对 {"xxx":"很长字符串..."} 之类结构。"""
    for suffix in ['"}', '"}']:
        try:
            return json.loads(text + suffix)
        except json.JSONDecodeError:
            pass
    cleaned = text.rstrip()
    if cleaned.endswith("\\"):
        cleaned = cleaned[:-1]
    for suffix in ['"}', '"\n"}', '" }']:
        try:
            return json.loads(cleaned + suffix)
        except json.JSONDecodeError:
            pass
    import re
    m = re.search(r'"full_text"\s*:\s*"', text)
    if m:
        val_start = m.end()
        raw_val = text[val_start:].rstrip()
        if raw_val.endswith("\\"):
            raw_val = raw_val[:-1]
        try:
            return {"full_text": json.loads('"' + raw_val + '"')}
        except json.JSONDecodeError:
            raw_val = raw_val.replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
            try:
                return {"full_text": json.loads('"' + raw_val + '"')}
            except json.JSONDecodeError:
                return {"full_text": raw_val}
    return None


def _fix_json_quotes(s: str) -> str:
    """修复 JSON 字符串内未转义的 \\n \\t \\r 与智能引号，同时处理字符串内未转义的 "。"""
    SMART_QUOTES = ("“", "”", "‘", "’")
    result = []
    in_string = False
    i = 0
    while i < len(s):
        ch = s[i]
        if not in_string:
            if ch == '"':
                in_string = True
            result.append(ch)
        else:
            if ch == '\\' and i + 1 < len(s):
                result.append(ch)
                result.append(s[i + 1])
                i += 2
                continue
            if ch == '"':
                j = i + 1
                while j < len(s) and s[j] in ' \t\r\n':
                    j += 1
                next_non_ws = s[j] if j < len(s) else ''
                if next_non_ws in (',', '}', ']', ':') or j >= len(s):
                    in_string = False
                    result.append(ch)
                else:
                    result.append('\\"')
            elif ch in SMART_QUOTES:
                result.append(ch)
            elif ch == '\n':
                result.append('\\n')
            elif ch == '\r':
                result.append('\\r')
            elif ch == '\t':
                result.append('\\t')
            else:
                result.append(ch)
        i += 1
    return ''.join(result)


def _compress_b64_image(b64_data: str, max_bytes: int = 4_000_000) -> tuple:
    """超过 max_bytes 的图片 thumbnail 到 1024 并转 JPEG q80。返回 (media_type, b64_raw)。"""
    media_type, raw = _parse_b64_image(b64_data)
    try:
        raw_bytes = b64mod.b64decode(raw)
    except Exception:
        return media_type, raw
    if len(raw_bytes) <= max_bytes:
        return media_type, raw
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
        return "image/jpeg", b64mod.b64encode(buf.getvalue()).decode()
    except Exception:
        return media_type, raw


def _load_ref_image_b64(image_url: str, max_size: int = 1500000) -> str:
    if not image_url or not image_url.startswith("/workflow-images/"):
        return ""
    rel = image_url.replace("/workflow-images/", "", 1)
    path = os.path.join(WORKFLOW_ROOT, rel)
    if not os.path.isfile(path):
        return ""
    try:
        raw = open(path, "rb").read()
        mime = "image/jpeg" if raw[:3] == b'\xff\xd8\xff' else "image/png"
        if len(raw) <= max_size:
            return f"data:{mime};base64," + b64mod.b64encode(raw).decode()
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw))
        if img.mode == "RGBA":
            img = img.convert("RGB")
        max_dim = 1024
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return "data:image/jpeg;base64," + b64mod.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


def _load_thumbnail_b64(image_url: str, max_dim: int = 256, quality: int = 70) -> str:
    """强制缩小到 max_dim 的 JPEG 缩略图。用于智能分段这种只需要判断画面相似性/转场的场景。"""
    if not image_url or not image_url.startswith("/workflow-images/"):
        return ""
    rel = image_url.replace("/workflow-images/", "", 1)
    path = os.path.join(WORKFLOW_ROOT, rel)
    if not os.path.isfile(path):
        return ""
    try:
        from PIL import Image
        import io
        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return "data:image/jpeg;base64," + b64mod.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


def _collect_ref_images(extra_urls=None):
    refs = []
    seen = set()
    for u in (extra_urls or []):
        if not u or u in seen:
            continue
        seen.add(u)
        b = _load_ref_image_b64(u)
        if b:
            refs.append(b)
    return refs


# ═══════════════════════════════════════════════════
#  接口 1: ffmpeg 状态检查
# ═══════════════════════════════════════════════════

@router.get("/ffmpeg-check")
async def ffmpeg_check():
    available = check_ffmpeg()
    return JSONResponse({"code": 0, "data": {"available": available}})


# ═══════════════════════════════════════════════════
#  接口 2: 上传视频
# ═══════════════════════════════════════════════════

@router.post("/upload-video/{workflow_id}")
async def upload_video_multipart(
    workflow_id: str,
    file: UploadFile = File(None),
):
    """Multipart 文件上传（大文件）"""
    if not file:
        raise HTTPException(status_code=400, detail="未提供视频文件")
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的视频格式: {ext}")

    wf_dir = get_workflow_dir(workflow_id)
    video_dir = os.path.join(wf_dir, "videos")
    os.makedirs(video_dir, exist_ok=True)
    video_path = os.path.join(video_dir, f"source{ext}")

    size = 0
    with open(video_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_VIDEO_SIZE:
                f.close()
                os.remove(video_path)
                raise HTTPException(status_code=413, detail="视频文件过大（最大500MB）")
            f.write(chunk)

    metadata = {}
    if check_ffmpeg():
        try:
            metadata = get_video_metadata(video_path)
        except Exception:
            pass

    rel_url = f"/workflow-images/{workflow_id}/videos/source{ext}"
    recommended = recommend_max_frames(metadata.get("duration", 0)) if metadata else 30
    return JSONResponse({"code": 0, "data": {
        "url": rel_url,
        "path": video_path,
        "metadata": metadata,
        "recommended_max_frames": recommended,
    }})


@router.post("/upload-video-b64/{workflow_id}")
async def upload_video_base64(workflow_id: str, body: dict):
    """Base64 JSON 上传（小文件）"""
    video_data = body.get("video_data", "")
    filename = body.get("filename", "source.mp4")
    if not video_data:
        raise HTTPException(status_code=400, detail="缺少视频数据")

    ext = os.path.splitext(filename)[1].lower() or ".mp4"
    if ext not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的视频格式: {ext}")

    if "," in video_data:
        video_data = video_data.split(",", 1)[1]
    # 容错：去除空白字符并补齐 padding
    video_data = "".join(video_data.split())
    missing = len(video_data) % 4
    if missing:
        video_data += "=" * (4 - missing)
    try:
        raw = b64mod.b64decode(video_data, validate=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"视频数据解码失败: {str(e)}。建议使用大文件上传通道（multipart）。")
    if len(raw) > MAX_VIDEO_SIZE:
        raise HTTPException(status_code=413, detail="视频文件过大（最大500MB）")

    wf_dir = get_workflow_dir(workflow_id)
    video_dir = os.path.join(wf_dir, "videos")
    os.makedirs(video_dir, exist_ok=True)
    video_path = os.path.join(video_dir, f"source{ext}")
    with open(video_path, "wb") as f:
        f.write(raw)

    metadata = {}
    if check_ffmpeg():
        try:
            metadata = get_video_metadata(video_path)
        except Exception:
            pass

    rel_url = f"/workflow-images/{workflow_id}/videos/source{ext}"
    recommended = recommend_max_frames(metadata.get("duration", 0)) if metadata else 30
    return JSONResponse({"code": 0, "data": {
        "url": rel_url,
        "path": video_path,
        "metadata": metadata,
        "recommended_max_frames": recommended,
    }})


# ═══════════════════════════════════════════════════
#  接口 3: 关键帧提取
# ═══════════════════════════════════════════════════

@router.post("/upload-image/{workflow_id}")
async def upload_image(workflow_id: str, body: dict):
    """用户手动替换图片（人物/场景）。body: {image_data, prefix}。返回 {url}。"""
    image_data = body.get("image_data", "")
    prefix = (body.get("prefix") or "rc_upload").replace("/", "_")
    if not image_data:
        raise HTTPException(status_code=400, detail="缺少 image_data")
    try:
        url = save_workflow_image(workflow_id, image_data, prefix)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"图片保存失败: {e}")
    return JSONResponse({"code": 0, "data": {"url": url}})


@router.post("/extract-keyframes/{workflow_id}")
async def extract_keyframes_api(workflow_id: str, body: dict):
    """
    算法粗筛关键帧：scene-cut 全量扫描 + 长镜头补帧 + 清晰度/pHash/亮度/边缘过滤。
    所有参数都有服务端默认值，前端通常不需要显式传入。
    """
    if not check_ffmpeg():
        raise HTTPException(status_code=503, detail="ffmpeg 未安装，无法提取关键帧。请安装 ffmpeg 后重试。")

    wf_dir = get_workflow_dir(workflow_id)
    video_dir = os.path.join(wf_dir, "videos")
    video_path = None
    for ext in VIDEO_EXTENSIONS:
        candidate = os.path.join(video_dir, f"source{ext}")
        if os.path.isfile(candidate):
            video_path = candidate
            break

    if not video_path:
        raise HTTPException(status_code=400, detail="未找到已上传的视频文件")

    # 算法参数（全部可选）
    params = {
        "min_scene_threshold": float(body.get("min_scene_threshold", 0.10)),
        "long_shot_max_gap": float(body.get("long_shot_max_gap", 4.0)),
        "merge_min_dt": float(body.get("merge_min_dt", 0.4)),
        "sharpness_min": float(body.get("sharpness_min", 80.0)),
        "hamming_dedup_threshold": int(body.get("hamming_dedup_threshold", 8)),
        "luma_lo": float(body.get("luma_lo", 10.0)),
        "luma_hi": float(body.get("luma_hi", 245.0)),
        "edge_density_min": float(body.get("edge_density_min", 0.02)),
        "max_candidates": int(body.get("max_candidates", 300)),
    }

    frames_dir = os.path.join(wf_dir, "keyframes")
    rejected_dir = os.path.join(wf_dir, "keyframes_rejected")

    try:
        result = pipeline_extract_keyframes(video_path, frames_dir, rejected_dir, params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"关键帧提取失败: {e}")

    # 拼 URL
    for frame in result["frames"]:
        frame["url"] = f"/workflow-images/{workflow_id}/keyframes/{frame['filename']}"
    for rej in result["rejected"]:
        rej["url"] = f"/workflow-images/{workflow_id}/keyframes_rejected/{rej['filename']}"

    # 落盘 keyframes.json 供后续步骤读
    try:
        with open(os.path.join(wf_dir, "keyframes.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    # 密度补帧：按 10s 滑动窗口（步长 5s）扫描，任何 10s 窗口内 < 9 帧就补到 9 帧
    try:
        density_added = _ensure_window_density(
            video_path=video_path,
            workflow_id=workflow_id,
            window_sec=10.0,
            stride_sec=5.0,
            target_per_window=9,
        )
        if density_added > 0:
            # 重新读 keyframes.json，把 result.frames 同步成最新（含补帧）
            kf_path = os.path.join(wf_dir, "keyframes.json")
            if os.path.isfile(kf_path):
                try:
                    new_kf = json.load(open(kf_path, "r", encoding="utf-8"))
                    result["frames"] = new_kf.get("frames", result["frames"])
                    result.setdefault("stats", {})["density_supplement_added"] = density_added
                except Exception:
                    pass
    except Exception as e:
        print(f"[extract-keyframes] 密度补帧失败（不阻断主流程）: {e}")

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  AI 调用辅助
# ═══════════════════════════════════════════════════

def _is_claude_model(config: dict) -> bool:
    model = (config.get("model_name") or "").lower()
    api_base = (config.get("api_base") or "").lower()
    return "claude" in model or "anthropic" in api_base


def _parse_b64_image(b64_data: str):
    if b64_data.startswith("data:"):
        header, raw = b64_data.split(",", 1)
        media_type = header.split(";")[0].replace("data:", "")
    else:
        raw = b64_data
        media_type = "image/jpeg"
    return media_type, raw


async def _call_llm_json(config: dict, system_prompt: str, user_prompt: str, max_tokens: int = 20000, timeout: float = 180.0) -> dict:
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config['api_key']}"}
    url = config["api_base"].rstrip("/") + "/chat/completions"
    data = {
        "model": config["model_name"],
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        "temperature": 0.7, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type": "json_object"}
    }
    response = await async_http_request("POST", url, headers, data, timeout=timeout)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text[:500])
    result = response.json()
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content or not content.strip():
        raise HTTPException(status_code=500, detail="模型返回空内容")
    return _parse_json_robust(content)


async def _call_llm_vision_json(config: dict, system_prompt: str, user_text: str, images: list, max_tokens: int = 20000, timeout: float = 180.0) -> dict:
    """调用视觉模型，images 格式: [{"b64": "data:...", "label": "说明"}]"""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config['api_key']}"}
    url = config["api_base"].rstrip("/")
    is_claude = _is_claude_model(config)

    if is_claude:
        url = url + "/messages"
        headers["x-api-key"] = config["api_key"]
        headers["anthropic-version"] = "2023-06-01"
        user_content = []
        for img in images:
            if not img.get("b64"):
                continue
            media_type, raw = _compress_b64_image(img["b64"])
            user_content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": raw}
            })
            if img.get("label"):
                user_content.append({"type": "text", "text": f"（上图是：{img['label']}）"})
        user_content.append({"type": "text", "text": user_text + "\n\n请严格只输出JSON，不要输出任何其他文字。"})
        data = {
            "model": config["model_name"],
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_content}],
        }
        response = await async_http_request("POST", url, headers, data, timeout=timeout)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text[:500])
        result = response.json()
        content = ""
        for block in result.get("content", []):
            if block.get("type") == "text":
                content += block.get("text", "")
    else:
        url = url + "/chat/completions"
        user_content = [{"type": "text", "text": user_text}]
        for img in images:
            if not img.get("b64"):
                continue
            b64_data = img["b64"]
            if not b64_data.startswith("data:"):
                b64_data = f"data:image/jpeg;base64,{b64_data}"
            user_content.append({
                "type": "image_url",
                "image_url": {"url": b64_data, "detail": "low"}
            })
            if img.get("label"):
                user_content.append({"type": "text", "text": f"（上图是：{img['label']}）"})
        data = {
            "model": config["model_name"],
            "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_content}],
            "temperature": 0.7, "stream": False, "max_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        }
        response = await async_http_request("POST", url, headers, data, timeout=timeout)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text[:500])
        result = response.json()
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")

    if not content or not content.strip():
        raise HTTPException(status_code=500, detail="模型返回空内容")
    return _parse_json_robust(content)


async def _retry_async(fn, max_retries: int = 2, base_delay: float = 1.5, label: str = ""):
    """指数退避重试。fn 是 lambda: coroutine；重试 max_retries 次（共 max_retries+1 次尝试）。"""
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as e:
            last_exc = e
            if attempt >= max_retries:
                break
            delay = base_delay * (2 ** attempt)
            print(f"[retry] {label or 'task'} 第 {attempt+1} 次失败: {str(e)[:120]}；{delay:.1f}s 后重试")
            await asyncio.sleep(delay)
    raise last_exc  # type: ignore


# ═══════════════════════════════════════════════════
#  Round 1：帧级标注（视觉 LLM，含 overview）
# ═══════════════════════════════════════════════════

_SHOT_TYPES = ["wide", "medium", "close-up", "over-the-shoulder", "extreme-close-up", "POV", "insert"]
_TRANSITION_HINTS = ["cut", "fade_in", "fade_out", "cross_dissolve", "match_cut", "none"]


async def llm_label_overview(config: dict, representative_images: list, plot: str = "") -> dict:
    """全局纲要：人物清单 + 场景清单 + 一句话叙事。representative_images 里每个元素是 {b64,label}。"""
    plot_block = f"\n【原始剧情参考】\n{plot[:1500]}\n" if plot else ""
    system_prompt = f"""你是一位专业影视分析师，请基于提供的代表帧做一次全局扫描，提取：
1. characters: 出现的所有人物，每人一条（id/name/features）。features 用稳定外貌描述（发型、服装、体态、年龄、饰物等），避免"红衣男子"这种位置依赖描述
2. scenes: 所有独立场景地点（id/name/features）
3. narrative: 整体叙事一句话概括（不超过 60 字）
{plot_block}
如果提供了原始剧情参考，人物命名应尽量采用剧情中出现的名字。

只输出 JSON：
{{
  "characters": [{{"id":"char_1","name":"角色名","features":"稳定外貌描述"}}],
  "scenes": [{{"id":"scene_1","name":"场景名","features":"环境特征"}}],
  "narrative": "一句话叙事"
}}"""
    user_text = f"共 {len(representative_images)} 张代表帧，请生成全局清单。"
    return await _call_llm_vision_json(config, system_prompt, user_text, representative_images, max_tokens=6000)


async def llm_label_batch(config: dict, batch: list, overview: dict, plot: str = "") -> dict:
    """单批帧标注。batch 每项 {b64,label,index,timestamp}。
    返回：{frames:[...], camera_summary:"本批运镜摘要", script_fragment:"本批剧情片段"}
    """
    overview_text = json.dumps(overview, ensure_ascii=False, indent=2)
    plot_block = f"\n【原始剧情参考（用于理解画面语境）】\n{plot[:1500]}\n" if plot else ""
    system_prompt = f"""你是一位专业影视分析师。全局清单如下（标注务必对齐）：

【全局清单】
{overview_text}
{plot_block}
请处理本批连续的 {len(batch)} 张关键帧。输出两部分：

1) frames：逐帧结构化标注
   - shot_type：{"|".join(_SHOT_TYPES)}
   - transition_hint：{"|".join(_TRANSITION_HINTS)}（只在画面有明显转场才用非 none 值）
   - quality：clear | motion_blur | uncertain
   - content：一句话画面描述（≤40 字，主体 + 动作 + 情绪）
   - subtitle：画面中字幕或推测对白（无则空串 ""）

2) camera_summary：综合本批连续帧判断的运镜摘要（≤60 字），描述镜头运动与切换。
   例："起幅中景切特写，镜头缓慢推近人物面部；末尾切到对角线角度中景"；
   涉及运镜动作：推/拉/摇/移/跟/升降/变焦/静止，镜头切换：cut/dissolve/fade 等。

3) script_fragment：本批对应的剧情片段（连贯叙事，50~120 字），整合画面动作+字幕对白+情绪，为后续"剧本演绎"节点提供原料。

特别说明：送入的图片顺序与下方"原始 index 列表"顺序**严格一致**。请**严格按照图片顺序**输出 frames，**不要改变顺序**，index 字段也按此顺序回填原始视频帧序号。

只输出 JSON：
{{
  "frames":[{{"index":0,"shot_type":"medium","transition_hint":"none","content":"...","subtitle":"","quality":"clear"}}],
  "camera_summary":"本批运镜综述",
  "script_fragment":"本批剧情叙事片段"
}}"""
    index_list = ", ".join(str(img["index"]) for img in batch)
    user_text = f"本批共 {len(batch)} 张帧，**按送入顺序**对应的原始 index 序列为：{index_list}。请严格按此顺序逐帧标注，并补出本批的运镜摘要和剧情片段。"
    return await _call_llm_vision_json(config, system_prompt, user_text, batch, max_tokens=10000)


@router.post("/generate/frame-label")
async def gen_frame_label(body: dict):
    """
    Round 1：对所有候选关键帧做标注（shot_type / transition_hint / content / subtitle / quality）。
    先生成 overview（每个 scene_group 一张代表帧，≤12 张），再分批并发标注。
    结果落盘到 frame_labels.json。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    # 若 body 没给 frames，从 keyframes.json 读
    frames_in = body.get("frames") or []
    if not frames_in:
        kf_path = os.path.join(wf_dir, "keyframes.json")
        if os.path.isfile(kf_path):
            try:
                frames_in = json.load(open(kf_path, "r", encoding="utf-8")).get("frames", [])
            except Exception:
                frames_in = []
    if not frames_in:
        raise HTTPException(status_code=400, detail="未提供帧列表且未找到 keyframes.json")

    batch_size = max(1, int(body.get("batch_size", 6)))
    max_concurrent = max(1, int(body.get("max_concurrent", 3)))
    skip_overview = bool(body.get("skip_overview", False))
    plot = (body.get("plot") or "").strip()
    max_retries = max(0, int(body.get("max_retries", 2)))

    # 加载图片 base64
    images = []
    for f in frames_in:
        url = f.get("url", "") if isinstance(f, dict) else str(f)
        idx = f.get("index", 0) if isinstance(f, dict) else 0
        ts = f.get("timestamp", 0.0) if isinstance(f, dict) else 0.0
        scene_group = f.get("scene_group", -1) if isinstance(f, dict) else -1
        b64 = _load_ref_image_b64(url)
        if b64:
            images.append({
                "b64": b64, "label": f"idx={idx}",  # 醒目的视觉锚点
                "index": idx, "timestamp": ts, "scene_group": scene_group,
            })
    if not images:
        raise HTTPException(status_code=400, detail="无法加载关键帧图片")

    # overview：每个 scene_group 取第一张，最多 12 张
    overview: dict = {"characters": [], "scenes": [], "narrative": ""}
    if not skip_overview:
        seen_groups = set()
        overview_imgs = []
        for img in images:
            g = img.get("scene_group", -1)
            if g not in seen_groups:
                seen_groups.add(g)
                overview_imgs.append(img)
            if len(overview_imgs) >= 12:
                break
        if not overview_imgs:
            overview_imgs = images[:12]
        try:
            overview = await _retry_async(
                lambda: llm_label_overview(config, overview_imgs, plot=plot),
                max_retries=max_retries, label="frame-label overview",
            )
        except Exception as e:
            print(f"[frame-label] overview 最终失败，继续分批: {e}")
            overview = {"characters": [], "scenes": [], "narrative": ""}

    # 分批并发标注
    batches = [images[s:s + batch_size] for s in range(0, len(images), batch_size)]
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _run(batch):
        async with semaphore:
            try:
                batch_label = f"frame-label batch idx={batch[0]['index']}~{batch[-1]['index']}"
                r = await _retry_async(
                    lambda: llm_label_batch(config, batch, overview, plot=plot),
                    max_retries=max_retries, label=batch_label,
                )
                # 强制按顺序回填 index（不信任 LLM 填的 index 字段）
                returned = r.get("frames") or []
                normalized = []
                for i, img in enumerate(batch):
                    src = returned[i] if i < len(returned) else {}
                    normalized.append({
                        **src,
                        "index": img["index"],
                        "timestamp": img["timestamp"],
                    })
                return {
                    "frames": normalized,
                    "batch_meta": {
                        "start_index": batch[0]["index"],
                        "end_index": batch[-1]["index"],
                        "start_ts": batch[0]["timestamp"],
                        "end_ts": batch[-1]["timestamp"],
                        "camera_summary": (r.get("camera_summary") or "")[:200],
                        "script_fragment": (r.get("script_fragment") or "")[:600],
                    },
                }
            except Exception as e:
                print(f"[frame-label] 批次最终失败（已重试 {max_retries} 次）: {e}")
                return {
                    "frames": [{
                        "index": img["index"], "timestamp": img["timestamp"],
                        "shot_type": "medium", "transition_hint": "none",
                        "content": "", "subtitle": "",
                        "quality": "uncertain", "error": str(e)[:200],
                    } for img in batch],
                    "batch_meta": {
                        "start_index": batch[0]["index"],
                        "end_index": batch[-1]["index"],
                        "start_ts": batch[0]["timestamp"],
                        "end_ts": batch[-1]["timestamp"],
                        "camera_summary": "",
                        "script_fragment": "",
                        "error": str(e)[:200],
                    },
                }

    batch_results = await asyncio.gather(*[_run(b) for b in batches])

    all_frames = []
    batch_metas = []
    for r in batch_results:
        all_frames.extend(r.get("frames", []))
        if r.get("batch_meta"):
            batch_metas.append(r["batch_meta"])

    # 枚举值兜底
    for f in all_frames:
        if f.get("shot_type") not in _SHOT_TYPES:
            f["shot_type"] = "medium"
        if f.get("transition_hint") not in _TRANSITION_HINTS:
            f["transition_hint"] = "none"
        if f.get("quality") not in ("clear", "motion_blur", "uncertain"):
            f["quality"] = "uncertain"
        f["content"] = (f.get("content") or "")[:80]
        f["subtitle"] = f.get("subtitle") or ""

    all_frames.sort(key=lambda x: x.get("index", 0))
    batch_metas.sort(key=lambda x: x.get("start_index", 0))

    result = {"overview": overview, "frames": all_frames, "batches": batch_metas}
    try:
        with open(os.path.join(wf_dir, "frame_labels.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  Round 1.5：剧本演绎（把帧标注的批级剧本片段合成连贯剧本并分段）
# ═══════════════════════════════════════════════════

async def llm_script_compose(config: dict, batches: list, duration: float, plot: str = "") -> dict:
    """
    输入：batches = [{start_index,end_index,start_ts,end_ts,camera_summary,script_fragment}]
    输出：{full_script}  ——只产出整篇连贯剧本文本，不再分段。
    """
    raw_lines = []
    for i, b in enumerate(batches):
        raw_lines.append(
            f"[批{i} | idx {b['start_index']}-{b['end_index']} | "
            f"{b['start_ts']:.1f}s-{b['end_ts']:.1f}s]\n"
            f"  运镜: {b.get('camera_summary','')}\n"
            f"  片段: {b.get('script_fragment','')}"
        )
    raw_text = "\n\n".join(raw_lines) if raw_lines else "（无批标注）"
    plot_block = f"\n【原始剧情参考】\n{plot[:1500]}\n" if plot else ""

    system_prompt = f"""你是一位影视剧本撰写师。已有一份按批次记录的原视频帧序列笔记（见下方，每批包含运镜摘要+剧情片段）。

任务：把所有批次合并为**一份连贯完整的剧本演绎文本**，**不要分段**，直接输出整篇。
要求：
1. 整片视频总时长约 {duration:.0f} 秒，按时间顺序叙述。
2. 文本要连贯，整合动作、对白、情绪与运镜，避免碎片化。
3. 字数 600~2500 字，长度按视频时长酌情。
4. 必要时可用空行划分自然段，但不要给段编号、不要输出 segments 列表。
{plot_block}
只输出 JSON：
{{
  "full_script":"整片剧本文本（一大段，可含自然分段空行）"
}}"""
    user_text = f"视频总时长 {duration:.2f}s。原始批次笔记：\n\n{raw_text}"
    return await _call_llm_json(config, system_prompt, user_text, max_tokens=12000, timeout=420.0)


@router.post("/generate/script")
async def gen_script(body: dict):
    """
    Round 1.5：基于 frame_labels.batches 合成完整剧本并分段。
    输入：{workflow_id, chat_config_id, max_retries?}
    输出：{full_script} 写入 script.json。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    fl_path = os.path.join(wf_dir, "frame_labels.json")
    if not os.path.isfile(fl_path):
        raise HTTPException(status_code=400, detail="未找到 frame_labels.json，请先运行帧标注")
    try:
        fl = json.load(open(fl_path, "r", encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取 frame_labels.json 失败: {e}")

    batches = fl.get("batches") or []
    if not batches:
        raise HTTPException(status_code=400, detail="frame_labels.json 中无批次数据，请重新运行帧标注（新版会产出 batches）")

    # 获取视频时长
    duration = 0.0
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            duration = float(json.load(open(kf_path, "r", encoding="utf-8")).get("duration", 0.0))
        except Exception:
            pass
    if duration <= 0:
        duration = max((b.get("end_ts", 0.0) for b in batches), default=0.0) + 2.0

    # 拿原始剧情作为参考
    plot = ""
    wf_state_path = os.path.join(wf_dir, "state.json")
    if os.path.isfile(wf_state_path):
        try:
            st = json.load(open(wf_state_path, "r", encoding="utf-8"))
            # workflow state 中读取 input.plot
            wfs = st.get("workflows") if isinstance(st, dict) else None
            if isinstance(wfs, list):
                for w in wfs:
                    if w.get("id") == wf_id:
                        plot = (w.get("input") or {}).get("plot", "") or ""
                        break
        except Exception:
            pass
    plot = body.get("plot") or plot

    max_retries = max(0, int(body.get("max_retries", 2)))
    try:
        raw = await _retry_async(
            lambda: llm_script_compose(config, batches, duration, plot=plot),
            max_retries=max_retries, label="script",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"剧本合成失败: {e}")

    result = {"full_script": raw.get("full_script") or ""}
    try:
        with open(os.path.join(wf_dir, "script.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  Round 2：智能分段（纯关键帧视觉判转场）
#  职责：直接看关键帧缩略图判断画面切换点，输出段边界。
#        不依赖 script.json / rewrite_plot.json。
# ═══════════════════════════════════════════════════

async def llm_detect_cuts_in_batch(
    config: dict,
    batch_frames: list,  # [{index, timestamp, b64}]
) -> list:
    """
    输入一批关键帧（按时间顺序，<=80 张），让视觉 LLM 输出哪些 index 是转场点
    （即"和上一帧画面差异显著、属于新场景的开端"）。
    返回：[{index:int, kind:str, reason?:str}]，kind ∈ cut/fade/dissolve/match_cut。
    第一帧不算转场点（开场默认是新场景）。
    """
    if not batch_frames:
        return []
    images = [
        {"b64": f["b64"], "label": f"idx={f['index']} t={f['timestamp']:.1f}s"}
        for f in batch_frames if f.get("b64")
    ]
    if not images:
        return []
    idx_list = [f["index"] for f in batch_frames if f.get("b64")]
    system_prompt = """你是一位专业影视剪辑师。下面给你一批按时间顺序的关键帧缩略图，每张图带 idx 标签。

任务：找出**新场景开端**的帧（即与前一帧相比画面切换明显的位置）。
- 同机位的小幅运动/对话切镜虽有差别但属于"同一场景延续"，不算转场。
- 切到完全不同的地点/构图/角色组合 → cut。
- 渐变黑/渐变白 → fade。叠化 → dissolve。配对剪辑 → match_cut。
- 第一张缩略图不算转场点。

只输出 JSON：
{
  "cuts": [
    {"index": 12, "kind": "cut", "reason": "从室内对话切到室外街景"}
  ]
}
没有转场就输出 {"cuts": []}。"""
    user_text = f"本批共 {len(images)} 张关键帧，idx 序列：{idx_list}。请按时间顺序判断哪些 idx 是新场景开端。"
    res = await _call_llm_vision_json(config, system_prompt, user_text, images, max_tokens=4000, timeout=240.0)
    cuts = res.get("cuts") or []
    valid = set(idx_list)
    out = []
    for c in cuts:
        try:
            i = int(c.get("index"))
        except (TypeError, ValueError):
            continue
        if i not in valid:
            continue
        out.append({"index": i, "kind": (c.get("kind") or "cut")[:20], "reason": (c.get("reason") or "")[:80]})
    return out


async def detect_cuts_all_frames(
    config: dict,
    keyframes: list,  # [{index, timestamp, url}]
    batch_size: int = 80,
    overlap: int = 4,
) -> list:
    """
    把所有关键帧按 batch_size 切批送视觉 LLM 判转场，相邻批保留 overlap 帧重叠以避免漏判跨批转场。
    返回：去重后的 cut idx 列表（升序）。
    """
    if not keyframes:
        return []
    frames = []
    for f in keyframes:
        url = f.get("url") or ""
        b = _load_thumbnail_b64(url, max_dim=256, quality=70) if url else ""
        if not b:
            continue
        frames.append({"index": int(f.get("index", 0)), "timestamp": float(f.get("timestamp", 0.0)), "b64": b})
    if not frames:
        return []
    frames.sort(key=lambda x: x["index"])

    cut_set = set()
    n = len(frames)
    step = max(1, batch_size - overlap)
    i = 0
    while i < n:
        batch = frames[i: i + batch_size]
        if not batch:
            break
        try:
            cuts = await llm_detect_cuts_in_batch(config, batch)
        except Exception as e:
            print(f"[smart-segment] batch [{i},{i+len(batch)}) detect failed: {str(e)[:120]}")
            cuts = []
        first_idx_in_batch = batch[0]["index"] if batch else None
        for c in cuts:
            if first_idx_in_batch is not None and c["index"] == first_idx_in_batch:
                continue
            cut_set.add(c["index"])
        if i + batch_size >= n:
            break
        i += step
    return sorted(cut_set)


def _build_segments_from_cuts(
    keyframes: list,
    cut_indices: list,
    duration: float,
    min_sec: int = 7,
    max_sec: int = 15,
) -> list:
    """
    根据视觉识别出的 cut 帧 idx 列表构建 segments，强制每段满足：
    - min_sec <= 段长 <= max_sec
    - start / end / duration 均为整数秒
    流程：
    1) 按 cut 形成 raw 浮点段
    2) 合并过短段（< min_sec）到相邻较短一侧
    3) 拆分过长段（> max_sec）：均匀切，每块仍 >= min_sec
    4) 整数化每段时长，保证 sum == round(duration)，每段 in [min_sec, max_sec]
    5) 累加成 boundary 后回填关键帧
    """
    if not keyframes:
        return []

    min_sec = max(1, int(min_sec))
    max_sec = max(min_sec, int(max_sec))

    kfs = sorted(keyframes, key=lambda f: int(f.get("index", 0)))
    ts_by_idx = {int(f.get("index", 0)): float(f.get("timestamp", 0.0)) for f in kfs}
    all_idx = [int(f.get("index", 0)) for f in kfs]
    first_idx = all_idx[0]

    cuts = sorted(set(int(c) for c in cut_indices if int(c) != first_idx))
    boundaries = [first_idx] + cuts

    raw = []
    for k, b_idx in enumerate(boundaries):
        s = ts_by_idx.get(b_idx, 0.0)
        if k + 1 < len(boundaries):
            e = ts_by_idx.get(boundaries[k + 1], s)
        else:
            e = duration if duration > 0 else (kfs[-1].get("timestamp", s) + 1.0)
        if e <= s:
            e = s + 0.1
        raw.append([float(s), float(e)])
    if raw:
        raw[-1][1] = max(float(duration), raw[-1][1])

    total = int(round(duration)) if duration > 0 else int(round(raw[-1][1]))
    total = max(1, total)

    if total < min_sec:
        return [{
            "index": 0,
            "start": 0,
            "end": total,
            "duration": total,
            "seconds": total,
            "frame_indices": sorted(set(all_idx)),
            "transitions": {"in": "none", "out": "none"},
            "theme": "",
            "characters_in_scene": [],
        }]

    def _dur(s):
        return s[1] - s[0]

    # 合并过短段
    changed = True
    while changed and len(raw) > 1:
        changed = False
        for i in range(len(raw)):
            if _dur(raw[i]) < min_sec - 1e-6:
                if i == 0:
                    target = 1
                elif i == len(raw) - 1:
                    target = len(raw) - 2
                else:
                    target = i - 1 if _dur(raw[i - 1]) <= _dur(raw[i + 1]) else i + 1
                a, b = sorted([i, target])
                raw = raw[:a] + [[raw[a][0], raw[b][1]]] + raw[b + 1:]
                changed = True
                break

    # 拆分过长段
    split_out = []
    for s in raw:
        d = _dur(s)
        if d <= max_sec + 1e-6:
            split_out.append(s)
            continue
        n_split = math.ceil(d / max_sec)
        n_split = min(n_split, max(1, int(d // min_sec)))
        if n_split < 2:
            split_out.append(s)
            continue
        chunk = d / n_split
        st = s[0]
        for k in range(n_split):
            ed = s[1] if k == n_split - 1 else st + chunk
            split_out.append([st, ed])
            st = ed
    raw = split_out
    n = len(raw)

    # 整数化时长
    durs = [max(min_sec, min(max_sec, int(round(_dur(s))))) for s in raw]
    diff = total - sum(durs)

    safety = 4 * n + 20
    while diff != 0 and safety > 0:
        safety -= 1
        if diff > 0:
            cands = [i for i, d in enumerate(durs) if d < max_sec]
            if not cands:
                break
            i = max(cands, key=lambda x: durs[x])
            durs[i] += 1
            diff -= 1
        else:
            cands = [i for i, d in enumerate(durs) if d > min_sec]
            if not cands:
                break
            i = max(cands, key=lambda x: durs[x])
            durs[i] -= 1
            diff += 1

    # diff > 0：段数不够（n * max_sec < total），补段
    while diff > 0:
        take = min(max_sec, diff)
        if take < min_sec and durs and durs[-1] + take <= max_sec:
            durs[-1] += take
        else:
            durs.append(max(min_sec, take))
        diff -= take
    # diff < 0：段数过多（n * min_sec > total），合并末段
    while diff < 0 and len(durs) > 1:
        last = durs.pop()
        durs[-1] = min(max_sec, durs[-1] + last)
        diff = total - sum(durs)
        if durs[-1] > max_sec:
            extra = durs[-1] - max_sec
            durs[-1] = max_sec
            durs.append(max(min_sec, extra))

    bs = [0]
    for d in durs:
        bs.append(bs[-1] + d)
    n = len(bs) - 1

    # 兜底：若最后一帧 ts 超出最后一段 end，则把最后一段拉长把它包进去。
    # 这种情况发生在 duration 与关键帧实际时间范围不一致时（例如关键帧抽到了 170s
    # 但 duration 标的 100s）。否则后面的帧会在区间筛选时全部被丢。
    last_ts = max(ts_by_idx.values()) if ts_by_idx else 0.0
    if last_ts >= bs[-1]:
        bs[-1] = int(math.ceil(last_ts)) + 1

    out = []
    for i in range(n):
        st = bs[i]
        ed = bs[i + 1]
        is_last = i == n - 1
        # 区间：[st, ed)；最后一段闭区间 [st, ed] 以确保末帧能落入
        if is_last:
            seg_indices = [idx for idx in all_idx if ts_by_idx[idx] >= st - 1e-6 and ts_by_idx[idx] <= ed + 1e-6]
        else:
            seg_indices = [idx for idx in all_idx if ts_by_idx[idx] >= st - 1e-6 and ts_by_idx[idx] < ed - 1e-6]
        if not seg_indices:
            closest = min(all_idx, key=lambda x: abs(ts_by_idx[x] - (st + ed) / 2.0))
            seg_indices = [closest]
        out.append({
            "index": i,
            "start": st,
            "end": ed,
            "duration": ed - st,
            "seconds": ed - st,
            "frame_indices": sorted(set(seg_indices)),
            "transitions": {"in": "cut" if i > 0 else "none", "out": "cut" if i < n - 1 else "none"},
            "theme": "",
            "characters_in_scene": [],
        })
    return out


@router.post("/generate/smart-segment")
async def gen_smart_segment(body: dict):
    """
    Round 2：直接基于关键帧视觉判转场分段，不依赖剧本演绎/剧情重编排。
    输入 body: {workflow_id, chat_config_id, batch_size?, min_sec?, max_sec?}
    输出写入 segments.json。每段时长强制为整数秒，且 min_sec <= 段长 <= max_sec。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    min_sec = int(body.get("min_sec", 7))
    max_sec = int(body.get("max_sec", 15))
    batch_size = int(body.get("batch_size", 80))

    duration = float(body.get("duration", 0.0))
    keyframes_list: list = []
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            kf_data = json.load(open(kf_path, "r", encoding="utf-8"))
            keyframes_list = kf_data.get("frames", [])
            if duration <= 0:
                duration = float(kf_data.get("duration", 0.0))
        except Exception:
            pass
    if not keyframes_list:
        raise HTTPException(status_code=400, detail="未找到关键帧（请先运行关键帧提取）")
    if duration <= 0:
        duration = float(keyframes_list[-1].get("timestamp", 0.0)) + 1.0

    try:
        cut_indices = await detect_cuts_all_frames(
            config, keyframes_list,
            batch_size=batch_size, overlap=4,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"智能分段（视觉判转场）失败: {e}")

    segments = _build_segments_from_cuts(
        keyframes_list, cut_indices, duration,
        min_sec=min_sec, max_sec=max_sec,
    )

    result = {
        "segments": segments,
        "constraints": {"min_sec": min_sec, "max_sec": max_sec, "batch_size": batch_size},
        "cut_indices": cut_indices,
    }
    try:
        with open(os.path.join(wf_dir, "segments.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/review-segment")
async def gen_review_segment(body: dict):
    """
    本地校验智能分段结果：检查段长是否在 [min_sec, max_sec] 内并为整数秒。
    """
    segments = body.get("segments") or []
    if not segments:
        raise HTTPException(status_code=400, detail="缺少 segments")
    min_sec = int(body.get("min_sec", 7))
    max_sec = int(body.get("max_sec", 15))

    issues = []
    for seg in segments:
        i = int(seg.get("index", 0))
        dur = float(seg.get("duration", 0.0))
        if abs(dur - round(dur)) > 1e-6:
            issues.append({"index": i, "severity": "error", "reason": f"段长 {dur} 不是整数秒"})
        if dur < min_sec - 1e-6:
            issues.append({"index": i, "severity": "error", "reason": f"段长 {dur:.0f}s 低于下限 {min_sec}s"})
        elif dur > max_sec + 1e-6:
            issues.append({"index": i, "severity": "error", "reason": f"段长 {dur:.0f}s 超过上限 {max_sec}s"})

    ok = not any(i.get("severity") == "error" for i in issues)
    return JSONResponse({"code": 0, "data": {
        "ok": ok,
        "summary": ("分段合理" if ok else f"存在不在 [{min_sec},{max_sec}]s 范围内或非整数的段"),
        "issues": issues,
    }})


# ═══════════════════════════════════════════════════
#  关键帧补采：段内帧数不足时抽帧补齐，保证 4/6/9 宫格的可选下限
# ═══════════════════════════════════════════════════

def _ensure_window_density(
    video_path: str,
    workflow_id: str,
    window_sec: float = 10.0,
    stride_sec: float = 5.0,
    target_per_window: int = 9,
) -> int:
    """
    保证视频里任意一个 window_sec 长度的窗口内关键帧数 >= target_per_window。
    用 stride_sec 步长滑动扫描，密度不足的窗口均匀补帧。
    返回总共新增的帧数。直接读写 keyframes.json，不返回 frames 列表。
    """
    wf_dir = get_workflow_dir(workflow_id)
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if not os.path.isfile(kf_path):
        return 0
    try:
        kf_data = json.load(open(kf_path, "r", encoding="utf-8"))
    except Exception:
        return 0
    frames = list(kf_data.get("frames") or [])
    duration = float(kf_data.get("duration", 0.0))
    if duration <= 0:
        if not frames:
            return 0
        duration = max(float(f.get("timestamp", 0.0)) for f in frames) + 1.0

    fps = kf_data.get("fps")
    if not fps:
        try:
            from backend.core.video_processor import get_video_metadata
            fps = get_video_metadata(video_path).get("fps")
        except Exception:
            fps = None

    timestamps_sorted = sorted(float(f.get("timestamp", 0.0)) for f in frames)

    def _count_in(lo: float, hi: float) -> int:
        # 二分计数 [lo, hi)
        import bisect
        l = bisect.bisect_left(timestamps_sorted, lo - 1e-6)
        r = bisect.bisect_left(timestamps_sorted, hi - 1e-6)
        return r - l

    # 收集需要补帧的窗口（按 lo 升序、不重叠的目标时间集合）
    pending_picks: list = []  # [(target_t, source_window_idx)]
    win_idx = 0
    lo = 0.0
    while lo < duration:
        hi = min(duration, lo + window_sec)
        # 末尾残窗（< window_sec 一半且不是起点）跳过：和上一个滑动窗口高度重叠
        if hi - lo < window_sec * 0.5 + 1e-6 and lo > 0:
            break
        existing = _count_in(lo, hi)
        if existing < target_per_window:
            need = target_per_window - existing
            # 在 (lo, hi) 内均匀生成 need 个时间点，避免与现有点过近
            pad = max(0.05, (hi - lo) * 0.03)
            a = lo + pad
            b = hi - pad
            # 以 (need + 1) 等分取内部 need 个点
            picks = [a + (b - a) * (i + 1) / (need + 1) for i in range(need)]
            for t in picks:
                # 与已有 timestamps 太近的剔除（< 0.25s）
                import bisect
                pos = bisect.bisect_left(timestamps_sorted, t)
                near = False
                for j in (pos - 1, pos):
                    if 0 <= j < len(timestamps_sorted) and abs(timestamps_sorted[j] - t) < 0.25:
                        near = True
                        break
                if not near:
                    pending_picks.append((round(t, 3), win_idx))
        win_idx += 1
        lo += stride_sec

    if not pending_picks:
        return 0

    # 多窗口可能产生重叠候选点，做一次去重（精度 0.25s）
    pending_picks.sort(key=lambda x: x[0])
    deduped: list = []
    for t, _wi in pending_picks:
        if deduped and abs(deduped[-1] - t) < 0.25:
            continue
        deduped.append(t)
    if not deduped:
        return 0

    try:
        from backend.core.video_processor import dump_candidate_frames
        supplement_dir = os.path.join(wf_dir, "keyframes")
        os.makedirs(supplement_dir, exist_ok=True)
        dumped = dump_candidate_frames(
            video_path, deduped, supplement_dir, fps=fps,
            naming="supp_density_%04d.jpg",
        )
    except Exception as e:
        print(f"[density-supplement] dump_candidate_frames 失败: {e}")
        return 0

    if not dumped:
        return 0

    max_idx = max((int(f.get("index", -1)) for f in frames), default=-1)
    added: list = []
    for d in dumped:
        max_idx += 1
        added.append({
            "index": max_idx,
            "timestamp": round(float(d.get("timestamp", 0.0)), 3),
            "filename": d.get("filename"),
            "path": d.get("path"),
            "url": f"/workflow-images/{workflow_id}/keyframes/{d.get('filename')}",
            "is_supplement": True,
            "scene_group": -1,
            "sharpness": -1.0,
            "reason": "density_window",
        })

    merged = list(frames) + added
    merged.sort(key=lambda f: float(f.get("timestamp", 0.0)))
    kf_data["frames"] = merged
    try:
        with open(kf_path, "w", encoding="utf-8") as f:
            json.dump(kf_data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    print(f"[density-supplement] 补帧 {len(added)} 张（10s 窗口、步长 5s、目标 {target_per_window}）")
    return len(added)


@router.post("/supplement-frames/{workflow_id}")
async def supplement_frames(workflow_id: str, body: dict):
    """
    在指定 [segment_start, segment_end] 内均匀抽 target 张帧，写入 keyframes 目录并 merge 到 keyframes.json。
    入参：{segment_start, segment_end, target, segment_index?}
    返回：{added_frames: [{index,timestamp,url,filename}], frames: <merged all frames>}
    """
    if not check_ffmpeg():
        raise HTTPException(status_code=503, detail="ffmpeg 未安装，无法补采关键帧")

    wf_dir = get_workflow_dir(workflow_id)
    video_dir = os.path.join(wf_dir, "videos")
    video_path = None
    for ext in VIDEO_EXTENSIONS:
        candidate = os.path.join(video_dir, f"source{ext}")
        if os.path.isfile(candidate):
            video_path = candidate
            break
    if not video_path:
        raise HTTPException(status_code=400, detail="未找到已上传的视频文件")

    try:
        seg_start = float(body.get("segment_start", 0.0))
        seg_end = float(body.get("segment_end", 0.0))
        target = max(1, int(body.get("target", 4)))
    except Exception:
        raise HTTPException(status_code=400, detail="segment_start/segment_end/target 参数非法")
    if seg_end <= seg_start:
        raise HTTPException(status_code=400, detail="segment_end 必须大于 segment_start")
    seg_idx = body.get("segment_index")

    # 读现有 keyframes
    kf_path = os.path.join(wf_dir, "keyframes.json")
    kf_data: dict = {}
    frames: list = []
    if os.path.isfile(kf_path):
        try:
            kf_data = json.load(open(kf_path, "r", encoding="utf-8"))
            frames = list(kf_data.get("frames") or [])
        except Exception:
            kf_data = {}
            frames = []

    try:
        from backend.core.video_processor import dump_candidate_frames, get_video_metadata
        fps = kf_data.get("fps") or get_video_metadata(video_path).get("fps")
    except Exception:
        fps = None

    # 段内已存在的 timestamps，避免重复
    existing_ts = sorted(
        float(f.get("timestamp", 0.0))
        for f in frames
        if seg_start - 0.05 <= float(f.get("timestamp", 0.0)) <= seg_end + 0.05
    )
    # 均匀生成 target 个时间点；向内缩 5% 避免刚好踩在切点
    pad = max(0.05, (seg_end - seg_start) * 0.03)
    lo = seg_start + pad
    hi = seg_end - pad
    if target == 1:
        picks = [(lo + hi) / 2]
    else:
        step = (hi - lo) / (target - 1) if target > 1 else 0
        picks = [lo + i * step for i in range(target)]

    # 和已有帧去重（差 < 0.25s 认为重复）
    def _near_existing(t: float) -> bool:
        for e in existing_ts:
            if abs(e - t) < 0.25:
                return True
        return False
    picks = [round(t, 3) for t in picks if not _near_existing(t)]

    supplement_dir = os.path.join(wf_dir, "keyframes")
    os.makedirs(supplement_dir, exist_ok=True)
    seg_tag = f"s{int(seg_idx)}" if seg_idx is not None else "sx"
    naming = f"supp_{seg_tag}_%04d.jpg"

    added: list = []
    if picks:
        try:
            dumped = dump_candidate_frames(video_path, picks, supplement_dir, fps=fps, naming=naming)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"补采失败: {e}")
        max_idx = max((int(f.get("index", -1)) for f in frames), default=-1)
        for d in dumped:
            max_idx += 1
            added.append({
                "index": max_idx,
                "timestamp": round(float(d.get("timestamp", 0.0)), 3),
                "filename": d.get("filename"),
                "path": d.get("path"),
                "url": f"/workflow-images/{workflow_id}/keyframes/{d.get('filename')}",
                "is_supplement": True,
                "scene_group": seg_idx if seg_idx is not None else -1,
            })

    merged_frames = list(frames) + added
    merged_frames.sort(key=lambda f: float(f.get("timestamp", 0.0)))
    kf_data["frames"] = merged_frames
    try:
        with open(kf_path, "w", encoding="utf-8") as f:
            json.dump(kf_data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": {"added_frames": added, "frames": merged_frames}})


# ═══════════════════════════════════════════════════
#  宫格合成：把 N 张同比例图按 rows×cols 拼成一张大图，长边控制在 [2048, 4096]
# ═══════════════════════════════════════════════════

def _rows_cols_for_count(n: int) -> tuple:
    """根据格子数返回 (rows, cols)：4→2x2 / 6→2x3 / 9→3x3；其他向上兼容。"""
    if n <= 4:
        return 2, 2
    if n <= 6:
        return 2, 3
    if n <= 9:
        return 3, 3
    # 兜底：接近正方
    import math
    cols = int(math.ceil(math.sqrt(n)))
    rows = int(math.ceil(n / cols))
    return rows, cols


def _url_to_local_path(image_url: str) -> str:
    if not image_url or not image_url.startswith("/workflow-images/"):
        return ""
    rel = image_url.replace("/workflow-images/", "", 1)
    path = os.path.join(WORKFLOW_ROOT, rel)
    return path if os.path.isfile(path) else ""


def _clamp_long_edge(size: tuple, min_edge: int = 2048, max_edge: int = 4096) -> tuple:
    """给定 (w,h)，返回调整后 (w,h)：长边超过 max_edge 等比缩到 max_edge；不足 min_edge 等比放到 min_edge。"""
    w, h = size
    if w <= 0 or h <= 0:
        return size
    long_edge = max(w, h)
    if long_edge > max_edge:
        k = max_edge / long_edge
    elif long_edge < min_edge:
        k = min_edge / long_edge
    else:
        return w, h
    return max(1, int(round(w * k))), max(1, int(round(h * k)))


def _compose_grid_core(
    workflow_id: str, segment_index: int, frame_urls: list, rows: int, cols: int,
    out_subdir: str = "grid_composed", filename_prefix: str = "seg",
    min_long_edge: int = 2048, max_long_edge: int = 4096,
) -> dict:
    """
    把 frame_urls 按 rows×cols 拼成一张大图，落盘，返回 {url,width,height,cell_w,cell_h,rows,cols,urls}。
    同比例保证：以第一张图的 aspect 为基准，其余用 ImageOps.fit 同比例裁切后再贴。
    """
    from PIL import Image, ImageOps
    import io

    paths = []
    for u in frame_urls:
        p = _url_to_local_path(u)
        if not p:
            raise HTTPException(status_code=400, detail=f"帧 URL 无效或文件缺失: {u}")
        paths.append(p)
    if not paths:
        raise HTTPException(status_code=400, detail="frame_urls 为空")
    if rows * cols < len(paths):
        raise HTTPException(status_code=400, detail=f"rows*cols={rows*cols} 小于帧数 {len(paths)}")

    imgs = []
    for p in paths:
        im = Image.open(p)
        if im.mode != "RGB":
            im = im.convert("RGB")
        imgs.append(im)

    # 以第一张作为基准比例
    base_w, base_h = imgs[0].size
    aspect = base_w / base_h if base_h else 1.0

    # 统一单格尺寸：取各图宽/高的中位
    ws = sorted(im.size[0] for im in imgs)
    hs = sorted(im.size[1] for im in imgs)
    cell_w = ws[len(ws) // 2]
    cell_h = hs[len(hs) // 2]
    # 对齐基准比例
    if abs((cell_w / cell_h) - aspect) > 0.02:
        cell_h = max(1, int(round(cell_w / aspect)))

    # 初步画布尺寸
    total_w = cell_w * cols
    total_h = cell_h * rows

    # 缩放 cell 让长边落入目标范围
    target_w, target_h = _clamp_long_edge((total_w, total_h), min_long_edge, max_long_edge)
    if (target_w, target_h) != (total_w, total_h):
        cell_w = max(1, target_w // cols)
        cell_h = max(1, target_h // rows)
        total_w = cell_w * cols
        total_h = cell_h * rows

    canvas = Image.new("RGB", (total_w, total_h), (0, 0, 0))
    for i, im in enumerate(imgs):
        r = i // cols
        c = i % cols
        # 同比例裁切 → 目标 cell 尺寸
        fitted = ImageOps.fit(im, (cell_w, cell_h), method=Image.LANCZOS, centering=(0.5, 0.5))
        canvas.paste(fitted, (c * cell_w, r * cell_h))

    # 落盘
    out_dir = os.path.join(get_workflow_dir(workflow_id), out_subdir)
    os.makedirs(out_dir, exist_ok=True)
    filename = f"{filename_prefix}_{int(segment_index)}.jpg"
    out_path = os.path.join(out_dir, filename)
    # 长边再 clamp 一次（防御性）
    final_w, final_h = _clamp_long_edge(canvas.size, min_long_edge, max_long_edge)
    if (final_w, final_h) != canvas.size:
        canvas = canvas.resize((final_w, final_h), Image.LANCZOS)
    canvas.save(out_path, format="JPEG", quality=85, optimize=True)

    return {
        "url": f"/workflow-images/{workflow_id}/{out_subdir}/{filename}",
        "filename": filename,
        "width": canvas.size[0],
        "height": canvas.size[1],
        "cell_w": cell_w,
        "cell_h": cell_h,
        "rows": rows,
        "cols": cols,
        "urls": list(frame_urls),
    }


@router.post("/compose-grid/{workflow_id}")
async def compose_grid_api(workflow_id: str, body: dict):
    """
    入参：{segments: [{index, frame_urls, rows?, cols?}]}；缺 rows/cols 时按数量推导。
    返回：{segments: [{index, url, width, height, cell_w, cell_h, rows, cols, urls}]}
    """
    segs_in = body.get("segments") or []
    if not segs_in:
        raise HTTPException(status_code=400, detail="缺少 segments")
    out_segs = []
    for s in segs_in:
        idx = int(s.get("index", 0))
        urls = s.get("frame_urls") or s.get("urls") or []
        if not urls:
            out_segs.append({"index": idx, "error": "no_frames"})
            continue
        rows = int(s.get("rows") or 0)
        cols = int(s.get("cols") or 0)
        if rows <= 0 or cols <= 0:
            rows, cols = _rows_cols_for_count(len(urls))
        try:
            r = _compose_grid_core(workflow_id, idx, urls, rows, cols)
            r["index"] = idx
            out_segs.append(r)
        except HTTPException:
            raise
        except Exception as e:
            out_segs.append({"index": idx, "error": str(e)})
    return JSONResponse({"code": 0, "data": {"segments": out_segs}})


@router.post("/replace-grid-cell/{workflow_id}")
async def replace_grid_cell_api(workflow_id: str, body: dict):
    """
    替换宫格的某一格：保持 rows/cols 不变，用新 url 替换 cell_index 位置后重新合成。
    若传入 image_data（base64），先落盘到 workflow 目录再替换。
    入参：{segment_index, cell_index, rows, cols, urls, replacement_url?, image_data?}
    返回：与 compose-grid 同结构。
    """
    try:
        seg_idx = int(body.get("segment_index", 0))
        cell_idx = int(body.get("cell_index", 0))
        rows = int(body.get("rows", 0))
        cols = int(body.get("cols", 0))
    except Exception:
        raise HTTPException(status_code=400, detail="segment_index/cell_index/rows/cols 必填且为整数")
    urls = list(body.get("urls") or [])
    if not urls or rows <= 0 or cols <= 0:
        raise HTTPException(status_code=400, detail="urls/rows/cols 不合法")
    if cell_idx < 0 or cell_idx >= rows * cols or cell_idx >= len(urls):
        raise HTTPException(status_code=400, detail="cell_index 越界")

    repl_url = body.get("replacement_url")
    if not repl_url:
        image_data = body.get("image_data")
        if not image_data:
            raise HTTPException(status_code=400, detail="需要 replacement_url 或 image_data")
        # 落盘上传图到 workflow 目录
        try:
            saved = save_workflow_image(workflow_id, image_data, prefix=f"grid_upload_s{seg_idx}_c{cell_idx}")
            repl_url = saved.get("url")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"保存替换图失败: {e}")
    if not repl_url:
        raise HTTPException(status_code=400, detail="replacement_url 为空")

    urls[cell_idx] = repl_url
    r = _compose_grid_core(workflow_id, seg_idx, urls, rows, cols)
    r["index"] = seg_idx
    r["replaced_cell_index"] = cell_idx
    return JSONResponse({"code": 0, "data": r})


def _target_count_for_duration(dur: float, rule: "dict | None" = None) -> int:
    """按段时长确定宫格格数：≤7→4 / ≤12→6 / >12→9（≤15 和 >15 都取 9）。"""
    rule = rule or {}
    t_4 = float(rule.get("lte4", 7.0))
    t_6 = float(rule.get("lte6", 12.0))
    if dur <= t_4:
        return int(rule.get("count_4", 4))
    if dur <= t_6:
        return int(rule.get("count_6", 6))
    return int(rule.get("count_9", 9))


async def llm_pick_representatives(
    config: dict, segment: dict, frame_labels_in_seg: list,
    images: list, target_count: int,
) -> dict:
    """每段一次视觉调用，让 LLM 从段内候选帧挑出 target_count 张。返回 {picked_indices, reason}。"""
    # 构造候选帧摘要（让模型知道每张对应的 index 和 label）
    summary_lines = []
    for f in frame_labels_in_seg:
        idx = f.get("index", 0)
        ts = f.get("timestamp", 0.0)
        st = f.get("shot_type", "medium")
        sub = f.get("subtitle") or ""
        ct = (f.get("content") or "")[:40]
        line = f"index={idx} ts={ts:.1f}s shot={st} content={ct}"
        if sub:
            line += f" subtitle={sub[:30]}"
        summary_lines.append(line)
    summary = "\n".join(summary_lines)
    seg_theme = segment.get("theme", "")
    sys = f"""你是分镜师。本段主题：{seg_theme}。请从下列候选帧中挑出 {target_count} 张作为本段的代表分镜。

选择标准：
1. 必须覆盖：段落开场、关键动作/情绪节点、段落结束
2. 有 subtitle（对白字幕）的帧优先考虑
3. 避免景别完全相同或画面高度相似的帧
4. picked_indices 返回的是原始视频帧序号（见候选列表中的 index= 字段）

只输出 JSON：
{{"picked_indices":[<{target_count}个原始index>], "reason":"一句话说明挑选理由"}}"""
    user = f"候选帧列表：\n\n{summary}\n\n请挑选 {target_count} 张最具代表性的帧。"
    return await _call_llm_vision_json(config, sys, user, images, max_tokens=3000)


@router.post("/generate/select-representative-frames")
async def gen_select_representatives(body: dict):
    """
    Round 3：对每段选 4/6/9 张代表帧（按段长自适应）。
    输入：{workflow_id, chat_config_id, segments?, frame_labels?, max_concurrent?, target_rule?}
    输出写入 rep_frames.json。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    # 读取 segments / frame_labels（body 缺省则从文件读）
    segments = body.get("segments") or []
    if not segments:
        seg_path = os.path.join(wf_dir, "segments.json")
        if os.path.isfile(seg_path):
            try:
                segments = json.load(open(seg_path, "r", encoding="utf-8")).get("segments", [])
            except Exception:
                segments = []
    if not segments:
        raise HTTPException(status_code=400, detail="未找到 segments")

    frame_labels = body.get("frame_labels") or []
    if not frame_labels:
        fl_path = os.path.join(wf_dir, "frame_labels.json")
        if os.path.isfile(fl_path):
            try:
                frame_labels = json.load(open(fl_path, "r", encoding="utf-8")).get("frames", [])
            except Exception:
                frame_labels = []

    # 从 keyframes.json 读 url 映射
    kf_frames: list = []
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            kf_frames = json.load(open(kf_path, "r", encoding="utf-8")).get("frames", [])
        except Exception:
            kf_frames = []
    url_map = {f.get("index"): f.get("url", "") for f in kf_frames}

    label_map = {f.get("index"): f for f in frame_labels}
    max_concurrent = max(1, int(body.get("max_concurrent", 3)))
    max_retries = max(0, int(body.get("max_retries", 2)))
    target_rule = body.get("target_rule") or {}

    semaphore = asyncio.Semaphore(max_concurrent)

    async def _process_seg(seg):
        async with semaphore:
            dur = float(seg.get("duration") or (seg.get("end", 0) - seg.get("start", 0)))
            target = _target_count_for_duration(dur, target_rule)
            indices = seg.get("frame_indices") or []
            if len(indices) <= target:
                return {
                    "index": seg.get("index", 0), "target_count": target,
                    "picked_indices": indices[:target], "reason": "段内候选不足，全选",
                }
            # 加载段内所有帧图片 + 标签
            imgs = []
            labels_in = []
            for idx in indices:
                url = url_map.get(idx, "")
                if not url:
                    continue
                b64 = _load_ref_image_b64(url)
                if not b64:
                    continue
                f = label_map.get(idx, {"index": idx})
                imgs.append({"b64": b64, "label": f"idx={idx}", "index": idx})
                labels_in.append(f)
            if not imgs:
                return {
                    "index": seg.get("index", 0), "target_count": target,
                    "picked_indices": indices[:target], "reason": "图片加载失败，退化为前 N 张",
                }
            try:
                r = await _retry_async(
                    lambda: llm_pick_representatives(config, seg, labels_in, imgs, target),
                    max_retries=max_retries, label=f"rep-frames seg={seg.get('index')}",
                )
                picked = [int(x) for x in (r.get("picked_indices") or [])]
                # 校验：picked 必须都在 indices 内，数量不够则用开头补
                valid = [i for i in picked if i in indices]
                if len(valid) < target:
                    for i in indices:
                        if i not in valid:
                            valid.append(i)
                            if len(valid) >= target:
                                break
                return {
                    "index": seg.get("index", 0), "target_count": target,
                    "picked_indices": valid[:target], "reason": r.get("reason", ""),
                }
            except Exception as e:
                return {
                    "index": seg.get("index", 0), "target_count": target,
                    "picked_indices": indices[:target],
                    "reason": "", "error": str(e)[:200],
                }

    seg_results = await asyncio.gather(*[_process_seg(s) for s in segments])
    seg_results.sort(key=lambda x: x.get("index", 0))

    # 给 picked 附 url 便于前端渲染
    for sr in seg_results:
        sr["picked"] = [
            {"index": i, "url": url_map.get(i, ""), "timestamp": (label_map.get(i, {}) or {}).get("timestamp", 0.0)}
            for i in sr.get("picked_indices", [])
        ]

    result = {"segments": seg_results}
    try:
        with open(os.path.join(wf_dir, "rep_frames.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  接口 5: 剧情重编排（前置，决定段数）
# ═══════════════════════════════════════════════════

@router.post("/generate/rewrite-plot")
async def gen_rewrite_plot(body: dict):
    """
    基于原始剧情 + 二创方向 + 帧标注/全局清单 产出分段新剧情。
    **不依赖** smart-segment：由本路由决定段数，smart-segment 后续按这个段数做帧分配。

    body: {workflow_id, chat_config_id, original_plot?, direction?, style?}
          （原始剧情/方向/风格缺省则从 wf.input 读——前端传入更方便）
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    original_plot = (body.get("original_plot") or "").strip()
    direction = (body.get("direction") or "").strip()
    style = (body.get("style") or "").strip()
    if not original_plot:
        raise HTTPException(status_code=400, detail="未提供原始剧情")

    # 从 frame_labels.json 读 overview（人物场景清单）
    overview: dict = {}
    fl_path = os.path.join(wf_dir, "frame_labels.json")
    if os.path.isfile(fl_path):
        try:
            overview = json.load(open(fl_path, "r", encoding="utf-8")).get("overview", {})
        except Exception:
            pass

    # 从 script.json 读完整原剧本
    script_full = ""
    sc_path = os.path.join(wf_dir, "script.json")
    if os.path.isfile(sc_path):
        try:
            sc = json.load(open(sc_path, "r", encoding="utf-8"))
            script_full = sc.get("full_script", "")
        except Exception:
            pass

    # 如果 script 不存在，回退到 frame_labels 的帧内容摘要（兼容旧流程）
    timeline_text = ""
    if not script_full:
        frame_labels = []
        if os.path.isfile(fl_path):
            try:
                frame_labels = json.load(open(fl_path, "r", encoding="utf-8")).get("frames", [])
            except Exception:
                frame_labels = []
        MAX_TL_LINES = 120
        if len(frame_labels) > MAX_TL_LINES:
            step = max(1, len(frame_labels) // MAX_TL_LINES)
            frame_labels = frame_labels[::step][:MAX_TL_LINES]
        lines = []
        for f in frame_labels:
            ct = (f.get("content") or "").replace("\n", " ")[:40]
            if not ct:
                continue
            ts = f.get("timestamp", 0.0)
            sub = (f.get("subtitle") or "")[:24]
            line = f"  [{ts:.1f}s] {ct}"
            if sub:
                line += f" ‹{sub}›"
            lines.append(line)
        timeline_text = "\n".join(lines)

    # overview 精简：只留 name/features
    overview_block = ""
    if overview:
        compact = {}
        for key in ("characters", "scenes"):
            items = overview.get(key) or []
            compact[key] = [
                {"name": (it.get("name") or "")[:30], "features": (it.get("features") or "")[:120]}
                for it in items[:20]
                if isinstance(it, dict)
            ]
        if overview.get("narrative"):
            compact["narrative"] = str(overview["narrative"])[:120]
        ov_text = json.dumps(compact, ensure_ascii=False, indent=2)
        overview_block = f"\n【全局清单参考】\n{ov_text[:2500]}\n"

    # 原视频剧本块
    if script_full:
        script_block = f"\n【原视频剧本演绎（按时间顺序的完整叙事）】\n{script_full[:6000]}\n"
    elif timeline_text:
        script_block = f"\n【原视频帧内容摘要（按时间顺序）】\n{timeline_text}\n"
    else:
        script_block = ""

    # 视频总时长
    video_duration = 0.0
    kf_path2 = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path2):
        try:
            video_duration = float(json.load(open(kf_path2, "r", encoding="utf-8")).get("duration", 0.0))
        except Exception:
            pass

    system_prompt = f"""你是一位影视二次创作编剧。请基于下列材料重新编排剧情。

【二创方向】{direction or '（用户未指定，保持原有叙事结构，优化节奏）'}
【目标风格】{style or '（保持原风格）'}
【原视频总时长】{video_duration:.1f} 秒

任务：产出**一篇完整的改编剧本**，**不要分段**，直接输出整篇连贯文本。

要求：
1. full_script：整片改编剧本，按时间顺序连贯叙述，整合动作/场景/情绪/对白与运镜过渡。可使用空行作自然分段，但不要给段编号、不要输出 segments 列表。
2. 字数 800~3000 字，长度按视频时长酌情。可加入新情节/铺垫/情绪停顿，但叙事顺序需与原视频时间线大致对应。
3. characters：列出全片主要人物（沿用全局清单 name，追加新形象描述）。
4. scenes：仅列出新增或大改的场景，保持原场景的不用写。

只输出 JSON：
{{
  "full_script":"整片改编剧本（一大段，可含自然分段空行，含台词与运镜过渡）",
  "characters": [
    {{"name":"角色A","original_desc":"...","new_desc":"..."}}
  ],
  "scenes": [
    {{"name":"场景X","original_desc":"...","new_desc":"..."}}
  ]
}}"""
    user_prompt = (
        f"【用户输入的原始剧情（梗概）】\n{original_plot[:2000]}\n{overview_block}"
        f"{script_block}\n"
        f"请按二创方向重新编排，产出整篇新剧本（不要分段）+ 人物/场景清单。"
    )
    result = await _retry_async(
        lambda: _call_llm_json(config, system_prompt, user_prompt, max_tokens=12000, timeout=420.0),
        max_retries=max(0, int(body.get("max_retries", 2))),
        label="rewrite-plot",
    )

    out = {
        "full_script": result.get("full_script") or "",
        "characters": result.get("characters") or [],
        "scenes": result.get("scenes") or [],
    }
    try:
        with open(os.path.join(wf_dir, "rewrite_plot.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return JSONResponse({"code": 0, "data": out})


@router.post("/generate/rewrite-plot-chat")
async def gen_rewrite_plot_chat(body: dict):
    """
    基于用户对话修改剧情重编排。接受当前 full_script/characters/scenes + 对话历史 + 用户消息，
    产出更新后的 full_script/characters/scenes（整篇剧本，不分段）。
    body: {
      workflow_id, chat_config_id,
      current_full_script, current_characters?, current_scenes?,
      chat_history: [{role:"user"|"assistant", content}],
      user_message,
      direction?, style?
    }
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    user_message = (body.get("user_message") or "").strip()
    if not user_message:
        raise HTTPException(status_code=400, detail="未提供用户消息")

    current_full_script = (body.get("current_full_script") or "").strip()
    current_characters = body.get("current_characters") or []
    current_scenes = body.get("current_scenes") or []
    chat_history = body.get("chat_history") or []
    direction = (body.get("direction") or "").strip()
    style = (body.get("style") or "").strip()

    # 视频时长
    video_duration = 0.0
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            video_duration = float(json.load(open(kf_path, "r", encoding="utf-8")).get("duration", 0.0))
        except Exception:
            pass

    slim_chars = [
        {"name": (c.get("name") or "")[:30], "new_desc": (c.get("new_desc") or "")[:200]}
        for c in current_characters[:20] if isinstance(c, dict)
    ]
    slim_scenes = [
        {"name": (s.get("name") or "")[:30], "new_desc": (s.get("new_desc") or "")[:200]}
        for s in current_scenes[:20] if isinstance(s, dict)
    ]

    history_block = ""
    if chat_history:
        history_block = "\n【对话历史】\n" + "\n".join(
            f"[{m.get('role','user')}] {(m.get('content') or '')[:300]}"
            for m in chat_history[-6:]
        )

    system_prompt = f"""你是一位影视二次创作编剧。用户正在审阅已有的改编剧本，并通过对话要求调整。请根据用户消息修改剧本并输出完整新版本。

【二创方向】{direction or '（保持原有）'}
【目标风格】{style or '（保持原风格）'}
【视频时长】{video_duration:.1f} 秒

要求：
1. 输出**一篇完整改编剧本**（不分段，整篇连贯；可用空行作自然段落），按时间顺序叙述，整合动作/场景/情绪/台词/运镜过渡。
2. 字数 800~3000 字。可加入新情节/铺垫/情绪停顿，但叙事顺序需与原视频时间线大致对应。
3. 用户可能要求调整局部，也可能要求整体改，未提到的部分保留原样。
4. characters / scenes 输出完整新版本（用户没要求改就原样返回）。
5. 必须在 message 字段对用户说明本次改动（做了哪些修改、为什么，200 字内）。

只输出 JSON：
{{
  "full_script":"整片改编剧本（一大段，可含自然分段空行）",
  "characters":[{{"name":"...","original_desc":"...","new_desc":"..."}}],
  "scenes":[{{"name":"...","original_desc":"...","new_desc":"..."}}],
  "message":"对用户说明本次改动的文字（200 字内）"
}}"""
    cur_block = json.dumps({
        "full_script": current_full_script[:6000],
        "characters": slim_chars,
        "scenes": slim_scenes,
    }, ensure_ascii=False, indent=2)
    user_prompt = (
        f"【当前剧本编排】\n{cur_block}\n"
        f"{history_block}\n\n"
        f"【用户本次消息】\n{user_message}\n\n"
        f"请基于用户要求修改剧本，输出完整新版本。"
    )

    try:
        result = await _retry_async(
            lambda: _call_llm_json(config, system_prompt, user_prompt, max_tokens=12000, timeout=420.0),
            max_retries=max(0, int(body.get("max_retries", 2))),
            label="rewrite-plot-chat",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"对话修改失败: {e}")

    out = {
        "full_script": result.get("full_script") or current_full_script,
        "characters": result.get("characters") or current_characters,
        "scenes": result.get("scenes") or current_scenes,
        "message": result.get("message", "") or "",
    }
    try:
        with open(os.path.join(wf_dir, "rewrite_plot.json"), "w", encoding="utf-8") as f:
            json.dump({
                "full_script": out["full_script"],
                "characters": out["characters"],
                "scenes": out["scenes"],
            }, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return JSONResponse({"code": 0, "data": out})


# ═══════════════════════════════════════════════════
#  接口 7: 人物形象重设计（两步：extract + generate）
# ═══════════════════════════════════════════════════

def _load_rep_frames_with_urls(wf_dir: str, seg_indices: "list | None" = None) -> list:
    """从 rep_frames.json + keyframes.json 拼出代表帧列表 [{index, url, timestamp}]。
    seg_indices=None 取全部段，否则只取指定段。"""
    rp_path = os.path.join(wf_dir, "rep_frames.json")
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if not (os.path.isfile(rp_path) and os.path.isfile(kf_path)):
        return []
    try:
        rep = json.load(open(rp_path, "r", encoding="utf-8")).get("segments", [])
        kf = json.load(open(kf_path, "r", encoding="utf-8")).get("frames", [])
    except Exception:
        return []
    url_map = {f.get("index"): f.get("url", "") for f in kf}
    ts_map = {f.get("index"): f.get("timestamp", 0.0) for f in kf}
    out = []
    seen = set()
    for rs in rep:
        if seg_indices is not None and rs.get("index") not in seg_indices:
            continue
        for idx in rs.get("picked_indices", []):
            if idx in seen:
                continue
            seen.add(idx)
            url = url_map.get(idx, "")
            if not url:
                continue
            out.append({"index": idx, "url": url, "timestamp": ts_map.get(idx, 0.0)})
    return out


async def llm_extract_main_characters(config: dict, rep_images: list, existing_characters: "list | None" = None) -> dict:
    """从代表帧视觉提取主要人物。返回 {"characters":[{name,features,ref_frame_index,confidence}]}"""
    existing_hint = ""
    if existing_characters:
        existing_hint = "\n【已有人物清单（沿用命名）】\n" + "\n".join(
            f"- {c.get('name','')}: {c.get('features','')}" for c in existing_characters[:10]
        )
    system_prompt = f"""你是一位影视选角指导。请从给定代表帧中找出**主要人物**（反复出镜的关键角色）。

要求：
1. 只列主要角色，不要把路人、群演列进来；通常 1~5 个
2. 每个人物给一个稳定的 name（可能和已有清单重合）和一句可识别的 features（发型/服装/体态/年龄；避免位置依赖描述）
3. ref_frame_index 必须是画面中该人物面部清晰、最有代表性的那张代表帧的 index（来自候选帧列表中的 idx=X）
4. confidence: "high" / "medium" / "low"，反映你对该人物确信度{existing_hint}

只输出 JSON：
{{"characters":[{{"name":"角色A","features":"...","ref_frame_index":3,"confidence":"high"}}]}}"""
    user_text = "请从下列 " + str(len(rep_images)) + " 张代表帧中提取主要人物。"
    return await _call_llm_vision_json(config, system_prompt, user_text, rep_images, max_tokens=4000)


@router.post("/generate/redesign-characters")
async def gen_redesign_characters(body: dict):
    """
    两步：
    - action="extract"：从代表帧视觉提取主要人物（需要 chat_config_id 的视觉模型），返回 characters 列表（无图，仅 name/features/ref_frame_url）
    - action="generate"（默认）：给定 characters 列表，为每个人物图生图生成新形象。支持 ref_frame_url 作为原图，new_desc 作为 prompt。
    """
    wf_id = body.get("workflow_id", "")
    wf_dir = get_workflow_dir(wf_id) if wf_id else None
    action = body.get("action") or "generate"
    style = body.get("style", "")

    if action == "extract":
        chat_config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
        if not chat_config:
            raise HTTPException(status_code=400, detail="未找到聊天配置（视觉提取需要）")
        if not wf_dir:
            raise HTTPException(status_code=400, detail="缺少 workflow_id")

        rep_frames = _load_rep_frames_with_urls(wf_dir, seg_indices=None)
        if not rep_frames:
            raise HTTPException(status_code=400, detail="未找到代表帧（请先运行代表帧节点）")
        # 按清晰度/时间均匀抽最多 20 张送给 LLM，节省 token
        rep_sample = rep_frames[: min(20, len(rep_frames))]
        images = []
        url_by_idx = {}
        for rf in rep_sample:
            b64 = _load_ref_image_b64(rf["url"])
            if not b64:
                continue
            images.append({"b64": b64, "label": f"idx={rf['index']}"})
            url_by_idx[rf["index"]] = rf["url"]
        if not images:
            raise HTTPException(status_code=400, detail="代表帧图片加载失败")

        # 沿用用户已有的 characters（如果前端传了）或 rewrite_plot 里的 characters
        existing = body.get("existing_characters") or []
        if not existing and wf_dir:
            rw_path = os.path.join(wf_dir, "rewrite_plot.json")
            if os.path.isfile(rw_path):
                try:
                    existing = json.load(open(rw_path, "r", encoding="utf-8")).get("characters", [])
                except Exception:
                    pass

        try:
            r = await llm_extract_main_characters(chat_config, images, existing)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"人物提取失败: {e}")
        out_chars = []
        for c in r.get("characters") or []:
            rf_idx = c.get("ref_frame_index")
            try:
                rf_idx = int(rf_idx) if rf_idx is not None else None
            except (TypeError, ValueError):
                rf_idx = None
            out_chars.append({
                "name": c.get("name", ""),
                "features": c.get("features", ""),
                "original_desc": c.get("features", ""),  # 作为原始描述保留
                "new_desc": "",  # 等用户填
                "visual_prompt": "",
                "ref_frame_url": url_by_idx.get(rf_idx, "") if rf_idx is not None else "",
                "ref_frame_index": rf_idx,
                "confidence": c.get("confidence", "medium"),
                "imageUrl": "",
            })
        return JSONResponse({"code": 0, "data": {"characters": out_chars}})

    # action == "generate"
    img_config = _get_config_by_id(body.get("image_config_id", "")) or _get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    characters = body.get("characters", [])
    ref_urls = body.get("ref_image_urls", [])
    force = bool(body.get("force", False))  # 强制重新生成已有 imageUrl 的项
    target_names = body.get("target_names")  # 可选：只为这些 name 生图
    if not characters:
        raise HTTPException(status_code=400, detail="未提供人物列表")

    node_refs = _collect_ref_images(extra_urls=ref_urls)
    errors = []

    async def gen_single(idx, char):
        try:
            if char.get("imageUrl") and not force:
                return
            if target_names and char.get("name") not in target_names:
                return
            desc = (
                char.get("new_desc")
                or char.get("visual_prompt")
                or char.get("features")
                or char.get("original_desc", "")
            )
            prompt = f"{style}风格，角色设定图，白色背景，正面全身立绘，{desc}"
            # 参考图：人物自己的 ref_frame_url（原始视觉）+ 节点级 refImages + 外部 ref_urls
            item_ref_urls = []
            if char.get("ref_frame_url"):
                item_ref_urls.append(char["ref_frame_url"])
            item_ref_urls.extend(char.get("refImages") or [])
            item_refs = _collect_ref_images(extra_urls=item_ref_urls)
            all_refs = item_refs + [r for r in node_refs if r not in item_refs]
            img_res = await generate_image(ImageGenerateRequest(
                config_id=img_config["id"], prompt=prompt,
                width=1152, height=2048, n=1,
                image_base64_list=all_refs,
            ))
            img_data = img_res.get("data", [])
            if img_data:
                b64 = img_data[0].get("b64_json", "")
                if b64:
                    url = save_workflow_image(
                        wf_id,
                        b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}",
                        f"rc_char_{char.get('name', 'char')}"
                    )
                    char["imageUrl"] = url
        except Exception as e:
            errors.append({"index": idx, "name": char.get("name", ""), "message": str(e)[:200]})

    tasks = [gen_single(i, c) for i, c in enumerate(characters)]
    await asyncio.gather(*tasks)

    return JSONResponse({"code": 0, "data": {"characters": characters, "errors": errors}})


# ═══════════════════════════════════════════════════
#  接口 8: 场景重设计（段级，两步：extract + generate）
# ═══════════════════════════════════════════════════

async def llm_extract_segment_scene(config: dict, rep_images: list, segment_info: dict) -> dict:
    """从段代表帧视觉提取主场景。一段通常一个主场景。
    返回 {"name":"场景名","features":"...","ref_frame_index":X}"""
    theme = segment_info.get("theme", "")
    system_prompt = f"""你是一位影视场景设计师。请从给定代表帧中归纳这一段的**主要场景**（单一主场景即可，不要多个）。

本段主题：{theme or '（未提供）'}

要求：
1. name：给一个简短场景名（地点/环境，不含时间）
2. features：场景环境描述（光线、室内外、主要物件、氛围）；避免描述画面中的人物
3. ref_frame_index：该段代表帧中场景展示最完整清晰的那张的原始 index

只输出 JSON：
{{"name":"...","features":"...","ref_frame_index":0}}"""
    user_text = f"下列 {len(rep_images)} 张是同一段落的代表帧，请归纳主场景。"
    return await _call_llm_vision_json(config, system_prompt, user_text, rep_images, max_tokens=2000)


@router.post("/generate/redesign-scenes")
async def gen_redesign_scenes(body: dict):
    """
    段级两步：
    - action="extract"：给定 workflow_id + segment_index，从该段代表帧视觉提取主场景
    - action="generate"（默认）：给定 scene（含 ref_frame_url + new_desc），图生图生成新场景
    """
    wf_id = body.get("workflow_id", "")
    wf_dir = get_workflow_dir(wf_id) if wf_id else None
    action = body.get("action") or "generate"
    style = body.get("style", "")

    if action == "extract":
        chat_config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
        if not chat_config:
            raise HTTPException(status_code=400, detail="未找到聊天配置（视觉提取需要）")
        if not wf_dir:
            raise HTTPException(status_code=400, detail="缺少 workflow_id")
        seg_idx = body.get("segment_index")
        if seg_idx is None:
            raise HTTPException(status_code=400, detail="缺少 segment_index")
        seg_idx = int(seg_idx)

        # 读该段信息
        seg_info: dict = {"theme": ""}
        seg_path = os.path.join(wf_dir, "segments.json")
        if os.path.isfile(seg_path):
            try:
                segs = json.load(open(seg_path, "r", encoding="utf-8")).get("segments", [])
                for s in segs:
                    if s.get("index") == seg_idx:
                        seg_info = s
                        break
            except Exception:
                pass

        rep_frames = _load_rep_frames_with_urls(wf_dir, seg_indices=[seg_idx])
        if not rep_frames:
            raise HTTPException(status_code=400, detail=f"未找到段 {seg_idx} 的代表帧")
        images = []
        url_by_idx = {}
        for rf in rep_frames[:9]:  # 最多 9 张
            b64 = _load_ref_image_b64(rf["url"])
            if not b64:
                continue
            images.append({"b64": b64, "label": f"idx={rf['index']}"})
            url_by_idx[rf["index"]] = rf["url"]
        if not images:
            raise HTTPException(status_code=400, detail="代表帧图片加载失败")

        try:
            r = await llm_extract_segment_scene(chat_config, images, seg_info)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"场景提取失败: {e}")
        rf_idx = r.get("ref_frame_index")
        try:
            rf_idx = int(rf_idx) if rf_idx is not None else None
        except (TypeError, ValueError):
            rf_idx = None
        scene = {
            "name": r.get("name", ""),
            "features": r.get("features", ""),
            "original_desc": r.get("features", ""),
            "new_desc": "",
            "visual_prompt": "",
            "ref_frame_url": url_by_idx.get(rf_idx, "") if rf_idx is not None else (rep_frames[0]["url"] if rep_frames else ""),
            "ref_frame_index": rf_idx,
            "segment_index": seg_idx,
            "imageUrl": "",
        }
        return JSONResponse({"code": 0, "data": {"scene": scene}})

    # action == "generate"
    img_config = _get_config_by_id(body.get("image_config_id", "")) or _get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    # 段级：body 可以传 scene（单个）或 scenes（批量）
    scene = body.get("scene")
    scenes = body.get("scenes") or ([scene] if scene else [])
    force = bool(body.get("force", False))
    if not scenes:
        raise HTTPException(status_code=400, detail="未提供场景")

    ref_urls = body.get("ref_image_urls", [])
    node_refs = _collect_ref_images(extra_urls=ref_urls)
    errors = []

    async def gen_single(idx, s):
        try:
            if s.get("imageUrl") and not force:
                return
            desc = (
                s.get("new_desc")
                or s.get("visual_prompt")
                or s.get("features")
                or s.get("original_desc", "")
            )
            prompt = f"{style}风格，场景概念图，无人物，{desc}"
            item_ref_urls = []
            if s.get("ref_frame_url"):
                item_ref_urls.append(s["ref_frame_url"])
            item_ref_urls.extend(s.get("refImages") or [])
            item_refs = _collect_ref_images(extra_urls=item_ref_urls)
            all_refs = item_refs + [r for r in node_refs if r not in item_refs]
            img_res = await generate_image(ImageGenerateRequest(
                config_id=img_config["id"], prompt=prompt,
                width=1920, height=1080, n=1,
                image_base64_list=all_refs,
            ))
            img_data = img_res.get("data", [])
            if img_data:
                b64 = img_data[0].get("b64_json", "")
                if b64:
                    url = save_workflow_image(
                        wf_id,
                        b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}",
                        f"rc_scene_s{s.get('segment_index', idx)}_{s.get('name', 'scene')}"
                    )
                    s["imageUrl"] = url
        except Exception as e:
            errors.append({"index": idx, "name": s.get("name", ""), "message": str(e)[:200]})

    tasks = [gen_single(i, s) for i, s in enumerate(scenes)]
    await asyncio.gather(*tasks)

    return JSONResponse({"code": 0, "data": {
        "scenes": scenes,
        "scene": scenes[0] if scenes else None,
        "errors": errors,
    }})


# ═══════════════════════════════════════════════════
#  接口 9: 分镜提示词生成（段级，终点 —— 只输出提示词，不生图）
# ═══════════════════════════════════════════════════

@router.post("/generate/rc-storyboard")
async def gen_rc_storyboard(body: dict):
    """
    段级终点：综合新剧情段落 + 二创方向 + 全片人物 + 段场景 + 该段代表帧，
    为每张代表帧输出一条分镜提示词（英文 prompt + 中文 + 构图说明）。

    body: {
      workflow_id, chat_config_id, segment_index,
      segment: {text, scene_action, ...},
      direction, style,
      characters: [{name, features/new_desc, imageUrl?}],
      scene: {name, features/new_desc, imageUrl?, ref_frame_url?},
      rep_frames_override?: [{index,url}],  # 可选，缺省从 rep_frames.json 读
    }
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    seg_idx = body.get("segment_index")
    if seg_idx is None:
        raise HTTPException(status_code=400, detail="缺少 segment_index")
    seg_idx = int(seg_idx)

    segment = body.get("segment") or {}
    direction = body.get("direction", "")
    style = body.get("style", "")
    characters = body.get("characters") or []
    scene = body.get("scene") or {}

    # 代表帧列表（该段）
    rep_override = body.get("rep_frames_override") or []
    if rep_override:
        rep_items = rep_override
    else:
        rep_items = _load_rep_frames_with_urls(wf_dir, seg_indices=[seg_idx])
    if not rep_items:
        raise HTTPException(status_code=400, detail=f"段 {seg_idx} 没有代表帧，请先运行代表帧节点")

    # 读 frame_labels 补充每帧的 shot_type / subtitle / content
    label_map = {}
    fl_path = os.path.join(wf_dir, "frame_labels.json")
    if os.path.isfile(fl_path):
        try:
            for f in json.load(open(fl_path, "r", encoding="utf-8")).get("frames", []):
                label_map[f.get("index")] = f
        except Exception:
            pass

    # 构造人物/场景信息块
    chars_desc = "\n".join(
        f"- {c.get('name','')}: {c.get('new_desc') or c.get('features') or c.get('original_desc','')}"
        for c in characters
    ) or "（无特定人物）"
    scene_desc = ""
    if scene:
        scene_desc = f"{scene.get('name','')}: {scene.get('new_desc') or scene.get('features') or scene.get('original_desc','')}"
    else:
        scene_desc = "（无特定场景）"

    # 每帧摘要
    shot_lines = []
    for rf in rep_items:
        idx = rf["index"]
        lab = label_map.get(idx, {})
        shot_lines.append(
            f"帧 idx={idx} @ {rf.get('timestamp', 0):.1f}s · "
            f"shot={lab.get('shot_type','medium')} · "
            f"content={(lab.get('content') or '')[:60]}"
            + (f" · subtitle={lab.get('subtitle')[:30]}" if lab.get("subtitle") else "")
        )
    shots_block = "\n".join(shot_lines)

    n_shots = len(rep_items)
    system_prompt = f"""你是 AI 绘图提示词工程师。为一段分镜生成 {n_shots} 条分镜提示词，每条对应一张原始代表帧。

【二创方向】{direction or '（未指定）'}
【目标风格】{style or '（保持原风格）'}
【本段新剧情】{segment.get('text','')}
【全片人物】
{chars_desc}
【本段场景】{scene_desc}
【原始分镜信息】
{shots_block}

要求：
1. 输出恰好 {n_shots} 条 shots，顺序与输入的 idx 一一对应
2. 每条 shot 输出：
   - ref_frame_index: 对应原始帧 idx（原样回填）
   - prompt_en: 英文 AI 绘图提示词（详细、可直出）
   - prompt_cn: 中文提示词（供人类阅读）
   - composition_notes: 构图说明（景别、机位、人物位置、光影）
3. prompt_en 必须融合：本段新剧情情境 + 人物特征 + 场景特征 + 该帧的构图（保持原构图骨架以确保画面连续）
4. 遵循二创方向与目标风格

只输出 JSON：
{{"shots":[{{"ref_frame_index":N,"prompt_en":"...","prompt_cn":"...","composition_notes":"..."}}]}}"""
    # 视觉 LLM：附上所有代表帧作为构图参考
    images = []
    for rf in rep_items:
        b64 = _load_ref_image_b64(rf["url"])
        if b64:
            images.append({"b64": b64, "label": f"idx={rf['index']}"})

    user_text = f"请为本段 {n_shots} 张代表帧生成分镜提示词。"
    sb_retries = max(0, int(body.get("max_retries", 2)))
    if images:
        try:
            result = await _retry_async(
                lambda: _call_llm_vision_json(config, system_prompt, user_text, images, max_tokens=6000),
                max_retries=sb_retries, label=f"storyboard seg={seg_idx}",
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"分镜生成失败: {e}")
    else:
        try:
            result = await _retry_async(
                lambda: _call_llm_json(config, system_prompt, user_text, max_tokens=6000),
                max_retries=sb_retries, label=f"storyboard seg={seg_idx} (text)",
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"分镜生成失败: {e}")

    # 规范化：按 rep_items 顺序对齐，缺的用空占位；强制回填 ref_frame_index 和 ref_frame_url
    shots_out = []
    by_idx = {int(s.get("ref_frame_index", -1)): s for s in (result.get("shots") or []) if s.get("ref_frame_index") is not None}
    for rf in rep_items:
        s = by_idx.get(rf["index"], {})
        shots_out.append({
            "ref_frame_index": rf["index"],
            "ref_frame_url": rf["url"],
            "prompt_en": s.get("prompt_en") or s.get("prompt") or "",
            "prompt_cn": s.get("prompt_cn") or "",
            "composition_notes": s.get("composition_notes") or "",
        })

    return JSONResponse({"code": 0, "data": {"shots": shots_out}})


# ═══════════════════════════════════════════════════
#  二创分镜（rc-storyboard-remix）
#  对话式：基于原版宫格 + 参考图 + 改编方向，生成同尺寸二创宫格
#  流程：视觉 LLM 出每格 prompt → 逐格 i2i → 拼大图 → 整张重绘统一风格 → 切片
# ═══════════════════════════════════════════════════

def _slice_grid_image_to_cells(grid_url: str, rows: int, cols: int,
                                workflow_id: str, segment_index: int, tag: str = "unified") -> list:
    """把一张已合成的宫格大图按 rows×cols 切成单格 URL 列表，落盘到 workflow 目录。"""
    from PIL import Image
    import uuid
    p = _url_to_local_path(grid_url)
    if not p:
        return []
    img = Image.open(p)
    if img.mode != "RGB":
        img = img.convert("RGB")
    W, H = img.size
    cw, ch = W // cols, H // rows
    out_dir = os.path.join(get_workflow_dir(workflow_id), "remix_cells")
    os.makedirs(out_dir, exist_ok=True)
    urls = []
    for r in range(rows):
        for c in range(cols):
            cell = img.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
            name = f"s{int(segment_index)}_{tag}_{r}_{c}_{uuid.uuid4().hex[:6]}.jpg"
            cell.save(os.path.join(out_dir, name), format="JPEG", quality=88, optimize=True)
            urls.append(f"/workflow-images/{workflow_id}/remix_cells/{name}")
    return urls


def _align16(v, lo=256, hi=2048):
    return (max(lo, min(hi, int(v))) // 16) * 16


async def _gen_image_via_internal(config_id: str, prompt: str, ref_b64_list: list,
                                   width: int = 1024, height: int = 1024,
                                   negative_prompt: str = "") -> str:
    """复用 /api/image/generate 入口图生图。返回 b64_json 字符串或 url。"""
    req = ImageGenerateRequest(
        config_id=config_id,
        prompt=prompt or "",
        negative_prompt=negative_prompt or "",
        width=width, height=height, n=1,
        image_base64_list=ref_b64_list or [],
    )
    res = await generate_image(req)
    data = (res or {}).get("data") or []
    if not data:
        raise HTTPException(status_code=500, detail="图像模型未返回数据")
    return data[0].get("b64_json") or data[0].get("url") or ""


@router.post("/generate/rc-storyboard-remix")
async def gen_rc_storyboard_remix(body: dict):
    """
    二创分镜（对话式）：基于原版宫格大图 + 用户参考图 + 改编方向，生成同 rows×cols 的二创宫格。

    body: {
      workflow_id, chat_config_id, image_config_id, segment_index,
      origin_grid: {url, rows, cols, urls[]},
      origin_segment_info?: {transitions, theme, start, end, duration},
      direction?, style?,
      user_message?: 本轮用户文字,
      chat_history?: [{role, content}] 前序对话,
      reference_images?: [{url, label}] 用户上传的参考图,
    }
    返回: {code:0, data:{grid:{url,rows,cols,urls,...}, message:"..."}}
    """
    chat_config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not chat_config:
        raise HTTPException(status_code=400, detail="未找到聊天/视觉配置")
    image_config_id = body.get("image_config_id") or ""
    if not _get_config_by_id(image_config_id):
        first_img = _get_first_config("image")
        if not first_img:
            raise HTTPException(status_code=400, detail="未找到图像配置")
        image_config_id = first_img["id"]

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    seg_idx = body.get("segment_index")
    if seg_idx is None:
        raise HTTPException(status_code=400, detail="缺少 segment_index")
    seg_idx = int(seg_idx)

    origin_grid = body.get("origin_grid") or {}
    grid_url = origin_grid.get("url")
    rows = int(origin_grid.get("rows") or 0)
    cols = int(origin_grid.get("cols") or 0)
    cell_urls = origin_grid.get("urls") or []
    if not grid_url or rows <= 0 or cols <= 0 or not cell_urls:
        raise HTTPException(status_code=400, detail="origin_grid 不完整（需要 url/rows/cols/urls）")
    n_cells = min(len(cell_urls), rows * cols)

    seg_info = body.get("origin_segment_info") or {}
    direction = (body.get("direction") or "").strip()
    style = (body.get("style") or "").strip()
    user_message = (body.get("user_message") or "").strip()
    chat_history = body.get("chat_history") or []
    reference_images = body.get("reference_images") or []

    # ── Step 1: 视觉 LLM 出每格 prompt + 整张统一风格 prompt ──
    # 参考图一次性加载（后面 i2i 还要复用），保留 label 给 LLM
    ref_items = []
    seen = set()
    for i, ri in enumerate(reference_images):
        ru = (ri or {}).get("url")
        if not ru or ru in seen:
            continue
        seen.add(ru)
        b = _load_ref_image_b64(ru)
        if b:
            ref_items.append({"b64": b, "label": (ri or {}).get("label") or f"参考图{i+1}"})
    ref_b64_user = [r["b64"] for r in ref_items]

    images_for_llm = []
    g_b64 = _load_ref_image_b64(grid_url)
    if g_b64:
        images_for_llm.append({"b64": g_b64, "label": f"原版宫格大图（{rows}×{cols}，从左到右、从上到下编号 1~{n_cells}）"})
    images_for_llm.extend(ref_items)

    hist_text = ""
    if chat_history:
        lines = []
        for m in chat_history[-8:]:
            role = "用户" if (m.get("role") == "user") else "助手"
            content = (m.get("content") or "").strip()
            if content:
                lines.append(f"{role}: {content[:300]}")
        if lines:
            hist_text = "\n".join(lines)

    seg_brief = ""
    if seg_info:
        seg_brief = (
            f"主题: {seg_info.get('theme','')}; "
            f"时长: {float(seg_info.get('duration') or 0):.1f}s; "
            f"转场: {seg_info.get('transitions','')}"
        )

    system_prompt = f"""你是 AI 影视二创分镜提示词工程师。
当前任务：为一段 {rows}×{cols}={n_cells} 格的原版分镜宫格生成二创版本的英文图像生成提示词。

【二创方向】{direction or '（用户对话决定）'}
【目标风格】{style or '（保持电影感，统一风格）'}
【本段信息】{seg_brief or '（无）'}
【历史对话】
{hist_text or '（首轮对话）'}
【用户本轮消息】{user_message or '（无文字，仅参考图/继续上轮）'}

要求：
1. 输出恰好 {n_cells} 条 cell_prompts，索引 0..{n_cells - 1}（行优先：左上为 0，向右递增；下一行从 cols 开始）
2. 每条 cell_prompts 输出：
   - cell_index: 整数，对应原版宫格位置
   - prompt_en: 英文 i2i 提示词，保留原构图骨架，融入二创方向 + 风格 + 参考图特征
   - composition_notes: 构图说明（中文，简短）
3. 同时输出 unified_prompt_en：一个适用于整张大图最终统一重绘的英文 prompt（强调风格/光影/色调一致性），不要描述具体构图
4. 同时输出 message：给用户的中文回复（说明你的改编思路 + 关键变化点，1-3 句话）

只输出 JSON：
{{
  "cell_prompts": [{{"cell_index": 0, "prompt_en": "...", "composition_notes": "..."}}],
  "unified_prompt_en": "...",
  "message": "..."
}}"""
    user_text = f"请为本段 {n_cells} 格分镜生成二创 prompt。"

    try:
        llm_result = await _retry_async(
            lambda: _call_llm_vision_json(chat_config, system_prompt, user_text, images_for_llm, max_tokens=8000),
            max_retries=int(body.get("max_retries", 1)),
            label=f"remix-llm seg={seg_idx}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"二创 prompt 生成失败: {e}")

    cell_prompts_raw = llm_result.get("cell_prompts") or []
    unified_prompt = (llm_result.get("unified_prompt_en") or "").strip()
    chat_message = (llm_result.get("message") or "已生成二创分镜").strip()

    by_idx = {}
    for cp in cell_prompts_raw:
        try:
            ci = int(cp.get("cell_index"))
        except Exception:
            continue
        by_idx[ci] = cp
    cell_prompts = [(by_idx.get(i, {}).get("prompt_en") or "").strip() for i in range(n_cells)]

    # ── Step 2: 逐格 i2i（每格用原格图 + 用户参考图作为多参考图） ──
    cell_w = _align16(int(origin_grid.get("cell_w") or 1024))
    cell_h = _align16(int(origin_grid.get("cell_h") or 1024))

    async def _gen_one_cell(i: int):
        prompt = cell_prompts[i] or unified_prompt or direction or "high quality cinematic frame"
        orig_b64 = _load_ref_image_b64(cell_urls[i])
        refs = ([orig_b64] if orig_b64 else []) + ref_b64_user
        try:
            data_url = await _gen_image_via_internal(
                image_config_id, prompt, refs,
                width=cell_w, height=cell_h,
            )
        except Exception:
            return None
        if not data_url:
            return None
        try:
            return save_workflow_image(wf_id, data_url, prefix=f"remix_s{seg_idx}_c{i}")
        except Exception:
            return None

    new_cell_urls = await asyncio.gather(*[_gen_one_cell(i) for i in range(n_cells)])
    final_cell_urls = []
    failed = []
    for i, u in enumerate(new_cell_urls):
        if u:
            final_cell_urls.append(u)
        else:
            failed.append(i)
            final_cell_urls.append(cell_urls[i])
    if failed:
        chat_message += f"\n（提示：第 {', '.join(str(f+1) for f in failed)} 格生成失败，已沿用原格）"

    # ── Step 3: 拼大图 ──
    grid_remix = _compose_grid_core(
        wf_id, seg_idx, final_cell_urls, rows, cols,
        out_subdir="grid_remix", filename_prefix="remix_seg",
    )

    # ── Step 4: 整张大图再做一次统一风格重绘 + 切片回单格 ──
    if unified_prompt:
        try:
            big_b64 = _load_ref_image_b64(grid_remix["url"], max_size=4 * 1024 * 1024)
            refined = await _gen_image_via_internal(
                image_config_id,
                unified_prompt + ", consistent style and color grading across the whole grid, seamless, cinematic",
                ([big_b64] if big_b64 else []) + ref_b64_user,
                width=_align16(grid_remix["width"]), height=_align16(grid_remix["height"]),
                negative_prompt="inconsistent style, mismatched lighting, seams, watermark",
            )
            if refined:
                refined_url = save_workflow_image(wf_id, refined, prefix=f"remix_unified_s{seg_idx}")
                sliced = _slice_grid_image_to_cells(refined_url, rows, cols, wf_id, seg_idx, tag="unified")
                if sliced and len(sliced) == n_cells:
                    grid_remix = _compose_grid_core(
                        wf_id, seg_idx, sliced, rows, cols,
                        out_subdir="grid_remix", filename_prefix="remix_unified_seg",
                    )
                else:
                    grid_remix["url"] = refined_url
                    grid_remix["urls"] = sliced or final_cell_urls
        except Exception as e:
            print(f"[二创][seg={seg_idx}] 整张统一重绘失败（保留逐格结果）: {e}")

    grid_remix["index"] = seg_idx
    return JSONResponse({"code": 0, "data": {"grid": grid_remix, "message": chat_message}})


# ═══════════════════════════════════════════════════
#  人物场景规划（自动挑帧提取人物清单 + 各段场景，供后续节点消费）
# ═══════════════════════════════════════════════════

async def llm_plan_char_and_scenes(config: dict, rep_images: list, segment_briefs: list, existing_characters: "list | None" = None) -> dict:
    """
    一次视觉调用：综合全片代表帧 + 各段主题，
    输出 {characters:[{name,features,ref_frame_index,confidence}], scenes:[{segment_index,name,features,ref_frame_index}]}
    """
    existing_hint = ""
    if existing_characters:
        existing_hint = "\n【已有人物清单（沿用命名）】\n" + "\n".join(
            f"- {c.get('name','')}: {c.get('features','')}" for c in existing_characters[:10]
        )
    seg_text = "\n".join(
        f"段 {s.get('segment_index')}: [{s.get('start',0):.1f}s-{s.get('end',0):.1f}s] {s.get('theme','')}"
        for s in segment_briefs
    ) or "（无分段）"
    system_prompt = f"""你是影视美术指导。请从给定代表帧中做两件事：

A) 全片主要人物清单（1~5 个最重要的角色；不要列群演/路人）
   - 每人：name（稳定命名）、features（可识别特征：发型/服装/体态/年龄）、ref_frame_index（面部最清晰那张代表帧的原始 index）、confidence（high/medium/low）
{existing_hint}

B) 每段主场景（按段号与分段一一对应，每段一个主场景）
   - segment_index（严格对齐输入段号）、name（场景名）、features（环境特征：室内外/光线/陈设）、ref_frame_index（本段代表帧中场景最完整那张的原始 index）

【分段信息】
{seg_text}

只输出 JSON：
{{
  "characters":[{{"name":"","features":"","ref_frame_index":0,"confidence":"medium"}}],
  "scenes":[{{"segment_index":0,"name":"","features":"","ref_frame_index":0}}]
}}"""
    user_text = f"送入的 {len(rep_images)} 张代表帧已按段顺序排列，label 中的 idx 为原始视频帧序号、seg= 为所属段号。请据此完成规划。"
    return await _call_llm_vision_json(config, system_prompt, user_text, rep_images, max_tokens=6000)


@router.post("/generate/plan-char-scenes")
async def gen_plan_char_scenes(body: dict):
    """
    自动从代表帧中规划：全片主要人物 + 各段主场景（均含 ref_frame_url）。
    结果写入 plan_char_scenes.json，供 rcCharacters/rcScenes 直接消费生图。
    body: {workflow_id, chat_config_id, max_retries?}
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)

    # 读 rep_frames / keyframes / segments
    rp_path = os.path.join(wf_dir, "rep_frames.json")
    kf_path = os.path.join(wf_dir, "keyframes.json")
    seg_path = os.path.join(wf_dir, "segments.json")
    if not os.path.isfile(rp_path):
        raise HTTPException(status_code=400, detail="未找到 rep_frames.json，请先运行代表帧节点")
    if not os.path.isfile(kf_path):
        raise HTTPException(status_code=400, detail="未找到 keyframes.json")
    if not os.path.isfile(seg_path):
        raise HTTPException(status_code=400, detail="未找到 segments.json，请先运行智能分段")
    try:
        rep = json.load(open(rp_path, "r", encoding="utf-8")).get("segments", [])
        kf = json.load(open(kf_path, "r", encoding="utf-8")).get("frames", [])
        segs = json.load(open(seg_path, "r", encoding="utf-8")).get("segments", [])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取中间文件失败: {e}")

    url_map = {f.get("index"): f.get("url", "") for f in kf}
    ts_map = {f.get("index"): f.get("timestamp", 0.0) for f in kf}
    seg_by_idx = {s.get("index"): s for s in segs}

    # 收集全片代表帧；每张打 seg= / idx= 标签（限数量最多 24 张节省 token）
    images: list = []
    for rs in rep:
        si = rs.get("index")
        for idx in rs.get("picked_indices") or []:
            url = url_map.get(idx, "")
            if not url:
                continue
            b64 = _load_ref_image_b64(url)
            if not b64:
                continue
            images.append({"b64": b64, "label": f"seg={si} idx={idx}", "_seg": si, "_idx": idx})
            if len(images) >= 24:
                break
        if len(images) >= 24:
            break
    if not images:
        raise HTTPException(status_code=400, detail="代表帧图片加载失败")

    # 段简要
    segment_briefs = [{
        "segment_index": s.get("index"),
        "start": s.get("start", 0.0), "end": s.get("end", 0.0),
        "theme": s.get("theme", ""),
    } for s in segs]

    # 可选：读取用户已调整的 characters 作为参考
    existing = body.get("existing_characters") or []
    if not existing:
        rw_path = os.path.join(wf_dir, "rewrite_plot.json")
        if os.path.isfile(rw_path):
            try:
                existing = json.load(open(rw_path, "r", encoding="utf-8")).get("characters", [])
            except Exception:
                pass

    max_retries = max(0, int(body.get("max_retries", 2)))
    try:
        r = await _retry_async(
            lambda: llm_plan_char_and_scenes(config, images, segment_briefs, existing),
            max_retries=max_retries, label="plan-char-scenes",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"人物场景规划失败: {e}")

    # 整理人物（含 ref_frame_url）
    out_chars = []
    for c in r.get("characters") or []:
        rf_idx = c.get("ref_frame_index")
        try:
            rf_idx = int(rf_idx) if rf_idx is not None else None
        except (TypeError, ValueError):
            rf_idx = None
        out_chars.append({
            "name": c.get("name", ""),
            "features": c.get("features", ""),
            "original_desc": c.get("features", ""),
            "new_desc": "",
            "ref_frame_url": url_map.get(rf_idx, "") if rf_idx is not None else "",
            "ref_frame_index": rf_idx,
            "confidence": c.get("confidence", "medium"),
            "imageUrl": "",
        })

    # 整理段场景（对齐 segments 段号；缺的用占位）
    scenes_by_seg = {}
    for s in r.get("scenes") or []:
        si = s.get("segment_index")
        try:
            si = int(si) if si is not None else None
        except (TypeError, ValueError):
            si = None
        if si is None or si not in seg_by_idx:
            continue
        rf_idx = s.get("ref_frame_index")
        try:
            rf_idx = int(rf_idx) if rf_idx is not None else None
        except (TypeError, ValueError):
            rf_idx = None
        scenes_by_seg[si] = {
            "segment_index": si,
            "name": s.get("name", ""),
            "features": s.get("features", ""),
            "original_desc": s.get("features", ""),
            "new_desc": "",
            "ref_frame_url": url_map.get(rf_idx, "") if rf_idx is not None else "",
            "ref_frame_index": rf_idx,
            "imageUrl": "",
        }
    # 为每个 segment 都填一条（缺的用兜底：段 rep_frames 第一张）
    out_scenes = []
    for s in segs:
        si = s.get("index")
        if si in scenes_by_seg:
            out_scenes.append(scenes_by_seg[si])
            continue
        rep_item = next((x for x in rep if x.get("index") == si), None)
        fallback_idx = (rep_item.get("picked_indices") or [None])[0] if rep_item else None
        out_scenes.append({
            "segment_index": si,
            "name": s.get("theme", "")[:20],
            "features": "",
            "original_desc": "",
            "new_desc": "",
            "ref_frame_url": url_map.get(fallback_idx, "") if fallback_idx is not None else "",
            "ref_frame_index": fallback_idx,
            "imageUrl": "",
        })

    result = {"characters": out_chars, "scenes": out_scenes}
    try:
        with open(os.path.join(wf_dir, "plan_char_scenes.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  视频提示词生成（段级，终点）
#  参考通用短剧 /generate/video-prompt 模板
# ═══════════════════════════════════════════════════

@router.post("/generate/rc-video-prompt")
async def gen_rc_video_prompt(body: dict):
    """
    综合 新剧本段 + 本段分镜提示词（rc-storyboard 的 shots）+ 全片人物 + 本段场景 + 时长，
    输出带时间码分镜的视频生成提示词 full_text。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    wf_dir = get_workflow_dir(wf_id) if wf_id else None
    seg_idx = body.get("segment_index")
    if seg_idx is None:
        raise HTTPException(status_code=400, detail="缺少 segment_index")
    seg_idx = int(seg_idx)

    segment = body.get("segment") or {}
    shots = body.get("shots") or []
    characters = body.get("characters") or []
    scene = body.get("scene") or None
    duration = int(body.get("duration") or (segment.get("duration") or 15))
    style = body.get("style", "")
    vtype = body.get("type", "短视频")
    direction = body.get("direction", "")
    total_segments = int(body.get("total_segments") or 1)

    # 整篇剧本（来自 rcPlotRewrite/rcScript/输入剧情，前端按优先级挑好后传入）
    full_script = (body.get("full_script") or "").strip()
    full_script_source = body.get("full_script_source") or ""  # rewrite/script/input
    seg_start = float(segment.get("start") or 0.0)
    seg_end = float(segment.get("end") or (seg_start + duration))
    seg_text = segment.get("script") or segment.get("script_text") or segment.get("text") or segment.get("theme") or ""
    camera_notes = segment.get("camera_notes") or ""
    n_shots = len(shots)

    # 构建 @图片引用列表
    img_ref_lines = []
    vision_images = []
    img_idx = 1
    seen = set()
    for c in characters:
        url = c.get("imageUrl") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        b = _load_ref_image_b64(url)
        if not b:
            continue
        img_ref_lines.append(f"@图片{img_idx} 是人物·{c.get('name','')}（{(c.get('new_desc') or c.get('features') or '')[:40]}）")
        vision_images.append({"b64": b, "label": f"人物·{c.get('name','')}"})
        img_idx += 1
    if scene and scene.get("imageUrl"):
        url = scene["imageUrl"]
        if url not in seen:
            seen.add(url)
            b = _load_ref_image_b64(url)
            if b:
                img_ref_lines.append(f"@图片{img_idx} 是场景·{scene.get('name','')}（{(scene.get('new_desc') or scene.get('features') or '')[:40]}）")
                vision_images.append({"b64": b, "label": f"场景·{scene.get('name','')}"})
                img_idx += 1
    # 分镜参考图（每张独立 @图片）
    shot_ref_start = img_idx
    for si, sh in enumerate(shots):
        url = sh.get("ref_frame_url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        b = _load_ref_image_b64(url)
        if not b:
            continue
        img_ref_lines.append(f"@图片{img_idx} 是分镜 {si+1}（idx={sh.get('ref_frame_index')}）")
        vision_images.append({"b64": b, "label": f"分镜 {si+1}"})
        img_idx += 1

    # 分镜列表文本（按 shot 顺序，提示词内容摘要）
    shot_lines = []
    for si, sh in enumerate(shots):
        line = f"分镜 {si+1}：{(sh.get('prompt_cn') or sh.get('prompt_en') or '')[:100]}"
        if sh.get("composition_notes"):
            line += f" | 构图: {sh['composition_notes'][:40]}"
        shot_lines.append(line)
    shots_block = "\n".join(shot_lines) or "（无分镜）"

    chars_desc_block = "\n".join(
        f"- {c.get('name','')}: {c.get('new_desc') or c.get('features') or ''}"
        for c in characters
    ) or "（无）"
    scene_desc = (
        f"{scene.get('name','')}: {scene.get('new_desc') or scene.get('features') or ''}"
        if scene else "（无）"
    )

    has_any_ref = bool(img_ref_lines)
    if has_any_ref:
        ref_section = (
            "开头先列出图片引用声明（每行一个），空一行后再按时间码逐段描述画面：\n"
            + "\n".join(img_ref_lines)
            + '\n\n注意：开头声明完 @图片N 之后，正文中一律用名字引用（如"人物·小明"直接写"小明"），不要在正文继续写 @图片N。'
        )
    else:
        ref_section = "无参考图片，直接按时间码逐段描述画面。"

    # 根据分镜数智能分配时长建议
    if n_shots > 0:
        shot_section = (
            f"本段共 {n_shots} 个分镜，总时长 {duration} 秒。请根据每个分镜的叙事密度和节奏智能分配时长，"
            f"所有分镜时长之和必须等于 {duration} 秒。\n\n"
            f"分镜列表（按顺序）：\n{shots_block}"
        )
        cut_format = "格式：【起止时间 | 分镜N | 画面概述→动作变化 | 镜头运动方式】然后紧跟详细描述"
    else:
        num_shots = max(3, duration // 3)
        shot_section = (
            f"本段没有分镜参考。请根据剧本内容自行分析出 {num_shots} 个左右的关键剧情节点，"
            f"将 {duration} 秒视频均匀分配到这些节点上。"
        )
        cut_format = "格式：【起止时间 | 画面概述→动作变化 | 镜头运动方式】然后紧跟详细描述"

    example_cuts = (
        "【0-3s | 分镜1 | 冷雨巷口特写→缓拉中景 | 固定→慢拉】固定镜头超特写雨水打在小明紧握的伞柄上...镜头以1.5m/s慢拉至中景，小明站在巷口路灯下..."
        if n_shots > 0 else
        "【0-3s | 冷雨巷口特写→缓拉中景 | 固定→慢拉】固定镜头超特写雨水打在小明紧握的伞柄上..."
    )

    system_prompt = f"""你是AI视频生成提示词专家。为这段二创短剧的第 {seg_idx+1}/{total_segments} 段写 {duration} 秒视频提示词。{"仔细观察每张参考图片的实际内容。" if has_any_ref else ""}

风格：{style or '（未指定）'} | 类型：{vtype} | 二创方向：{direction or '（保持原有）'}

严格按照以下格式输出（不要输出JSON包装，直接输出纯文本）：

{ref_section}

{cut_format}

{shot_section}

本段镜头语言参考：{camera_notes or '（无）'}

每个时间段的详细描述必须包含：
1. 具体的镜头运动（推/拉/摇/移/跟/升/降/环绕/手持，含速度和距离）
2. 人物的精确动作、表情、姿态变化
3. 场景环境细节（光线方向、色调、氛围物体）
4. 特效和视觉效果（粒子、光效、物理效果）
5. 景别变化（特写→近景→中景→全景→远景）
6. 如果剧本中有台词或对白，必须在对应时间段内完整写出台词内容（用引号标注），并注明说话人、语气和情绪

【本段人物】
{chars_desc_block}

【本段场景】
{scene_desc}

参考示例格式：
{example_cuts}

重要：full_text 总字数不得超过2000字，精炼描述，突出关键画面和动作。

只输出JSON：{{"full_text": "完整提示词文本"}}"""

    user_prompt_parts = []
    if full_script:
        src_label = {"rewrite": "改编新剧本", "script": "原视频剧本", "input": "用户输入的剧情梗概"}.get(full_script_source, "完整剧本参考")
        user_prompt_parts.append(f"【{src_label}（整片）】\n{full_script[:6000]}")
    user_prompt_parts.append(
        f"【本段时间窗】{seg_start:.1f}s ~ {seg_end:.1f}s（共 {duration} 秒）。请只为这段时间窗内的画面写提示词，叙事内容请从整片剧本中按时间窗对应的部分提取。"
    )
    if seg_text:
        user_prompt_parts.append(f"【本段补充信息】{seg_text}")
    user_prompt = "\n\n".join(user_prompt_parts)

    max_retries = max(0, int(body.get("max_retries", 2)))
    try:
        if vision_images:
            result = await _retry_async(
                lambda: _call_llm_vision_json(config, system_prompt, user_prompt, vision_images, max_tokens=32000),
                max_retries=max_retries, label=f"rc-video-prompt seg={seg_idx}",
            )
        else:
            result = await _retry_async(
                lambda: _call_llm_json(config, system_prompt, user_prompt, max_tokens=32000),
                max_retries=max_retries, label=f"rc-video-prompt seg={seg_idx} (text)",
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"视频提示词生成失败: {e}")

    return JSONResponse({"code": 0, "data": {"full_text": result.get("full_text") or ""}})


# ═══════════════════════════════════════════════════
#  画面生成路由已移除（rc-video-prompt 是终点）
# ═══════════════════════════════════════════════════
