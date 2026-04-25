from typing import List, Optional, Dict, Literal, Any
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


class SmartUploadedFile(BaseModel):
    filename: str
    content_type: str
    text_content: str
    size: int


class SmartChatRequest(BaseModel):
    message: str
    messages: List[Dict[str, str]] = []
    chat_config_id: Optional[str] = None
    image_config_id: Optional[str] = None
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    stream: bool = True
    files: List[SmartUploadedFile] = []


class SmartRouteResult(BaseModel):
    task_type: Literal["chat", "image", "file"]
    reason: str
    rewritten_prompt: Optional[str] = None
    image_size: Optional[str] = None
    image_count: Optional[int] = None

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
    image_base64_list: List[str] = []
    n: int = 1


class CanvasStatePayload(BaseModel):
    sessions: List[Dict[str, Any]] = []
    assetLibrary: List[Dict[str, Any]] = []
    categories: List[str] = []


class CanvasAssetCreateRequest(BaseModel):
    title: str = "未命名素材"
    source: str = "素材"
    category: str = "未分类"
    mime_type: str = "image/png"
    image_base64: str


class CanvasCategoryCreateRequest(BaseModel):
    name: str


class CanvasCategoryRenameRequest(BaseModel):
    old_name: str
    new_name: str


class CanvasAssetMoveRequest(BaseModel):
    asset_id: str
    target_category: str


class CanvasCategoryDeleteRequest(BaseModel):
    name: str


class CanvasAssetDeleteRequest(BaseModel):
    asset_id: str
