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