import json
import os
import asyncio
import base64 as b64mod
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from backend.core.workflow_storage import (
    list_workflows, load_workflow, save_workflow, delete_workflow as delete_wf,
    save_workflow_image, WORKFLOW_ROOT
)
from backend.api.config_router import config_list
from backend.api.image_router import generate_image
from backend.models.schemas import ImageGenerateRequest
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/workflow", tags=["工作流"])


def load_ref_image_b64(image_url: str, max_size: int = 1500000) -> str:
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


def collect_ref_images(characters=None, scenes=None, extra_urls=None):
    refs = []
    for c in (characters or []):
        b = load_ref_image_b64(c.get("imageUrl", ""))
        if b: refs.append(b)
    for s in (scenes or []):
        b = load_ref_image_b64(s.get("imageUrl", ""))
        if b: refs.append(b)
    for u in (extra_urls or []):
        b = load_ref_image_b64(u)
        if b: refs.append(b)
    return refs


def get_config_by_id(config_id: str):
    return next((c for c in config_list if c["id"] == config_id), None)


def get_first_config(config_type: str):
    allowed = {config_type, "both"}
    return next((c for c in config_list if c.get("config_type") in allowed), None)


async def call_llm_json(config: dict, system_prompt: str, user_prompt: str, max_tokens: int = 20000) -> dict:
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
        finish = result.get("choices", [{}])[0].get("finish_reason", "")
        raise HTTPException(status_code=500, detail=f"模型返回空内容（finish_reason={finish}），可能是 max_tokens 不足或模型拒绝回答")
    return _parse_json_robust(content)


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


def _parse_json_robust(content: str) -> dict:
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
            print(f"[JSON解析] 修复后仍失败: {e}")
            print(f"[JSON解析] 原始内容前500字符: {content[:500]}")
    else:
        print(f"[JSON解析] 未找到{{...}}结构")
        print(f"[JSON解析] 原始内容前500字符: {content[:500]}")
    raise HTTPException(status_code=500, detail=f"模型返回内容无法解析为JSON，前200字符: {content[:200]}")


def _fix_json_quotes(s: str) -> str:
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
                result.append(ch)
        else:
            if ch == '\\' and i + 1 < len(s):
                result.append(ch)
                result.append(s[i + 1])
                i += 2
                continue
            if ch == '"':
                next_non_ws = ''
                j = i + 1
                while j < len(s) and s[j] in ' \t\r\n':
                    j += 1
                if j < len(s):
                    next_non_ws = s[j]
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
    media_type, raw = _parse_b64_image(b64_data)
    raw_bytes = b64mod.b64decode(raw)
    if len(raw_bytes) <= max_bytes:
        return media_type, raw
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


async def call_llm_vision_json(config: dict, system_prompt: str, user_text: str, images: list) -> dict:
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
            "max_tokens": 20000,
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
        user_content = []
        user_content.append({"type": "text", "text": user_text})
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
            "temperature": 0.7, "stream": False, "max_tokens": 20000,
            "response_format": {"type": "json_object"}
        }
        response = await async_http_request("POST", url, headers, data, timeout=180.0)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text[:500])
        result = response.json()
        content = result["choices"][0]["message"]["content"]

    if not content or not content.strip():
        raise HTTPException(status_code=500, detail="模型返回空内容")
    return _parse_json_robust(content)


@router.get("/list")
async def workflow_list():
    return JSONResponse({"code": 0, "data": list_workflows()})


@router.get("/{workflow_id}")
async def workflow_get(workflow_id: str):
    wf = load_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="工作流不存在")
    return JSONResponse({"code": 0, "data": wf})


@router.post("/{workflow_id}")
async def workflow_save(workflow_id: str, body: dict):
    body["id"] = workflow_id
    save_workflow(body)
    return JSONResponse({"code": 0})


@router.delete("/{workflow_id}")
async def workflow_delete(workflow_id: str):
    delete_wf(workflow_id)
    return JSONResponse({"code": 0})


@router.post("/upload-image/{workflow_id}")
async def upload_image(workflow_id: str, body: dict):
    image_data = body.get("image_data", "")
    prefix = body.get("prefix", "upload")
    if not image_data:
        raise HTTPException(status_code=400, detail="缺少图片数据")
    url = save_workflow_image(workflow_id, image_data, prefix)
    return JSONResponse({"code": 0, "data": {"url": url}})


