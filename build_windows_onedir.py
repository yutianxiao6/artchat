"""
Windows 多文件（onedir）打包脚本（备用）
功能与 build_exe.py 相同。
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
ICON_FILE = os.path.join(PROJECT_ROOT, "frontend", "assets", "app-icon.ico")
SPEC_FILE = os.path.join(PROJECT_ROOT, f"{APP_NAME}.spec")


def clean_old_build():
    for dir_path in [DIST_DIR, BUILD_DIR]:
        if os.path.exists(dir_path):
            shutil.rmtree(dir_path)
    if os.path.exists(SPEC_FILE):
        os.remove(SPEC_FILE)


def build():
    print("清理旧构建文件...")
    clean_old_build()

    print("开始打包 Windows 多文件版本...")
    args = [
        ENTRY_FILE,
        f"--name={APP_NAME}",
        "--onedir",
        "--windowed",
        "--clean",
        "--noconfirm",
        f"--icon={ICON_FILE}",
        "--add-data", f"{FRONTEND_DIR}{os.pathsep}frontend",
    ]

    PyInstaller.__main__.run(args)

    output_dir = os.path.join(DIST_DIR, APP_NAME)
    exe_path = os.path.join(output_dir, f"{APP_NAME}.exe")

    print(f"\n打包完成！")
    print(f"输出目录: {output_dir}")
    print(f"可执行文件: {exe_path}")


if __name__ == "__main__":
    build()
