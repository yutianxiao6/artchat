"""
recreate_router.py — 二创影视剧工作流专用路由
各接口解耦，职责单一，便于后续扩展。
"""

import os
import json
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


async def _call_llm_json(config: dict, system_prompt: str, user_prompt: str, max_tokens: int = 20000) -> dict:
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config['api_key']}"}
    url = config["api_base"].rstrip("/") + "/chat/completions"
    data = {
        "model": config["model_name"],
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        "temperature": 0.7, "stream": False, "max_tokens": max_tokens,
        "response_format": {"type": "json_object"}
    }
    response = await async_http_request("POST", url, headers, data, timeout=180.0)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text[:500])
    result = response.json()
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content or not content.strip():
        raise HTTPException(status_code=500, detail="模型返回空内容")
    return _parse_json_robust(content)


async def _call_llm_vision_json(config: dict, system_prompt: str, user_text: str, images: list, max_tokens: int = 20000) -> dict:
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
        response = await async_http_request("POST", url, headers, data, timeout=180.0)
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
        response = await async_http_request("POST", url, headers, data, timeout=180.0)
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
    输出：{full_script, segments:[{index,start,end,theme,script_text,camera_notes,frame_range:[s,e]}]}
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
    plot_block = f"\n【原始剧情参考】\n{plot[:1200]}\n" if plot else ""

    system_prompt = f"""你是一位影视剧本撰写师。已有一份按批次记录的原视频帧序列笔记（见下方，每批包含运镜摘要+剧情片段）。

任务：把所有批次合并为**一份连贯完整的剧本演绎文本**，并按叙事节奏**自然分段**（段数由叙事决定，3~15 段之间）。

要求：
1. full_script：整部视频的完整连贯叙事（不拘泥批次边界，避免碎片化，控制在 400~1500 字）
2. segments：按叙事自然段（不是按批次等分），每段给：
   - start/end：对应原视频的时间（秒），必须严格按时间递进不重叠
   - theme：一句话主题（≤20 字）
   - script_text：本段剧情文本（80~300 字，包含动作/对白/情绪）
   - camera_notes：本段运镜摘要（综合所涉批次的运镜描述）
   - frame_range：[起始原始帧 index, 结束原始帧 index]
3. 全部段的时间范围覆盖 0 到 {duration:.2f}s（最后一段 end 接近视频时长）
{plot_block}
只输出 JSON：
{{
  "full_script":"整片剧本文本",
  "segments":[
    {{"index":0,"start":0.0,"end":12.5,"theme":"...","script_text":"...","camera_notes":"...","frame_range":[0,5]}}
  ]
}}"""
    user_text = f"视频总时长 {duration:.2f}s。原始批次笔记：\n\n{raw_text}"
    return await _call_llm_json(config, system_prompt, user_text, max_tokens=16000)