@router.post("/generate/script")
async def gen_script(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    plot = body.get("plot", "")
    style = body.get("style", "")
    vtype = body.get("type", "")
    seg_count = body.get("segment_count")
    seg_hint = f"请生成恰好 {seg_count} 段，每段15秒。" if seg_count else "根据情节自动决定段数，每段15秒。"
    system_prompt = f"""你是一位专业的影视编剧和导演。根据用户提供的简要情节、视频风格和类型，生成完整的视频剧本。

要求：
1. 剧本按每15秒一段进行分段。{seg_hint}
2. 风格：{style}，类型：{vtype}
3. 每段包含：场景环境、人物动作、对白/旁白、情绪氛围
4. 智能分析剧本中的所有人物：
   - 主要人物：贯穿多段的核心角色
   - 次要人物：仅在某些段落出现的配角
   - 如果某段没有次要人物，标记为空数组
5. 智能分析每段的场景：场景只描述环境/地点，不包含人物
6. 标注每段出现了哪些主要人物和次要人物

只输出JSON：
{{
  "full_text": "完整剧本文本",
  "main_characters": [
    {{"name": "角色名", "description": "外貌特征详细描述", "visual_prompt": "用于AI绘图的纯外貌描述，不含场景"}}
  ],
  "segments": [
    {{
      "index": 0,
      "text": "该段剧本内容",
      "duration": 15,
      "main_character_names": ["出现的主要人物名"],
      "minor_characters": [
        {{"name": "次要角色名", "description": "外貌描述", "visual_prompt": "绘图用外貌描述"}}
      ],
      "scenes": [
        {{"name": "场景名称（如：竹林小径）", "description": "纯场景环境描述，不含任何人物", "visual_prompt": "用于AI生成纯场景图的提示词，明确排除人物"}}
      ],
      "scene_count": 1,
      "storyboard_grid": 4
    }}
  ]
}}"""
    result = await call_llm_json(config, system_prompt, f"情节：{plot}")
    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/plan-characters-scenes")
async def plan_characters_scenes(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    full_text = body.get("full_text", "")
    segments = body.get("segments", [])
    style = body.get("style", "")
    vtype = body.get("type", "")
    user_hint = body.get("user_hint", "")

    seg_texts = "\n\n".join(f"【第{i+1}段】{s.get('text','')}" for i, s in enumerate(segments))
    hint_line = f"\n用户补充要求：{user_hint}" if user_hint else ""

    system_prompt = f"""你是一位专业的影视美术总监。根据完整剧本，统一规划所有人物和场景的视觉设计，确保全片一致性。
风格：{style}，类型：{vtype}{hint_line}

要求：
1. 主要人物：贯穿多段的核心角色。description 只写详细的穿着、服饰、发型、体型等外貌特征，不写表情和动作。visual_prompt 用于AI生成2x2四视图角色模型图（正面/侧面/背面/四分之三角度），人物保持直立姿势，白色背景
2. 每段的次要人物：仅在该段出现的配角，如果该段没有次要人物则返回空数组。次要人物不能和主要人物重复。描述规则同主要人物
3. 每段的场景：纯环境描述，不含任何人物。visual_prompt 用于AI生成2x2四机位全景场景图（从四个不同角度拍摄同一场景），必须明确"无人物、无人影"
4. 同一角色在不同段落的描述必须一致
5. 场景描述要前后连贯，相同场景保持一致性

只输出JSON：
{{
  "main_characters": [
    {{"name": "角色名", "description": "详细穿着、服饰、发型、体型等外貌特征，不含表情和动作", "visual_prompt": "2x2四视图，角色模型图，直立姿势，白色背景，正面/侧面/背面/四分之三角度，详细外貌描述..."}}
  ],
  "segments": [
    {{
      "index": 0,
      "minor_characters": [{{"name": "角色名", "description": "详细穿着外貌特征", "visual_prompt": "2x2四视图，角色模型图，直立姿势，白色背景，详细外貌描述..."}}],
      "scenes": [{{"name": "场景名称标签", "description": "场景环境详细描述", "visual_prompt": "2x2四机位全景图，无人物无人影，{style}风格，从四个不同角度拍摄，场景描述..."}}]
    }}
  ]
}}"""
    result = await call_llm_json(config, system_prompt, f"完整剧本：\n{full_text}\n\n分段剧本：\n{seg_texts}")
    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/plan-frames")
async def plan_frames(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    characters = body.get("characters", [])
    minor_characters = body.get("minor_characters", [])
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    grid = body.get("grid", 4)
    is_last_segment = body.get("is_last_segment", False)
    prev_last_frame_desc = body.get("prev_last_frame_desc", "")
    user_hint = body.get("user_hint", "")

    if grid not in (4, 9, 16):
        grid = 4
    grid_label = {4: "2x2", 9: "3x3", 16: "4x4"}.get(grid, "2x2")

    char_desc = "\n".join(f"- {c.get('name','')}: {c.get('visual_prompt', c.get('description',''))}" for c in characters + minor_characters) if (characters or minor_characters) else "无特定角色"
    scene_desc = "\n".join(f"- {s.get('name','')}: {s.get('visual_prompt', s.get('description',''))}" for s in scenes) if scenes else "无特定场景"

    prev_hint = f"\n前一段的尾帧画面：{prev_last_frame_desc}\n本段首帧必须能从前段尾帧自然过渡。" if prev_last_frame_desc else ""
    ending_hint = "这是整个视频的最后一段，尾帧需要有结束感和余韵。" if is_last_segment else "这段之后还有下一段，尾帧需要为下一段做铺垫和过渡。"
    hint_line = f"\n用户补充要求：{user_hint}" if user_hint else ""

    system_prompt = f"""你是一位专业的电影美术指导和分镜师。根据剧本片段，统一规划该段的首帧画面、{grid_label}分镜图和尾帧画面，确保三者之间的过渡连贯。
风格：{style}
{ending_hint}{prev_hint}{hint_line}

出场人物：
{char_desc}

场景环境：
{scene_desc}

严格要求：
1. 首帧是视频开场第一帧，要抓住注意力
2. 分镜图共{grid}格（{grid_label}），每格一个镜头，逐格描述画面内容
3. 首帧画面必须能自然过渡到分镜图第1格
4. 分镜图第{grid}格必须能自然过渡到尾帧画面
5. 尾帧是该段最后一帧
6. 所有 visual_prompt 用于AI生图，包含人物、场景、构图、光线、{style}风格

只输出JSON：
{{
  "first_frame": {{
    "description": "首帧画面详细描述",
    "visual_prompt": "用于AI生图的完整提示词"
  }},
  "storyboard": {{
    "description": "分镜整体描述",
    "grid_prompts": ["第1格画面描述", "第2格画面描述", ...]
  }},
  "last_frame": {{
    "description": "尾帧画面详细描述",
    "visual_prompt": "用于AI生图的完整提示词"
  }}
}}"""
    result = await call_llm_json(config, system_prompt, f"段落剧本：{segment_text}")
    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/main-characters")
async def gen_main_characters(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    characters = body.get("characters", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    user_refs = collect_ref_images(extra_urls=ref_image_urls)
    async def gen_char_img(char):
        try:
            prompt = f"{style}风格，2x2四视图网格，角色模型图，白色背景，直立姿势，正面/侧面/背面/四分之三角度，{char.get('visual_prompt', char.get('description', ''))}"
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1152, height=2048, n=1, image_base64_list=user_refs))
            img_data = img_res.get("data", [])
            if img_data and img_data[0].get("b64_json"):
                b64 = img_data[0]["b64_json"]
                char["imageUrl"] = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"mc_{char.get('name','char')}")
        except Exception as e:
            print(f"[workflow] 人物图生成失败: {e}")
    await asyncio.gather(*[gen_char_img(c) for c in characters])
    return JSONResponse({"code": 0, "data": {"characters": characters}})


@router.post("/generate/minor-characters")
async def gen_minor_characters(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    characters = body.get("characters", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    user_refs = collect_ref_images(extra_urls=ref_image_urls)
    if characters:
        async def gen_minor_img(char):
            try:
                prompt = f"{style}风格，2x2四视图网格，角色模型图，白色背景，直立姿势，正面/侧面/背面/四分之三角度，{char.get('visual_prompt', char.get('description', ''))}"
                img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1152, height=2048, n=1, image_base64_list=user_refs))
                img_data = img_res.get("data", [])
                if img_data and img_data[0].get("b64_json"):
                    b64 = img_data[0]["b64_json"]
                    char["imageUrl"] = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "minor")
            except Exception as e:
                print(f"[workflow] 次要人物图生成失败: {e}")
        await asyncio.gather(*[gen_minor_img(c) for c in characters])
    return JSONResponse({"code": 0, "data": {"has_minor": len(characters) > 0, "characters": characters}})


@router.post("/generate/scene")
async def gen_scene(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    prev_scenes = body.get("prev_segment_scenes", [])
    prev_ref_imgs = collect_ref_images(scenes=prev_scenes[:1])
    user_refs = collect_ref_images(extra_urls=ref_image_urls)
    all_refs = prev_ref_imgs + user_refs
    async def gen_scene_img(sc):
        try:
            prompt = f"{style}风格，2x2四机位全景图网格，纯场景环境，无人物无人影，从四个不同角度拍摄同一场景，{sc.get('visual_prompt', sc.get('description', ''))}"
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1536, n=1, image_base64_list=all_refs))
            img_data = img_res.get("data", [])
            if img_data and img_data[0].get("b64_json"):
                b64 = img_data[0]["b64_json"]
                sc["imageUrl"] = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"scene_{sc.get('name','')[:8]}")
        except Exception as e:
            print(f"[workflow] 场景图生成失败: {e}")
    await asyncio.gather(*[gen_scene_img(s) for s in scenes])
    return JSONResponse({"code": 0, "data": {"scene_count": len(scenes), "scenes": scenes}})


