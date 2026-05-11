"""
recreate_router.py — 二创影视剧工作流专用路由
各接口解耦，职责单一，便于后续扩展。
"""

import os
import json
import base64 as b64mod
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from backend.core.workflow_storage import (
    get_workflow_dir, save_workflow_image, WORKFLOW_ROOT
)
from backend.core.video_processor import (
    check_ffmpeg, get_video_metadata, extract_keyframes, recommend_max_frames
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
    from backend.api.config_router import config_list
    for c in config_list:
        if c.get("id") == config_id:
            return c
    return None


def _get_first_config(config_type: str):
    from backend.api.config_router import config_list
    allowed = [config_type, "both"]
    for c in config_list:
        if c.get("config_type") in allowed:
            return c
    return None


def _parse_json_robust(content: str) -> dict:
    """从 AI 返回的文本中提取 JSON"""
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        start = 1
        end = len(lines)
        for i in range(1, len(lines)):
            if lines[i].strip() == "```":
                end = i
                break
        content = "\n".join(lines[start:end])
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        import re
        match = re.search(r'\{[\s\S]*\}', content)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        match = re.search(r'\[[\s\S]*\]', content)
        if match:
            try:
                return {"items": json.loads(match.group())}
            except json.JSONDecodeError:
                pass
    raise ValueError("无法解析 AI 返回的 JSON")


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

@router.post("/extract-keyframes/{workflow_id}")
async def extract_keyframes_api(workflow_id: str, body: dict):
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

    mode = body.get("mode", "scene")
    max_frames = min(int(body.get("max_frames", 30)), 80)
    interval_sec = float(body.get("interval_sec", 2.0))
    scene_threshold = float(body.get("scene_threshold", 0.3))

    frames_dir = os.path.join(wf_dir, "keyframes")
    if os.path.isdir(frames_dir):
        import shutil
        shutil.rmtree(frames_dir)
    os.makedirs(frames_dir, exist_ok=True)

    frames = await extract_keyframes(
        video_path, frames_dir,
        mode=mode, max_frames=max_frames,
        interval_sec=interval_sec, scene_threshold=scene_threshold,
    )

    for frame in frames:
        frame["url"] = f"/workflow-images/{workflow_id}/keyframes/{frame['filename']}"

    return JSONResponse({"code": 0, "data": {"frames": frames}})


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
            media_type, raw = _parse_b64_image(img["b64"])
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


# ═══════════════════════════════════════════════════
#  接口 4: 帧内容分析（Vision AI）
# ═══════════════════════════════════════════════════

@router.post("/generate/frame-analysis")
async def gen_frame_analysis(body: dict):
    """
    两阶段分析：
    阶段1（全局脉络）：所有帧一次性送入 Vision，返回人物清单 + 场景清单 + 整体叙事脉络
    阶段2（细节分析）：将帧分批并发，每批带上阶段1的全局清单作为上下文
    """
    import asyncio
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    wf_id = body.get("workflow_id", "")
    frame_urls = body.get("frames", [])
    batch_size = int(body.get("batch_size", 6))
    max_concurrent = int(body.get("max_concurrent", 3))
    if not frame_urls:
        raise HTTPException(status_code=400, detail="未提供关键帧")

    images = []
    for i, frame in enumerate(frame_urls):
        url = frame.get("url", "") if isinstance(frame, dict) else str(frame)
        ts = frame.get("timestamp", 0) if isinstance(frame, dict) else 0
        b64 = _load_ref_image_b64(url)
        if b64:
            images.append({"b64": b64, "label": f"帧{i+1}@{ts:.1f}s", "index": i, "timestamp": ts})
    if not images:
        raise HTTPException(status_code=400, detail="无法加载关键帧图片")

    # 阶段 1：全局脉络
    overview = await _phase1_overview(config, images)

    # 阶段 2：分批并发细节分析
    batches = [images[s:s + batch_size] for s in range(0, len(images), batch_size)]
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _run_batch(batch):
        async with semaphore:
            try:
                return await _phase2_batch(config, batch, overview)
            except Exception as e:
                print(f"[frame-analysis] 批次失败: {e}")
                return {"frames": [{"index": img["index"], "scene": "", "characters": "",
                                    "composition": "", "mood": "", "dialogue": "",
                                    "error": str(e)[:200]} for img in batch]}

    batch_results = await asyncio.gather(*[_run_batch(b) for b in batches])

    all_frames = []
    for r in batch_results:
        all_frames.extend(r.get("frames", []))
    all_frames.sort(key=lambda x: x.get("index", 0))

    return JSONResponse({"code": 0, "data": {
        "frames": all_frames,
        "overview": overview,
    }})


async def _phase1_overview(config: dict, images: list) -> dict:
    """阶段1：所有帧浏览一遍，提取人物清单、场景清单、叙事脉络。"""
    system_prompt = """你是一位专业的影视分析师。现在将看到一部视频的全部关键帧序列。

请先做一次"全局扫描"，提取：
1. characters: 出现的所有人物（按首次出场顺序），每个人物的稳定外貌特征（避免用"红衣男子"这种位置依赖描述，而用"身穿红色唐装、短发、约30岁的男性"）
2. scenes: 所有独立场景地点（去重），每个场景的环境特征
3. narrative: 整体叙事脉络（开头/发展/高潮/结尾），包括情绪变化曲线

这份清单会作为后续逐帧深入分析的锚点——所以**务必统一人物和场景命名**，并描述足够具体以便后续识别。

只输出JSON：
{
  "characters": [
    {"id": "char_1", "name": "人物1（或昵称）", "features": "稳定外貌特征（发型、服装、体态、年龄）"}
  ],
  "scenes": [
    {"id": "scene_1", "name": "场景1", "features": "环境特征"}
  ],
  "narrative": "整体叙事脉络文字描述"
}"""
    overview_images = images[:40]
    user_text = f"共 {len(overview_images)} 张关键帧，请按时间顺序浏览，提取全局清单。"
    return await _call_llm_vision_json(config, system_prompt, user_text, overview_images, max_tokens=8000)


async def _phase2_batch(config: dict, batch: list, overview: dict) -> dict:
    """阶段2：用阶段1的全局清单作为上下文，深入分析本批图片。"""
    import json as _json
    overview_text = _json.dumps(overview, ensure_ascii=False, indent=2)

    system_prompt = f"""你是一位专业的影视分析师。下面是本视频的全局清单（已在前序分析中确立）：

【全局清单】
{overview_text}

请逐帧深入分析本批图片。要求：
1. 提到人物时，**必须使用全局清单中已有的 name 或 id**，不要创造新名字
2. 提到场景时，**必须对应全局清单中的 scene**（若不在清单则用"未列入清单的场景：xxx"）
3. 如果画面中有人物不在清单里（可能是前序分析遗漏），用 "新人物：简述"
4. 每帧输出：scene / characters / composition / mood / dialogue

只输出JSON：
{{
  "frames": [
    {{
      "index": 0,
      "scene": "对应场景名或新场景描述",
      "characters": "该帧中出现的人物及动作表情（使用清单中的 name）",
      "composition": "镜头角度 / 人物位置 / 景别",
      "mood": "情绪基调",
      "dialogue": "推测的对话或旁白"
    }}
  ]
}}"""
    batch_info = ", ".join([f"帧{img['index']+1}" for img in batch])
    index_list = ", ".join([str(img["index"]) for img in batch])
    user_text = (
        f"本批共 {len(batch)} 张帧（{batch_info}），请按全局清单深入分析每一帧。"
        f"返回时 index 字段必须填写帧在视频中的原始序号（从 0 开始）：{index_list}"
    )
    return await _call_llm_vision_json(config, system_prompt, user_text, batch, max_tokens=10000)


# ═══════════════════════════════════════════════════
#  接口 5: 剧情-帧对齐
# ═══════════════════════════════════════════════════

@router.post("/generate/plot-align")
async def gen_plot_align(body: dict):
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    original_plot = body.get("original_plot", "")
    frame_analyses = body.get("frame_analyses", [])
    overview = body.get("overview", {})
    if not original_plot:
        raise HTTPException(status_code=400, detail="未提供原始剧情")
    if not frame_analyses:
        raise HTTPException(status_code=400, detail="未提供帧分析结果")

    frames_desc = "\n".join([
        f"帧{f.get('index', i)}: 场景={f.get('scene','')}, 人物={f.get('characters','')}, 情绪={f.get('mood','')}"
        for i, f in enumerate(frame_analyses)
    ])

    overview_block = ""
    if overview:
        import json as _json
        overview_block = f"\n【全局清单（人物/场景锚点）】\n{_json.dumps(overview, ensure_ascii=False, indent=2)}\n"

    system_prompt = """你是一位专业的影视剪辑师。将原始剧情文本与关键帧序列进行对齐，形成分段结构。

要求：
1. 根据关键帧的场景切换点，将剧情自然分段
2. 每段对应一组连续的关键帧
3. 保持剧情的完整性，不遗漏任何情节
4. 如果提供了全局清单，**每段的 characters_in_scene 字段必须使用清单中的人物 name**

只输出JSON：
{
  "segments": [
    {
      "index": 0,
      "frame_indices": [0, 1, 2],
      "plot_text": "该段对应的剧情文本",
      "time_range": "0:00-0:15",
      "scene_summary": "场景概述",
      "characters_in_scene": ["清单中的人物名"]
    }
  ]
}"""

    user_prompt = f"【原始剧情】\n{original_plot}{overview_block}\n\n【关键帧分析】\n{frames_desc}\n\n请将剧情与关键帧对齐分段。"
    result = await _call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  接口 6: 剧情重编排
# ═══════════════════════════════════════════════════

@router.post("/generate/rewrite-plot")
async def gen_rewrite_plot(body: dict):
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    aligned_segments = body.get("aligned_segments", [])
    direction = body.get("direction", "")
    style = body.get("style", "")
    if not aligned_segments:
        raise HTTPException(status_code=400, detail="未提供对齐后的分段")

    segments_text = "\n".join([
        f"第{s.get('index', i)+1}段: {s.get('plot_text', '')}"
        for i, s in enumerate(aligned_segments)
    ])

    system_prompt = f"""你是一位创意编剧，擅长影视二次创作。基于原始分段剧情进行重新编排。

二创方向：{direction or '保持原有结构，优化叙事节奏'}
目标风格：{style or '保持原风格'}

要求：
1. 保持与原作相同的段落数量和基本结构
2. 每段标注场景处理方式：keep（保留原场景）/ modify（修改场景）/ new（新增场景）
3. 人物可以改变形象但保持角色关系
4. 对话可以重写但保持情节逻辑

只输出JSON：
{{
  "segments": [
    {{
      "index": 0,
      "text": "重编排后的剧情文本",
      "dialogue": "该段对话/旁白",
      "scene_action": "keep/modify/new",
      "scene_note": "场景变化说明（如有）",
      "characters_in_scene": ["人物名1", "人物名2"]
    }}
  ],
  "characters": [
    {{"name": "人物名", "original_desc": "原始描述", "new_desc": "新形象描述建议"}}
  ],
  "scenes": [
    {{"name": "场景名", "original_desc": "原始描述", "new_desc": "新风格描述建议"}}
  ]
}}"""

    user_prompt = f"【原始分段剧情】\n{segments_text}\n\n请进行二创重编排。"
    result = await _call_llm_json(config, system_prompt, user_prompt, max_tokens=30000)
    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  接口 7: 人物形象重设计
# ═══════════════════════════════════════════════════

@router.post("/generate/redesign-characters")
async def gen_redesign_characters(body: dict):
    img_config = _get_config_by_id(body.get("image_config_id", "")) or _get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    wf_id = body.get("workflow_id", "")
    characters = body.get("characters", [])
    style = body.get("style", "")
    ref_urls = body.get("ref_image_urls", [])

    if not characters:
        raise HTTPException(status_code=400, detail="未提供人物列表")

    node_refs = _collect_ref_images(extra_urls=ref_urls)
    errors = []

    async def gen_single(idx, char):
        try:
            if char.get("imageUrl"):
                return
            desc = char.get("new_desc") or char.get("visual_prompt") or char.get("description", "")
            prompt = f"{style}风格，角色设定图，白色背景，正面全身立绘，{desc}"
            item_refs = _collect_ref_images(extra_urls=char.get("refImages", []))
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
            errors.append({"index": idx, "name": char.get("name", ""), "message": str(e)})

    import asyncio
    tasks = [gen_single(i, c) for i, c in enumerate(characters)]
    await asyncio.gather(*tasks)

    return JSONResponse({"code": 0, "data": {
        "characters": characters,
        "errors": errors,
    }})


# ═══════════════════════════════════════════════════
#  接口 8: 场景风格转换
# ═══════════════════════════════════════════════════

@router.post("/generate/redesign-scenes")
async def gen_redesign_scenes(body: dict):
    img_config = _get_config_by_id(body.get("image_config_id", "")) or _get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    wf_id = body.get("workflow_id", "")
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    ref_urls = body.get("ref_image_urls", [])

    if not scenes:
        raise HTTPException(status_code=400, detail="未提供场景列表")

    node_refs = _collect_ref_images(extra_urls=ref_urls)
    errors = []

    async def gen_single(idx, scene):
        try:
            if scene.get("imageUrl"):
                return
            desc = scene.get("new_desc") or scene.get("visual_prompt") or scene.get("description", "")
            prompt = f"{style}风格，场景概念图，无人物，{desc}"
            item_refs = _collect_ref_images(extra_urls=scene.get("refImages", []))
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
                        f"rc_scene_{scene.get('name', 'scene')}"
                    )
                    scene["imageUrl"] = url
        except Exception as e:
            errors.append({"index": idx, "name": scene.get("name", ""), "message": str(e)})

    import asyncio
    tasks = [gen_single(i, s) for i, s in enumerate(scenes)]
    await asyncio.gather(*tasks)

    return JSONResponse({"code": 0, "data": {
        "scenes": scenes,
        "errors": errors,
    }})