@router.post("/generate/script")
async def gen_script(body: dict):
    """
    Round 1.5：基于 frame_labels.batches 合成完整剧本并分段。
    输入：{workflow_id, chat_config_id, max_retries?}
    输出：{full_script, segments:[...]} 写入 script.json。
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

    # 规范化 segments
    segs = raw.get("segments") or []
    out_segs = []
    for i, s in enumerate(segs):
        start = max(0.0, float(s.get("start", 0.0)))
        end = min(duration, float(s.get("end", 0.0)))
        if end <= start:
            continue
        fr = s.get("frame_range") or [0, 0]
        if not isinstance(fr, list) or len(fr) < 2:
            fr = [0, 0]
        out_segs.append({
            "index": len(out_segs),
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(end - start, 2),
            "theme": (s.get("theme") or "")[:40],
            "script_text": s.get("script_text") or "",
            "camera_notes": s.get("camera_notes") or "",
            "frame_range": [int(fr[0]), int(fr[1])],
        })

    result = {"full_script": raw.get("full_script") or "", "segments": out_segs}
    try:
        with open(os.path.join(wf_dir, "script.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  Round 2：智能分段（纯文本 LLM）
#  职责：把视觉帧分配到 rewrite-plot 决定的段数上
# ═══════════════════════════════════════════════════

async def llm_smart_segment(
    config: dict,
    script_segments: list,     # 原剧本段：[{index,start,end,script_text,frame_range:[s,e]}]
    rewrite_segments: list,    # 新剧本段：[{index,script,dialogue,seconds,text,...}]
    duration: float,
    keyframes: "list | None" = None,  # [{index,url,timestamp}]，用于挑缩略图
    max_seg_sec: float = 10.0,
    min_seg_sec: float = 3.0,
    max_thumbs_per_origin: int = 1,
) -> dict:
    """
    视觉增强：为每个原剧本段送 1~2 张缩略图，让 LLM 结合画面与新剧情文本决定分段。
    硬约束：**所有新段的时长总和 ≥ 视频时长**（只增不减，覆盖全部画面）。
    输出每段的 start/end 和 frame_indices。
    """
    rw_block = "\n".join(
        f"新段 {s.get('index', i)} | 建议时长 {float(s.get('seconds') or 0):.1f}s: "
        + ((s.get('script') or s.get('text') or '').replace(chr(10), ' ')[:220])
        for i, s in enumerate(rewrite_segments)
    )
    # 采样缩略图：每个原剧本段取中间一帧
    images: list = []
    kf_url = {f.get("index"): f.get("url", "") for f in (keyframes or [])}
    sc_lines = []
    for i, s in enumerate(script_segments):
        fr = s.get("frame_range") or [0, 0]
        sc_lines.append(
            f"原段 {s.get('index', i)} [{s.get('start',0):.1f}s-{s.get('end',0):.1f}s | 帧{fr[0]}-{fr[1]}]: "
            + (s.get("script_text") or "").replace("\n", " ")[:160]
        )
        # 挑中间一帧送入视觉
        fr_lo, fr_hi = int(fr[0]), int(fr[1])
        if fr_hi < fr_lo:
            fr_lo, fr_hi = fr_hi, fr_lo
        mid = (fr_lo + fr_hi) // 2
        url = kf_url.get(mid) or kf_url.get(fr_lo) or kf_url.get(fr_hi)
        if url:
            b64 = _load_ref_image_b64(url)
            if b64:
                images.append({"b64": b64, "label": f"原段{s.get('index', i)} 中间帧"})
                if len(images) >= len(script_segments) * max_thumbs_per_origin:
                    continue

    sc_block = "\n".join(sc_lines)
    n_target = len(rewrite_segments)
    total_suggested = sum(float(s.get("seconds") or 0) for s in rewrite_segments)

    system_prompt = f"""你是一位影视剪辑师。综合画面缩略图 + 原剧本段 + 改编新剧本段，决定如何把新剧情段安排到视频时间轴上。

关键硬约束：
1. 输出 **正好 {n_target} 段**，index 与新剧情段号一致
2. **时长只增不减**：所有段时长之和 ≥ 视频时长（{duration:.2f}s）。二创允许扩展时长（因为可能加对白/情绪停顿/额外镜头），但**严禁压缩**。新剧情建议总时长 {total_suggested:.1f}s，请据此分配每段 seconds
3. 每段硬约束：{min_seg_sec:.1f}s ≤ seconds ≤ {max_seg_sec:.1f}s（段要短，便于分镜设计）
4. start/end 表示该段**对应的原视频时间范围**（用于选参考帧）：start/end 按 0→{duration:.2f} 递进覆盖，第 1 段 start=0，最后一段 end={duration:.2f}；相邻段的 end/start 相等不重叠
5. seconds 表示**新剧情本段目标时长**（可以 > end-start，因为二创延长）
6. frame_indices：从原段 frame_range 挑选与本段 [start,end] 相交的原始帧 index（整数数组）
7. theme 必须概括**新剧情**（≤25 字），不要沿用原剧本
8. 请结合画面缩略图（标注了原段 index）理解画面节奏，确认段边界落在画面切换的合理位置

