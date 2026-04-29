from fastapi import APIRouter, HTTPException
from backend.models.schemas import ModelConfig, ConfigTestRequest
from backend.core.config_handler import load_configs, save_configs
from backend.core.request_client import async_http_request

router = APIRouter(prefix="/api/configs", tags=["配置管理"])

# 全局配置缓存
config_list = load_configs()


# 获取所有配置
@router.get("")
async def get_all_configs():
    return {"code": 0, "data": config_list}


# 新增/更新配置
@router.post("")
async def add_or_update_config(config: ModelConfig):
    global config_list
    exist_index = next((i for i, c in enumerate(config_list) if c["id"] == config.id), -1)
    config_dict = config.model_dump()
    if exist_index >= 0:
        config_list[exist_index] = config_dict
    else:
        config_list.append(config_dict)
    save_configs(config_list)
    return {"code": 0, "message": "配置保存成功", "data": config_dict}


# 删除配置
@router.delete("/{config_id}")
async def delete_config(config_id: str):
    global config_list
    config_list = [c for c in config_list if c["id"] != config_id]
    save_configs(config_list)
    return {"code": 0, "message": "配置删除成功"}


# 🔧 测试配置连通性（超详细日志版）
@router.post("/test")
async def test_config_connection(req: ConfigTestRequest):
    print("\n" + "=" * 50)
    print("[测试连接] 开始测试...")
    print(f"[测试连接] 配置类型: {req.config_type}")
    print(f"[测试连接] API地址: {req.api_base}")
    print(f"[测试连接] 模型名称: {req.model_name}")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {req.api_key}"
    }

    try:
        # 1. 先测试聊天模型（如果是聊天或通用）
        if req.config_type in ["chat", "both"]:
            print("[测试连接] 正在测试聊天接口...")
            chat_url = req.api_base.rstrip("/") + "/chat/completions"
            chat_data = {
                "model": req.model_name,
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 5
            }

            print(f"[测试连接] 请求URL: {chat_url}")
            response = await async_http_request("POST", chat_url, headers, chat_data, timeout=60.0)
            print(f"[测试连接] 聊天接口状态码: {response.status_code}")

            if response.status_code == 200:
                print("[测试连接] ✅ 聊天接口测试成功")
                return {"code": 0, "message": "✅ 连接测试成功，配置可用"}

        # 2. 测试图片模型（如果是图片或通用，且聊天没成功）
        if req.config_type in ["image", "both"]:
            print("[测试连接] 正在测试图片接口...")
            image_url = req.api_base.rstrip("/") + "/images/generations"
            image_data = {
                "model": req.model_name,
                "prompt": "test",
                "size": "1024x1024",
                "n": 1
            }

            print(f"[测试连接] 请求URL: {image_url}")
            response = await async_http_request("POST", image_url, headers, image_data, timeout=60.0)
            print(f"[测试连接] 图片接口状态码: {response.status_code}")

            raw_text = response.text
            print(f"[测试连接] 图片接口响应: {raw_text[:200]}")

            if response.status_code == 200:
                print("[测试连接] ✅ 图片接口测试成功")
                return {"code": 0, "message": "✅ 连接测试成功，配置可用"}

        # 如果都没成功
        print("[测试连接] ❌ 所有接口测试失败")
        return {"code": -1, "message": "连接失败，请检查API地址、Key和模型名称"}

    except Exception as e:
        print(f"[测试连接] ❌ 系统异常: {str(e)}")
        import traceback
        traceback.print_exc()
        return {"code": -1, "message": f"连接失败: {str(e)}"}
    finally:
        print("=" * 50 + "\n")