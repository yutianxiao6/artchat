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
            return json.load(f)
    except Exception:
        return []


def save_workflow_index(workflows: List[Dict]):
    index_path = os.path.join(WORKFLOW_ROOT, "workflow_list.json")
    summaries = []
    for wf in workflows:
        summaries.append({
            "id": wf.get("id", ""),
            "title": wf.get("title", ""),
            "createdAt": wf.get("createdAt", ""),
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
    img_bytes = base64.b64decode(raw)
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