# ═══════════════════════════════════════════════════
#  接口 9: 分镜提示词生成
# ═══════════════════════════════════════════════════

@router.post("/generate/rc-storyboard")
async def gen_rc_storyboard(body: dict):
    config = _get_config_by_id(body.get("chat_config_id", "")) or _get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")

    segment = body.get("segment", {})
    characters = body.get("characters", [])
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    frame_url = body.get("frame_url", "")
    composition = body.get("composition", "")

    seg_text = segment.get("text", "")
    seg_dialogue = segment.get("dialogue", "")
    if not seg_text:
        raise HTTPException(status_code=400, detail="未提供段落剧情")

    chars_desc = "\n".join([
        f"- {c.get('name','')}: {c.get('new_desc') or c.get('visual_prompt') or c.get('description','')}"
        for c in characters
    ])
    scenes_desc = "\n".join([
        f"- {s.get('name','')}: {s.get('new_desc') or s.get('visual_prompt') or s.get('description','')}"
        for s in scenes
    ])

    system_prompt = f"""你是一位专业的AI绘图提示词工程师。根据剧情段落、人物设定、场景设定和构图参考，生成用于图像生成的详细提示词。

目标风格：{style or '保持原风格'}

要求：
1. 提示词必须包含：场景环境、人物外貌与动作、光影氛围、镜头角度
2. 保持与原始构图一致的画面布局（人物位置、景别、角度）
3. 融入新的人物形象和场景风格
4. 提示词用英文输出（更适合AI绘图模型）
5. 同时输出中文的构图说明

只输出JSON：
{{
  "prompt": "英文图像生成提示词",
  "prompt_cn": "中文提示词（供参考）",
  "composition_notes": "构图说明：镜头角度、人物位置、景别等"
}}"""

    user_prompt = f"""【段落剧情】
{seg_text}

【对话/旁白】
{seg_dialogue or '（无）'}

【人物设定】
{chars_desc or '（无特定人物）'}

【场景设定】
{scenes_desc or '（无特定场景）'}

【原始构图参考】
{composition or '（无构图信息）'}

请生成该段的图像提示词。"""

    if frame_url:
        b64 = _load_ref_image_b64(frame_url)
        if b64:
            images = [{"b64": b64, "label": "原始关键帧（构图参考）"}]
            result = await _call_llm_vision_json(config, system_prompt, user_prompt, images)
            return JSONResponse({"code": 0, "data": result})

    result = await _call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  接口 10: 画面生成
