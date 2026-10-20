"""音频 IO：16k mono float32 波形读取 + 按区间拼接。

从 meeting-agent/app/util.py 抽离为独立模块（无 meeting-agent import，sidecar 自包含）。
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, List, Sequence, Tuple, Union

import numpy as np

SAMPLE_RATE = 16000

TimeRange = Union[Tuple[int, int], dict]


def load_audio(path: str | Path, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """读取任意格式音频，重采样成 target_sr mono float32。"""
    import soundfile as sf

    wav, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sr != target_sr:
        try:
            import librosa

            wav = librosa.resample(wav, orig_sr=sr, target_sr=target_sr)
        except Exception:
            from scipy.signal import resample

            n = int(round(len(wav) * target_sr / sr))
            wav = resample(wav, n).astype(np.float32)
    return np.ascontiguousarray(wav, dtype=np.float32)


def _range_ms(item: TimeRange) -> Tuple[int, int]:
    """接受 (start_ms, end_ms) 或 {start,end}/{startTime,endTime}/{start_ms,end_ms}。"""
    if isinstance(item, dict):
        start = item.get("start", item.get("startTime", item.get("start_ms", 0)))
        end = item.get("end", item.get("endTime", item.get("end_ms", 0)))
    else:
        start, end = item
    return int(start), int(end)


def concat_segments(wav: np.ndarray, ranges: Sequence[TimeRange], sr: int = SAMPLE_RATE) -> np.ndarray:
    """把 (start_ms, end_ms) 区间列表拼成一段连续波形（与 meeting-agent 一致）。"""
    parts: List[np.ndarray] = []
    for item in ranges:
        start_ms, end_ms = _range_ms(item)
        a = max(0, int(start_ms * sr / 1000))
        b = min(len(wav), int(end_ms * sr / 1000))
        if b > a:
            parts.append(wav[a:b])
    if not parts:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(parts).astype(np.float32)


def duration_sec(wav: np.ndarray | None, sr: int = SAMPLE_RATE) -> float:
    return 0.0 if wav is None else len(wav) / sr


def probe_duration_ms(path: str | Path) -> int:
    """只探测音频时长（不重采样，快速）。"""
    import soundfile as sf

    info = sf.info(str(path))
    return int(round(info.frames / info.samplerate * 1000))
