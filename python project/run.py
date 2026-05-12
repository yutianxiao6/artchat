"""
一键启动脚本
启动规则：
1. 优先检查默认端口是否已有流绘服务；若已有，则直接打开浏览器，不重复启动。
2. 若默认端口被其他程序占用，则自动寻找新端口启动新的流绘实例。
3. 若默认端口空闲，则直接在默认端口启动，并在服务启动后自动打开浏览器。

运行形态：
- uvicorn 在后台线程运行，主线程驻留系统托盘
- 关闭浏览器不会关闭进程；要退出请在托盘图标上右键选择"退出"

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
import urllib.request
import urllib.error
import uvicorn

# 将项目根目录加入Python路径，解决模块导入问题
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.main import SERVER_HOST, SERVER_PORT, app

APP_TITLE = "artchat"
APP_DISPLAY_NAME = "流绘"


def setup_basic_logging():
    """在 windowed/无控制台环境下兜底日志配置。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )


def is_headless_stdio():
    return sys.stdout is None or sys.stderr is None


def browser_host(host: str) -> str:
    return "127.0.0.1" if host == "0.0.0.0" else host


def is_port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    probe_host = browser_host(host)
    try:
        with socket.create_connection((probe_host, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_our_app_running(host: str, port: int, timeout: float = 1.5) -> bool:
    url = f"http://{browser_host(host)}:{port}/"
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "LiuhuiLauncher/1.0"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(4096).decode("utf-8", errors="ignore")
            return (APP_TITLE in body.lower()) or (APP_DISPLAY_NAME in body)
    except Exception:
        return False


def find_free_port(host: str, preferred_port: int, max_attempts: int = 100) -> int:
    """从指定端口开始寻找空闲端口。"""
    bind_host = "127.0.0.1" if host == "0.0.0.0" else host
    for port in range(preferred_port, preferred_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((bind_host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"在 {preferred_port} ~ {preferred_port + max_attempts - 1} 范围内未找到可用端口")


def wait_for_server(host: str, port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_port_open(host, port, timeout=0.5):
            return True
        time.sleep(0.2)
    return False


def open_browser(url: str):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def open_browser_when_ready(host: str, port: int):
    url = f"http://{browser_host(host)}:{port}"
    if wait_for_server(host, port):
        open_browser(url)


def _resource_path(*parts) -> str:
    """兼容打包与开发环境的资源查找。"""
    if getattr(sys, 'frozen', False):
        bases = [getattr(sys, '_MEIPASS', None), os.path.dirname(sys.executable)]
    else:
        bases = [os.path.dirname(os.path.abspath(__file__))]
    for b in bases:
        if not b:
            continue
        p = os.path.join(b, *parts)
        if os.path.exists(p):
            return p
    return os.path.join(bases[0] or "", *parts)


def _load_tray_icon_image():
    """加载托盘图标。优先 .ico，其次 png，最后生成占位图。"""
    from PIL import Image
    candidates = [
        _resource_path("frontend", "assets", "app-icon.ico"),
        _resource_path("frontend", "assets", "app-icon-512.png"),
        _resource_path("frontend", "assets", "logo.png"),
        _resource_path("frontend", "assets", "favicon.png"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                img = Image.open(path)
                img.load()
                return img
            except Exception:
                continue
    # 生成一个简单占位方块
    img = Image.new("RGB", (64, 64), (31, 41, 55))
    return img


def run_uvicorn(host: str, port: int):
    log_config = None if is_headless_stdio() else uvicorn.config.LOGGING_CONFIG
    if log_config is None:
        setup_basic_logging()
    uvicorn.run(app, host=host, port=port, log_config=log_config)


def start_uvicorn_in_background(host: str, port: int):
    t = threading.Thread(target=run_uvicorn, args=(host, port), daemon=True)
    t.start()
    return t


def run_tray(host: str, port: int):
    """主线程驻留托盘。用户从托盘右键退出。"""
    try:
        import pystray
        from pystray import MenuItem as Item, Menu
    except ImportError as e:
        # 没装 pystray：退化成阻塞主线程（用户用任务管理器或 Ctrl+C 退出）
        print(f"[托盘] pystray 未安装，托盘图标不可用：{e}")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    url = f"http://{browser_host(host)}:{port}"
    icon_image = _load_tray_icon_image()

    def on_open(icon, item):
        open_browser(url)

    def on_quit(icon, item):
        icon.visible = False
        icon.stop()

    menu = Menu(
        Item("打开流绘", on_open, default=True),
        Item("退出", on_quit),
    )

    tray = pystray.Icon("liuhui", icon_image, APP_DISPLAY_NAME, menu)
    tray.run()
    # tray.run 返回后立即结束进程，避免残留后台线程
    os._exit(0)


if __name__ == "__main__":
    default_url = f"http://{browser_host(SERVER_HOST)}:{SERVER_PORT}"

    if is_our_app_running(SERVER_HOST, SERVER_PORT):
        # 已有实例：只打开浏览器，不再启动
        open_browser(default_url)
        sys.exit(0)

    if is_port_open(SERVER_HOST, SERVER_PORT):
        selected_port = find_free_port(SERVER_HOST, SERVER_PORT + 1)
    else:
        selected_port = SERVER_PORT

    # 先启服务
    start_uvicorn_in_background(SERVER_HOST, selected_port)

    # 服务就绪后打开浏览器
    threading.Thread(
        target=open_browser_when_ready,
        args=(SERVER_HOST, selected_port),
        daemon=True,
    ).start()

    # 主线程驻留托盘，直到用户右键退出
    run_tray(SERVER_HOST, selected_port)
