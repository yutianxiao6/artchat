import os
import sys
import json
from typing import List, Dict

# 配置文件路径：始终保存在EXE/脚本所在目录
def get_config_file_path():
    # EXE运行时的所在目录
    if getattr(sys, 'frozen', False):
        base_path = os.path.dirname(sys.executable)
    else:
        # 开发环境项目根目录
        base_path = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base_path, "model_configs.json")

CONFIG_FILE = get_config_file_path()
FORMAT_CACHE_FILE = os.path.join(os.path.dirname(CONFIG_FILE), "api_format_cache.json")

# 加载配置
def load_configs() -> List[Dict]:
    if not os.path.exists(CONFIG_FILE):
        print(f"[config] CONFIG_FILE 不存在: {CONFIG_FILE}")
        return []
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            print(f"[config] CONFIG_FILE 不是数组: {CONFIG_FILE} type={type(data).__name__}")
            return []
        print(f"[config] 已加载 {len(data)} 条配置: {CONFIG_FILE}")
        return data
    except Exception as e:
        print(f"[config] 配置文件加载失败 ({CONFIG_FILE}): {type(e).__name__}: {e}")
        return []

# 保存配置
def save_configs(configs: List[Dict]):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(configs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"配置文件保存失败: {str(e)}")
        raise Exception("配置保存失败")


# API 格式缓存
_format_cache: Dict = {}

def load_format_cache() -> Dict:
    global _format_cache
    if not os.path.exists(FORMAT_CACHE_FILE):
        _format_cache = {}
        return _format_cache
    try:
        with open(FORMAT_CACHE_FILE, "r", encoding="utf-8") as f:
            _format_cache = json.load(f)
    except Exception:
        _format_cache = {}
    return _format_cache

def save_format_cache():
    try:
        with open(FORMAT_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_format_cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[format_cache] 保存失败: {e}")

def get_cached_strategy(config_id: str) -> str | None:
    if not _format_cache:
        load_format_cache()
    entry = _format_cache.get(config_id)
    if entry and isinstance(entry, dict):
        return entry.get("strategy_id")
    return None

def set_cached_strategy(config_id: str, strategy_id: str):
    from datetime import datetime
    _format_cache[config_id] = {
        "strategy_id": strategy_id,
        "last_success": datetime.now().isoformat(),
    }
    save_format_cache()

def clear_cached_strategy(config_id: str):
    if config_id in _format_cache:
        del _format_cache[config_id]
        save_format_cache()