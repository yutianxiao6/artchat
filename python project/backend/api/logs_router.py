from fastapi import APIRouter, HTTPException
from backend.core.log_store import log_store

router = APIRouter(prefix="/api/logs", tags=["日志"])


@router.get("")
async def get_logs(tail: int = 500, since: int = 0):
    entries = log_store.tail(limit=tail, since_id=since)
    last_id = entries[-1]["id"] if entries else since
    return {"code": 0, "data": {"entries": entries, "lastId": last_id}}


@router.delete("")
async def clear_logs():
    log_store.clear_memory()
    return {"code": 0, "message": "内存日志已清空（磁盘文件未删除）"}


@router.get("/files")
async def list_log_files():
    return {"code": 0, "data": log_store.list_files()}


@router.get("/files/{name}")
async def read_log_file(name: str):
    text = log_store.read_file(name)
    return {"code": 0, "data": {"name": name, "text": text}}
