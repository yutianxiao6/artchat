import json
import os
import re
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


def compute_grid_layout(grid: int, resolution: str = "") -> tuple:
    """根据grid数和分辨率计算行列布局。返回 (grid, rows, cols, grid_label)"""
    if grid not in (4, 6, 9, 16):
        grid = 4
    if grid == 6:
        is_portrait = False
        if resolution:
            try:
                w, h = [int(x) for x in resolution.split("x")]
                is_portrait = h > w
            except (ValueError, IndexError):
                pass
        rows, cols = (3, 2) if is_portrait else (2, 3)
        grid_label = "3x2" if is_portrait else "2x3"
    else:
        rows = {4: 2, 9: 3, 16: 4}[grid]
        cols = rows
        grid_label = {4: "2x2", 9: "3x3", 16: "4x4"}[grid]
    return grid, rows, cols, grid_label


def _strip_style_prefix(text: str, style: str = "") -> str:
    """剥离描述文本里嵌入的风格词（如"水墨国风风格，"），保留其他内容（包括"第N格"编号）。
    能处理"水墨国风风格，..."、"第1格：水墨国风风格，..."、"...，水墨国风风格，..."等位置。
    """
    if style:
        s = style.strip()
        if s:
            esc = re.escape(s)
            # 任意位置的"{style}风格 + 标点/空白"，直接删除短语本身，保留周围上下文
            text = re.sub(rf"{esc}\s*风格\s*[，,、.。\s]*", "", text)
    # 兜底：清理任意"XX风格，"（≤20字），但只在行首或标点之后，避免误伤画面内容里的"风格"
    text = re.sub(r"^\s*[一-龥A-Za-z0-9]{1,20}风格\s*[，,、:：.。\s]+", "", text)
    text = re.sub(r"([，,、:：。.])\s*[一-龥A-Za-z0-9]{1,20}风格\s*[，,、:：.。\s]+", r"\1", text)
    return text.strip(" ，,、:：.。")


def _strip_grid_position_and_style(text: str, style: str = "") -> str:
    """移除分镜描述里自带的行列定位与风格前缀（用于故事板拼接）。"""
    text = re.sub(r"第\s*[一二三四五六七八九十0-9]+\s*排\s*第\s*[一二三四五六七八九十0-9]+\s*格[:：,，.。\s]*", "", text)
    text = re.sub(r"第\s*[一二三四五六七八九十0-9]+\s*[排行列][:：,，.。\s]*", "", text)
    text = re.sub(r"第\s*[一二三四五六七八九十0-9]+\s*格[:：,，.。\s]*", "", text)
    text = re.sub(r"(画面|镜头|分镜)\s*\d+[:：]\s*", "", text)
    return _strip_style_prefix(text, style)


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
    elif start >= 0 and end <= start:
        # JSON 被截断：有 { 但没有闭合的 }，尝试恢复
        truncated = content[start:]
        recovered = _recover_truncated_json(truncated)
        if recovered:
            return recovered
        print(f"[JSON解析] JSON被截断，恢复失败")
        print(f"[JSON解析] 原始内容前500字符: {content[:500]}")
    else:
        print(f"[JSON解析] 未找到{{...}}结构")
        print(f"[JSON解析] 原始内容前500字符: {content[:500]}")
    raise HTTPException(status_code=500, detail=f"模型返回内容无法解析为JSON，前200字符: {content[:200]}")


def _recover_truncated_json(text: str) -> dict | None:
    """尝试恢复被截断的 JSON，适用于 {"full_text": "..."} 等简单结构"""
    # 常见模式：{"full_text": "很长的文本被截断
    # 策略：找到最后一个完整的 key-value，截断 value 并闭合
    for suffix in ['"}', '"}']:
        try:
            return json.loads(text + suffix)
        except json.JSONDecodeError:
            pass
    # 尝试转义末尾可能的未闭合引号
    cleaned = text.rstrip()
    if cleaned.endswith("\\"):
        cleaned = cleaned[:-1]
    for suffix in ['"}', '"\n"}', '" }']:
        try:
            return json.loads(cleaned + suffix)
        except json.JSONDecodeError:
            pass
    # 最后手段：提取 full_text 的值
    import re
    m = re.search(r'"full_text"\s*:\s*"', text)
    if m:
        val_start = m.end()
        raw_val = text[val_start:]
        # 去掉末尾未闭合的转义
        raw_val = raw_val.rstrip()
        if raw_val.endswith("\\"):
            raw_val = raw_val[:-1]
        # 转义内部未转义的双引号（简单处理）
        try:
            return {"full_text": json.loads('"' + raw_val + '"')}
        except json.JSONDecodeError:
            # 直接用原始文本，替换问题字符
            raw_val = raw_val.replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
            try:
                return {"full_text": json.loads('"' + raw_val + '"')}
            except json.JSONDecodeError:
                # 放弃转义，直接返回原始文本
                return {"full_text": raw_val}
    return None


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


async def call_llm_vision_json(config: dict, system_prompt: str, user_text: str, images: list, max_tokens: int = 20000) -> dict:
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
        stop_reason = result.get("stop_reason", "")
        if stop_reason == "max_tokens":
            print(f"[call_llm_vision_json] Claude响应被截断(max_tokens={max_tokens})，尝试恢复")
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
            "temperature": 0.7, "stream": False, "max_tokens": max_tokens,
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
1. 主要人物：贯穿多段的核心角色。description 必须以"【性别：男/女/其他】"开头（即使剧本未明说，也要根据名字、行为、称谓等合理推断并明确写出；不得留"未知"），随后写详细的穿着、服饰、发型、体型、年龄段等外貌特征，不写表情和动作。visual_prompt 用于AI生成2x2四视图角色模型图（正面/侧面/背面/四分之三角度），人物保持直立姿势，白色背景，且必须在开头体现性别（如"年轻男性角色"/"中年女性角色"）
2. 每段的次要人物：仅在该段出现的配角，如果该段没有次要人物则返回空数组。次要人物不能和主要人物重复。description 同样以"【性别：男/女/其他】"开头，visual_prompt 同样在开头体现性别
3. 每段的场景：纯环境描述，不含任何人物。visual_prompt 用于AI生成2x2四机位全景场景图（从四个不同角度拍摄同一场景），必须明确"无人物、无人影"
4. 同一角色在不同段落的描述必须一致，性别绝不可前后矛盾
5. 场景描述要前后连贯，相同场景保持一致性