只输出 JSON：
{{
  "segments":[
    {{"index":0,"start":0.0,"end":6.2,"seconds":7.5,"theme":"新剧情主题","frame_indices":[0,1,2],"source_origin_segments":[0],"transitions":{{"in":"fade_in","out":"cut"}},"characters_in_scene":["..."]}}
  ]
}}"""
    user_text = (
        f"视频总时长 {duration:.2f}s，目标新段数 {n_target}；新剧情建议总时长 {total_suggested:.1f}s（允许 ≥ 视频时长）。\n\n"
        f"【改编新剧本（含建议时长）】\n{rw_block}\n\n"
        f"【原剧本分段（提供时间/帧范围参考；theme 不要沿用原剧本）】\n{sc_block}\n\n"
        f"已附上 {len(images)} 张原段中间帧缩略图供画面参考。"
    )
    if images:
        return await _call_llm_vision_json(config, system_prompt, user_text, images, max_tokens=12000)
    return await _call_llm_json(config, system_prompt, user_text, max_tokens=12000)


def _enforce_segment_constraints(
    segments: list, duration: float,
    max_seg_sec: float = 10.0, min_seg_sec: float = 3.0,
) -> list:
    """
    后端兜底：
      1. 把 start/end 规范化到 [0, duration]，相邻不重叠，首段 start=0，尾段 end=duration
      2. seconds 字段：保留 LLM 给的值（允许 > end-start，表示二创目标时长）；缺失则回填 end-start
      3. 超短段（视频时间段 < min_seg_sec）并入邻段；超长段切分
    """
    cleaned = []
    for seg in segments:
        start = max(0.0, float(seg.get("start", 0.0)))
        end = min(duration, float(seg.get("end", 0.0)))
        if end <= start:
            continue
        seconds = float(seg.get("seconds", end - start) or (end - start))
        cleaned.append({
            **seg,
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(end - start, 2),
            "seconds": round(max(seconds, end - start), 2),  # seconds 至少等于视频段长
            "frame_indices": list(seg.get("frame_indices") or []),
        })
    cleaned.sort(key=lambda s: s["start"])
    if not cleaned:
        return []

    # 修补首尾，把 start=0 / end=duration，中间段相邻端点衔接
    cleaned[0]["start"] = 0.0
    cleaned[-1]["end"] = round(duration, 2)
    for i in range(1, len(cleaned)):
        prev = cleaned[i-1]
        cur = cleaned[i]
        cur["start"] = prev["end"]
        if cur["end"] <= cur["start"]:
            cur["end"] = min(duration, cur["start"] + 0.1)
    for s in cleaned:
        s["duration"] = round(s["end"] - s["start"], 2)
        s["seconds"] = round(max(s.get("seconds", s["duration"]), s["duration"]), 2)

    # 合并超短段（基于视频段长）
    merged = []
    for seg in cleaned:
        if merged and seg["duration"] < min_seg_sec:
            prev = merged[-1]
            prev["end"] = seg["end"]
            prev["duration"] = round(prev["end"] - prev["start"], 2)
            prev["seconds"] = round(prev.get("seconds", 0) + seg.get("seconds", 0), 2)
            prev["frame_indices"] = list(prev["frame_indices"]) + list(seg["frame_indices"])
            continue
        merged.append(dict(seg))

    # 切超长段（视频段长 > max_seg_sec）
    final = []
    for seg in merged:
        dur = seg["duration"]
        if dur <= max_seg_sec + 0.01:
            final.append(seg)
            continue
        n_sub = max(2, int((dur + max_seg_sec - 0.01) // max_seg_sec) + (1 if dur % max_seg_sec > 0 else 0))
        sub_dur = dur / n_sub
        seconds_per_sub = seg.get("seconds", dur) / n_sub
        frame_idx = seg["frame_indices"]
        for k in range(n_sub):
            s = seg["start"] + k * sub_dur
            e = min(seg["end"], s + sub_dur)
            per = max(1, len(frame_idx) // n_sub) if frame_idx else 0
            sub_indices = frame_idx[k * per: (k + 1) * per] if (frame_idx and k < n_sub - 1) else (frame_idx[k * per:] if frame_idx else [])
            final.append({
                **seg,
                "start": round(s, 2),
                "end": round(e, 2),
                "duration": round(e - s, 2),
                "seconds": round(seconds_per_sub, 2),
                "theme": (seg.get("theme") or "") + (f"（{k+1}/{n_sub}）" if n_sub > 1 else ""),
                "frame_indices": sub_indices,
            })

    for i, s in enumerate(final):
        s["index"] = i
    return final


@router.post("/generate/smart-segment")
async def gen_smart_segment(body: dict):
    """
    Round 2：基于原剧本（script.json）+ 新剧本（rewrite_plot.json）做分段对齐。
    不再发帧序列给 LLM，token 消耗显著降低。
    输入 body: {workflow_id, chat_config_id, script_segments?, rewrite_segments?, max_seg_sec?, min_seg_sec?}
    输出写入 segments.json。
    """
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    if not wf_id:
        raise HTTPException(status_code=400, detail="缺少 workflow_id")
    wf_dir = get_workflow_dir(wf_id)
    max_seg_sec = float(body.get("max_seg_sec", 10.0))
    min_seg_sec = float(body.get("min_seg_sec", 3.0))

    # 读原剧本段（script.json）
    script_segments = body.get("script_segments") or []
    if not script_segments:
        sc_path = os.path.join(wf_dir, "script.json")
        if os.path.isfile(sc_path):
            try:
                script_segments = json.load(open(sc_path, "r", encoding="utf-8")).get("segments", [])
            except Exception:
                script_segments = []
    if not script_segments:
        raise HTTPException(status_code=400, detail="未找到剧本演绎结果（请先运行 /generate/script）")

    # 读新剧本段（rewrite_plot.json）
    rewrite_segments = body.get("rewrite_segments") or []
    if not rewrite_segments:
        rw_path = os.path.join(wf_dir, "rewrite_plot.json")
        if os.path.isfile(rw_path):
            try:
                rewrite_segments = json.load(open(rw_path, "r", encoding="utf-8")).get("segments", [])
            except Exception:
                rewrite_segments = []
    if not rewrite_segments:
        raise HTTPException(status_code=400, detail="未提供新剧情段数（请先运行剧情重编排）")

    # 读 keyframes（供视觉）
    keyframes_list: list = []
    duration = float(body.get("duration", 0.0))
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            kf_data = json.load(open(kf_path, "r", encoding="utf-8"))
            keyframes_list = kf_data.get("frames", [])
            if duration <= 0:
                duration = float(kf_data.get("duration", 0.0))
        except Exception:
            pass
    if duration <= 0:
        duration = max((s.get("end", 0.0) for s in script_segments), default=0.0)

    # 单段情况
    if len(rewrite_segments) <= 1:
        all_indices = []
        for s in script_segments:
            fr = s.get("frame_range") or [0, 0]
            for i in range(int(fr[0]), int(fr[1]) + 1):
                all_indices.append(i)
        rw0 = rewrite_segments[0] if rewrite_segments else {}
        seg = {
            "index": 0, "start": 0.0, "end": round(duration, 2), "duration": round(duration, 2),
            "seconds": round(max(float(rw0.get("seconds", duration) or duration), duration), 2),
            "theme": (rw0.get("script") or rw0.get("text") or "全片")[:25],
            "frame_indices": sorted(set(all_indices)),
            "transitions": {"in": "none", "out": "none"},
            "characters_in_scene": rw0.get("characters_in_scene") or [],
        }
        result = {"segments": [seg], "constraints": {"max_seg_sec": max_seg_sec, "min_seg_sec": min_seg_sec}}
    else:
        try:
            raw = await _retry_async(
                lambda: llm_smart_segment(
                    config, script_segments, rewrite_segments, duration,
                    keyframes=keyframes_list,
                    max_seg_sec=max_seg_sec, min_seg_sec=min_seg_sec,
                ),
                max_retries=max(0, int(body.get("max_retries", 2))),
                label="smart-segment",
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"智能分段失败: {e}")
        segments = _enforce_segment_constraints(
            raw.get("segments") or [], duration,
            max_seg_sec=max_seg_sec, min_seg_sec=min_seg_sec,
        )
        result = {
            "segments": segments,
            "constraints": {"max_seg_sec": max_seg_sec, "min_seg_sec": min_seg_sec},
        }

    try:
        with open(os.path.join(wf_dir, "segments.json"), "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  Round 3：段内选代表帧（视觉 LLM）
# ═══════════════════════════════════════════════════

def _target_count_for_duration(dur: float, rule: dict) -> int:
    if dur < float(rule.get("lt5_threshold", 5.0)):
        return int(rule.get("lt5", 4))
    if dur < float(rule.get("lt10_threshold", 10.0)):
        return int(rule.get("lt10", 6))
    return int(rule.get("default", 9))


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
    if not frame_labels:
        raise HTTPException(status_code=400, detail="未找到 frame_labels")

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
    target_rule = body.get("target_rule") or {"lt5": 4, "lt10": 6, "default": 9}

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

    # 从 script.json 读完整原剧本（首选，比零散帧标注连贯得多）
    script_full = ""
    script_segments: list = []
    sc_path = os.path.join(wf_dir, "script.json")
    if os.path.isfile(sc_path):
        try:
            sc = json.load(open(sc_path, "r", encoding="utf-8"))
            script_full = sc.get("full_script", "")
            script_segments = sc.get("segments", [])
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
        lines = []
        for f in frame_labels:
            ct = (f.get("content") or "").replace("\n", " ")[:50]
            if not ct:
                continue
            ts = f.get("timestamp", 0.0)
            sub = f.get("subtitle") or ""
            line = f"  [{ts:.1f}s] {ct}"
            if sub:
                line += f" ‹{sub[:30]}›"
            lines.append(line)
        timeline_text = "\n".join(lines)

    overview_block = ""
    if overview:
        overview_block = f"\n【全局清单参考】\n{json.dumps(overview, ensure_ascii=False, indent=2)}\n"

    # 构造原视频剧本块（优先用 script.json 的连贯版本）
    if script_full:
        script_block = f"\n【原视频剧本演绎（按时间顺序的完整叙事）】\n{script_full}\n"
        if script_segments:
            sc_brief = "\n".join(
                f"  段 {s.get('index')} [{s.get('start',0):.1f}s-{s.get('end',0):.1f}s]: {s.get('theme','')}"
                for s in script_segments
            )
            script_block += f"\n【原剧本分段概览】\n{sc_brief}\n"
    elif timeline_text:
        script_block = f"\n【原视频帧内容摘要（按时间顺序）】\n{timeline_text}\n"
    else:
        script_block = ""

    # 视频总时长（用于 duration 建议约束）
    video_duration = 0.0
    kf_path2 = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path2):
        try:
            video_duration = float(json.load(open(kf_path2, "r", encoding="utf-8")).get("duration", 0.0))
        except Exception:
            pass
    dur_hint = f"（视频总时长 {video_duration:.1f} 秒）" if video_duration > 0 else ""

    system_prompt = f"""你是一位影视二次创作编剧。请基于下列材料重新编排剧情。

