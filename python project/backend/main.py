import os
import sys
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from backend.api.config_router import router as config_router
from backend.api.chat_router import router as chat_router, CHAT_IMAGES_DIR
from backend.api.image_router import router as image_router
from backend.api.canvas_router import router as canvas_router, canvas_assets_app
from backend.api.workflow_router import router as workflow_router
from backend.core.workflow_storage import WORKFLOW_ROOT
from backend.core.lifecycle import lifecycle_manager

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

# 添加生命周期管理中间件
@app.middleware("http")
async def lifecycle_middleware(request: Request, call_next):
    # 记录活动
    lifecycle_manager.record_activity()
    response = await call_next(request)
    return response

app.include_router(config_router)
app.include_router(chat_router)
app.include_router(image_router)
app.include_router(canvas_router)
app.include_router(workflow_router)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
app.mount("/canvas-assets", canvas_assets_app, name="canvas-assets")
app.mount("/chat-images", StaticFiles(directory=CHAT_IMAGES_DIR), name="chat-images")
app.mount("/workflow-images", StaticFiles(directory=WORKFLOW_ROOT), name="workflow-images")

@app.get("/")
async def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/api/heartbeat")
async def heartbeat():
    """前端心跳接口，保持连接活跃"""
    import time
    lifecycle_manager.record_activity()
    return {"status": "ok", "timestamp": int(time.time() * 1000)}
