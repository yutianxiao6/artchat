from typing import List, Optional, Dict
from pydantic import BaseModel

# 模型配置模型
class ModelConfig(BaseModel):
    id: str
    name: str
    config_type: str  # chat / image / both
    api_base: str
    api_key: str
    model_name: str
    description: Optional[str] = ""

# 配置连通性测试请求
class ConfigTestRequest(BaseModel):
    config_type: str
    api_base: str
    api_key: str
    model_name: str

# 聊天请求模型
class ChatRequest(BaseModel):
    config_id: str
    messages: List[Dict[str, str]]
    stream: bool = True
    temperature: float = 0.7
    max_tokens: Optional[int] = None

# 图片生成请求模型
class ImageGenerateRequest(BaseModel):
    config_id: str
    prompt: str
    negative_prompt: Optional[str] = ""
    width: int = 1024
    height: int = 1024
    steps: Optional[int] = 20
    cfg_scale: Optional[float] = 7.0
    image_base64: Optional[str] = None  # 图生图用
    n: int = 1