只输出JSON：
{{
  "main_characters": [
    {{"name": "角色名", "description": "【性别：男】详细穿着、服饰、发型、体型、年龄段等外貌特征，不含表情和动作", "visual_prompt": "2x2四视图，年轻男性角色模型图，直立姿势，白色背景，正面/侧面/背面/四分之三角度，详细外貌描述..."}}
  ],
  "segments": [
    {{
      "index": 0,
      "minor_characters": [{{"name": "角色名", "description": "【性别：女】详细穿着外貌特征", "visual_prompt": "2x2四视图，中年女性角色模型图，直立姿势，白色背景，详细外貌描述..."}}],
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
    segment_index = body.get("segment_index", 0)
    characters = body.get("characters", [])
    minor_characters = body.get("minor_characters", [])
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    grid = body.get("grid", 4)
    is_last_segment = body.get("is_last_segment", False)
    prev_last_frame_desc = body.get("prev_last_frame_desc", "")
    prev_planning_history = body.get("prev_planning_history", [])
    prev_storyboard_url = body.get("prev_storyboard_url", "")
    user_hint = body.get("user_hint", "")
    skip_first_frame = body.get("skip_first_frame", False)
    skip_storyboard = body.get("skip_storyboard", False)
    skip_last_frame = body.get("skip_last_frame", False)
    resolution = body.get("resolution", "")

    grid, rows, cols, grid_label = compute_grid_layout(grid, resolution)

    def _fmt_char(c):
        name = c.get("name", "")
        desc = (c.get("description") or "").strip()
        vp = (c.get("visual_prompt") or "").strip()
        parts = []
        if desc:
            parts.append(f"外貌设定: {desc}")
        if vp and vp != desc:
            parts.append(f"视觉提示: {vp}")
        body_text = " | ".join(parts) if parts else "（无设定）"
        return f"- {name}: {body_text}"

    def _fmt_scene(s):
        name = s.get("name", "")
        desc = (s.get("description") or "").strip()
        vp = (s.get("visual_prompt") or "").strip()
        parts = []
        if desc:
            parts.append(f"环境设定: {desc}")
        if vp and vp != desc:
            parts.append(f"视觉提示: {vp}")
        body_text = " | ".join(parts) if parts else "（无设定）"
        return f"- {name}: {body_text}"

    char_desc = "\n".join(_fmt_char(c) for c in characters + minor_characters) if (characters or minor_characters) else "无特定角色"
    scene_desc = "\n".join(_fmt_scene(s) for s in scenes) if scenes else "无特定场景"

    # 构建前段规划历史上下文
    prev_context = ""
    if segment_index > 0 and prev_planning_history:
        latest_plan = prev_planning_history[-1] if prev_planning_history else {}
        if latest_plan:
            prev_context = f"\n\n【前一段落的规划记录】\n"
            if latest_plan.get("first_frame"):
                prev_context += f"前段首帧：{latest_plan['first_frame'].get('description', '')}\n"
            if latest_plan.get("storyboard") and latest_plan["storyboard"].get("grid_prompts"):
                prev_context += f"前段分镜图（{len(latest_plan['storyboard']['grid_prompts'])}格）：\n"
                for i, gp in enumerate(latest_plan["storyboard"]["grid_prompts"][:3]):
                    prev_context += f"  格{i+1}: {gp[:80]}...\n"
            if latest_plan.get("last_frame"):
                prev_context += f"前段尾帧：{latest_plan['last_frame'].get('description', '')}\n"
            prev_context += "本段规划需要与前段自然衔接，保持视觉连贯性。\n"

    prev_hint = f"\n前一段的尾帧画面：{prev_last_frame_desc}\n本段首帧必须能从前段尾帧自然过渡。" if prev_last_frame_desc else ""
    ending_hint = "这是整个视频的最后一段，尾帧需要有结束感和余韵。" if is_last_segment else "这段之后还有下一段，尾帧需要为下一段做铺垫和过渡。"
    hint_line = f"\n用户补充要求：{user_hint}" if user_hint else ""

    # 构建需要规划的节点列表
    plan_parts = []
    json_fields = []
    if not skip_first_frame:
        plan_parts.append("首帧画面")
        json_fields.append('"first_frame": {"description": "首帧画面详细描述", "visual_prompt": "用于AI生图的完整提示词"}')
    if not skip_storyboard:
        plan_parts.append(f"{grid_label}分镜图（{grid}格）")
        json_fields.append('"storyboard": {"description": "分镜整体描述", "grid_prompts": ["第1排第1格画面描述", ...]}')
    if not skip_last_frame:
        plan_parts.append("尾帧画面")
        json_fields.append('"last_frame": {"description": "尾帧画面详细描述", "visual_prompt": "用于AI生图的完整提示词"}')

    if not plan_parts:
        return JSONResponse({"code": 0, "data": {"first_frame": {}, "storyboard": {}, "last_frame": {}}})

    plan_target = "、".join(plan_parts)
    json_structure = ",\n  ".join(json_fields)

    # 分镜格位描述
    grid_positions = []
    for r in range(rows):
        for c_idx in range(cols):
            grid_positions.append(f"第{r+1}排第{c_idx+1}格")
    grid_pos_text = "、".join(grid_positions)

    storyboard_rules = ""
    if not skip_storyboard:
        # 按宫格数限定每格字数，总提示词压在 2000 中文字以内（不含数组包装/逗号等）
        # 2x2=4格 → 每格约 200 字；2x3=6格 → 每格约 150 字；3x3=9格 → 每格约 100 字；4x4=16格 → 每格约 60 字
        per_cell_budget = max(40, min(200, 2000 // max(grid, 1)))
        storyboard_rules = f"""
分镜图严格要求（{grid}格，{grid_label}布局，格位：{grid_pos_text}）：
- grid_prompts 数组中每个元素只用"第X排第Y格"标识格位，不要写"第N格"
- 每格必须是视频中的关键节点：情节转折、动作高潮、情绪变化、场景切换等重要时刻
- 每格描述必须包含：
  a) 出场人物及其在画面中的具体站位（左/中/右/前景/背景）
  b) 人物的具体动作和表情
  c) 背景环境的详细描述（光线、天气、物体摆放）
  d) 镜头景别（特写/近景/中景/全景/远景）和角度（俯拍/仰拍/平拍/斜角）
  e) 画面中的关键物体和道具
- **长度预算（硬限制）**：每格描述不超过 {per_cell_budget} 个中文字；grid_prompts 所有元素加起来不超过 2000 字。宫格越密（3x3/4x4）越要精简，只写画面关键信息，省略形容词堆砌和重复铺陈。
- 每格描述中不要重复写风格，风格会统一附加在生图提示词末尾
- 相邻格之间必须有逻辑连贯性，动作和情节能自然衔接
- 不要描述无意义的过渡画面，每格都必须有明确的叙事功能"""

    system_prompt = f"""你是一位专业的电影美术指导和分镜师。根据剧本片段，统一规划该段的{plan_target}，确保各部分之间的过渡连贯。
风格：{style}
{ending_hint}{prev_hint}{hint_line}{prev_context}

出场人物（必须严格遵循以下设定，不得擅自改写性别、外貌、穿着）：
{char_desc}

场景环境（必须严格遵循以下设定）：
{scene_desc}
{storyboard_rules}

严格要求：
{"- 首帧是视频开场第一帧，要抓住注意力，构图必须有冲击力" if not skip_first_frame else ""}
{"- 首帧画面必须能自然过渡到分镜图第1排第1格" if not skip_first_frame and not skip_storyboard else ""}
{f"- 分镜图第{rows}排第{cols}格必须能自然过渡到尾帧画面" if not skip_storyboard and not skip_last_frame else ""}
{"- 尾帧是该段最后一帧" if not skip_last_frame else ""}
- 所有 visual_prompt 用于AI生图，必须包含：人物外貌和站位、场景环境、构图方式、光线方向
- **人物出现时必须按"出场人物"中的设定描述**：沿用其性别（如"年轻男性"/"中年女性"）、发型、服饰、体型等关键特征；严禁出现与设定冲突的描述（例如设定为男性却写成"女子"、设定为古装却写成"西装"）
- **场景出现时必须按"场景环境"中的设定描述**，不得更改场景核心要素
- visual_prompt 中不要写风格描述，风格"{style}"会在生图时统一附加到提示词末尾
- 所有描述必须具体到可以直接画出来的程度，不要使用模糊的形容词

只输出JSON：
{{
  {json_structure}
}}"""
    result = await call_llm_json(config, system_prompt, f"段落剧本：{segment_text}")

    # 审校步骤：让模型检查并改进分镜描述
    if not skip_storyboard and result.get("storyboard", {}).get("grid_prompts"):
        review_prompt = f"""你是一位资深电影分镜审校师。请审查以下帧画面规划，检查并修正问题，输出改进后的完整版本。

审查要点：
1. 每格分镜是否都是视频中的关键节点（不是无意义的过渡画面）
2. 人物在画面中的站位是否明确（左/中/右/前景/背景）
3. **人物描述必须严格遵循"出场人物"中的设定**：性别、发型、服饰、体型不得偏离；若出现与设定冲突（例如设定男性却写成"女子"、设定古装却写成"西装"）必须改回
4. 背景环境描述是否具体（不能只说"某个场景"，要描述光线、物体、氛围），且不得偏离"场景环境"中的设定
5. 相邻格之间的动作和情节是否连贯合理
6. 事件的因果关系是否合理（人物的动作要有动机和结果）
7. visual_prompt 是否足够详细，能让AI直接生成准确的图片
8. **长度预算**：grid_prompts 每一格不超过 {per_cell_budget if not skip_storyboard else 200} 个中文字，全部格子加起来不超过 2000 字。超长必须精简。
9. 每格描述中不要含有风格词（如"{style}风格""水墨""赛博朋克风格"等），风格统一在生图时附加。发现保留了风格词的要删掉。

风格：{style}
出场人物：{char_desc}
场景环境：{scene_desc}

原始规划：
{json.dumps(result, ensure_ascii=False, indent=2)}

请输出修改后的完整JSON（格式与原始规划完全一致），如果某些部分已经很好则保持不变，只改进不足之处。"""
        try:
            reviewed = await call_llm_json(config, "你是分镜审校师，只输出改进后的JSON。", review_prompt)
            if not skip_first_frame and reviewed.get("first_frame"):
                result["first_frame"] = reviewed["first_frame"]
            if reviewed.get("storyboard", {}).get("grid_prompts"):
                result["storyboard"] = reviewed["storyboard"]
            if not skip_last_frame and reviewed.get("last_frame"):
                result["last_frame"] = reviewed["last_frame"]
        except Exception as e:
            print(f"[workflow] 分镜审校失败，使用原始版本: {e}")

    if skip_first_frame:
        result["first_frame"] = {}
    if skip_storyboard:
        result["storyboard"] = {}
    else:
        # 兜底：即使模型没完全遵守规则，也强制剥除残留风格前缀并截断到每格预算内
        sb = result.get("storyboard") or {}
        raw_prompts = sb.get("grid_prompts") or []
        if raw_prompts:
            cleaned = []
            total_budget = 2000
            used = 0
            per_cell = max(40, min(200, 2000 // max(grid, 1)))
            for gp in raw_prompts:
                if isinstance(gp, dict):
                    gp = gp.get("description") or gp.get("visual_prompt") or gp.get("text") or ""
                text = _strip_grid_position_and_style(str(gp or ""), style)
                if len(text) > per_cell:
                    text = text[:per_cell].rstrip("，,、 。.") + "…"
                if used + len(text) > total_budget:
                    remain = max(0, total_budget - used)
                    text = text[:remain].rstrip("，,、 。.") + "…" if remain > 20 else ""
                cleaned.append(text)
                used += len(text)
            sb["grid_prompts"] = cleaned
            result["storyboard"] = sb
    if skip_last_frame:
        result["last_frame"] = {}

    # 保存规划历史记录
    import time
    planning_record = {
        "timestamp": time.time(),
        "segment_index": segment_index,
        "first_frame": result.get("first_frame", {}),
        "storyboard": result.get("storyboard", {}),
        "last_frame": result.get("last_frame", {}),
        "grid": grid,
        "grid_label": grid_label
    }

    return JSONResponse({"code": 0, "data": result, "planning_record": planning_record})


@router.post("/generate/main-characters")
async def gen_main_characters(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    characters = body.get("characters", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    node_refs = collect_ref_images(extra_urls=ref_image_urls)
    errors = []
    async def gen_char_img(idx, char):
        try:
            desc = char.get("description") or char.get("visual_prompt") or ""
            item_refs = collect_ref_images(extra_urls=char.get("refImages", []))
            all_refs = item_refs + [r for r in node_refs if r not in item_refs]
            prompt = f"{style}风格，2x2四视图网格，角色模型图，白色背景，直立姿势，正面/侧面/背面/四分之三角度，{desc}"
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1152, height=2048, n=image_count, image_base64_list=all_refs))
            img_data = img_res.get("data", [])
            urls = []
            for item in img_data:
                b64 = item.get("b64_json", "")
                if b64:
                    url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"mc_{char.get('name','char')}")
                    urls.append(url)
            if urls:
                char["imageUrl"] = urls[0]
                char["imageUrls"] = urls
            else:
                errors.append({"index": idx, "name": char.get("name", ""), "message": "未返回图片"})
        except Exception as e:
            print(f"[workflow] 人物图生成失败: {e}")
            errors.append({"index": idx, "name": char.get("name", ""), "message": str(e)})
    await asyncio.gather(*[gen_char_img(i, c) for i, c in enumerate(characters)])
    return JSONResponse({"code": 0, "data": {"characters": characters, "errors": errors}})


@router.post("/generate/minor-characters")
async def gen_minor_characters(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    characters = body.get("characters", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    node_refs = collect_ref_images(extra_urls=ref_image_urls)
    errors = []
    if characters:
        async def gen_minor_img(idx, char):
            try:
                desc = char.get("description") or char.get("visual_prompt") or ""
                item_refs = collect_ref_images(extra_urls=char.get("refImages", []))
                all_refs = item_refs + [r for r in node_refs if r not in item_refs]
                prompt = f"{style}风格，2x2四视图网格，角色模型图，白色背景，直立姿势，正面/侧面/背面/四分之三角度，{desc}"
                img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1152, height=2048, n=image_count, image_base64_list=all_refs))
                img_data = img_res.get("data", [])
                urls = []
                for item in img_data:
                    b64 = item.get("b64_json", "")
                    if b64:
                        url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "minor")
                        urls.append(url)
                if urls:
                    char["imageUrl"] = urls[0]
                    char["imageUrls"] = urls
                else:
                    errors.append({"index": idx, "name": char.get("name", ""), "message": "未返回图片"})
            except Exception as e:
                print(f"[workflow] 次要人物图生成失败: {e}")
                errors.append({"index": idx, "name": char.get("name", ""), "message": str(e)})
        await asyncio.gather(*[gen_minor_img(i, c) for i, c in enumerate(characters)])
    return JSONResponse({"code": 0, "data": {"has_minor": len(characters) > 0, "characters": characters, "errors": errors}})


@router.post("/generate/scene")
async def gen_scene(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    scenes = body.get("scenes", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    ref_image_urls = body.get("ref_image_urls", [])
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    prev_scenes = body.get("prev_segment_scenes", [])
    prev_ref_imgs = collect_ref_images(scenes=prev_scenes[:1])
    node_refs = collect_ref_images(extra_urls=ref_image_urls)
    errors = []
    async def gen_scene_img(idx, sc):
        try:
            desc = sc.get("description") or sc.get("visual_prompt") or ""
            item_refs = collect_ref_images(extra_urls=sc.get("refImages", []))
            all_refs = item_refs + [r for r in node_refs if r not in item_refs] + [r for r in prev_ref_imgs if r not in item_refs and r not in node_refs]
            prompt = f"{style}风格，2x2四机位全景图网格，纯场景环境，无人物无人影，从四个不同角度拍摄同一场景，{desc}"
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1536, n=image_count, image_base64_list=all_refs))
            img_data = img_res.get("data", [])
            urls = []
            for item in img_data:
                b64 = item.get("b64_json", "")
                if b64:
                    url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"scene_{sc.get('name','')[:8]}")
                    urls.append(url)
            if urls:
                sc["imageUrl"] = urls[0]
                sc["imageUrls"] = urls
            else:
                errors.append({"index": idx, "name": sc.get("name", ""), "message": "未返回图片"})
        except Exception as e:
            print(f"[workflow] 场景图生成失败: {e}")
            errors.append({"index": idx, "name": sc.get("name", ""), "message": str(e)})
    await asyncio.gather(*[gen_scene_img(i, s) for i, s in enumerate(scenes)])
    return JSONResponse({"code": 0, "data": {"scene_count": len(scenes), "scenes": scenes, "errors": errors}})


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
    resolution = body.get("resolution", "")
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    grid, _rows, _cols, grid_label = compute_grid_layout(grid, resolution)
    # 清洗 storyboard_prompt 里可能残留的风格前缀，避免"{style}风格...第X格：{style}风格..."重复
    # 注意：分镜图端要保留"第N格"编号（前端就是按这种格式拼的）
    cleaned_sb_prompt = _strip_style_prefix(storyboard_prompt or "", style) if storyboard_prompt else ""
    prompt = f"{grid_label}宫格分镜图，电影分镜，每格一个镜头，{cleaned_sb_prompt}，清晰的格线分隔，每格内容不同，保持人物和场景一致性"
    if style and style.strip():
        prompt += f"\n整体画面风格：{style.strip()}"
    ref_imgs = collect_ref_images(characters=characters, scenes=scenes, extra_urls=([first_frame_url] if first_frame_url else []) + ref_image_urls)

    # 解析分辨率，支持前端传入 "宽x高" 格式，自动添加降级分辨率
    FALLBACK_MAP = {
        (2160, 3840): [(1080, 1920)],
        (3840, 2160): [(2048, 1152), (1536, 1024)],
        (2048, 2048): [(1024, 1024)],
        (2048, 1152): [(1536, 1024)],
        (1024, 1536): [(1080, 1920)],
    }
    resolutions = []
    if resolution:
        try:
            w, h = [int(x) for x in resolution.split("x")]
            resolutions.append((w, h))
            for fb in FALLBACK_MAP.get((w, h), []):
                resolutions.append(fb)
        except (ValueError, IndexError):
            pass
    if not resolutions:
        resolutions = [(2160, 3840), (1080, 1920)]

    images = []
    for w, h in resolutions:
        try:
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=w, height=h, n=image_count, image_base64_list=ref_imgs))
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
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    image_url = ""
    image_urls = []
    try:
        ref_imgs = collect_ref_images(characters=characters + minor_characters, scenes=scenes, extra_urls=ref_image_urls)
        prompt = f"{style}风格，电影首帧画面，{visual_prompt or description}"
        img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1152, n=image_count, image_base64_list=ref_imgs))
        img_data = img_res.get("data", [])
        for item in img_data:
            b64 = item.get("b64_json", "")
            if b64:
                url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "first_frame")
                image_urls.append(url)
        if image_urls:
            image_url = image_urls[0]
    except Exception as e:
        print(f"[workflow] 首帧画面生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"description": description, "visual_prompt": visual_prompt, "imageUrl": image_url, "imageUrls": image_urls}})


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
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    image_url = ""
    image_urls = []
    try:
        ref_imgs = collect_ref_images(characters=characters + minor_characters, scenes=scenes, extra_urls=storyboard_urls + ref_image_urls)
        prompt = f"{style}风格，电影尾帧画面，{visual_prompt or description}"
        img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=2048, height=1152, n=image_count, image_base64_list=ref_imgs))
        img_data = img_res.get("data", [])
        for item in img_data:
            b64 = item.get("b64_json", "")
            if b64:
                url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "last_frame")
                image_urls.append(url)
        if image_urls:
            image_url = image_urls[0]
    except Exception as e:
        print(f"[workflow] 尾帧画面生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"description": description, "visual_prompt": visual_prompt, "imageUrl": image_url, "imageUrls": image_urls}})


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
    grid_prompts = body.get("grid_prompts", [])
    first_frame = body.get("first_frame", {})
    last_frame = body.get("last_frame", {})
    style = body.get("style", "")
    vtype = body.get("type", "")
    duration = body.get("duration", 15)
    all_segments_context = body.get("all_segments_context", [])

    has_first = bool(first_frame.get("imageUrl"))
    has_sb = bool(storyboard_images) and storyboard_grid > 0
    has_last = bool(last_frame.get("imageUrl"))

    # 构建全局上下文：所有段落的规划历史和执行进度
    context_summary = ""
    if all_segments_context:
        context_summary = "\n\n【全局上下文 - 所有段落的规划和执行进度】\n"
        for ctx in all_segments_context:
            idx = ctx.get("segment_index", 0)
            executed_to = ctx.get("executed_to")
            context_summary += f"\n第{idx+1}段："
            if ctx.get("first_frame_generated"):
                context_summary += " 首帧已生成"
            if ctx.get("storyboard_generated"):
                context_summary += " 分镜已生成"
            if ctx.get("last_frame_generated"):
                context_summary += " 尾帧已生成"
            if executed_to:
                context_summary += f" [执行进度: {executed_to}]"

            # 添加规划历史摘要
            plan_history = ctx.get("planning_history", [])
            if plan_history:
                latest = plan_history[-1]
                if latest.get("first_frame"):
                    ff_desc = latest["first_frame"].get("description", "")
                    if ff_desc:
                        context_summary += f"\n  首帧规划: {ff_desc[:60]}..."
                if latest.get("last_frame"):
                    lf_desc = latest["last_frame"].get("description", "")
                    if lf_desc:
                        context_summary += f"\n  尾帧规划: {lf_desc[:60]}..."

        context_summary += f"\n\n当前正在生成第{seg_idx+1}段的视频提示词。请确保本段的开场能自然衔接前段的结尾，整体保持视觉连贯性。\n"

    # 构建 @图片引用列表
    img_ref_lines = []
    img_idx = 1
    char_ref_map = {}
    for c in chars:
        if c.get("imageUrl"):
            char_ref_map[c.get("name", "")] = f"@图片{img_idx}"
            img_ref_lines.append(f"@图片{img_idx} 是主要人物·{c.get('name', '')}")
            img_idx += 1
    for c in minor_chars:
        if c.get("imageUrl"):
            char_ref_map[c.get("name", "")] = f"@图片{img_idx}"
            img_ref_lines.append(f"@图片{img_idx} 是次要人物·{c.get('name', '')}")
            img_idx += 1
    for sc in scenes:
        if sc.get("imageUrl"):
            img_ref_lines.append(f"@图片{img_idx} 是场景·{sc.get('name', '')}")
            img_idx += 1
    first_frame_ref = ""
    if has_first:
        first_frame_ref = f"@图片{img_idx}"
        img_ref_lines.append(f"@图片{img_idx} 是首帧图")
        img_idx += 1
    sb_ref = ""
    if has_sb:
        sb_ref = f"@图片{img_idx}"
        img_ref_lines.append(f"@图片{img_idx} 是分镜图（共{storyboard_grid}格，具体行列布局请自行观察图片判断）")
        img_idx += 1
    last_frame_ref = ""
    if has_last:
        last_frame_ref = f"@图片{img_idx}"
        img_ref_lines.append(f"@图片{img_idx} 是尾帧图")
        img_idx += 1

    img_ref_block = "\n".join(img_ref_lines) if img_ref_lines else ""

    # 构建分镜格位列表（按阅读顺序编号，不写行列，由模型观察分镜图自行判断真实行列布局）
    grid_time_hints = []
    if has_sb and storyboard_grid > 0:
        for gi in range(storyboard_grid):
            gp_desc = grid_prompts[gi] if gi < len(grid_prompts) else ""
            grid_time_hints.append(f"第{gi+1}个格位（按从左到右、从上到下的阅读顺序）" + (f"：{gp_desc}" if gp_desc else ""))
        grid_time_text = "\n".join(grid_time_hints)
    else:
        grid_time_text = ""

    # 首帧/尾帧描述
    ff_desc = first_frame.get("description", "") or first_frame.get("visual_prompt", "")
    lf_desc = last_frame.get("description", "") or last_frame.get("visual_prompt", "")

    has_any_ref = bool(img_ref_lines)
    has_any_grid = bool(grid_time_text)

    # 根据是否有参考图构建不同的指引
    if has_any_ref:
        ref_section = f"""开头先列出图片引用声明（每行一个），空一行后再按时间码逐段描述画面：
{img_ref_block}

注意：开头声明完 @图片N 之后，正文中一律用名字引用（如"主要人物·小明"直接写"小明"，"场景·竹林"直接写"竹林"），不要在正文继续写 @图片N。"""
    else:
        ref_section = """无参考图片，直接按时间码逐段描述画面。"""

    if has_any_grid:
        grid_section = f"""每段对应分镜图的一个格位，总时长{duration}秒，共{storyboard_grid}格。
**布局由你自行观察分镜图判断**：请仔细看分镜图实际有几行几列（例如 6 格可能是 2行3列，也可能是 3行2列；9 格是 3行3列，等等），然后按真实行列填写"第X排第Y格"。不要凭空假设布局，也不要写出超过真实行列范围的索引。
阅读顺序：从左到右、从上到下。下面列出的"第N个格位"即按此顺序编号，第1个格 = 左上角第一格，最后一个格 = 右下角最后一格。
你需要根据每格的剧情密度和节奏需要，智能分配每格的时长（动作密集的格分配更多时间，静态画面的格可以更短），所有格的时长之和必须等于{duration}秒。
{f"首帧画面描述：{ff_desc}" if ff_desc else ""}
{f"尾帧画面描述：{lf_desc}" if lf_desc else ""}

分镜格位（按阅读顺序给出，请你对照分镜图自行推断每个格位所在的真实行列）：
{grid_time_text}"""
    else:
        # 无分镜时，让模型自行拆分关键节点
        num_segments = max(4, duration // 2)
        grid_section = f"""没有分镜参考图，你需要根据剧本内容自行分析出{num_segments}个左右的关键剧情节点（转折、动作高潮、情绪变化、场景切换等），将{duration}秒视频均匀分配到这些节点上。
{f"首帧画面描述：{ff_desc}" if ff_desc else ""}
{f"尾帧画面描述：{lf_desc}" if lf_desc else ""}
每个时间段必须对应一个有明确叙事功能的关键画面，不要写无意义的过渡。"""

    cut_format = "格式：【起止时间 | 第X排第Y格 | 画面概述→动作变化 | 镜头运动方式】然后紧跟详细描述（X/Y 按你观察分镜图判断出的真实行列填写）" if has_any_grid else "格式：【起止时间 | 画面概述→动作变化 | 镜头运动方式】然后紧跟详细描述"

    example_cuts = (
        "【0-2s | 第1排第1格 | 冰封特写→急拉全景 | 固定→急拉】固定镜头超特写锁焦小明闭合的眼睑，睫毛上结着细碎冰晶...紧接着镜头以6m/s速度急拉至全景——小明立于竹林中央...\n"
        "【2-4s | 第1排第2格 | 俯冲环绕+螺旋爆发 | 俯冲环绕+螺旋升镜】高空8米以30度斜角极速俯冲环绕...（示例仅演示格式，真实行列以你观察分镜图为准）"
    ) if has_any_grid else (
        "【0-2s | 冰封特写→急拉全景 | 固定→急拉】固定镜头超特写锁焦小明闭合的眼睑，睫毛上结着细碎冰晶...紧接着镜头以6m/s速度急拉至全景——小明立于竹林中央...\n"
        "【2-4s | 俯冲环绕+螺旋爆发 | 俯冲环绕+螺旋升镜】高空8米以30度斜角极速俯冲环绕..."
    )

    system_prompt = f"""你是AI视频生成提示词专家。根据{"提供的参考图片和" if has_any_ref else ""}剧本，为这段{duration}秒视频写提示词。{"仔细观察每张参考图片的实际内容。" if has_any_ref else ""}

段落：第{seg_idx+1}段/共{total}段 | 风格：{style} | 类型：{vtype}
{context_summary}

严格按照以下格式输出（不要输出JSON，直接输出纯文本）：

{ref_section}
{cut_format}

{grid_section}

每个时间段的详细描述必须包含：
1. 具体的镜头运动（推/拉/摇/移/跟/升/降/环绕/手持，含速度和距离）
2. 人物的精确动作、表情、姿态变化
3. 场景环境细节（光线方向、色调、氛围物体）
4. 特效和视觉效果（粒子、光效、物理效果）
5. 景别变化（特写→近景→中景→全景→远景）
6. 如果剧情中有台词或对白，必须在对应时间段内完整写出台词内容（用引号标注），并注明说话人、语气和情绪

参考示例格式：
{"@图片1 是主要人物·小明" + chr(10) + "@图片2 是场景·竹林" + chr(10) + chr(10) if has_any_ref else ""}{example_cuts}

重要：full_text 总字数不得超过2000字，请精炼描述，突出关键画面和动作。

只输出JSON：{{"full_text": "完整提示词文本"}}"""

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
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images, max_tokens=32000)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt, max_tokens=32000)
    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/video-prompt-iterate")
