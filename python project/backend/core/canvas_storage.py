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


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def rebuild_asset_library_from_disk() -> List[Dict[str, Any]]:
    """扫描 assets/<category>/*.<img> 重建素材记录。用于 canvas_history.json 丢失或 assetLibrary 为空时的自愈。"""
    assets_root = PATHS["assets"]
    rebuilt: List[Dict[str, Any]] = []
    if not os.path.isdir(assets_root):
        return rebuilt
    for category_name in sorted(os.listdir(assets_root)):
        cat_dir = os.path.join(assets_root, category_name)
        if not os.path.isdir(cat_dir):
            continue
        category = slugify_category(category_name)
        for filename in sorted(os.listdir(cat_dir)):
            full = os.path.join(cat_dir, filename)
            if not os.path.isfile(full):
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext not in _IMAGE_EXTS:
                continue
            asset_id = os.path.splitext(filename)[0]
            rebuilt.append({
                "id": asset_id,
                "title": asset_id,
                "source": "rebuilt",
                "category": category,
                "mime_type": f"image/{ext.lstrip('.')}",
                "file_name": filename,
                "file_path": rel_asset_path(category, filename),
                "imageUrl": asset_url(category, filename),
                "imageBase64": "",
            })
    return rebuilt


def load_history() -> Dict[str, Any]:
    path = PATHS["history"]
    candidates = [path] + [f"{path}.bak{i}" for i in range(1, 4)]
    last_err = None
    for p in candidates:
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            asset_library = data.get("assetLibrary", []) or []
            # 素材库空 → 从 assets 目录重建（不影响 sessions）
            if not asset_library:
                rebuilt = rebuild_asset_library_from_disk()
                if rebuilt:
                    print(f"素材库为空，已从 assets 目录重建 {len(rebuilt)} 条")
                    asset_library = rebuilt
            ensure_asset_dirs_from_history(asset_library)
            # categories 合并：json + 素材记录 + assets 目录实际子文件夹
            fs_categories = []
            if os.path.isdir(PATHS["assets"]):
                for name in os.listdir(PATHS["assets"]):
                    if os.path.isdir(os.path.join(PATHS["assets"], name)):
                        fs_categories.append(slugify_category(name))
            categories = sorted({
                DEFAULT_CATEGORY,
                *(slugify_category(asset.get("category")) for asset in asset_library),
                *(slugify_category(name) for name in data.get("categories", [])),
                *fs_categories,
            })
            if p != path:
                print(f"画布历史主文件损坏，已从备份恢复: {os.path.basename(p)}")
            return {
                "sessions": data.get("sessions", []),
                "assetLibrary": asset_library,
                "categories": categories,
            }
        except Exception as e:
            last_err = e
            print(f"画布历史加载失败 ({os.path.basename(p)}): {str(e)}")
            continue
    if last_err:
        print(f"画布历史所有备份均无法读取: {str(last_err)}")
    # 所有备份失败 → 至少把素材库从磁盘重建出来
    rebuilt = rebuild_asset_library_from_disk()
    fs_categories = []
    if os.path.isdir(PATHS["assets"]):
        for name in os.listdir(PATHS["assets"]):
            if os.path.isdir(os.path.join(PATHS["assets"], name)):
                fs_categories.append(slugify_category(name))
    categories = sorted({DEFAULT_CATEGORY, *(slugify_category(a.get("category")) for a in rebuilt), *fs_categories})
    return {"sessions": [], "assetLibrary": rebuilt, "categories": categories}


def _count_session_nodes(sessions: List[Dict[str, Any]]) -> int:
    total = 0
    for s in sessions or []:
        snap = (s or {}).get("snapshot") or {}
        total += len((snap.get("nodes") or []))
    return total


def _rotate_backups(path: str, keep: int = 3):
    # 滚动：bak{keep-1} 丢弃，bakN 向 bak{N+1} 移动，当前文件 -> bak1
    if not os.path.exists(path):
        return
    try:
        oldest = f"{path}.bak{keep}"
        if os.path.exists(oldest):
            os.remove(oldest)
        for i in range(keep - 1, 0, -1):
            src = f"{path}.bak{i}"
            dst = f"{path}.bak{i+1}"
            if os.path.exists(src):
                os.replace(src, dst)
        # 当前文件快照到 bak1（用 copy 而非 move，避免丢掉"当前有效数据"）
        shutil.copy2(path, f"{path}.bak1")
    except Exception as e:
        print(f"画布历史备份失败: {str(e)}")


def save_history(data: Dict[str, Any]):
    asset_library = [normalize_asset_record(dict(asset)) for asset in data.get("assetLibrary", [])]
    categories = sorted({DEFAULT_CATEGORY, *(slugify_category(asset.get("category")) for asset in asset_library), *(slugify_category(name) for name in data.get("categories", []))})
    new_sessions = data.get("sessions", []) or []
    path = PATHS["history"]

    # 空覆盖防护：只守护 sessions（节点不可重建）；assetLibrary 可由 assets 目录重建，不做此校验
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            existing_nodes = _count_session_nodes(existing.get("sessions", []))
            new_nodes = _count_session_nodes(new_sessions)
            if existing_nodes > 0 and new_nodes == 0:
                print(f"画布历史写入已拒绝（疑似空覆盖）: 磁盘 nodes={existing_nodes}，提交 nodes={new_nodes}")
                return {"skipped": True, "reason": "refuse_empty_overwrite"}
        except Exception as e:
            print(f"画布历史预检失败，继续写入: {str(e)}")

    # 滚动备份
    _rotate_backups(path, keep=3)

    # 原子写：tmp + replace
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "sessions": new_sessions,
            "assetLibrary": asset_library,
            "categories": categories,
        }, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return {"skipped": False}


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