# ═══════════════════════════════════════════════════

@router.post("/generate/rc-image")
async def gen_rc_image(body: dict):
    img_config = _get_config_by_id(body.get("image_config_id", "")) or _get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    wf_id = body.get("workflow_id", "")
    prompt = body.get("prompt", "")
    ref_frame_url = body.get("ref_frame_url", "")
    char_ref_urls = body.get("char_ref_urls", [])
    scene_ref_url = body.get("scene_ref_url", "")
    seg_index = body.get("segment_index", 0)
    width = int(body.get("width", 1920))
    height = int(body.get("height", 1080))

    if not prompt:
        raise HTTPException(status_code=400, detail="未提供提示词")

    all_ref_urls = []
    if ref_frame_url:
        all_ref_urls.append(ref_frame_url)
    all_ref_urls.extend(char_ref_urls or [])
    if scene_ref_url:
        all_ref_urls.append(scene_ref_url)

    ref_images = _collect_ref_images(extra_urls=all_ref_urls)

    try:
        img_res = await generate_image(ImageGenerateRequest(
            config_id=img_config["id"], prompt=prompt,
            width=width, height=height, n=1,
            image_base64_list=ref_images,
        ))
        img_data = img_res.get("data", [])
        if not img_data:
            raise HTTPException(status_code=500, detail="生图模型未返回图片")
        b64 = img_data[0].get("b64_json", "")
        if not b64:
            raise HTTPException(status_code=500, detail="生图模型返回空数据")
        url = save_workflow_image(
            wf_id,
            b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}",
            f"rc_seg{seg_index}"
        )
        return JSONResponse({"code": 0, "data": {"imageUrl": url}})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生图失败: {str(e)}")