@router.post("/generate/storyboard")
async def gen_storyboard(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    storyboard_prompt = body.get("storyboard_prompt", "")
    characters = body.get("characters", [])
    scenes = body.get("scenes", [])
    first_frame_url = body.get("first_frame_url", "")
    grid = body.get("grid", 4)
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    if grid not in (4, 9, 16):
        grid = 4
    grid_label = {4: "2x2", 9: "3x3", 16: "4x4"}.get(grid, "2x2")
    prompt = f"{style}风格，{grid_label}宫格分镜图，电影分镜，每格一个镜头，{storyboard_prompt}，清晰的格线分隔，每格内容不同，保持人物和场景一致性"
    ref_imgs = collect_ref_images(characters=characters, scenes=scenes, extra_urls=([first_frame_url] if first_frame_url else []) + ref_image_urls)
    resolutions = [(2160, 3840), (1080, 1920)]
    images = []
    for w, h in resolutions:
        try:
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=w, height=h, n=1, image_base64_list=ref_imgs))
            for item in img_res.get("data", []):
                b64 = item.get("b64_json", "")
                if b64:
                    url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"sb_{grid_label}")
                    images.append(url)
            if images:
                return JSONResponse({"code": 0, "data": {"images": images, "grid": grid, "grid_label": grid_label}})
        except Exception as e:
            print(f"[workflow] 分镜图 {w}x{h} 生成失败，尝试降级: {e}")
    raise HTTPException(status_code=500, detail="分镜图生成失败：所有分辨率均失败")


