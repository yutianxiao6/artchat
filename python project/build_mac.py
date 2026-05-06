"""
macOS 打包脚本（ad-hoc 签名）
必须在 macOS 上运行，产出 dist/流绘.app 和 dist/流绘.dmg（若安装了 create-dmg）。

用法：
    python3 build_mac.py

依赖：
    pip install pyinstaller
    # 可选，用于生成 DMG：
    brew install create-dmg
"""
import os
import shutil
import subprocess
import sys

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(PROJECT_ROOT, "dist")
BUILD_DIR = os.path.join(PROJECT_ROOT, "build")
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
ENTRY_FILE = os.path.join(PROJECT_ROOT, "run.py")
APP_NAME = "流绘"
APP_NAME_ASCII = "LiuHui"
BUNDLE_ID = "com.liuhui.app"
ICON_PNG = os.path.join(FRONTEND_DIR, "assets", "app-icon-512.png")
ICON_ICNS = os.path.join(PROJECT_ROOT, "app-icon.icns")
SPEC_FILE = os.path.join(PROJECT_ROOT, f"{APP_NAME}.spec")
APP_BUNDLE = os.path.join(DIST_DIR, f"{APP_NAME}.app")
DMG_PATH = os.path.join(DIST_DIR, f"{APP_NAME_ASCII}.dmg")


def require_macos():
    if sys.platform != "darwin":
        sys.exit("错误：本脚本必须在 macOS 上运行（当前: %s）" % sys.platform)


def clean_old_build():
    for p in [DIST_DIR, BUILD_DIR, SPEC_FILE, ICON_ICNS, DMG_PATH]:
        if os.path.isdir(p):
            shutil.rmtree(p)
        elif os.path.isfile(p):
            os.remove(p)


def make_icns():
    """用 sips + iconutil 把 PNG 转成 .icns。"""
    if not os.path.isfile(ICON_PNG):
        print(f"[警告] 未找到 {ICON_PNG}，.app 将不带自定义图标")
        return None

    iconset = os.path.join(PROJECT_ROOT, "app-icon.iconset")
    if os.path.isdir(iconset):
        shutil.rmtree(iconset)
    os.makedirs(iconset)

    sizes = [
        (16, "16x16"), (32, "16x16@2x"),
        (32, "32x32"), (64, "32x32@2x"),
        (128, "128x128"), (256, "128x128@2x"),
        (256, "256x256"), (512, "256x256@2x"),
        (512, "512x512"), (1024, "512x512@2x"),
    ]
    for size, name in sizes:
        out = os.path.join(iconset, f"icon_{name}.png")
        subprocess.run(
            ["sips", "-z", str(size), str(size), ICON_PNG, "--out", out],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", ICON_ICNS], check=True)
    shutil.rmtree(iconset)
    print(f"[图标] 已生成 {ICON_ICNS}")
    return ICON_ICNS


def run_pyinstaller(icon_path):
    import PyInstaller.__main__

    args = [
        ENTRY_FILE,
        f"--name={APP_NAME}",
        "--windowed",
        "--onedir",
        "--clean",
        "--noconfirm",
        f"--osx-bundle-identifier={BUNDLE_ID}",
        "--add-data", f"{FRONTEND_DIR}{os.pathsep}frontend",
    ]
    target_arch = os.environ.get("TARGET_ARCH", "").strip()
    if target_arch in ("x86_64", "arm64", "universal2"):
        args.append(f"--target-architecture={target_arch}")
    if icon_path:
        args.append(f"--icon={icon_path}")

    PyInstaller.__main__.run(args)

    if not os.path.isdir(APP_BUNDLE):
        sys.exit(f"打包失败：未生成 {APP_BUNDLE}")


def adhoc_sign():
    """用临时身份（-）对 .app 做 ad-hoc 签名，解决 Apple Silicon 上未签名二进制无法运行的问题。"""
    print(f"[签名] ad-hoc 签名 {APP_BUNDLE}")
    subprocess.run(
        ["codesign", "--force", "--deep", "--sign", "-", APP_BUNDLE],
        check=True,
    )
    subprocess.run(["codesign", "--verify", "--deep", "--strict", APP_BUNDLE], check=True)
    print("[签名] 完成")


def make_dmg():
    if not shutil.which("create-dmg"):
        print("[DMG] 未检测到 create-dmg，跳过。可 `brew install create-dmg` 后重跑。")
        return
    print(f"[DMG] 生成 {DMG_PATH}")
    subprocess.run(
        [
            "create-dmg",
            "--volname", APP_NAME,
            "--window-size", "600", "400",
            "--icon-size", "120",
            "--icon", f"{APP_NAME}.app", "150", "200",
            "--app-drop-link", "450", "200",
            DMG_PATH,
            APP_BUNDLE,
        ],
        check=True,
    )
    print(f"[DMG] 完成：{DMG_PATH}")


def print_usage_hint():
    print()
    print("=" * 60)
    print("打包完成")
    print("=" * 60)
    print(f".app 位置：{APP_BUNDLE}")
    if os.path.isfile(DMG_PATH):
        print(f"DMG 位置：{DMG_PATH}")
    print()
    print("首次打开提示（发给用户）：")
    print("  因为使用的是 ad-hoc 签名（未经苹果公证），首次打开会被 Gatekeeper 拦截。")
    print("  右键点击应用 → 打开 → 在弹窗中再次点击“打开”。之后双击即可正常使用。")
    print("  或者在终端执行：")
    print(f"    xattr -dr com.apple.quarantine '/Applications/{APP_NAME}.app'")
    print()


def build():
    require_macos()
    print("清理旧构建...")
    clean_old_build()

    print("生成 .icns 图标...")
    icon_path = make_icns()

    print("开始 PyInstaller 打包...")
    run_pyinstaller(icon_path)

    adhoc_sign()
    make_dmg()
    print_usage_hint()


if __name__ == "__main__":
    build()
