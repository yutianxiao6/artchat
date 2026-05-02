import json
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


def get_config_by_id(config_id: str):
    return next((c for c in config_list if c["id"] == config_id), None)


def get_first_config(config_type: str):
    allowed = {config_type, "both"}
    return next((c for c in config_list if c.get("config_type") in allowed), None)


async def call_llm_json(config: dict, system_prompt: str, user_prompt: str) -> dict:
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {config['api_key']}"}
    url = config["api_base"].rstrip("/") + "/chat/completions"
    data = {
        "model": config["model_name"],
        "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
        "temperature": 0.7, "stream": False, "max_tokens": 4000,
        "response_format": {"type": "json_object"}
    }
    response = await async_http_request("POST", url, headers, data, timeout=120.0)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text[:500])
    result = response.json()
    content = result["choices"][0]["message"]["content"]
    return json.loads(content)


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
    system_prompt = "你是一位专业的影视编剧。根据用户提供的简要情节、视频风格和类型，生成一个完整的视频剧本。\n要求：\n1. 剧本按每15秒一段进行分段，每段有清晰的场景描述和动作指示\n2. " + seg_hint + "\n3. 风格：" + style + "\n4. 类型：" + vtype + "\n5. 每段包含：场景环境、人物动作、对白/旁白、情绪氛围\n\n只输出 JSON：{\"full_text\": \"完整剧本\", \"segments\": [{\"index\": 0, \"text\": \"第一段...\", \"duration\": 15}, ...]}"
    result = await call_llm_json(config, system_prompt, f"情节：{plot}")
    return JSONResponse({"code": 0, "data": result})


@router.post("/generate/main-characters")
async def gen_main_characters(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    script = body.get("script", "")
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    system_prompt = "你是一位专业的角色设计师。根据以下剧本，提取并设计主要角色。\n风格：" + style + "\n\n为每个角色提供：名称、外貌特征详细描述（用于AI绘图的visual_prompt）、性格特点、在剧中的作用。\n\n只输出 JSON：{\"characters\": [{\"name\": \"...\", \"description\": \"...\", \"visual_prompt\": \"用于生图的详细外貌描述\"}]}"
    result = await call_llm_json(config, system_prompt, f"剧本：{script}")
    characters = result.get("characters", [])
    if img_config:
        for char in characters:
            try:
                prompt = f"{style}风格，角色设定图，{char.get('visual_prompt', char.get('description', ''))}"
                img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1024, height=1024, n=1))
                img_data = img_res.get("data", [])
                if img_data:
                    b64 = img_data[0].get("b64_json", "")
                    if b64:
                        url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", f"mc_{char.get('name','char')}")
                        char["imageUrl"] = url
            except Exception as e:
                print(f"[workflow] 人物图生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"characters": characters}})


@router.post("/generate/minor-characters")
async def gen_minor_characters(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    main_chars = body.get("main_characters", [])
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    main_names = ", ".join(c.get("name", "") for c in main_chars) if main_chars else "无"
    system_prompt = f"你是角色设计师。根据这段15秒剧本片段，设计该段出现的次要角色（不包括主要角色：{main_names}）。\n风格：{style}\n\n只输出 JSON：{{\"characters\": [{{\"name\": \"...\", \"description\": \"...\", \"visual_prompt\": \"...\"}}]}}\n如果没有次要角色，返回空数组。"
    result = await call_llm_json(config, system_prompt, f"段落剧本：{segment_text}")
    characters = result.get("characters", [])
    if img_config and characters:
        for char in characters:
            try:
                prompt = f"{style}风格，角色设定图，{char.get('visual_prompt', char.get('description', ''))}"
                img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1024, height=1024, n=1))
                img_data = img_res.get("data", [])
                if img_data and img_data[0].get("b64_json"):
                    b64 = img_data[0]["b64_json"]
                    char["imageUrl"] = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "minor")
            except Exception as e:
                print(f"[workflow] 次要人物图生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"characters": characters}})


@router.post("/generate/scene")
async def gen_scene(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    system_prompt = f"你是场景设计师。根据这段15秒剧本片段，设计该段的场景。\n风格：{style}\n\n只输出 JSON：{{\"description\": \"场景的详细文字描述\", \"visual_prompt\": \"用于AI生图的场景描述\"}}"
    result = await call_llm_json(config, system_prompt, f"段落剧本：{segment_text}")
    image_url = ""
    if img_config:
        try:
            prompt = f"{style}风格，场景设定图，{result.get('visual_prompt', result.get('description', ''))}"
            img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1536, height=1024, n=1))
            img_data = img_res.get("data", [])
            if img_data and img_data[0].get("b64_json"):
                b64 = img_data[0]["b64_json"]
                image_url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "scene")
        except Exception as e:
            print(f"[workflow] 场景图生成失败: {e}")
    return JSONResponse({"code": 0, "data": {"description": result.get("description", ""), "image_url": image_url}})


@router.post("/generate/storyboard")
async def gen_storyboard(body: dict):
    img_config = get_config_by_id(body.get("image_config_id", "")) or get_first_config("image")
    if not img_config:
        raise HTTPException(status_code=400, detail="未找到图片配置")
    segment_text = body.get("segment_text", "")
    scene_desc = body.get("scene_description", "")
    grid = body.get("grid", 4)
    style = body.get("style", "")
    wf_id = body.get("workflow_id", "")
    prompt = f"{style}风格，{grid}宫格分镜图，电影分镜，场景：{scene_desc}，剧情：{segment_text}"
    try:
        img_res = await generate_image(ImageGenerateRequest(config_id=img_config["id"], prompt=prompt, width=1024, height=1024, n=1))
        images = []
        for item in img_res.get("data", []):
            b64 = item.get("b64_json", "")
            if b64:
                url = save_workflow_image(wf_id, b64 if b64.startswith("data:") else f"data:image/png;base64,{b64}", "sb")
                images.append(url)
        return JSONResponse({"code": 0, "data": {"images": images}})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分镜图生成失败: {str(e)}")


@router.post("/generate/video-prompt")
async def gen_video_prompt(body: dict):
    config = get_config_by_id(body.get("chat_config_id", "")) or get_first_config("chat")
    if not config:
        raise HTTPException(status_code=400, detail="未找到聊天配置")
    segment_text = body.get("segment_text", "")
    seg_idx = body.get("segment_index", 0)
    total = body.get("total_segments", 1)
    scene_desc = body.get("scene_description", "")
    chars = body.get("characters", [])
    style = body.get("style", "")
    vtype = body.get("type", "")
    char_info = "\n".join(f"- {c.get('name','')}: {c.get('description','')}" for c in chars) if chars else "无特定角色信息"
    system_prompt = f"""你是一位专业的电影导演和视频制作人。根据以下信息，为这段15秒的视频片段生成详细的专业视频制作提示词。

段落序号：第{seg_idx+1}段，共{total}段
视频风格：{style}
视频类型：{vtype}

请生成以下内容：
1. 【运镜】详细的镜头运动描述（推拉摇移跟升降、景别变化、镜头速度）
2. 【音效】环境音、特效音描述
3. 【配音】旁白或对白内容及语气
4. 【过渡】与上一段/下一段的过渡方式
5. 【完整提示词】整合以上所有信息的一段完整视频生成提示词

只输出 JSON：{{"camera": "...", "sound": "...", "voiceover": "...", "transition": "...", "full_text": "..."}}"""
    user_prompt = f"段落剧本：{segment_text}\n场景描述：{scene_desc}\n出场人物：\n{char_info}"
    result = await call_llm_json(config, system_prompt, user_prompt)
    return JSONResponse({"code": 0, "data": result})