async def gen_video_prompt_iterate(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    current_text = body.get("current_text", "")
    script_text = body.get("script_text", "")
    image_urls = body.get("image_urls", [])
    chat_history = body.get("chat_history", [])
    user_message = body.get("user_message", "")
    if not current_text:
        raise HTTPException(status_code=400, detail="当前提示词为空")
    if not user_message:
        raise HTTPException(status_code=400, detail="修改指令为空")

    system_prompt = """你是一位资深的视频导演和AI视频提示词专家，拥有丰富的镜头语言和叙事节奏经验。

你的任务：
1. 仔细观察用户提供的参考图片（首帧、分镜图、尾帧，如有），结合剧情和当前提示词，以专业视角分析当前提示词存在的问题（镜头运动不合理、节奏拖沓、与画面不符、缺少细节等）
2. 根据用户的修改指令和你的专业分析，输出修改后的完整提示词

分析原则：
- 镜头运动是否流畅自然，是否有助于叙事
- 时间分配是否合理，关键动作是否有足够时长
- 描述是否足够具体，能让AI视频模型准确还原
- 画面与画面之间的过渡是否连贯
- 是否充分利用了参考图片中的视觉信息

规则：
1. 只修改需要改进的部分，其余内容保持不变
2. 保持原有的格式结构（@图片引用、【时间码】分段）
3. 修改后的提示词必须完整输出，不要省略未修改的部分
4. 如果用户的修改涉及时间分配变化，相应调整其他时间段
5. full_text 是最终输出的视频提示词，总字数不得超过2000字，精炼描述
6. analysis 是你的专业分析，字数不限，尽可能详细说明问题和改进思路

只输出JSON：{"analysis": "你的专业分析（不限字数，详细说明问题和改进方向）", "full_text": "修改后的完整提示词（不超过2000字）"}"""

    # 收集参考图片
    vision_images = []
    for url in image_urls:
        b = load_ref_image_b64(url)
        if b:
            vision_images.append({"b64": b, "label": "参考画面"})

    user_text = ""
    if script_text:
        user_text += f"剧情内容：\n{script_text}\n\n"
    user_text += f"当前视频提示词：\n{current_text}"

    if chat_history:
        user_text += "\n\n之前的修改记录：\n"
        for msg in chat_history:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "user" and content:
                user_text += f"用户要求：{content}\n"
            elif role == "assistant" and content and content != "done":
                user_text += f"AI分析：{content}\n"

    user_text += f"\n本次修改指令：{user_message}"

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_text, vision_images, max_tokens=20000)
    else:
        result = await call_llm_json(config, system_prompt, user_text, max_tokens=20000)

    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/storyboard-iterate")
