"""
一键启动脚本
直接运行此文件即可启动服务并自动打开浏览器
"""
import os
import sys
import webbrowser
import uvicorn

# 将项目根目录加入Python路径，解决模块导入问题
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.main import SERVER_HOST, SERVER_PORT, app

if __name__ == "__main__":
    # 自动打开浏览器
    webbrowser.open(f"http://{SERVER_HOST}:{SERVER_PORT}")
    # 启动Web服务
    uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT)