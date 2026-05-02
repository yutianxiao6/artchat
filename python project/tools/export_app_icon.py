"""
把 SVG 图标导出成 Windows 可用的多尺寸 PNG/ICO。

依赖：
    pip install cairosvg pillow

用法：
    python tools/export_app_icon.py
"""
import os
from io import BytesIO

from PIL import Image
import cairosvg

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(PROJECT_ROOT, "frontend", "assets")
SVG_PATH = os.path.join(ASSET_DIR, "app-icon.svg")
PNG_PATH = os.path.join(ASSET_DIR, "app-icon-512.png")
ICO_PATH = os.path.join(ASSET_DIR, "app-icon.ico")


def main():
    if not os.path.exists(SVG_PATH):
        raise FileNotFoundError(f"未找到 SVG 图标: {SVG_PATH}")

    png_bytes = cairosvg.svg2png(url=SVG_PATH, output_width=512, output_height=512)
    with open(PNG_PATH, "wb") as f:
        f.write(png_bytes)

    image = Image.open(BytesIO(png_bytes)).convert("RGBA")
    image.save(
        ICO_PATH,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print("✅ 图标导出完成")
    print(f"PNG: {PNG_PATH}")
    print(f"ICO: {ICO_PATH}")


if __name__ == "__main__":
    main()