async def gen_storyboard_iterate(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    grid_prompts = body.get("grid_prompts", [])
    description = body.get("description", "")
    script_text = body.get("script_text", "")
    image_urls = body.get("image_urls", [])
    chat_history = body.get("chat_history", [])
    user_message = body.get("user_message", "")
    if not grid_prompts and not description:
        raise HTTPException(status_code=400, detail="当前分镜描述为空")
    if not user_message:
        raise HTTPException(status_code=400, detail="修改指令为空")

    prompts_text = "\n".join(f"格{i+1}: {gp}" for i, gp in enumerate(grid_prompts)) if grid_prompts else description

    system_prompt = """你是一位资深的视频编剧和导演，拥有丰富的分镜设计经验。

你的任务：
1. 仔细观察用户提供的上一次生成的分镜图片（如有），结合剧情和当前分镜描述，以专业视角分析这张分镜图存在的缺陷（构图问题、人物站位不合理、镜头衔接不流畅、与剧情不符等）
2. 根据用户的修改指令和你的专业分析，输出修改后的分镜描述

分析原则：
- 画面是否准确传达了剧情的情绪和节奏
- 人物的动作、表情是否与剧情匹配
- 镜头景别和角度是否有助于叙事
- 相邻格之间的视觉连贯性和节奏感
- 构图是否有冲击力，是否避免了呆板的正面平拍

规则：
1. 只修改需要改进的部分，其余格保持不变
2. 修改后的格数必须与原来一致
3. 每格描述必须包含：人物站位、动作表情、背景环境、镜头景别和角度
4. 确保修改后相邻格之间的动作和情节仍然连贯

只输出JSON：{"analysis": "你的专业分析（不限字数，详细说明发现的问题和改进思路）", "grid_prompts": ["格1描述", "格2描述", ...], "description": "整体分镜描述"}"""

    # 收集分镜图片
    vision_images = []
    for url in image_urls:
        b = load_ref_image_b64(url)
        if b:
            vision_images.append({"b64": b, "label": "上一次生成的分镜图"})

    user_text = f"剧情内容：\n{script_text}\n\n当前分镜描述：\n{prompts_text}"

    if chat_history:
        user_text += "\n\n之前的修改记录：\n"
        for msg in chat_history:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "user" and content:
                user_text += f"用户要求：{content}\n"
            elif role == "assistant" and content and content != "done":
                user_text += f"AI分析：{content}\n"

    user_text += f"\n本次修改指令：{user_message}"

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_text, vision_images, max_tokens=20000)
    else:
        result = await call_llm_json(config, system_prompt, user_text, max_tokens=20000)

    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/story-template")
