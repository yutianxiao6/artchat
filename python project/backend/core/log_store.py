"""
日志存储与捕获：
- 内存环形缓冲（给前端快速拉取）
- 按天滚动文件（持久化，默认保留 7 天）
- 劫持 print 的 stdout/stderr 到缓冲+文件+原 stream

前端可通过 GET /api/logs 拉取，支持 since 增量。
"""
import os
import sys
import time
import threading
from collections import deque
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional


_MAX_LINES_IN_MEMORY = 5000
_LOG_KEEP_DAYS = 7


def get_logs_dir() -> str:
    if getattr(sys, 'frozen', False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    d = os.path.join(base, "logs")
    os.makedirs(d, exist_ok=True)
    return d


def get_log_file_for(day: Optional[datetime] = None) -> str:
    d = day or datetime.now()
    return os.path.join(get_logs_dir(), f"app_{d.strftime('%Y%m%d')}.log")


class LogStore:
    def __init__(self, max_lines: int = _MAX_LINES_IN_MEMORY):
        self.buffer: deque = deque(maxlen=max_lines)
        self.lock = threading.Lock()
        self._seq = 0
        self._file_fp = None
        self._file_path = None
        self._ensure_file()

    def _ensure_file(self):
        want = get_log_file_for()
        if want != self._file_path:
            if self._file_fp:
                try: self._file_fp.close()
                except Exception: pass
            self._file_path = want
            try:
                self._file_fp = open(want, "a", encoding="utf-8", buffering=1)
            except Exception:
                self._file_fp = None

    def append(self, line: str, level: str = "info"):
        line = line.rstrip("\r\n")
        if not line:
            return
        ts_ms = int(time.time() * 1000)
        with self.lock:
            self._seq += 1
            entry = {"id": self._seq, "ts": ts_ms, "level": level, "text": line}
            self.buffer.append(entry)
            self._ensure_file()
            if self._file_fp:
                try:
                    self._file_fp.write(f"[{datetime.now().strftime('%H:%M:%S')}] [{level}] {line}\n")
                except Exception:
                    pass

    def tail(self, limit: int = 500, since_id: int = 0) -> List[Dict[str, Any]]:
        with self.lock:
            if since_id > 0:
                out = [e for e in self.buffer if e["id"] > since_id]
            else:
                out = list(self.buffer)
            if limit > 0 and len(out) > limit:
                out = out[-limit:]
            return out

    def clear_memory(self):
        with self.lock:
            self.buffer.clear()

    def list_files(self) -> List[Dict[str, Any]]:
        d = get_logs_dir()
        out = []
        if not os.path.isdir(d):
            return out
        for name in sorted(os.listdir(d), reverse=True):
            if not name.startswith("app_") or not name.endswith(".log"):
                continue
            full = os.path.join(d, name)
            try:
                st = os.stat(full)
                out.append({"name": name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
            except Exception:
                continue
        return out

    def read_file(self, name: str, max_bytes: int = 2_000_000) -> str:
        # 防路径穿越：只接受 app_YYYYMMDD.log 格式
        import re
        if not re.match(r"^app_\d{8}\.log$", name):
            return ""
        path = os.path.join(get_logs_dir(), name)
        if not os.path.isfile(path):
            return ""
        try:
            size = os.path.getsize(path)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                if size > max_bytes:
                    f.seek(size - max_bytes)
                return f.read()
        except Exception as e:
            return f"[日志读取失败] {e}"


log_store = LogStore()


class _TeeStream:
    """同时写到原 stream 和 LogStore。用于劫持 stdout / stderr。"""
    def __init__(self, original, level: str = "info"):
        self.original = original
        self.level = level
        self._buf = ""

    def write(self, s):
        try:
            if self.original is not None:
                try: self.original.write(s)
                except Exception: pass
            if not s:
                return
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                log_store.append(line, level=self.level)
        except Exception:
            pass

    def flush(self):
        try:
            if self.original is not None:
                try: self.original.flush()
                except Exception: pass
        except Exception:
            pass
        # 把残余缓冲也刷进 store
        if self._buf:
            log_store.append(self._buf, level=self.level)
            self._buf = ""

    def isatty(self):
        try:
            return bool(self.original and self.original.isatty())
        except Exception:
            return False

    # 透传其他属性给原 stream
    def __getattr__(self, item):
        if self.original is None:
            raise AttributeError(item)
        return getattr(self.original, item)


_attached = False


def attach_stdout_stderr():
    """把 print 的 stdout/stderr 同时灌到内存 buffer + 日志文件，同时保留原输出。只调用一次。"""
    global _attached
    if _attached:
        return
    _attached = True
    sys.stdout = _TeeStream(sys.stdout, level="info")
    sys.stderr = _TeeStream(sys.stderr, level="error")


def cleanup_old_logs(keep_days: int = _LOG_KEEP_DAYS):
    """清理超过 keep_days 的日志文件，防止无限增长。"""
    d = get_logs_dir()
    if not os.path.isdir(d):
        return
    cutoff = datetime.now() - timedelta(days=keep_days)
    import re
    for name in os.listdir(d):
        m = re.match(r"^app_(\d{8})\.log$", name)
        if not m:
            continue
        try:
            day = datetime.strptime(m.group(1), "%Y%m%d")
            if day < cutoff:
                os.remove(os.path.join(d, name))
        except Exception:
            continue
