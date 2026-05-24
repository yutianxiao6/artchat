import re
import httpx
from typing import Dict, Any, Tuple
from urllib.parse import urlparse


# ══════════════════════════════════════════════════════════════
#  白名单：所有模型（含图像）都走 /chat/completions，
#  图片以 markdown ![](url) 形式塞在 choices[0].message.content 里
# ══════════════════════════════════════════════════════════════

CHAT_AS_IMAGE_HOSTS = {
    "aiapi.up.railway.app",
}


def _host_of(api_base: str) -> str:
    return (urlparse((api_base or "").strip()).netloc or "").lower()


def is_chat_as_image_host(api_base: str) -> bool:
    return _host_of(api_base) in CHAT_AS_IMAGE_HOSTS


# ══════════════════════════════════════════════════════════════
#  API Base URL 自适应工具
#  支持三类用户输入：
#    1. 裸 host：         https://api.example.com
#    2. 带版本前缀：       https://api.example.com/v1
#    3. 完整 endpoint：    https://api.example.com/v1/chat/completions
#    4. 自定义网关路径：    https://gateway.example.com/proxy/openai/v1
#  目标：无论哪种形态，chat/image 调用都能构造出合理的请求 URL
# ══════════════════════════════════════════════════════════════

# 已知的 OpenAI 兼容 endpoint 后缀（按更长匹配优先）
_KNOWN_ENDPOINTS = [
    "/chat/completions",
    "/messages",                 # Anthropic
    "/images/generations",
    "/images/edits",
    "/images/variations",
    "/completions",
    "/embeddings",
]

_VERSION_RE = re.compile(r"/v\d+$")


def split_api_base(api_base: str) -> Tuple[str, str]:
    """把用户填的 api_base 拆成 (base, trailing_endpoint)。
    - base：尾部不含已知 endpoint，可能以 /vN 结尾，也可能是裸 host 或自定义路径
    - trailing_endpoint：如果用户已经填了完整 endpoint，返回去掉 base 后的那段（以 / 开头）；否则 ""
    """
    s = (api_base or "").strip().rstrip("/")
    if not s:
        return "", ""
    low = s.lower()
    for ep in _KNOWN_ENDPOINTS:
        if low.endswith(ep):
            return s[: -len(ep)], s[-len(ep):]
    return s, ""


def base_has_version(base: str) -> bool:
    return bool(_VERSION_RE.search((base or "").rstrip("/")))


def build_endpoint_url(api_base: str, endpoint: str, *, default_version: str = "/v1") -> str:
    """按 endpoint 拼接完整 URL，自适应三类输入。
    endpoint 必须以 "/" 开头，例如 "/chat/completions"、"/images/generations"。
    规则：
      - 用户已填完整 endpoint（无论是同一个还是其他）→ 如果匹配，原样返回；如果不匹配目标 endpoint，则退到 base 再拼
      - 用户 base 以 /vN 结尾 → base + endpoint
      - 用户 base 无版本前缀 → base + default_version + endpoint
    """
    base, trailing = split_api_base(api_base)
    ep_lower = endpoint.lower()
    if trailing and trailing.lower() == ep_lower:
        return base + trailing
    # 否则忽略 trailing（可能是不同的 endpoint，用户估计是 chat 配置填成 image endpoint 之类）
    if base_has_version(base):
        return base + endpoint
    return base + default_version + endpoint


# 通用异步HTTP客户端
async def async_http_request(
    method: str,
    url: str,
    headers: Dict[str, str],
    json_data: Dict[str, Any] = None,
    timeout: float = 60.0,
    stream: bool = False,
):
    timeout_config = httpx.Timeout(timeout, connect=10.0)

    if stream:
        client = httpx.AsyncClient(verify=False, timeout=timeout_config)
        return client.stream(method, url, headers=headers, json=json_data)

    async with httpx.AsyncClient(verify=False, timeout=timeout_config) as client:
        if method.upper() == "POST":
            return await client.post(url, headers=headers, json=json_data)
        if method.upper() == "GET":
            return await client.get(url, headers=headers)
        raise Exception("不支持的请求方法")
