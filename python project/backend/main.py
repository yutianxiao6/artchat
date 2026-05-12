import os
import sys
import logging
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# 关键：尽早劫持 stdout/stderr，这样后续所有 import 阶段的 print 都能被捕获
from backend.core.log_store import attach_stdout_stderr, cleanup_old_logs
attach_stdout_stderr()
cleanup_old_logs()

from backend.api.config_router import router as config_router
from backend.api.chat_router import router as chat_router, CHAT_IMAGES_DIR
from backend.api.image_router import router as image_router
from backend.api.canvas_router import router as canvas_router, canvas_assets_app
from backend.api.workflow_router import router as workflow_router
from backend.api.recreate_router import router as recreate_router
from backend.api.logs_router import router as logs_router
from backend.core.workflow_storage import WORKFLOW_ROOT


# 服务配置
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8000

# 适配开发环境与EXE打包后的静态文件路径
def get_frontend_dir():
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, "frontend")

FRONTEND_DIR = get_frontend_dir()

app = FastAPI(title="artchat", version="3.0", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(config_router)
app.include_router(chat_router)
app.include_router(image_router)
app.include_router(canvas_router)
app.include_router(workflow_router)
app.include_router(recreate_router)
app.include_router(logs_router)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
app.mount("/canvas-assets", canvas_assets_app, name="canvas-assets")
app.mount("/chat-images", StaticFiles(directory=CHAT_IMAGES_DIR), name="chat-images")
app.mount("/workflow-images", StaticFiles(directory=WORKFLOW_ROOT), name="workflow-images")

@app.get("/")
async def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
