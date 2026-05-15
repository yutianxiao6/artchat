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
    id: Optional[str] = None  # 如传入且已存在于配置列表，测试成功的图片策略会缓存到该 id

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
    text_content: str = ""
    size: int = 0
    image_url: Optional[str] = None
    preview_url: Optional[str] = None
    preview_path: Optional[str] = None


class SmartChatRequest(BaseModel):
    message: str
    messages: List[Dict[str, Any]] = []
    chat_config_id: Optional[str] = None
    image_config_id: Optional[str] = None
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    stream: bool = True
    files: List[SmartUploadedFile] = []


class SmartRouteResult(BaseModel):
    task_type: Literal["chat", "image"]
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


class PanoramaGenerateRequest(BaseModel):
    config_id: str
    image_base64: str  # forward 方位参考图（必填）
    prompt: Optional[str] = ""  # 场景额外描述（可选，会拼到方位 prompt 后）
    negative_prompt: Optional[str] = ""
    face_size: int = 1024  # 单个 cubemap 面分辨率
    out_width: int = 4096  # 全景输出宽度（高度 = 宽度 / 2）


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


class VideoChatRequest(BaseModel):
    config_id: str
    video_url: str
    message: str
    messages: List[Dict[str, Any]] = []
    stream: bool = True
    temperature: float = 0.7
    max_tokens: int = 4000
