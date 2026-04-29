"""
Windows 多文件（onedir）打包脚本
运行后会生成 dist/流绘/ 目录：
- 流绘.exe
- frontend/ 静态资源
- 其他 PyInstaller 依赖文件

适合直接打包成 zip 发给别人，在 Windows 上解压后双击 exe 运行。
"""
import os
import shutil
import PyInstaller.__main__

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
BUILD_DIR = os.path.join(PROJECT_ROOT, "build")
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
ENTRY_FILE = os.path.join(PROJECT_ROOT, "run.py")
APP_NAME = "流绘"
SPEC_FILE = os.path.join(PROJECT_ROOT, f"{APP_NAME}.spec")


def clean_old_build():
    for dir_path in [DIST_DIR, BUILD_DIR]:
        if os.path.exists(dir_path):
            shutil.rmtree(dir_path)
    if os.path.exists(SPEC_FILE):
        os.remove(SPEC_FILE)



def build_windows_onedir():
    print("🔧 清理旧构建文件...")
    clean_old_build()

    print("📦 开始打包 Windows 多文件版本（onedir）...")
    args = [
        ENTRY_FILE,
        f"--name={APP_NAME}",
        "--onedir",
        "--windowed",
        "--clean",
        "--noconfirm",
        "--icon=frontend/assets/app-icon.ico",
        "--add-data", f"{FRONTEND_DIR}{os.pathsep}frontend",
    ]

    PyInstaller.__main__.run(args)

    output_dir = os.path.join(DIST_DIR, APP_NAME)
    exe_path = os.path.join(output_dir, f"{APP_NAME}.exe")

    print("\n✅ 打包完成！")
    print(f"📂 输出目录: {output_dir}")
    print(f"🚀 可执行文件: {exe_path}")
    print("\n使用说明：")
    print("1. 将整个 dist/流绘 文件夹一起分发，不能只拿 exe 单文件")
    print("2. Windows 上解压后，双击 流绘.exe 运行")
    print("3. 首次运行后，model_configs.json 和 canvas_data 会生成在 exe 同目录")


if __name__ == "__main__":
    build_windows_onedir()
