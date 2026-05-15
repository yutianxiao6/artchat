"""
video_processor.py — 视频处理工具层（纯函数，无业务依赖）

设计原则：每个函数职责单一，可独立测试和复用。
高层编排函数 pipeline_extract_keyframes 串起：
  scene-cut 检测 → 长镜头补帧 → 合并去重 → 批量截帧 → 清晰度过滤 → pHash 去重 → 转场过滤
"""

import os
import json
import subprocess
import shutil
import re
from typing import List, Dict, Optional, Tuple

from backend.core import image_quality as iq


# ═══════════════════════════════════════════════════
#  基础能力
# ═══════════════════════════════════════════════════

def check_ffmpeg() -> bool:
    """检查 ffmpeg 是否可用"""
    return shutil.which("ffmpeg") is not None


def get_video_metadata(video_path: str) -> Dict:
    """
    获取视频元数据：时长、分辨率、帧率、编码、总帧数。
    返回: {"duration","width","height","fps","codec","nb_frames"}
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
    nb_frames = video_stream.get("nb_frames")
    try:
        nb_frames = int(nb_frames) if nb_frames else int(duration * fps)
    except (TypeError, ValueError):
        nb_frames = int(duration * fps)
    return {
        "duration": duration,
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
        "fps": round(fps, 3),
        "codec": video_stream.get("codec_name", "unknown"),
        "nb_frames": nb_frames,
    }


def _parse_showinfo_timestamps(stderr_text: str) -> List[float]:
    """从 ffmpeg 的 stderr 中解析 showinfo 过滤器输出的 pts_time 序列"""
    pattern = re.compile(r"pts_time:\s*([\d.]+)")
    timestamps = []
    for match in pattern.finditer(stderr_text):
        try:
            timestamps.append(float(match.group(1)))
        except ValueError:
            continue
    return timestamps

# ═══════════════════════════════════════════════════
#  场景切点检测
# ═══════════════════════════════════════════════════

def detect_scene_cuts(video_path: str, min_threshold: float = 0.10) -> List[float]:
    """
    用 ffmpeg scene 滤镜低阈值扫全视频，返回所有候选切点 pts_time（升序、已去重）。
    只走 showinfo 不输出图像，速度快。
    """
    if not check_ffmpeg():
        raise RuntimeError("ffmpeg 未安装")
    if not os.path.isfile(video_path):
        raise FileNotFoundError(video_path)
    vf = f"select='gt(scene\\,{min_threshold})',showinfo"
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", vf, "-vsync", "vfr",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    cuts = _parse_showinfo_timestamps(result.stderr or "")
    cuts = sorted(set(round(t, 3) for t in cuts))
    if not cuts or cuts[0] > 0.1:
        cuts = [0.0] + cuts
    return cuts


def long_shot_supplement(
    scene_cuts: List[float],
    duration: float,
    max_gap: float = 4.0,
) -> List[float]:
    """
    相邻切点间隔 > max_gap 的空白区间内，按 max_gap/2 为步长补点。
    仅返回"补入的"时间戳（不含原切点）。末尾到视频结束同样补。
    """
    if not scene_cuts:
        return []
    extras: List[float] = []
    step = max_gap / 2.0
    boundary = list(scene_cuts) + [duration]
    for a, b in zip(boundary, boundary[1:]):
        if b - a <= max_gap:
            continue
        t = a + step
        while t < b - 0.2:
            extras.append(round(t, 3))
            t += step
    return extras


def merge_timestamps(
    base: List[float],
    extra: List[float],
    min_dt: float = 0.4,
) -> List[float]:
    """
    合并两组时间戳并按升序去除间距 < min_dt 的近邻（保留较早的）。
    """
    merged = sorted(set(round(t, 3) for t in list(base) + list(extra)))
    if not merged:
        return []
    out = [merged[0]]
    for t in merged[1:]:
        if t - out[-1] >= min_dt:
            out.append(t)
    return out


# ═══════════════════════════════════════════════════
#  候选帧截取（核心：批量 ffmpeg 一次搞定）
# ═══════════════════════════════════════════════════

def _timestamps_to_frame_numbers(timestamps: List[float], fps: float) -> List[int]:
    """ts → frame index，去重后升序"""
    nums = sorted(set(max(0, int(round(t * fps))) for t in timestamps))
    return nums


def _batch_dump_by_select(
    video_path: str,
    frame_numbers: List[int],
    output_pattern: str,
) -> bool:
    """
    一次 ffmpeg 调用，用 select='eq(n,f1)+eq(n,f2)+...' 批量提取指定帧。
    frame_numbers 超过 120 个时返回 False 让调用方降级（filter 过长会超 ffmpeg 限制）。
    成功返回 True。
    """
    if not frame_numbers:
        return True
    if len(frame_numbers) > 120:
        return False
    expr = "+".join(f"eq(n\\,{n})" for n in frame_numbers)
    vf = f"select='{expr}'"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", video_path,
        "-vf", vf, "-vsync", "vfr",
        "-q:v", "2",
        output_pattern, "-y",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return result.returncode == 0


def _fallback_dump_by_seek(
    video_path: str,
    timestamps: List[float],
    output_dir: str,
    naming: str,
) -> List[int]:
    """
    降级方案：逐个时间戳用双阶段 seek（-ss 粗 + -ss 精）。返回成功写出的 timestamp 索引列表。
    """
    ok_idx = []
    for i, ts in enumerate(timestamps):
        out_path = os.path.join(output_dir, naming % i)
        pre = max(0.0, ts - 0.5)
        fine = ts - pre
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{pre:.3f}", "-i", video_path,
            "-ss", f"{fine:.3f}",
            "-frames:v", "1", "-q:v", "2",
            out_path, "-y",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and os.path.isfile(out_path):
            ok_idx.append(i)
    return ok_idx


def dump_candidate_frames(
    video_path: str,
    timestamps: List[float],
    output_dir: str,
    fps: Optional[float] = None,
    naming: str = "cand_%04d.jpg",
) -> List[Dict]:
    """
    对每个 timestamp 导出一帧。优先批量 select（快），失败或超量降级逐帧 seek。
    返回 [{"index","timestamp","filename","path"}]，仅包含成功写出的帧。
    """
    os.makedirs(output_dir, exist_ok=True)
    timestamps = sorted(set(round(t, 3) for t in timestamps))
    if not timestamps:
        return []
    if fps is None:
        fps = get_video_metadata(video_path)["fps"]

    frame_nums = _timestamps_to_frame_numbers(timestamps, fps)
    output_pattern = os.path.join(output_dir, naming)

    # 清理旧文件避免混入
    for existing in os.listdir(output_dir):
        if existing.startswith(naming.split("_")[0] + "_") and existing.endswith(".jpg"):
            try:
                os.remove(os.path.join(output_dir, existing))
            except OSError:
                pass

    use_batch = _batch_dump_by_select(video_path, frame_nums, output_pattern)
    produced: List[str] = []
    if use_batch:
        produced = sorted(
            f for f in os.listdir(output_dir)
            if f.endswith(".jpg") and f.startswith(naming.split("_")[0] + "_")
        )

    if not produced:
        # 降级
        ok = _fallback_dump_by_seek(video_path, timestamps, output_dir, naming)
        produced = [naming % i for i in ok]
        # 重建 timestamp 映射为实际成功的那些
        timestamps_for_map = [timestamps[i] for i in ok]
    else:
        timestamps_for_map = timestamps

    # 产出数量可能 < 输入（某些 frame_number 因压缩边界找不到）
    # 按顺序把文件与 timestamps 对齐；若文件数不等于请求数，按文件数截取
    n = min(len(produced), len(timestamps_for_map))
    results: List[Dict] = []
    for i in range(n):
        fname = produced[i]
        results.append({
            "index": i,
            "timestamp": round(timestamps_for_map[i], 3),
            "filename": fname,
            "path": os.path.join(output_dir, fname),
        })
    return results


# ═══════════════════════════════════════════════════
#  转场/纯色帧过滤
# ═══════════════════════════════════════════════════

def detect_transition_frames(
    frame_items: List[Dict],
    luma_lo: float = 10.0,
    luma_hi: float = 245.0,
    edge_density_min: float = 0.02,
) -> Tuple[List[Dict], List[Dict]]:
    """
    过滤黑场/白场/纯色过渡帧。需要帧文件已存在。
    在每项上就地补充 brightness / edge_density 字段。
    """
    kept, rejected = [], []
    for item in frame_items:
        path = item.get("path") or ""
        b = iq.score_frame_brightness(path)
        e = iq.score_edge_density(path)
        item["brightness"] = round(b, 2) if b >= 0 else -1
        item["edge_density"] = round(e, 4) if e >= 0 else -1
        if 0 <= b < luma_lo:
            rej = dict(item); rej["reason"] = "too_dark"; rejected.append(rej); continue
        if b > luma_hi:
            rej = dict(item); rej["reason"] = "too_bright"; rejected.append(rej); continue
        if 0 <= e < edge_density_min:
            rej = dict(item); rej["reason"] = "no_edges"; rejected.append(rej); continue
        kept.append(item)
    return kept, rejected


# ═══════════════════════════════════════════════════
#  高层编排
# ═══════════════════════════════════════════════════

def pipeline_extract_keyframes(
    video_path: str,
    output_dir: str,
    rejected_dir: str,
    params: Optional[Dict] = None,
) -> Dict:
    """
    端到端关键帧提取编排：
      1. scene-cut 全量扫描
      2. 长镜头补帧 + 合并近邻
      3. 批量截帧到候选目录
      4. 清晰度打分 + pHash 去重
      5. 亮度/边缘密度过滤转场
      6. 保留帧重命名为 frame_%03d.jpg，淘汰帧移到 rejected_dir

    返回 keyframes.json 结构字典（不含 url，由路由层拼接）。
    """
    params = dict(params or {})
    min_scene_threshold = float(params.get("min_scene_threshold", 0.08))
    long_shot_max_gap = float(params.get("long_shot_max_gap", 2.0))
    merge_min_dt = float(params.get("merge_min_dt", 0.35))
    sharpness_min = float(params.get("sharpness_min", 60.0))
    hamming_dedup_threshold = int(params.get("hamming_dedup_threshold", 4))
    luma_lo = float(params.get("luma_lo", 10.0))
    luma_hi = float(params.get("luma_hi", 245.0))
    edge_density_min = float(params.get("edge_density_min", 0.02))
    max_candidates = int(params.get("max_candidates", 600))

    meta = get_video_metadata(video_path)
    duration = meta["duration"]
    fps = meta["fps"]

    # 步骤 1+2：切点 + 长镜头补帧
    scene_cuts = detect_scene_cuts(video_path, min_threshold=min_scene_threshold)
    supplements = long_shot_supplement(scene_cuts, duration, max_gap=long_shot_max_gap)
    merged = merge_timestamps(scene_cuts, supplements, min_dt=merge_min_dt)

    # 超上限就下采样（均匀取）
    if len(merged) > max_candidates:
        step = len(merged) / float(max_candidates)
        merged = [merged[int(i * step)] for i in range(max_candidates)]

    supplement_set = set(round(t, 3) for t in supplements)

    # 步骤 3：批量截帧
    cand_dir = output_dir  # 先都堆这里，最后重命名
    os.makedirs(cand_dir, exist_ok=True)
    os.makedirs(rejected_dir, exist_ok=True)
    # 清空目标目录旧帧
    for d in (cand_dir, rejected_dir):
        for f in os.listdir(d):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass

    raw = dump_candidate_frames(video_path, merged, cand_dir, fps=fps, naming="cand_%04d.jpg")

    # 为每个候选打标签：是否补帧
    for item in raw:
        item["is_supplement"] = round(item["timestamp"], 3) in supplement_set

    # 步骤 4：清晰度打分 + pHash 计算
    for item in raw:
        item["sharpness"] = round(iq.score_frame_sharpness(item["path"]), 2)
        item["phash"] = iq.compute_perceptual_hash(item["path"])

    # 模糊过滤
    after_blur, rej_blur = iq.filter_blurry_frames(raw, sharpness_min=sharpness_min)
    # pHash 去重
    after_dedup, rej_dedup = iq.dedup_similar_frames(after_blur, hamming_threshold=hamming_dedup_threshold)
    # 转场/纯色过滤
    after_trans, rej_trans = detect_transition_frames(
        after_dedup,
        luma_lo=luma_lo, luma_hi=luma_hi,
        edge_density_min=edge_density_min,
    )
    all_rejected = rej_blur + rej_dedup + rej_trans

    # 步骤 6：按 timestamp 排序，重新编号 + 重命名；scene_group 分组
    after_trans.sort(key=lambda x: x.get("timestamp", 0.0))
    # scene_group：基于 scene_cuts 分组
    def _group_of(ts: float) -> int:
        g = 0
        for i, c in enumerate(scene_cuts):
            if ts >= c:
                g = i
            else:
                break
        return g

    final_frames: List[Dict] = []
    for new_idx, item in enumerate(after_trans):
        old_path = item["path"]
        new_name = f"frame_{new_idx:03d}.jpg"
        new_path = os.path.join(cand_dir, new_name)
        try:
            os.replace(old_path, new_path)
        except OSError:
            continue
        final_frames.append({
            "index": new_idx,
            "timestamp": item["timestamp"],
            "filename": new_name,
            "sharpness": item.get("sharpness", -1),
            "phash": item.get("phash", ""),
            "brightness": item.get("brightness", -1),
            "edge_density": item.get("edge_density", -1),
            "scene_group": _group_of(item["timestamp"]),
            "is_supplement": item.get("is_supplement", False),
        })

    # 淘汰帧移到 rejected_dir，重新编号
    final_rejected: List[Dict] = []
    for new_idx, item in enumerate(all_rejected):
        old_path = item.get("path")
        if not old_path or not os.path.isfile(old_path):
            # 可能已经被 os.replace 或其他原因删除
            continue
        new_name = f"rej_{new_idx:03d}.jpg"
        new_path = os.path.join(rejected_dir, new_name)
        try:
            os.replace(old_path, new_path)
        except OSError:
            continue
        final_rejected.append({
            "index": new_idx,
            "timestamp": item.get("timestamp", 0.0),
            "filename": new_name,
            "reason": item.get("reason", "unknown"),
            "sharpness": item.get("sharpness", -1),
            "brightness": item.get("brightness", -1),
            "edge_density": item.get("edge_density", -1),
        })

    # 清理 cand_dir 里遗留的 cand_*.jpg（没被保留也没被淘汰的异常情况）
    for f in os.listdir(cand_dir):
        if f.startswith("cand_"):
            try:
                os.remove(os.path.join(cand_dir, f))
            except OSError:
                pass

    return {
        "version": 2,
        "duration": duration,
        "fps": fps,
        "params": {
            "min_scene_threshold": min_scene_threshold,
            "long_shot_max_gap": long_shot_max_gap,
            "merge_min_dt": merge_min_dt,
            "sharpness_min": sharpness_min,
            "hamming_dedup_threshold": hamming_dedup_threshold,
            "luma_lo": luma_lo, "luma_hi": luma_hi,
            "edge_density_min": edge_density_min,
            "max_candidates": max_candidates,
        },
        "scene_cuts": scene_cuts,
        "frames": final_frames,
        "rejected": final_rejected,
        "stats": {
            "candidates": len(raw),
            "rejected_blurry": len(rej_blur),
            "rejected_duplicate": len(rej_dedup),
            "rejected_transition": len(rej_trans),
            "kept": len(final_frames),
        },
    }


# ═══════════════════════════════════════════════════
#  兼容旧接口（供路由调用方渐进迁移，可删除）
# ═══════════════════════════════════════════════════

def recommend_max_frames(duration_sec: float, target_interval_sec: float = 15.0, hard_cap: int = 80) -> int:
    """旧接口保留用于估算，新 pipeline 不再使用"""
    if not duration_sec or duration_sec <= 0:
        return 30
    n = int(duration_sec / max(1.0, target_interval_sec))
    return max(6, min(hard_cap, n))
