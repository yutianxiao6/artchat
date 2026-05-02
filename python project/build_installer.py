"""
一键构建安装包：PyInstaller 打包 + Inno Setup 生成安装程序
"""
import os
import sys
import subprocess

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
APP_NAME = "流绘"
DIST_DIR = os.path.join(PROJECT_ROOT, "dist", APP_NAME)
SETUP_ISS = os.path.join(PROJECT_ROOT, "setup.iss")
INSTALLER_DIR = os.path.join(PROJECT_ROOT, "installer")
ISCC_PATHS = [
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
]


def find_iscc():
    for p in ISCC_PATHS:
        if os.path.isfile(p):
            return p
    return None


def step_pyinstaller():
    print("=" * 48)
    print("  [1/2] PyInstaller 打包")
    print("=" * 48)
    build_script = os.path.join(PROJECT_ROOT, "build_exe.py")
    ret = subprocess.run([sys.executable, build_script], cwd=PROJECT_ROOT)
    if ret.returncode != 0:
        print(f"\n[错误] PyInstaller 打包失败 (exit {ret.returncode})")
        return False
    exe_path = os.path.join(DIST_DIR, f"{APP_NAME}.exe")
    if not os.path.isfile(exe_path):
        print(f"\n[错误] 打包产物不存在：{exe_path}")
        return False
    print(f"\n[完成] {exe_path}")
    return True


def step_inno_setup():
    print()
    print("=" * 48)
    print("  [2/2] Inno Setup 生成安装包")
    print("=" * 48)
    iscc = find_iscc()
    if not iscc:
        print("[错误] 找不到 ISCC.exe，请确认已安装 Inno Setup 6")
        return False
    if not os.path.isfile(SETUP_ISS):
        print(f"[错误] 找不到 {SETUP_ISS}")
        return False
    ret = subprocess.run([iscc, SETUP_ISS], cwd=PROJECT_ROOT)
    if ret.returncode != 0:
        print(f"\n[错误] Inno Setup 编译失败 (exit {ret.returncode})")
        return False
    output = os.path.join(INSTALLER_DIR, f"{APP_NAME}-Setup.exe")
    print(f"\n[完成] {output}")
    return True


if __name__ == "__main__":
    print()
    ok1 = step_pyinstaller()
    if not ok1:
        input("\n按回车退出...")
        sys.exit(1)
    ok2 = step_inno_setup()
    print()
    if ok1 and ok2:
        output = os.path.join(INSTALLER_DIR, f"{APP_NAME}-Setup.exe")
        print("=" * 48)
        print(f"  构建完成！")
        print(f"  安装包：{output}")
        print("=" * 48)
    else:
        print("[警告] 部分步骤失败，请检查上方日志")
    input("\n按回车退出...")