async def gen_story_template(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")

    segment_text = body.get("segment_text", "")
    seg_idx = body.get("segment_index", 0)
    total = body.get("total_segments", 1)
    duration = body.get("duration", 15)
    characters = body.get("characters", [])
    scenes = body.get("scenes", [])
    storyboard_images = body.get("storyboard_images", [])
    storyboard_grid = body.get("storyboard_grid", 4)
    grid_prompts = body.get("grid_prompts", []) or []
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    image_count = max(1, min(int(body.get("image_count", 1)), 4))
    orientation = body.get("orientation", "horizontal")
    if orientation not in ("horizontal", "vertical"):
        orientation = "horizontal"
    extra_hint = (body.get("extra_hint") or "").strip()

    if storyboard_grid not in (4, 6, 9, 16):
        storyboard_grid = 4
    grid_label = {4: "2x2", 6: "2x3", 9: "3x3", 16: "4x4"}.get(storyboard_grid, "2x2")

    char_desc = "、".join(f"{c.get('name','')}" for c in characters) if characters else "无特定角色"
    scene_desc = "、".join(f"{s.get('name','')}: {s.get('description','')[:60]}" for s in scenes) if scenes else "无特定场景"

    # 用分镜节点给出的每格描述作为每格画面依据；缺失时才退化为"依据剧情自行拆分"
    # 分镜节点的描述里自带"第X排第Y格"行列定位（按分镜图宫格比例规划），
    # 但故事板的比例/排布不同，位置对不上会误导模型，所以这里剥掉行列定位，只保留画面描述本身。
    cut_lines = []
    effective_grid = storyboard_grid
    if grid_prompts:
        effective_grid = len(grid_prompts)
        for i, gp in enumerate(grid_prompts):
            text = _strip_grid_position_and_style((gp or "").strip(), style)
            if len(text) > 280:
                text = text[:280] + "…"
            cut_lines.append(f"第{i+1}格：{text}")
    else:
        for i in range(storyboard_grid):
            cut_lines.append(f"第{i+1}格：依据剧情自行拆分本格画面内容")
    cut_block = "\n".join(cut_lines)

    style_tag = f"\n整体画面风格：{style}" if (style and style.strip()) else ""

    if orientation == "vertical":
        prompt = (
            f"故事板设计图，竖版9:16比例，电影分镜板布局。\n"
            f"剧情：{segment_text[:300]}\n"
            f"总时长：{duration}秒（时间在各分镜之间按画面信息量和叙事节奏自由分配，不要求等分，只需保证总和=总时长）。\n"
            f"人物：{char_desc}。场景：{scene_desc}。\n"
            f"分镜内容（共{effective_grid}格，必须按顺序逐格对应以下描述绘制，画面主体/动作/构图/景别必须与下述一致）：\n"
            f"{cut_block}\n"
            f"结构要求：\n"
            f"【分镜板】画面上部，{effective_grid}个分镜从上到下竖直顺序单列排列，每一格占一行，占据画面主要面积。\n"
            f"每格必须标注：格编号（第1格、第2格…，严禁使用第X排第Y格或行列坐标）、"
            f"该格的持续时长（由你根据该格画面节奏自行决定，如第1格 3.2s）、"
            f"分镜画面、主体描述、动作、画面描述、镜头景别与运镜、台词、音效。\n"
            f"【场景图】分镜板下方，2张俯视角场景全景图横向并列，无人物。\n"
            f"【光影与氛围】底部排列，灯光效果、色彩板、风格标注。\n"
            f"整体排版清晰，竖向长屏故事板风格，适配手机/短视频竖屏阅读，中文标注。"
            f"{style_tag}"
        )
        resolutions = [(2160, 3840), (1080, 1920)]
    else:
        prompt = (
            f"故事板设计图，横版16:9比例，电影分镜板布局。\n"
            f"剧情：{segment_text[:300]}\n"
            f"总时长：{duration}秒（时间在各分镜之间按画面信息量和叙事节奏自由分配，不要求等分，只需保证总和=总时长）。\n"
            f"人物：{char_desc}。场景：{scene_desc}。\n"
            f"分镜内容（共{effective_grid}格，必须按顺序逐格对应以下描述绘制，画面主体/动作/构图/景别必须与下述一致）：\n"
            f"{cut_block}\n"
            f"结构要求：\n"
            f"【分镜板】画面中央靠上，{grid_label}宫格图顺序排列，共{effective_grid}个分镜。\n"
            f"每格必须标注：格编号（第1格、第2格…，严禁使用第X排第Y格或行列坐标）、"
            f"该格的持续时长（由你根据该格画面节奏自行决定，如第1格 3.2s）、"
            f"分镜画面、主体描述、动作、画面描述、镜头景别与运镜、台词、音效。\n"
            f"【场景图】分镜板下方，2张俯视角场景全景图，无人物。\n"
            f"【光影与氛围】底部排列，灯光效果、色彩板、风格标注。\n"
            f"整体排版清晰，专业电影故事板风格，中文标注。"
            f"{style_tag}"
        )
        resolutions = [(3840, 2160), (2560, 1440)]

    if extra_hint:
        prompt = prompt + f"\n【审核反馈（需在本次生成中解决）】：{extra_hint}"

    ref_imgs = collect_ref_images(characters=characters, scenes=scenes, extra_urls=storyboard_images)

    for w, h in resolutions:
        try:
            img_res = await generate_image(ImageGenerateRequest(
                config_id=img_config["id"], prompt=prompt,
                width=w, height=h, n=image_count,
                image_base64_list=ref_imgs,
            ))
            img_data = img_res.get("data", [])
            image_urls = []
            for item in img_data:
                b64 = item.get("b64_json", "")
                if b64:
                    url = save_workflow_image(
                        wf_id,
                        b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}",
                        f"story_tpl_seg{seg_idx}"
                    )
                    image_urls.append(url)
            if image_urls:
                return JSONResponse({"code": 0, "data": {"imageUrl": image_urls[0], "imageUrls": image_urls, "prompt": prompt}})
        except Exception as e:
            print(f"[workflow] 故事模板 {w}x{h} 生成失败，尝试降级: {e}")

    raise HTTPException(status_code=500, detail="故事模板生成失败：所有分辨率均失败")


