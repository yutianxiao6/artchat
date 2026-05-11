"""
video_processor.py — 视频处理工具层
纯工具函数，不依赖业务逻辑。提供 ffmpeg 关键帧提取、视频元数据获取等能力。
"""

import os
import json
import subprocess
import shutil
from typing import List, Dict, Optional


def check_ffmpeg() -> bool:
    """检查 ffmpeg 是否可用"""
    return shutil.which("ffmpeg") is not None


def get_video_metadata(video_path: str) -> Dict:
    """
    获取视频元数据：时长、分辨率、帧率、编码。
    返回: {"duration": float, "width": int, "height": int, "fps": float, "codec": str}
    """
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"视频文件不存在: {video_path}")
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe 失败: {result.stderr[:200]}")
    info = json.loads(result.stdout)
    video_stream = None
    for s in info.get("streams", []):
        if s.get("codec_type") == "video":
            video_stream = s
            break
    if not video_stream:
        raise RuntimeError("未找到视频流")
    fps_parts = video_stream.get("r_frame_rate", "30/1").split("/")
    fps = float(fps_parts[0]) / max(1, float(fps_parts[1])) if len(fps_parts) == 2 else 30.0
    duration = float(info.get("format", {}).get("duration", 0))
    return {
        "duration": duration,
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
        "fps": round(fps, 2),
        "codec": video_stream.get("codec_name", "unknown"),
    }


def recommend_max_frames(duration_sec: float, target_interval_sec: float = 15.0, hard_cap: int = 80) -> int:
    """
    根据视频时长推荐关键帧数量。
    默认每 15 秒一帧的密度，最少 6 帧，最多 hard_cap 帧。
    """
    if not duration_sec or duration_sec <= 0:
        return 30
    n = int(duration_sec / max(1.0, target_interval_sec))
    return max(6, min(hard_cap, n))


async def extract_keyframes(
    video_path: str,
    output_dir: str,
    mode: str = "scene",
    max_frames: int = 30,
    interval_sec: float = 2.0,
    scene_threshold: float = 0.3,
) -> List[Dict]:
    """
    提取关键帧。
    mode="scene": 基于场景切换检测（ffmpeg select='gt(scene,threshold)'）
    mode="interval": 固定间隔（每 interval_sec 秒一帧）
    返回: [{"index": 0, "timestamp": 2.5, "filename": "frame_000.jpg"}]
    """
    if not check_ffmpeg():
        raise RuntimeError("ffmpeg 未安装，无法提取关键帧")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(f"视频文件不存在: {video_path}")
    os.makedirs(output_dir, exist_ok=True)

    output_pattern = os.path.join(output_dir, "frame_%03d.jpg")

    if mode == "scene":
        vf = f"select='gt(scene\\,{scene_threshold})',showinfo"
        cmd = [
            "ffmpeg", "-i", video_path,
            "-vf", vf,
            "-vsync", "vfr",
            "-frames:v", str(max_frames),
            "-q:v", "2",
            output_pattern,
            "-y"
        ]
    else:
        vf = f"fps=1/{interval_sec},showinfo"
        cmd = [
            "ffmpeg", "-i", video_path,
            "-vf", vf,
            "-frames:v", str(max_frames),
            "-q:v", "2",
            output_pattern,
            "-y"
        ]

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300
    )

    # 从 showinfo 过滤器的 stderr 输出解析每帧真实时间戳 (pts_time)
    # showinfo 日志形如: [Parsed_showinfo_1 @ 0x...] n:  0 pts:  0 pts_time:0.5 duration:...
    timestamps = _parse_showinfo_timestamps(result.stderr or "")

    frames = []
    for fname in sorted(os.listdir(output_dir)):
        if not fname.startswith("frame_") or not fname.endswith(".jpg"):
            continue
        idx = len(frames)
        if idx >= max_frames:
            break
        if idx < len(timestamps):
            timestamp = timestamps[idx]
        else:
            # 回退：按模式估算
            timestamp = idx * interval_sec if mode == "interval" else idx * 2.0
        frames.append({
            "index": idx,
            "timestamp": round(timestamp, 2),
            "filename": fname,
        })

    return frames


def _parse_showinfo_timestamps(stderr_text: str) -> List[float]:
    """从 ffmpeg 的 stderr 中解析 showinfo 过滤器输出的 pts_time 序列。"""
    import re
    timestamps = []
    # 匹配 "pts_time:1.234" 或 "pts_time:1.234000"
    pattern = re.compile(r"pts_time:\s*([\d.]+)")
    for match in pattern.finditer(stderr_text):
        try:
            timestamps.append(float(match.group(1)))
        except ValueError:
            continue
    return timestamps
