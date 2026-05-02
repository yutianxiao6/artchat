import os
import sys
import json
import base64
import uuid
import shutil
import re
from typing import Dict, List, Any


def get_data_root():
    if getattr(sys, 'frozen', False):
        base_path = os.path.dirname(sys.executable)
    else:
        base_path = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base_path, "canvas_data")


def ensure_dirs() -> Dict[str, str]:
    root = get_data_root()
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    uncategorized = os.path.join(assets, "未分类")
    os.makedirs(uncategorized, exist_ok=True)
    return {
        "root": root,
        "assets": assets,
        "history": os.path.join(root, "canvas_history.json"),
    }


PATHS = ensure_dirs()
DEFAULT_CATEGORY = "未分类"


def slugify_category(name: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|]+', '_', str(name or '').strip())
    clean = re.sub(r'\s+', ' ', clean).strip(" .")
    return clean or DEFAULT_CATEGORY


def get_category_dir(category: str) -> str:
    return os.path.join(PATHS["assets"], slugify_category(category))


def ensure_category_dir(category: str) -> str:
    category_name = slugify_category(category)
    category_dir = get_category_dir(category_name)
    os.makedirs(category_dir, exist_ok=True)
    return category_dir


def rel_asset_path(category: str, filename: str) -> str:
    return f"{slugify_category(category)}/{filename}"


def asset_url(category: str, filename: str) -> str:
    return f"/canvas-assets/{rel_asset_path(category, filename)}"


def normalize_asset_record(asset: Dict[str, Any]) -> Dict[str, Any]:
    category = slugify_category(asset.get("category") or DEFAULT_CATEGORY)
    file_name = asset.get("file_name") or ""
    file_path = asset.get("file_path") or rel_asset_path(category, file_name) if file_name else ""
    if file_name and not os.path.exists(os.path.join(PATHS["assets"], file_path)):
        legacy_path = os.path.join(PATHS["assets"], file_name)
        if os.path.exists(legacy_path):
            ensure_category_dir(category)
            shutil.move(legacy_path, os.path.join(PATHS["assets"], file_path))
    asset["category"] = category
    asset["file_name"] = file_name
    asset["file_path"] = file_path
    asset["imageUrl"] = asset_url(category, file_name) if file_name else asset.get("imageUrl", "")
    asset.setdefault("imageBase64", "")
    return asset


def ensure_asset_dirs_from_history(asset_library: List[Dict[str, Any]]):
    ensure_category_dir(DEFAULT_CATEGORY)
    for asset in asset_library:
        category = slugify_category(asset.get("category") or DEFAULT_CATEGORY)
        ensure_category_dir(category)
        normalize_asset_record(asset)


def load_history() -> Dict[str, Any]:
    if not os.path.exists(PATHS["history"]):
        return {"sessions": [], "assetLibrary": [], "categories": [DEFAULT_CATEGORY]}
    try:
        with open(PATHS["history"], "r", encoding="utf-8") as f:
            data = json.load(f)
            asset_library = data.get("assetLibrary", [])
            ensure_asset_dirs_from_history(asset_library)
            categories = sorted({DEFAULT_CATEGORY, *(slugify_category(asset.get("category")) for asset in asset_library), *(slugify_category(name) for name in data.get("categories", []))})
            return {
                "sessions": data.get("sessions", []),
                "assetLibrary": asset_library,
                "categories": categories,
            }
    except Exception as e:
        print(f"画布历史加载失败: {str(e)}")
        return {"sessions": [], "assetLibrary": [], "categories": [DEFAULT_CATEGORY]}


def save_history(data: Dict[str, Any]):
    asset_library = [normalize_asset_record(dict(asset)) for asset in data.get("assetLibrary", [])]
    categories = sorted({DEFAULT_CATEGORY, *(slugify_category(asset.get("category")) for asset in asset_library), *(slugify_category(name) for name in data.get("categories", []))})
    with open(PATHS["history"], "w", encoding="utf-8") as f:
        json.dump({
            "sessions": data.get("sessions", []),
            "assetLibrary": asset_library,
            "categories": categories,
        }, f, ensure_ascii=False, indent=2)


