"""
image_quality.py — 图像质量评估与去重工具
纯函数层：Laplacian 清晰度、pHash、汉明距离、模糊/相似帧筛选。
无业务依赖，可被任意模块复用。
"""

import os
from typing import List, Dict, Tuple, Optional

try:
    import cv2
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False

try:
    from PIL import Image
    import imagehash
    _HAS_PHASH = True
except ImportError:
    _HAS_PHASH = False


def has_opencv() -> bool:
    return _HAS_CV2


def has_phash() -> bool:
    return _HAS_PHASH


def score_frame_sharpness(image_path: str) -> float:
    """
    Laplacian 方差估计清晰度。越高越清晰，运动模糊/失焦帧的方差会显著偏低。
    失败返回 -1.0，调用方应跳过（不作为过滤依据）。
    """
    if not _HAS_CV2 or not os.path.isfile(image_path):
        return -1.0
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return -1.0
        return float(cv2.Laplacian(img, cv2.CV_64F).var())
    except Exception:
        return -1.0


def compute_perceptual_hash(image_path: str, hash_size: int = 16) -> str:
    """
    pHash 感知哈希，用于相似帧检测。返回 hex 字符串；失败返回空串。
    hash_size=16 → 256-bit 哈希，区分度比默认 8 (64-bit) 高。
    """
    if not _HAS_PHASH or not os.path.isfile(image_path):
        return ""
    try:
        with Image.open(image_path) as img:
            return str(imagehash.phash(img, hash_size=hash_size))
    except Exception:
        return ""


def hamming_distance(hash_a: str, hash_b: str) -> int:
    """两个 hex pHash 字符串的汉明距离。任一为空返回 -1。"""
    if not hash_a or not hash_b or len(hash_a) != len(hash_b):
        return -1
    try:
        a = int(hash_a, 16)
        b = int(hash_b, 16)
        return bin(a ^ b).count("1")
    except ValueError:
        return -1


def score_frame_brightness(image_path: str) -> float:
    """
    平均亮度（0-255）。用于检测黑场/白场过渡。失败返回 -1.0。
    """
    if not _HAS_CV2 or not os.path.isfile(image_path):
        return -1.0
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return -1.0
        return float(img.mean())
    except Exception:
        return -1.0


def score_edge_density(image_path: str) -> float:
    """
    Canny 边缘像素占比（0-1）。纯色过渡/虚化帧的边缘密度接近 0。失败返回 -1.0。
    """
    if not _HAS_CV2 or not os.path.isfile(image_path):
        return -1.0
    try:
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            return -1.0
        edges = cv2.Canny(img, 80, 160)
        return float((edges > 0).sum()) / float(edges.size)
    except Exception:
        return -1.0


def filter_blurry_frames(
    frame_items: List[Dict],
    sharpness_min: float = 80.0,
) -> Tuple[List[Dict], List[Dict]]:
    """
    按清晰度过滤。frame_items 中必须已有 'sharpness' 字段（调用前用 score_frame_sharpness 填充）。
    sharpness = -1 的跳过不杀（算法失败时不瞎杀）。
    返回 (kept, rejected)，rejected 项追加 reason="blurry"。
    """
    kept, rejected = [], []
    for item in frame_items:
        s = item.get("sharpness", -1.0)
        if s >= 0 and s < sharpness_min:
            rej = dict(item)
            rej["reason"] = "blurry"
            rejected.append(rej)
        else:
            kept.append(item)
    return kept, rejected


def dedup_similar_frames(
    frame_items: List[Dict],
    hamming_threshold: int = 8,
) -> Tuple[List[Dict], List[Dict]]:
    """
    按 pHash 去重。frame_items 需按时间顺序（timestamp 升序），且每项有 'phash' 与 'sharpness' 字段。
    汉明距离 <= threshold 视为同一组；组内保留 sharpness 最高者，其他标 reason=duplicate_of=<idx>。
    空 phash 不参与去重（直接保留）。
    """
    kept: List[Dict] = []
    rejected: List[Dict] = []
    # 贪心分组：遍历帧，若与已保留帧中 phash 距离 <= threshold 则归入该组
    groups: List[List[int]] = []  # frame_items index lists
    for i, item in enumerate(frame_items):
        ph = item.get("phash", "")
        if not ph:
            groups.append([i])
            continue
        merged = False
        for g in groups:
            rep = frame_items[g[0]]
            rep_ph = rep.get("phash", "")
            if not rep_ph:
                continue
            d = hamming_distance(ph, rep_ph)
            if 0 <= d <= hamming_threshold:
                g.append(i)
                merged = True
                break
        if not merged:
            groups.append([i])

    for g in groups:
        if len(g) == 1:
            kept.append(frame_items[g[0]])
            continue
        # 组内选 sharpness 最高的（-1 视作最小）
        best_idx = max(g, key=lambda i: frame_items[i].get("sharpness", -1.0))
        kept_item = frame_items[best_idx]
        kept.append(kept_item)
        keep_original_idx = kept_item.get("index", best_idx)
        for i in g:
            if i == best_idx:
                continue
            rej = dict(frame_items[i])
            rej["reason"] = f"duplicate_of={keep_original_idx}"
            rejected.append(rej)
    # 保持原顺序：按 timestamp 排序
    kept.sort(key=lambda x: x.get("timestamp", 0.0))
    return kept, rejected
