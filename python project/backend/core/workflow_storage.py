import os
import json
import uuid
import base64
import hashlib
from typing import Dict, List, Any
from backend.core.canvas_storage import get_data_root


def get_workflow_root():
    root = os.path.join(get_data_root(), "workflows")
    os.makedirs(root, exist_ok=True)
    return root


WORKFLOW_ROOT = get_workflow_root()


def get_workflow_dir(workflow_id: str) -> str:
    d = os.path.join(WORKFLOW_ROOT, workflow_id)
    os.makedirs(d, exist_ok=True)
    img_dir = os.path.join(d, "images")
    os.makedirs(img_dir, exist_ok=True)
    return d


def list_workflows() -> List[Dict]:
    index_path = os.path.join(WORKFLOW_ROOT, "workflow_list.json")
    if not os.path.isfile(index_path):
        return []
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            return []
    except Exception:
        return []

    # 旧索引可能缺 templateId/inputPreview，按需从每个 workflow.json 补一次并回写
    needs_rewrite = False
    for i, e in enumerate(entries):
        if "templateId" in e and "inputPreview" in e:
            continue
        wf_path = os.path.join(WORKFLOW_ROOT, e.get("id", ""), "workflow.json")
        if not os.path.isfile(wf_path):
            e.setdefault("templateId", None)
            e.setdefault("inputPreview", "")
            needs_rewrite = True
            continue
        try:
            with open(wf_path, "r", encoding="utf-8") as fp:
                wf = json.load(fp)
            e["templateId"] = wf.get("templateId") or None
            e["inputPreview"] = ((wf.get("input") or {}).get("plot") or "")[:100]
            needs_rewrite = True
        except Exception:
            e.setdefault("templateId", None)
            e.setdefault("inputPreview", "")
    if needs_rewrite:
        try:
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump(entries, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return entries


def save_workflow_index(workflows: List[Dict]):
    index_path = os.path.join(WORKFLOW_ROOT, "workflow_list.json")
    summaries = []
    for wf in workflows:
        input_data = wf.get("input") or {}
        plot_preview = (input_data.get("plot") or "")[:100]
        summaries.append({
            "id": wf.get("id", ""),
            "title": wf.get("title", ""),
            "createdAt": wf.get("createdAt", ""),
            "templateId": wf.get("templateId") or None,
            "inputPreview": plot_preview,
        })
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(summaries, f, ensure_ascii=False, indent=2)


def load_workflow(workflow_id: str) -> Dict:
    wf_dir = os.path.join(WORKFLOW_ROOT, workflow_id)
    wf_path = os.path.join(wf_dir, "workflow.json")
    if not os.path.isfile(wf_path):
        return {}
    try:
        with open(wf_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_workflow(workflow: Dict):
    wf_id = workflow.get("id", "")
    if not wf_id:
        return
    wf_dir = get_workflow_dir(wf_id)
    wf_path = os.path.join(wf_dir, "workflow.json")
    with open(wf_path, "w", encoding="utf-8") as f:
        json.dump(workflow, f, ensure_ascii=False, indent=2)
    all_wfs = list_workflows()
    exists = any(w["id"] == wf_id for w in all_wfs)
    if not exists:
        all_wfs.insert(0, workflow)
    else:
        all_wfs = [workflow if w["id"] == wf_id else w for w in all_wfs]
    save_workflow_index(all_wfs)


def delete_workflow(workflow_id: str):
    import shutil
    wf_dir = os.path.join(WORKFLOW_ROOT, workflow_id)
    if os.path.isdir(wf_dir):
        shutil.rmtree(wf_dir, ignore_errors=True)
    all_wfs = list_workflows()
    all_wfs = [w for w in all_wfs if w["id"] != workflow_id]
    save_workflow_index(all_wfs)


def save_workflow_image(workflow_id: str, image_data: str, prefix: str = "img") -> str:
    wf_dir = get_workflow_dir(workflow_id)
    img_dir = os.path.join(wf_dir, "images")
    os.makedirs(img_dir, exist_ok=True)
    if image_data.startswith("data:image"):
        parts = image_data.split(",", 1)
        raw = parts[1] if len(parts) > 1 else ""
    else:
        raw = image_data
    # 容错：去除空白字符并补齐 padding（防止 JSON 传输导致的字符丢失）
    raw = "".join(raw.split())
    missing = len(raw) % 4
    if missing:
        raw += "=" * (4 - missing)
    # 防御：图片接口不应接收超大数据（>20MB 的 base64 通常是视频等误发）
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError(f"图片数据过大（{len(raw)} 字符），不应通过图片接口上传。视频请使用 /api/recreate/upload-video 接口。")
    img_bytes = base64.b64decode(raw, validate=False)
    content_hash = hashlib.md5(img_bytes).hexdigest()[:12]
    for existing in os.listdir(img_dir):
        existing_path = os.path.join(img_dir, existing)
        if os.path.isfile(existing_path) and os.path.getsize(existing_path) == len(img_bytes):
            with open(existing_path, "rb") as f:
                if hashlib.md5(f.read()).hexdigest()[:12] == content_hash:
                    return f"/workflow-images/{workflow_id}/images/{existing}"
    filename = f"{prefix}_{uuid.uuid4().hex[:8]}.png"
    filepath = os.path.join(img_dir, filename)
    with open(filepath, "wb") as f:
        f.write(img_bytes)
    return f"/workflow-images/{workflow_id}/images/{filename}"