def save_base64_asset(base64_data: str, category: str = DEFAULT_CATEGORY, ext: str = ".png") -> Dict[str, str]:
    filename = f"{uuid.uuid4().hex}{ext}"
    category = slugify_category(category)
    category_dir = ensure_category_dir(category)
    file_path = os.path.join(category_dir, filename)
    with open(file_path, "wb") as f:
        f.write(base64.b64decode(base64_data))
    return {
        "file_name": filename,
        "file_path": rel_asset_path(category, filename),
        "category": category,
        "imageUrl": asset_url(category, filename),
    }


def move_asset_to_category(asset: Dict[str, Any], category: str) -> Dict[str, Any]:
    target_category = slugify_category(category)
    ensure_category_dir(target_category)
    current_rel = asset.get("file_path") or rel_asset_path(asset.get("category") or DEFAULT_CATEGORY, asset.get("file_name") or "")
    if not current_rel:
        asset["category"] = target_category
        return normalize_asset_record(asset)
    src_path = os.path.join(PATHS["assets"], current_rel)
    filename = asset.get("file_name") or os.path.basename(current_rel)
    dst_rel = rel_asset_path(target_category, filename)
    dst_path = os.path.join(PATHS["assets"], dst_rel)
    if os.path.exists(src_path) and os.path.abspath(src_path) != os.path.abspath(dst_path):
        shutil.move(src_path, dst_path)
    asset["category"] = target_category
    asset["file_name"] = filename
    asset["file_path"] = dst_rel
    asset["imageUrl"] = asset_url(target_category, filename)
    return normalize_asset_record(asset)


def rename_category_folder(old_category: str, new_category: str):
    old_name = slugify_category(old_category)
    new_name = slugify_category(new_category)
    if old_name == new_name:
        ensure_category_dir(new_name)
        return new_name
    old_dir = get_category_dir(old_name)
    new_dir = get_category_dir(new_name)
    ensure_category_dir(DEFAULT_CATEGORY)
    if os.path.exists(old_dir):
        if os.path.exists(new_dir):
            for name in os.listdir(old_dir):
                shutil.move(os.path.join(old_dir, name), os.path.join(new_dir, name))
            shutil.rmtree(old_dir, ignore_errors=True)
        else:
            shutil.move(old_dir, new_dir)
    else:
        ensure_category_dir(new_name)
    return new_name


def delete_asset_file(asset: Dict[str, Any]):
    normalized = normalize_asset_record(dict(asset))
    rel_path = normalized.get("file_path") or rel_asset_path(normalized.get("category") or DEFAULT_CATEGORY, normalized.get("file_name") or "")
    if not rel_path:
        return normalized
    abs_path = os.path.join(PATHS["assets"], rel_path)
    if os.path.exists(abs_path):
        os.remove(abs_path)
    return normalized


def delete_category_folder(category: str):
    category_name = slugify_category(category)
    if category_name == DEFAULT_CATEGORY:
        raise ValueError("默认分类不能删除")
    target_dir = get_category_dir(category_name)
    if os.path.exists(target_dir):
        shutil.rmtree(target_dir, ignore_errors=True)
    return category_name


def guess_ext_from_mime(mime_type: str) -> str:
    if not mime_type:
        return ".png"
    if "jpeg" in mime_type or "jpg" in mime_type:
        return ".jpg"
    if "webp" in mime_type:
        return ".webp"
    if "gif" in mime_type:
        return ".gif"
    return ".png"


def list_asset_files() -> List[str]:
    files: List[str] = []
    if not os.path.exists(PATHS["assets"]):
        return files
    for root, _, names in os.walk(PATHS["assets"]):
        for name in names:
            files.append(os.path.relpath(os.path.join(root, name), PATHS["assets"]))
    return sorted(files)
