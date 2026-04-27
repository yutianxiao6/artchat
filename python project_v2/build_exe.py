"""
EXE一键打包脚本
运行此脚本即可将项目打包为单文件可执行程序，无需Python环境即可运行
"""
import os
import shutil
import PyInstaller.__main__

# 项目路径配置
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")  # 输出目录
BUILD_DIR = os.path.join(PROJECT_ROOT, "build") # 临时构建目录
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend") # 前端资源
ENTRY_FILE = os.path.join(PROJECT_ROOT, "run.py") # 程序入口

def clean_old_build():
    """清理旧的构建文件"""
    for dir_path in [DIST_DIR, BUILD_DIR]:
        if os.path.exists(dir_path):
            shutil.rmtree(dir_path)
    # 清理旧的spec文件
    spec_file = os.path.join(PROJECT_ROOT, "run.spec")
    if os.path.exists(spec_file):
        os.remove(spec_file)

def build_exe():
    """执行打包"""
    print("🔧 开始清理旧构建文件...")
    clean_old_build()

    print("📦 开始打包项目为EXE...")
    # PyInstaller打包参数
    args = [
        ENTRY_FILE,
        "--name=API模型调用客户端",  # 生成的EXE文件名
        "--onefile",  # 打包为单文件
        "--windowed", # 隐藏控制台窗口（如需看日志可删除此行）
        "--add-data", f"{FRONTEND_DIR}{os.pathsep}frontend", # 打包前端资源
        "--clean", # 清理临时文件
        "--icon=NONE", # 可替换为自定义图标：--icon=你的图标.ico
    ]

    # 执行打包
    PyInstaller.__main__.run(args)

    print(f"\n✅ 打包完成！")
    print(f"📂 可执行文件路径: {os.path.join(DIST_DIR, 'API模型调用客户端.exe')}")
    print(f"ℹ️  运行说明：双击exe即可启动，配置文件会自动生成在exe同目录下")

if __name__ == "__main__":
    build_exe()