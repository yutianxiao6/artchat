import httpx
from typing import Dict, Any


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