@router.post("/generate/first-frame")
async def gen_first_frame(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    visual_prompt = body.get("visual_prompt", "")
    description = body.get("description", "")
    characters = body.get("characters", [])
    minor_characters = body.get("minor_characters", [])
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    image_url = ""
    try:
        ref_imgs = collect_ref_images(characters=characters + minor_characters, scenes=scenes, extra_urls=ref_image_urls)
        prompt = f"{style}风格，电影首帧画面，{visual_prompt or description}"
        img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1152, n=1, image_base64_list=ref_imgs))
        img_data = img_res.get("data", [])
        if img_data and img_data[0].get("b64_json"):
            b64 = img_data[0]["b64_json"]
            image_url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "first_frame")
    except Exception as e:
        print(f"[workflow] 首帧画面生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"description": description, "visual_prompt": visual_prompt, "imageUrl": image_url}})


@router.post("/generate/last-frame")
async def gen_last_frame(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    visual_prompt = body.get("visual_prompt", "")
    description = body.get("description", "")
    characters = body.get("characters", [])
    minor_characters = body.get("minor_characters", [])
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    storyboard_urls = body.get("storyboard_urls", [])
    ref_image_urls = body.get("ref_image_urls", [])
    image_url = ""
    try:
        ref_imgs = collect_ref_images(characters=characters + minor_characters, scenes=scenes, extra_urls=storyboard_urls + ref_image_urls)
        prompt = f"{style}风格，电影尾帧画面，{visual_prompt or description}"
        img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1152, n=1, image_base64_list=ref_imgs))
        img_data = img_res.get("data", [])
        if img_data and img_data[0].get("b64_json"):
            b64 = img_data[0]["b64_json"]
            image_url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "last_frame")
    except Exception as e:
        print(f"[workflow] 尾帧画面生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"description": description, "visual_prompt": visual_prompt, "imageUrl": image_url}})


@router.post("/generate/video-prompt")
async def gen_video_prompt(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    seg_idx = body.get("segment_index", 0)
    total = body.get("total_segments", 1)
    scenes = body.get("scenes", [])
    chars = body.get("characters", [])
    minor_chars = body.get("minor_characters", [])
    storyboard_grid = body.get("storyboard_grid", 0)
    storyboard_images = body.get("storyboard_images", [])
    first_frame = body.get("first_frame", {})
    last_frame = body.get("last_frame", {})
    style = body.get("style", "")
    vtype = body.get("type", "")

    has_first = bool(first_frame.get("imageUrl"))
    has_sb = bool(storyboard_images) and storyboard_grid > 0
    has_last = bool(last_frame.get("imageUrl"))
    grid_label = {4: "2x2", 9: "3x3", 16: "4x4"}.get(storyboard_grid, "")

    ref_list = []
    if chars:
        ref_list.append("主要人物: " + "、".join(f"{c.get('name','')}" for c in chars))
    if minor_chars:
        ref_list.append("次要人物: " + "、".join(f"{c.get('name','')}" for c in minor_chars))
    if scenes:
        ref_list.append("场景: " + "、".join(f"{s.get('name','')}" for s in scenes))
    ref_text = "；".join(ref_list) if ref_list else ""

    structure_parts = []
    if has_first:
        structure_parts.append("从 @首帧画面 开始")
    if has_sb:
        structure_parts.append(f"按照 @分镜图 的{grid_label}宫格逐格执行，说明每格之间的运镜和过渡方式")
    if has_last:
        structure_parts.append("到 @尾帧画面 结束")

    if structure_parts:
        structure_desc = "，".join(structure_parts)
    elif has_sb:
        structure_desc = f"按照 @分镜图 的{grid_label}宫格逐格执行"
    else:
        structure_desc = "按照剧本内容自行编排镜头"

    char_refs = ""
    if chars:
        char_refs = "，".join(f"@主要人物·{c.get('name','')}" for c in chars)
    if minor_chars:
        if char_refs: char_refs += "，"
        char_refs += "，".join(f"@次要人物·{c.get('name','')}" for c in minor_chars)
    scene_refs = "，".join(f"@场景·{s.get('name','')}" for s in scenes) if scenes else ""

    system_prompt = f"""你是AI视频生成提示词专家。根据提供的参考图片和剧本，为这段15秒视频写提示词。你可以看到所有参考图片，请仔细观察每张图片的实际内容来写提示词。

段落：第{seg_idx+1}段/共{total}段 | 风格：{style} | 类型：{vtype}
{ref_text}

严格只写两段话：

第一段【画面与运镜】：{structure_desc}。用 @ 引用参考图（如 {char_refs or "@人物名"}、{scene_refs or "@场景名"}）。仔细观察分镜图每个格子的实际画面内容，逐格描述。每格之间说清楚运镜方式（推/拉/摇/移/跟/升/降）和过渡（切/溶/淡/划）。细节要具体：景别变化、镜头速度、人物动作。

第二段【配音与音效】：写出配音内容（含语气、情绪状态、语速），再写环境音和特效音。

只输出JSON：{{"full_text": "第一段...\\n\\n第二段..."}}"""
    user_prompt = f"段落剧本：{segment_text}"

    # 收集所有参考图发给多模态LLM
    vision_images = []
    if has_first:
        b = load_ref_image_b64(first_frame.get("imageUrl", ""))
        if b: vision_images.append({"b64": b, "label": "首帧画面"})
    for c in chars:
        b = load_ref_image_b64(c.get("imageUrl", ""))
        if b: vision_images.append({"b64": b, "label": f"主要人物·{c.get('name','')}"})
    for c in minor_chars:
        b = load_ref_image_b64(c.get("imageUrl", ""))
        if b: vision_images.append({"b64": b, "label": f"次要人物·{c.get('name','')}"})
    for sc in scenes:
        b = load_ref_image_b64(sc.get("imageUrl", ""))
        if b: vision_images.append({"b64": b, "label": f"场景·{sc.get('name','')}"})
    for sb_url in storyboard_images:
        b = load_ref_image_b64(sb_url)
        if b: vision_images.append({"b64": b, "label": "分镜图"})
    if has_last:
        b = load_ref_image_b64(last_frame.get("imageUrl", ""))
        if b: vision_images.append({"b64": b, "label": "尾帧画面"})

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})