@router.post("/generate/frame-prompt")
async def gen_frame_prompt(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    plot = body.get("plot", "")
    duration = min(max(int(body.get("duration", 5)), 1), 15)
    first_frame_url = body.get("first_frame_url", "")
    last_frame_url = body.get("last_frame_url", "")
    wf_id = body.get("workflow_id", "")

    system_prompt = f"""你是AI视频生成提示词专家。用户会提供一段视频的首帧画面和尾帧画面（图片），以及这段时间内发生的剧情描述。

你的任务是根据这些信息，生成一段完整的视频提示词，时长{duration}秒。

提示词必须包含以下内容，分为两段：

第一段【画面与运镜】：
- 从首帧画面开始，到尾帧画面结束
- 详细描述画面中发生的动作、表情、姿态变化
- 明确说明运镜方式（推/拉/摇/移/跟/升/降/环绕/手持等）
- 说明镜头过渡方式（切/溶/淡入淡出/划等）
- 描述景别变化（特写/近景/中景/全景/远景）
- 描述光线、色调、氛围的变化
- 注意首尾帧之间的连贯性和自然过渡

第二段【配音与音效】：
- 配音内容（台词/旁白，含语气、情绪、语速描述）
- 环境音（风声、雨声、人群声等）
- 特效音（脚步声、门声、音乐节奏等）
- 音乐风格和节奏建议

仔细观察首帧和尾帧图片的实际内容（人物、场景、光线、构图），确保提示词与图片内容一致。

只输出JSON：{{"full_text": "第一段...\\n\\n第二段..."}}"""

    user_prompt = f"视频时长：{duration}秒\n剧情描述：{plot}"

    vision_images = []
    if first_frame_url:
        b = load_ref_image_b64(first_frame_url)
        if b:
            vision_images.append({"b64": b, "label": "首帧画面"})
    if last_frame_url:
        b = load_ref_image_b64(last_frame_url)
        if b:
            vision_images.append({"b64": b, "label": "尾帧画面"})

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


# ═══════════════════════════════════════════════════
#  审核 API
# ═══════════════════════════════════════════════════

@router.post("/review/plan")
async def review_plan(body: dict):
    """审核人物场景规划：剧情 + 人物 + 场景 → 判断规划合理性"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    full_text = body.get("full_text", "")
    main_characters = body.get("main_characters", [])
    segments = body.get("segments", [])
    style = body.get("style", "")

    chars_desc = "\n".join(
        f"- {c.get('name','')}: {c.get('description','')}" for c in main_characters
    ) or "无"
    segs_desc = ""
    for i, sp in enumerate(segments):
        minors = sp.get("minor_characters", [])
        scenes = sp.get("scenes", [])
        minor_text = "\n    ".join(f"{c.get('name','')}: {c.get('description','')[:80]}" for c in minors) if minors else "无"
        scene_text = "\n    ".join(f"{s.get('name','')}: {s.get('description','')[:80]}" for s in scenes) if scenes else "无"
        segs_desc += f"\n第{i+1}段:\n  次要人物: {minor_text}\n  场景: {scene_text}"

    system_prompt = f"""你是一位资深影视制片人和美术总监。请审核以下视频项目的人物场景规划是否合理。
风格：{style}

审核原则（重要）：
- 你的职责是判断"已有的规划内容质量是否可用"，而不是追求完美覆盖剧本中的每一个细节
- 如果规划中的人物描述足够详细、场景描述足够具体、整体风格一致，即使有些剧本中提到的次要元素未被单独列出，也应该判定为通过
- 只有在存在明显的质量问题时才判定不通过，例如：描述过于模糊无法生成图片、人物描述前后矛盾、关键主角缺失等
- 次要人物和场景为"无"不一定是问题——有些段落确实不需要额外的次要人物或独立场景

审核要点：
1. 主要人物的外貌描述是否足够详细，能让AI准确生成角色图
2. 已列出的次要人物描述是否清晰（不要求剧本中每个提及的角色都必须列出）
3. 已列出的场景描述是否具体，能让AI生成准确的场景图
4. 人物和场景在不同段落间的一致性
5. 整体视觉风格是否统一

如果规划质量可用，返回 passed=true。
只有存在明显质量缺陷时才返回 passed=false，并在 revised_data 中给出修改后的完整规划。
所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，详细说明审核结论和理由，不可为空", "revised_data": {{"main_characters": [...], "segments": [...]}}}}
revised_data 的格式与输入完全一致。如果 passed=true，revised_data 可以为空对象。"""

    user_prompt = f"完整剧本：\n{full_text}\n\n主要人物：\n{chars_desc}\n\n各段规划：{segs_desc}"
    result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


@router.post("/review/scene-image")
async def review_scene_image(body: dict):
    """审核场景图片：图片 + 描述 + 剧情 → 判断场景图是否合理"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    scenes = body.get("scenes", [])
    segment_text = body.get("segment_text", "")
    style = body.get("style", "")

    vision_images = []
    scene_descs = []
    for i, sc in enumerate(scenes):
        scene_descs.append(f"场景{i+1} {sc.get('name','')}: {sc.get('description','')}")
        b = load_ref_image_b64(sc.get("imageUrl", ""))
        if b:
            vision_images.append({"b64": b, "label": f"场景{i+1}·{sc.get('name','')}"})

    system_prompt = f"""你是一位资深影视美术指导。请审核以下场景图片是否与剧情和描述匹配。
风格：{style}

审核要点：
1. 图片中的环境是否与场景描述一致
2. 图片风格是否符合项目整体风格
3. 图片中是否意外出现了人物（场景图应该是纯环境）
4. 光线、氛围是否与剧情匹配

如果所有场景图都合理，返回 passed=true。
如果有问题，返回 passed=false，并在 revised_scenes 中给出修改后的 visual_prompt。
所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，详细说明审核结论和理由，不可为空", "revised_scenes": [{{"index": 0, "visual_prompt": "修改后的生图提示词"}}]}}
如果 passed=true，revised_scenes 可以为空数组。"""

    user_prompt = f"段落剧情：{segment_text}\n\n场景描述：\n" + "\n".join(scene_descs)

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


@router.post("/review/frame-plan")
async def review_frame_plan(body: dict):
    """审核帧画面规划：剧情 → 判断首帧/分镜/尾帧规划合理性"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    first_frame = body.get("first_frame", {})
    storyboard = body.get("storyboard", {})
    last_frame = body.get("last_frame", {})
    style = body.get("style", "")

    ff_desc = first_frame.get("description", "") or first_frame.get("visual_prompt", "")
    lf_desc = last_frame.get("description", "") or last_frame.get("visual_prompt", "")
    grid_prompts = storyboard.get("grid_prompts", [])

    has_ff = bool(ff_desc)
    has_sb = bool(grid_prompts)
    has_lf = bool(lf_desc)

    if not has_ff and not has_sb and not has_lf:
        return JSONResponse({"code": 0, "data": {"passed": True, "analysis": "所有帧节点均已跳过，无需审核", "revised_data": {}}})

    review_parts = []
    review_points = []
    json_fields = []
    user_parts = []

    if has_ff:
        review_parts.append("首帧")
        review_points.append("- 首帧是否有足够的视觉冲击力，能抓住观众注意力")
        json_fields.append('"first_frame": {"description": "...", "visual_prompt": "..."}')
        user_parts.append(f"首帧：{ff_desc}")
    if has_sb:
        sb_text = "\n".join(f"格{i+1}: {gp}" for i, gp in enumerate(grid_prompts))
        review_parts.append("分镜")
        review_points.append("- 分镜各格是否都是关键叙事节点（不是无意义的过渡）")
        review_points.append("- 分镜格之间的动作和情节是否连贯")
        json_fields.append('"storyboard": {"description": "...", "grid_prompts": [...]}')
        user_parts.append(f"分镜：\n{sb_text}")
    if has_lf:
        review_parts.append("尾帧")
        review_points.append("- 尾帧是否有合适的收束感或过渡感")
        json_fields.append('"last_frame": {"description": "...", "visual_prompt": "..."}')
        user_parts.append(f"尾帧：{lf_desc}")
    if len(review_parts) > 1:
        review_points.append("- " + "→".join(review_parts) + " 的整体节奏是否流畅")

    target = "、".join(review_parts)
    points_text = "\n".join(review_points)
    json_structure = ", ".join(json_fields)

    system_prompt = f"""你是一位资深电影分镜师。请审核以下帧画面规划中的 {target} 是否合理。
风格：{style}
注意：用户只启用了 {target}，其他帧节点已跳过，不要评价未启用的部分。

审核要点：
{points_text}

如果规划合理，返回 passed=true。
如果有问题，返回 passed=false，并在 revised_data 中给出修改后的规划。
所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，详细说明审核结论和理由，不可为空", "revised_data": {{{json_structure}}}}}
如果 passed=true，revised_data 可以为空对象。只修改有问题的部分，没问题的保持原样。"""

    user_prompt = f"段落剧情：{segment_text}\n\n" + "\n\n".join(user_parts)
    result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


# PLACEHOLDER_REVIEW_IMAGE_AND_MORE

@router.post("/review/image")
async def review_image(body: dict):
    """审核图片节点（首帧/分镜/尾帧）：图片 + 描述 + 剧情 → 判断合理性"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    node_type = body.get("node_type", "")
    image_urls = body.get("image_urls", [])
    description = body.get("description", "")
    visual_prompt = body.get("visual_prompt", "")
    segment_text = body.get("segment_text", "")
    style = body.get("style", "")

    node_label = {"firstFrame": "首帧画面", "storyboard": "分镜图", "lastFrame": "尾帧画面"}.get(node_type, node_type)

    vision_images = []
    for url in image_urls:
        b = load_ref_image_b64(url)
        if b:
            vision_images.append({"b64": b, "label": node_label})

    system_prompt = f"""你是一位资深影视美术指导。请审核以下{node_label}是否与剧情和描述匹配。
风格：{style}

审核要点：
1. 图片内容是否准确反映了描述中的画面
2. 人物的动作、表情、站位是否与描述一致
3. 场景环境、光线、氛围是否正确
4. 构图和镜头角度是否合理
5. 整体风格是否统一

如果图片合理，返回 passed=true。
如果有问题，返回 passed=false，并给出修改后的 visual_prompt 用于重新生成。
所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，详细说明审核结论和理由，不可为空", "revised_visual_prompt": "修改后的生图提示词（passed=true时为空字符串）"}}"""

    user_prompt = f"段落剧情：{segment_text}\n\n{node_label}描述：{description}\n生图提示词：{visual_prompt}"

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})


