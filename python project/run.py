"""
一键启动脚本
默认自动寻找可用端口，并在服务启动后自动打开浏览器。

兼容 PyInstaller --windowed：在无控制台环境下禁用 uvicorn 默认日志配置，
避免 `NoneType has no attribute isatty`。
"""
import os
import sys
import time
import socket
import logging
import threading
import webbrowser
import uvicorn

# 将项目根目录加入Python路径，解决模块导入问题
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.main import SERVER_HOST, SERVER_PORT, app


def setup_basic_logging():
    """在 windowed/无控制台环境下兜底日志配置。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )


def is_headless_stdio():
    return sys.stdout is None or sys.stderr is None


def find_free_port(host: str, preferred_port: int, max_attempts: int = 100) -> int:
    """优先使用默认端口，若被占用则自动寻找后续空闲端口。"""
    for port in range(preferred_port, preferred_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"在 {preferred_port} ~ {preferred_port + max_attempts - 1} 范围内未找到可用端口")


def wait_for_server(host: str, port: int, timeout: float = 15.0) -> bool:
    """等待服务真正监听后再打开浏览器，避免空白页。"""
    deadline = time.time() + timeout
    probe_host = "127.0.0.1" if host == "0.0.0.0" else host
    while time.time() < deadline:
        try:
            with socket.create_connection((probe_host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def open_browser_when_ready(host: str, port: int):
    probe_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{probe_host}:{port}"
    if wait_for_server(host, port):
        try:
            webbrowser.open(url)
        except Exception:
            pass


if __name__ == "__main__":
    log_config = None if is_headless_stdio() else uvicorn.config.LOGGING_CONFIG
    if log_config is None:
        setup_basic_logging()

    selected_port = find_free_port(SERVER_HOST, SERVER_PORT)

    browser_thread = threading.Thread(
        target=open_browser_when_ready,
        args=(SERVER_HOST, selected_port),
        daemon=True,
    )
    browser_thread.start()

    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=selected_port,
        log_config=log_config,
    )
