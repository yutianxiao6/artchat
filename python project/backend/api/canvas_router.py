import os
from fastapi import APIRouter, HTTPException
from fastapi.staticfiles import StaticFiles
from backend.models.schemas import (
    CanvasStatePayload,
    CanvasAssetCreateRequest,
    CanvasCategoryCreateRequest,
    CanvasCategoryRenameRequest,
    CanvasAssetMoveRequest,
    CanvasCategoryDeleteRequest,
    CanvasAssetDeleteRequest,
)
from backend.core.canvas_storage import (
    load_history,
    save_history,
    save_base64_asset,
    guess_ext_from_mime,
    PATHS,
    DEFAULT_CATEGORY,
    slugify_category,
    ensure_category_dir,
    move_asset_to_category,
    rename_category_folder,
    delete_asset_file,
    delete_category_folder,
)

router = APIRouter(prefix="/api/canvas", tags=["画布存储"])


@router.get("/state")
async def get_canvas_state():
    data = load_history()
    return {"code": 0, "data": data}


@router.post("/state")
async def save_canvas_state(payload: CanvasStatePayload):
    try:
        save_history(payload.model_dump())
        return {"code": 0, "message": "保存成功"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")


@router.post("/categories")
async def create_canvas_category(payload: CanvasCategoryCreateRequest):
    try:
        category = slugify_category(payload.name)
        ensure_category_dir(category)
        data = load_history()
        categories = set(data.get("categories", []))
        categories.add(DEFAULT_CATEGORY)
        categories.add(category)
        data["categories"] = sorted(categories)
        save_history(data)
        return {"code": 0, "data": {"name": category, "categories": data["categories"]}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分类创建失败: {str(e)}")


@router.put("/categories")
async def rename_canvas_category(payload: CanvasCategoryRenameRequest):
    try:
        old_name = slugify_category(payload.old_name)
        new_name = slugify_category(payload.new_name)
        renamed = rename_category_folder(old_name, new_name)
        data = load_history()
        for asset in data.get("assetLibrary", []):
            if slugify_category(asset.get("category")) == old_name:
                move_asset_to_category(asset, renamed)
        categories = {DEFAULT_CATEGORY, *(slugify_category(name) for name in data.get("categories", []))}
        categories.discard(old_name)
        categories.add(renamed)
        data["categories"] = sorted(categories)
        save_history(data)
        return {"code": 0, "data": {"name": renamed, "categories": data["categories"], "assetLibrary": data.get("assetLibrary", [])}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分类重命名失败: {str(e)}")


@router.post("/assets")
async def create_canvas_asset(payload: CanvasAssetCreateRequest):
    try:
        ext = guess_ext_from_mime(payload.mime_type)
        file_info = save_base64_asset(payload.image_base64, payload.category or DEFAULT_CATEGORY, ext)
        asset = {
            "id": os.path.splitext(file_info["file_name"])[0],
            "title": payload.title,
            "source": payload.source,
            "category": file_info["category"],
            "mime_type": payload.mime_type,
            "file_name": file_info["file_name"],
            "file_path": file_info["file_path"],
            "imageUrl": file_info["imageUrl"],
            "imageBase64": "",
        }
        data = load_history()
        data.setdefault("assetLibrary", [])
        data.setdefault("categories", [DEFAULT_CATEGORY])
        data["categories"] = sorted(set(data["categories"] + [asset["category"], DEFAULT_CATEGORY]))
        data["assetLibrary"] = [asset] + [a for a in data["assetLibrary"] if a.get("id") != asset["id"]]
        save_history(data)
        return {"code": 0, "data": asset}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"素材保存失败: {str(e)}")


@router.put("/assets/move")
async def move_canvas_asset(payload: CanvasAssetMoveRequest):
    try:
        data = load_history()
        asset = next((item for item in data.get("assetLibrary", []) if item.get("id") == payload.asset_id), None)
        if not asset:
            raise HTTPException(status_code=404, detail="素材不存在")
        move_asset_to_category(asset, payload.target_category)
        data["categories"] = sorted(set(data.get("categories", []) + [asset.get("category"), DEFAULT_CATEGORY]))
        save_history(data)
        return {"code": 0, "data": {"asset": asset, "categories": data["categories"], "assetLibrary": data.get("assetLibrary", [])}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"素材移动失败: {str(e)}")


@router.delete("/categories")
async def delete_canvas_category(payload: CanvasCategoryDeleteRequest):
    try:
        category = slugify_category(payload.name)
        if category == DEFAULT_CATEGORY:
            raise HTTPException(status_code=400, detail="默认分类不能删除")
        data = load_history()
        assets = data.get("assetLibrary", [])
        deleted_assets = [asset for asset in assets if slugify_category(asset.get("category")) == category]
        remaining_assets = [asset for asset in assets if slugify_category(asset.get("category")) != category]
        for asset in deleted_assets:
            delete_asset_file(asset)
        delete_category_folder(category)
        data["assetLibrary"] = remaining_assets
        data["categories"] = sorted({DEFAULT_CATEGORY, *(slugify_category(name) for name in data.get("categories", []))} - {category})
        save_history(data)
        return {"code": 0, "data": {"categories": data["categories"], "assetLibrary": data.get("assetLibrary", []), "deleted": len(deleted_assets)}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分类删除失败: {str(e)}")


@router.delete("/assets")
async def delete_canvas_asset(payload: CanvasAssetDeleteRequest):
    try:
        data = load_history()
        asset = next((item for item in data.get("assetLibrary", []) if item.get("id") == payload.asset_id), None)
        if not asset:
            raise HTTPException(status_code=404, detail="素材不存在")
        delete_asset_file(asset)
        data["assetLibrary"] = [item for item in data.get("assetLibrary", []) if item.get("id") != payload.asset_id]
        data["categories"] = sorted({DEFAULT_CATEGORY, *(slugify_category(name) for name in data.get("categories", [])), *(slugify_category(item.get("category")) for item in data.get("assetLibrary", []))})
        save_history(data)
        return {"code": 0, "data": {"categories": data["categories"], "assetLibrary": data.get("assetLibrary", [])}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"素材删除失败: {str(e)}")


canvas_assets_app = StaticFiles(directory=PATHS["assets"])