@router.post("/review/video-prompt")
async def review_video_prompt(body: dict):
    """审核视频提示词：提示词 + 剧情 + 分镜图 + 首尾帧图片 → 多模态判断"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    full_text = body.get("full_text", "")
    segment_text = body.get("segment_text", "")
    style = body.get("style", "")
    first_frame_url = body.get("first_frame_url", "")
    last_frame_url = body.get("last_frame_url", "")
    storyboard_urls = body.get("storyboard_urls", [])

    vision_images = []
    if first_frame_url:
        b = load_ref_image_b64(first_frame_url)
        if b: vision_images.append({"b64": b, "label": "首帧画面"})
    for url in storyboard_urls:
        b = load_ref_image_b64(url)
        if b: vision_images.append({"b64": b, "label": "分镜图"})
    if last_frame_url:
        b = load_ref_image_b64(last_frame_url)
        if b: vision_images.append({"b64": b, "label": "尾帧画面"})

    system_prompt = f"""你是一位资深视频导演和AI视频提示词专家。请审核以下视频提示词是否存在会影响视频生成质量的明显错误。

仔细观察提供的参考图片（首帧、分镜图、尾帧），逐格对照提示词中的动作描述进行审核。

审核范围（只关注以下问题，其他方面不要评价）：
1. 人物动作/姿态描述是否与参考图片中的实际画面一致（这是最重要的，仔细观察每张图中人物的手、脚、身体姿态）
2. 运镜描述是否合理（推/拉/摇/移/跟等是否流畅、是否有助于叙事）
3. 时间分配是否合理，关键动作是否有足够时长
4. 画面之间的过渡是否连贯

