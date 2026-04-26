"""
一键启动脚本
默认仅启动服务；如需自动打开浏览器，设置环境变量 OPEN_BROWSER=1

兼容 PyInstaller --windowed：在无控制台环境下禁用 uvicorn 默认日志配置，
避免 `NoneType has no attribute isatty`。
"""
import os
import sys
import logging
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


if __name__ == "__main__":
    if os.environ.get("OPEN_BROWSER", "0") == "1":
        try:
            import webbrowser
            webbrowser.open(f"http://{SERVER_HOST}:{SERVER_PORT}")
        except Exception:
            pass

    log_config = None if is_headless_stdio() else uvicorn.config.LOGGING_CONFIG
    if log_config is None:
        setup_basic_logging()

    uvicorn.run(
        app,
        host=SERVER_HOST,
        port=SERVER_PORT,
        log_config=log_config,
    )