【二创方向】{direction or '（用户未指定，保持原有叙事结构，优化节奏）'}
【目标风格】{style or '（保持原风格）'}

要求：
1. **段数要多、每段要短**：建议 **8~20 段**；每段建议时长 **4~10 秒**（便于后续分镜设计）
2. **总时长只增不减**：新剧情所有段的 seconds 之和**必须 ≥ 视频总时长 {video_duration:.1f} 秒**（可显著大于；严禁压缩）。二创通常会加入新情节/铺垫/情绪停顿，允许最多达到原时长的 2 倍
3. 每段应能对应一段连续时间的画面（段序必须与视频时间线自然对应）
4. 每段产出：
   - script：本段**详细剧本**，完整包含动作/场景变化/情绪节拍/**运镜过渡安排**（如"开场近景缓推→中景切换→对手镜头"），供后续分镜使用；100~300 字
   - dialogue：本段**台词、旁白、画外音**集合（按出场顺序分别注明说话人、情绪；无则写 "（无对白）"）
   - seconds：本段建议时长（浮点数，单位秒，4~10 秒为宜）
   - scene_action：keep/modify/new
   - characters_in_scene：本段出场人物名（沿用全局清单 name）
5. 人物清单 characters：列出全片主要人物（沿用全局清单 name，追加新形象描述）
6. scenes 字段仅列出新增或大改的场景，保持原场景的不用写

只输出 JSON：
{{
  "segments": [
    {{
      "index":0,
      "script":"包含动作场景情绪运镜过渡的详细剧本",
      "dialogue":"台词/旁白",
      "seconds":6.0,
      "scene_action":"keep",
      "scene_note":"",
      "characters_in_scene":["角色A"]
    }}
  ],
  "characters": [
    {{"name":"角色A","original_desc":"...","new_desc":"..."}}
  ],
  "scenes": [
    {{"name":"场景X","original_desc":"...","new_desc":"..."}}
  ]
}}"""
    user_prompt = (
        f"【用户输入的原始剧情（梗概）】\n{original_plot}\n{overview_block}"
        f"{script_block}\n"
        f"请按二创方向重新编排，产出新的分段剧情与人物/场景清单。"
    )
    result = await _retry_async(
        lambda: _call_llm_json(config, system_prompt, user_prompt, max_tokens=20000),
        max_retries=max(0, int(body.get("max_retries", 2))),
        label="rewrite-plot",
    )

    # 规范化：强制 index 连续；字段兜底（兼容老字段名 text → script）
    segs = result.get("segments") or []
    for i, s in enumerate(segs):
        s["index"] = i
        if not s.get("script"):
            s["script"] = s.get("text", "")
        if "text" not in s:
            s["text"] = s.get("script", "")  # 保持 text 字段兼容下游（smart-segment 等仍读 text）
        s["dialogue"] = s.get("dialogue", "") or ""
        try:
            s["seconds"] = float(s.get("seconds", 0))
        except (TypeError, ValueError):
            s["seconds"] = 0.0

    out = {
        "segments": segs,
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
    基于用户对话修改剧情重编排。接受当前 segments/characters/scenes + 对话历史 + 用户消息，
    产出更新后的 segments/characters/scenes。允许用户调整段数、修改单段内容、改变二创方向。
    body: {
      workflow_id, chat_config_id,
      current_segments, current_characters?, current_scenes?,
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

    current_segments = body.get("current_segments") or []
    current_characters = body.get("current_characters") or []
    current_scenes = body.get("current_scenes") or []
    chat_history = body.get("chat_history") or []
    direction = (body.get("direction") or "").strip()
    style = (body.get("style") or "").strip()

    # 视频时长（用于硬约束）
    video_duration = 0.0
    kf_path = os.path.join(wf_dir, "keyframes.json")
    if os.path.isfile(kf_path):
        try:
            video_duration = float(json.load(open(kf_path, "r", encoding="utf-8")).get("duration", 0.0))
        except Exception:
            pass

    cur_block = json.dumps({
        "segments": current_segments,
        "characters": current_characters,
        "scenes": current_scenes,
    }, ensure_ascii=False, indent=2)

    history_block = ""
    if chat_history:
        history_block = "\n【对话历史】\n" + "\n".join(
            f"[{m.get('role','user')}] {(m.get('content') or '')[:500]}"
            for m in chat_history[-10:]  # 最近 10 条
        )

    system_prompt = f"""你是一位影视二次创作编剧。用户正在审阅已有的改编剧本，并通过对话要求调整。请根据用户消息修改剧本并输出完整新版本。

【二创方向】{direction or '（保持原有）'}
【目标风格】{style or '（保持原风格）'}
【视频时长】{video_duration:.1f} 秒

硬约束：
1. 总时长只增不减：所有段 seconds 之和 ≥ {video_duration:.1f} 秒
2. 每段 seconds 4~10 秒（便于分镜）
3. 段数可以增加或减少（按用户要求）
4. 每段必须输出 script（含运镜过渡的详细剧本）+ dialogue（台词/旁白）+ seconds + characters_in_scene
5. 输出**完整新版本**（不是增量），包含所有段（用户只指定修改某段时，其他段保持原样）
6. 必须在 message 字段对用户说明本次改动（做了哪些修改、为什么）

只输出 JSON：
{{
  "segments":[{{"index":0,"script":"...","dialogue":"...","seconds":6.0,"scene_action":"keep","characters_in_scene":["..."]}}],
  "characters":[{{"name":"...","original_desc":"...","new_desc":"..."}}],
  "scenes":[{{"name":"...","original_desc":"...","new_desc":"..."}}],
  "message":"对用户说明本次改动的文字（200 字内）"
}}"""
    user_prompt = (
        f"【当前剧本编排（完整 JSON）】\n{cur_block}\n"
        f"{history_block}\n\n"
        f"【用户本次消息】\n{user_message}\n\n"
        f"请基于用户要求修改剧本，输出完整新版本。"
    )

    try:
        result = await _retry_async(
            lambda: _call_llm_json(config, system_prompt, user_prompt, max_tokens=20000),
            max_retries=max(0, int(body.get("max_retries", 2))),
            label="rewrite-plot-chat",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"对话修改失败: {e}")

    # 规范化 segments（同 gen_rewrite_plot）
    segs = result.get("segments") or []
    for i, s in enumerate(segs):
        s["index"] = i
        if not s.get("script"):
            s["script"] = s.get("text", "")
        if "text" not in s:
            s["text"] = s.get("script", "")
        s["dialogue"] = s.get("dialogue", "") or ""
        try:
            s["seconds"] = float(s.get("seconds", 0))
        except (TypeError, ValueError):
            s["seconds"] = 0.0

    out = {
        "segments": segs,
        "characters": result.get("characters") or current_characters,
        "scenes": result.get("scenes") or current_scenes,
        "message": result.get("message", "") or "",
    }
    # 持久化当前版本（同步覆盖 rewrite_plot.json，供下游消费）
    try:
        with open(os.path.join(wf_dir, "rewrite_plot.json"), "w", encoding="utf-8") as f:
            json.dump({"segments": out["segments"], "characters": out["characters"], "scenes": out["scenes"]}, f, ensure_ascii=False, indent=2)
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

    user_prompt = f"段落剧本：{seg_text}"

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