不要审核的内容（以下问题直接忽略，不影响通过）：
- 风格描述（风格会在生成时统一附加）
- 背景场景细节（光线、天气、环境物体等）
- 色调、氛围等美术方向

如果提示词没有明显的动作描述错误和运镜问题，返回 passed=true。
只有存在动作与画面明显不符、运镜逻辑错误等会直接影响视频生成的问题时，才返回 passed=false，并给出修改后的完整提示词。
所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，详细说明审核结论和理由，不可为空", "revised_full_text": "修改后的完整提示词（passed=true时为空字符串）"}}"""

    user_prompt = f"段落剧情：{segment_text}\n\n当前视频提示词：\n{full_text}"

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)

    if not result.get("passed") and not (result.get("analysis") or "").strip():
        result["analysis"] = "审核未通过但模型未给出具体原因，请人工检查提示词或画面对照关系"

    return JSONResponse({"code": 0, "data": result})


@router.post("/review/story-template")
async def review_story_template(body: dict):
    """审核故事模板：图片 + 剧情 + 分镜图对照 → 专业编导视角判断"""
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    image_url = body.get("image_url", "")
    segment_text = body.get("segment_text", "")
    style = body.get("style", "")
    current_prompt = body.get("current_prompt", "")
    storyboard_urls = body.get("storyboard_urls", []) or []
    grid_prompts = body.get("grid_prompts", []) or []

    vision_images = []
    b = load_ref_image_b64(image_url)
    if b:
        vision_images.append({"b64": b, "label": "故事模板"})
    for idx, url in enumerate(storyboard_urls):
        sb_b = load_ref_image_b64(url)
        if sb_b:
            vision_images.append({"b64": sb_b, "label": f"分镜图{idx+1}"})

    has_ref = bool(storyboard_urls)
    gp_text = ""
    if grid_prompts:
        gp_text = "\n\n分镜分格描述（用于校对，已去除行列定位与重复风格前缀）：\n" + "\n".join(
            f"第{i+1}格：{_strip_grid_position_and_style(str(p or ''), style)}"
            for i, p in enumerate(grid_prompts)
        )

    ref_section = ""
    if has_ref:
        ref_section = (
            "\n\n本次审核提供了该段的【分镜图】作为标准对照。故事模板中的每一格分镜必须与分镜图逐格对应，"
            "包括主体、动作、构图、景别、镜头语言、场景要素等都应保持一致。\n"
            "重点检查：\n"
            "A. 故事模板的分镜数量、顺序是否与分镜图一致\n"
            "B. 每一格画面内容是否忠实还原对应的分镜图（主体姿态、构图、景别、镜头、场景）\n"
            "C. 如果有明显偏离分镜图的地方，必须 passed=false，并在 revised_prompt 中针对性地微调生图提示词，"
            "强调与分镜图对照一致的要求（例如补充景别、运镜、构图、场景、姿态等约束）。"
        )

    system_prompt = f"""你是一位资深影视编导。请以专业编导的视角审核以下故事模板图片。
风格：{style}

审核要点：
1. 故事模板中的分镜内容是否与剧情匹配
2. 分镜的叙事节奏是否合理（起承转合）
3. 画面构图是否专业，镜头语言是否丰富
4. 人物动作和表情是否自然、有表现力
5. 场景切换是否流畅，视觉连贯性如何
6. 整体是否达到专业编导的制作标准{ref_section}

输出要求：
- analysis 必填。无论 passed 是 true 还是 false，都必须给出详细的中文审核理由（至少 30 字），说明看到了什么、为什么通过或不通过。禁止返回空字符串。
- 如果故事模板合理且与分镜图（若提供）一致，passed=true。
- 如果有问题，passed=false，并在 revise_hint 中给出**简短具体的中文微调指令**（50~200字），用于在下一轮重新生成时叠加到原提示词末尾。revise_hint 必须是可执行的整改要点，例如"第2格改为俯拍全景，人物姿态改为抬头仰望"，而不是整篇提示词。
- revised_prompt 可选：如果你认为必须整段重写原提示词才能修复，再填入完整新提示词；否则保持空字符串。

所有输出内容必须使用中文。

只输出JSON：
{{"passed": true/false, "analysis": "必填，不可为空", "revise_hint": "微调指令（passed=true时为空字符串）", "revised_prompt": "可选，仅在需要整段重写时填入"}}"""

    user_prompt = f"段落剧情：{segment_text}\n\n当前生图提示词：{current_prompt}{gp_text}"

    if vision_images:
        result = await call_llm_vision_json(config, system_prompt, user_prompt, vision_images)
    else:
        result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})
