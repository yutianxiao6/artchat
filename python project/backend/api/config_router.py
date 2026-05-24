from fastapi import APIRouter, HTTPException
from backend.models.schemas import ModelConfig, ConfigTestRequest
from backend.core.config_handler import load_configs, save_configs, set_cached_strategy, clear_cached_strategy
from backend.core.request_client import async_http_request, build_endpoint_url, is_chat_as_image_host

router = APIRouter(prefix="/api/configs", tags=["配置管理"])

# 全局配置缓存（列表对象一旦创建，永远就地修改，不重新赋值，避免其他模块拿到的引用失效）
config_list = load_configs()


def get_config_list():
    """其他模块统一通过此函数获取当前最新配置列表；函数每次返回当前绑定，避免 from...import 冻结引用。"""
    return config_list


# 获取所有配置
@router.get("")
async def get_all_configs():
    return {"code": 0, "data": config_list}


# 新增/更新配置
@router.post("")
async def add_or_update_config(config: ModelConfig):
    exist_index = next((i for i, c in enumerate(config_list) if c["id"] == config.id), -1)
    config_dict = config.model_dump()
    if exist_index >= 0:
        # 若 api_base 改变，旧的 strategy 缓存失效，清掉
        old_base = (config_list[exist_index].get("api_base") or "").rstrip("/")
        new_base = (config_dict.get("api_base") or "").rstrip("/")
        if old_base != new_base:
            clear_cached_strategy(config.id)
        config_list[exist_index] = config_dict
    else:
        config_list.append(config_dict)
    save_configs(config_list)
    return {"code": 0, "message": "配置保存成功", "data": config_dict}


# 删除配置
@router.delete("/{config_id}")
async def delete_config(config_id: str):
    # 就地删除，不重新赋值 config_list（保证其他模块早已 import 的引用依然有效）
    config_list[:] = [c for c in config_list if c["id"] != config_id]
    save_configs(config_list)
    clear_cached_strategy(config_id)
    return {"code": 0, "message": "配置删除成功"}


# 🔧 测试配置连通性
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
        # 白名单 host：所有模型都走 /chat/completions，用 GET /models 做轻量探活
        if is_chat_as_image_host(req.api_base):
            print("[测试连接] 白名单 host，使用 /models 探活...")
            models_url = build_endpoint_url(req.api_base, "/models")
            try:
                response = await async_http_request("GET", models_url, headers, None, timeout=60.0)
                if response.status_code == 200:
                    print("[测试连接] /models 探活成功")
                    if req.id and any(c.get("id") == req.id for c in config_list):
                        set_cached_strategy(req.id, "chat_as_image")
                    return {"code": 0, "message": "连接测试成功，配置可用（chat-as-image 网关）"}
                else:
                    print(f"[测试连接] /models 返回 {response.status_code}")
                    return {"code": -1, "message": f"连接失败（/models 返回 {response.status_code}），请检查API地址和Key"}
            except Exception as e:
                print(f"[测试连接] /models 探活异常: {e}")
                return {"code": -1, "message": f"连接超时或网络不可达，请检查API地址: {str(e)[:100]}"}

        # 1. 先测试聊天模型（如果是聊天或通用）
        if req.config_type in ["chat", "both"]:
            print("[测试连接] 正在测试聊天接口...")
            chat_url = build_endpoint_url(req.api_base, "/chat/completions")
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
            from backend.api.image_router import _get_applicable_strategies, _build_url, _build_request_data
            strategies = _get_applicable_strategies(req.api_base)
            for strategy in strategies:
                image_url = _build_url(req.api_base, strategy)
                image_data = _build_request_data(strategy, req.model_name, "test", 1024, 1024, 1, "", [])
                print(f"[测试连接] 尝试策略 {strategy['id']}，URL: {image_url}")
                try:
                    response = await async_http_request("POST", image_url, headers, image_data, timeout=60.0)
                    print(f"[测试连接] 状态码: {response.status_code}")
                    if response.status_code == 200:
                        print(f"[测试连接] ✅ 图片接口测试成功（策略: {strategy['id']}）")
                        # 若客户端带了 id 且已保存过，把探测出来的策略缓存起来，避免生图时再重新探测
                        if req.id and any(c.get("id") == req.id for c in config_list):
                            set_cached_strategy(req.id, strategy["id"])
                            print(f"[测试连接] 已缓存策略 {strategy['id']} 到 config_id={req.id}")
                        return {"code": 0, "message": f"✅ 连接测试成功，配置可用（格式: {strategy['id']}）"}
                    else:
                        print(f"[测试连接] 策略 {strategy['id']} 返回 {response.status_code}: {response.text[:200]}")
                except Exception as e:
                    print(f"[测试连接] 策略 {strategy['id']} 异常: {e}")
                    continue

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