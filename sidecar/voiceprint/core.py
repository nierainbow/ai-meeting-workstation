"""声纹核心：嵌入后端 + 主库 Gallery + 纯 numpy 凝聚聚类。

代码自 meeting-agent/app/voiceprint.py 拷贝而来（meeting-agent 现为只读归档），
差异点：
- 不再 from .util import，改 from .audio import（sidecar 自包含）
- normalize_name 简化：只做 strip/压缩空白，姓名纠错表由调用方在 HTTP 层处理
- 其余逻辑（双条件、加权累积、贡献三件套、聚类）逐行保持同口径，
  以保证与 meeting-agent 基线（22 簇 / 认出 3 人）可比。
"""
from __future__ import annotations

import pickle
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from .audio import SAMPLE_RATE, duration_sec


# ----------------------------- 嵌入后端 -----------------------------


class BaseEmbedder:
    """声纹嵌入抽象。embed 接收 16k mono float32 波形，返回向量或 None。"""

    name = "base"
    dim = 0

    def __init__(self) -> None:
        self._model = None

    def embed(self, wav: np.ndarray, max_sec: int = 120) -> Optional[np.ndarray]:
        raise NotImplementedError

    def _truncate(self, wav: np.ndarray, max_sec: int) -> np.ndarray:
        max_len = int(max_sec * SAMPLE_RATE)
        return wav[:max_len] if len(wav) > max_len else wav


class ResemblyzerEmbedder(BaseEmbedder):
    name = "ressemblyzer"
    dim = 256

    def _ensure(self):
        if self._model is None:
            from resemblyzer import VoiceEncoder

            self._model = VoiceEncoder()

    def embed(self, wav: np.ndarray, max_sec: int = 120) -> Optional[np.ndarray]:
        if len(wav) == 0:
            return None
        self._ensure()
        wav = self._truncate(wav, max_sec)
        try:
            emb = self._model.embed_utterance(wav)
        except Exception:
            return None
        return np.asarray(emb, dtype=np.float32)


def _modelscope_snapshot_dir(model_id: str) -> Optional[Path]:
    """在 ModelScope 缓存里找已下载完成的模型快照目录（离线，不触发网络）。

    只认 ~/.cache/modelscope 与 MODELSCOPE_CACHE 两种位置，匹配
    models/<owner>--<name>/snapshots/<rev>/。
    """
    import os

    owner, _, name = model_id.partition("/")
    folder = f"{owner}--{name}" if name else model_id
    roots = []
    env_cache = os.environ.get("MODELSCOPE_CACHE", "").strip()
    if env_cache:
        roots.append(Path(env_cache))
    roots.append(Path.home() / ".cache" / "modelscope")
    roots.append(Path.home() / ".cache" / "modelscope" / "hub")

    for root in roots:
        for sub in ("models", "."):
            base = root / sub / folder / "snapshots"
            if base.is_dir():
                for rev in sorted(base.iterdir(), reverse=True):
                    if rev.is_dir() and (rev / "configuration.json").exists():
                        return rev
    return None


class FunASREmbedder(BaseEmbedder):
    """FunASR 说话人验证模型（ERes2NetV2，中文 ≥ ECAPA）。

    模型权重走 ModelScope（~/.cache/modelscope/models/iic--speech_eres2netv2_sv_zh-cn_16k-common）。

    加载策略（本机实测）：AutoModel(model_id) 会走 modelscope snapshot_download，
    即使快照已缓存也会发起网络请求；本机到 modelscope 的 TLS 握手失败会让它
    无限重试并占住 .lock，导致整个 /identify 卡死。因此这里：
      1) 先在本地快照目录直接构造 ERes2NetV2SV（纯离线，~2.6s）；
      2) 只有本地快照缺失时才退回 AutoModel（首次下载场景）。
    """

    name = "eres2net"
    dim = 192
    MODEL_ID = "iic/speech_eres2netv2_sv_zh-cn_16k-common"

    def _ensure(self):
        if self._model is not None:
            return
        self._model = self._load_offline() or self._load_auto()

    def _load_offline(self):
        import json

        snap = _modelscope_snapshot_dir(self.MODEL_ID)
        if snap is None:
            return None
        try:
            import torch
            from funasr.models.campplus.utils import extract_feature
            from funasr.models.eres2net.model import ERes2NetV2SV

            cfg = json.loads((snap / "configuration.json").read_text(encoding="utf-8"))
            model_cfg = dict(cfg.get("model", {}).get("model_config", {}))
            model_cfg.pop("sample_rate", None)  # ERes2NetV2SV 不收这个参数
            sv = ERes2NetV2SV(model_path=str(snap), **model_cfg)
            sv.eval()
            return _OfflineERes2NetV2(sv, extract_feature)
        except Exception:
            return None

    def _load_auto(self):
        from funasr import AutoModel

        return AutoModel(model=self.MODEL_ID, disable_update=True)

    def embed(self, wav: np.ndarray, max_sec: int = 120) -> Optional[np.ndarray]:
        if len(wav) == 0:
            return None
        self._ensure()
        wav = self._truncate(wav, max_sec)
        try:
            if isinstance(self._model, _OfflineERes2NetV2):
                emb = self._model.embed(wav)
            else:
                import tempfile

                import soundfile as sf

                tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
                try:
                    sf.write(tmp.name, wav, SAMPLE_RATE)
                    res = self._model.generate(input=tmp.name, fs=SAMPLE_RATE)
                    emb = np.array(res[0].get("spk_embedding"))
                finally:
                    Path(tmp.name).unlink(missing_ok=True)
        except Exception:
            return None
        return np.asarray(emb, dtype=np.float32).reshape(-1)


class _OfflineERes2NetV2:
    """本地快照直载的 ERes2NetV2 包装：吃 16k float32 波形，吐 192 维嵌入。

    与 AutoModel.generate(input=<wav 文件>, fs=16000) 的输出同口径
    （res[0]['spk_embedding']），因此上层用法完全一致。
    """

    def __init__(self, sv, extract_feature) -> None:
        self.sv = sv
        self.extract_feature = extract_feature

    def embed(self, wav: np.ndarray) -> np.ndarray:
        import torch

        # extract_feature 期望「1-D tensor 列表」，内部逐条 unsqueeze(0) 后送 Kaldi.fbank
        speech, _lengths, _times = self.extract_feature([torch.from_numpy(wav).to(torch.float32)])
        with torch.no_grad():
            out = self.sv(speech.to(torch.float32))
        item = out[0] if isinstance(out, (list, tuple)) else out
        emb = item["spk_embedding"] if isinstance(item, dict) else item
        return np.asarray(emb, dtype=np.float32).reshape(-1)


_EMBEDDERS = {"ressemblyzer": ResemblyzerEmbedder, "eres2net": FunASREmbedder}
_EMBEDDER_CACHE: Dict[str, BaseEmbedder] = {}


def get_embedder(name: str) -> BaseEmbedder:
    """返回可复用（带模型缓存）的嵌入后端单例，避免每次会议重复加载模型。"""
    if name in _EMBEDDER_CACHE:
        return _EMBEDDER_CACHE[name]
    cls = _EMBEDDERS.get(name, ResemblyzerEmbedder)
    inst = cls()
    _EMBEDDER_CACHE[name] = inst
    return inst


def embedder_available(name: str) -> bool:
    """探测该后端依赖是否可导入（/health 用，不真正加载模型权重）。"""
    try:
        if name == "ressemblyzer":
            import resemblyzer  # noqa: F401
        elif name == "eres2net":
            import funasr  # noqa: F401
            import soundfile  # noqa: F401
        else:
            return False
        return True
    except Exception:
        return False


def normalize_name(name: str, corrections: Optional[Dict[str, str]] = None) -> str:
    """姓名规范化：去首尾空白 + 压缩内部连续空白；可选调用方纠错表。"""
    text = " ".join(str(name or "").split())
    if corrections:
        text = corrections.get(text, text)
    return text


# ----------------------------- 声纹库 -----------------------------


@dataclass
class MatchDetail:
    voice_id: str
    duration_sec: float
    best_name: Optional[str]
    best_score: float
    second_name: Optional[str]
    second_score: float
    gap: float
    assigned: bool
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "voice_id": self.voice_id,
            "duration_sec": round(self.duration_sec, 1),
            "best_name": self.best_name,
            "best_score": round(self.best_score, 3),
            "second_name": self.second_name,
            "second_score": round(self.second_score, 3),
            "gap": round(self.gap, 3),
            "assigned": self.assigned,
            "reason": self.reason,
        }


@dataclass
class PendingSpeaker:
    voice_id: str
    duration_sec: float
    best_name: Optional[str]
    best_score: float
    second_name: Optional[str]
    second_score: float
    gap: float

    def to_dict(self) -> dict:
        return {
            "voice_id": self.voice_id,
            "duration_sec": round(self.duration_sec, 1),
            "best_name": self.best_name,
            "best_score": round(self.best_score, 3),
            "second_name": self.second_name,
            "second_score": round(self.second_score, 3),
            "gap": round(self.gap, 3),
        }


class Gallery:
    """256 维 Resemblyzer 声纹主库：加载/匹配/累积/编辑/贡献包。

    pkl 文件永不进 git；本类只负责读写本地 .local-data/voiceprint/gallery.pkl。
    """

    def __init__(
        self,
        path: str | Path,
        threshold: float = 0.65,
        margin: float = 0.05,
        max_sec: int = 120,
        min_duration_sec: float = 1.5,
        corrections: Optional[Dict[str, str]] = None,
    ) -> None:
        self.path = Path(path)
        self.threshold = threshold
        self.margin = margin
        self.max_sec = max_sec
        self.min_duration_sec = min_duration_sec
        self.corrections = corrections or {}
        self.data: dict = {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "speakers": {},
        }
        self._names: List[str] = []
        self._matrix: Optional[np.ndarray] = None
        if self.path.exists():
            self._load()

    # ---- 持久化 ----
    def _load(self) -> None:
        with open(self.path, "rb") as f:
            self.data = pickle.load(f)
        self.data.setdefault("speakers", {})
        self._rebuild()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data["updated_at"] = datetime.now().isoformat(timespec="seconds")
        with open(self.path, "wb") as f:
            pickle.dump(self.data, f)

    def _rebuild(self) -> None:
        self._names = sorted(self.data["speakers"].keys())
        if self._names:
            mats = [np.asarray(self.data["speakers"][n]["embedding"], dtype=np.float32) for n in self._names]
            m = np.stack(mats)
            self._matrix = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)
        else:
            self._matrix = None

    # ---- 查询 ----
    @property
    def speaker_names(self) -> List[str]:
        return list(self._names)

    @property
    def speaker_count(self) -> int:
        return len(self._names)

    def stats(self) -> List[dict]:
        out = []
        for n in self._names:
            s = self.data["speakers"][n]
            out.append(
                {
                    "name": n,
                    "sample_count": s.get("sample_count", 0),
                    "total_seconds": s.get("total_seconds", 0),
                }
            )
        return out

    # ---- 匹配 ----
    def match_segments(
        self, segments: Dict[str, np.ndarray], embedder: BaseEmbedder
    ) -> Tuple[Dict[str, Optional[str]], List[MatchDetail], List[PendingSpeaker]]:
        """对若干音频段(段id -> 波形)做声纹匹配。

        返回 (mapping, details, pending)。mapping[seg_id]=姓名或 None。
        双条件：score>=threshold 且 gap>=margin 才自动确认。
        """
        mapping: Dict[str, Optional[str]] = {}
        details: List[MatchDetail] = []
        pending: List[PendingSpeaker] = []

        for seg_id, wav in segments.items():
            dur = duration_sec(wav)
            if wav is None or dur < self.min_duration_sec:
                details.append(MatchDetail(seg_id, dur, None, 0.0, None, 0.0, 0.0, False, "语音过短"))
                mapping[seg_id] = None
                continue

            emb = embedder.embed(wav, max_sec=self.max_sec)
            if emb is None:
                details.append(MatchDetail(seg_id, dur, None, 0.0, None, 0.0, 0.0, False, "嵌入提取失败"))
                mapping[seg_id] = None
                continue

            emb_n = emb / (np.linalg.norm(emb) + 1e-8)
            if self._matrix is None or len(self._names) == 0:
                details.append(MatchDetail(seg_id, dur, None, 0.0, None, 0.0, 0.0, False, "声纹库为空"))
                mapping[seg_id] = None
                continue

            sims = self._matrix @ emb_n
            order = np.argsort(sims)[::-1]
            best_idx = int(order[0])
            best_name = self._names[best_idx]
            best_score = float(sims[best_idx])
            second_name = self._names[int(order[1])] if len(self._names) > 1 else None
            second_score = float(sims[order[1]]) if len(self._names) > 1 else 0.0
            gap = best_score - second_score

            assigned = best_score >= self.threshold and gap >= self.margin
            mapping[seg_id] = best_name if assigned else None
            details.append(MatchDetail(seg_id, dur, best_name, best_score, second_name, second_score, gap, assigned))
            if not assigned:
                pending.append(PendingSpeaker(seg_id, dur, best_name, best_score, second_name, second_score, gap))

        return mapping, details, pending

    # ---- 累积更新 ----
    def update_from_mapping(
        self,
        segments: Dict[str, np.ndarray],
        mapping: Dict[str, Optional[str]],
        embedder: BaseEmbedder,
        source_label: str = "",
    ) -> dict:
        """根据已确认的 mapping 把本场会议各说话人声纹加权累积进主库。

        每个姓名在本场的若干段取均值作为一次样本，sample_count=段数。
        加权：merged = (old*n + new*sc) / (old_n + sc)，与 merge 脚本一致。
        返回 {added:[], updated:[]}。
        """
        by_name: Dict[str, List[np.ndarray]] = {}
        by_secs: Dict[str, float] = {}
        for seg_id, name in mapping.items():
            if not name or seg_id not in segments:
                continue
            wav = segments[seg_id]
            if wav is None or len(wav) < SAMPLE_RATE * self.min_duration_sec:
                continue
            by_name.setdefault(name, []).append(wav)
            by_secs[name] = by_secs.get(name, 0.0) + len(wav) / SAMPLE_RATE

        added, updated = [], []
        for name, wavs in by_name.items():
            name = normalize_name(name, self.corrections)
            if not name:
                continue
            embs = [embedder.embed(w, max_sec=self.max_sec) for w in wavs]
            embs = [e for e in embs if e is not None]
            if not embs:
                continue
            new_emb = np.mean(embs, axis=0).astype(np.float32)
            sc = len(embs)
            total_sec = round(by_secs.get(name, 0.0), 1)
            existing = self.data["speakers"].get(name)
            if existing is None:
                self.data["speakers"][name] = {
                    "embedding": new_emb,
                    "sample_count": sc,
                    "total_seconds": total_sec,
                    "first_seen": source_label,
                }
                added.append(name)
            else:
                old = np.asarray(existing["embedding"], dtype=np.float32)
                old_n = existing.get("sample_count", 1)
                merged = (old * old_n + new_emb * sc) / (old_n + sc)
                existing["embedding"] = merged.astype(np.float32)
                existing["sample_count"] = old_n + sc
                existing["total_seconds"] = round(existing.get("total_seconds", 0.0) + total_sec, 1)
                updated.append(name)
        if added or updated:
            self._rebuild()
            self.save()
        return {"added": added, "updated": updated}

    # ---- 编辑 ----
    def rename(self, old: str, new: str) -> bool:
        if old not in self.data["speakers"] or not new:
            return False
        self.data["speakers"][new] = self.data["speakers"].pop(old)
        self._rebuild()
        self.save()
        return True

    def merge(self, src: str, dst: str) -> bool:
        """把 src 的声纹合并进 dst（加权），删除 src。用于同人多 voiceId 归并。"""
        if src not in self.data["speakers"] or dst not in self.data["speakers"]:
            return False
        a = self.data["speakers"][src]
        b = self.data["speakers"][dst]
        na, nb = a.get("sample_count", 1), b.get("sample_count", 1)
        merged = (
            np.asarray(b["embedding"], np.float32) * nb + np.asarray(a["embedding"], np.float32) * na
        ) / (na + nb)
        b["embedding"] = merged.astype(np.float32)
        b["sample_count"] = na + nb
        b["total_seconds"] = round(a.get("total_seconds", 0) + b.get("total_seconds", 0), 1)
        del self.data["speakers"][src]
        self._rebuild()
        self.save()
        return True

    def delete(self, name: str) -> bool:
        if name not in self.data["speakers"]:
            return False
        del self.data["speakers"][name]
        self._rebuild()
        self.save()
        return True

    # ---- 贡献包 ----
    def build_contribution(
        self,
        segments: Dict[str, np.ndarray],
        mapping: Dict[str, Optional[str]],
        embedder: BaseEmbedder,
        share_id: str,
        contributor: str,
        meeting_title: str,
        format_tag: str,
    ) -> dict:
        """生成本场会议声纹贡献三件套：{embeddings, mapping, metadata}。

        metadata.format 固定为 resemblyzer-256，兼容既有 merge 脚本（防混维）。
        """
        speakers: Dict[str, Dict] = {}
        vid_map: Dict[str, str] = {}
        for seg_id, name in mapping.items():
            if not name or seg_id not in segments:
                continue
            wav = segments[seg_id]
            if wav is None or len(wav) < SAMPLE_RATE * self.min_duration_sec:
                continue
            emb = embedder.embed(wav, max_sec=self.max_sec)
            if emb is None:
                continue
            name = normalize_name(name, self.corrections)
            if not name:
                continue
            cur = speakers.setdefault(name, {"embedding": [], "sample_count": 0, "total_seconds": 0.0})
            cur["embedding"].append(emb)
            cur["sample_count"] += 1
            cur["total_seconds"] += round(len(wav) / SAMPLE_RATE, 1)
            vid_map[str(seg_id)] = name

        for name, info in speakers.items():
            info["embedding"] = np.mean(info["embedding"], axis=0).astype(np.float32).tolist()
            info["total_seconds"] = round(info["total_seconds"], 1)

        metadata = {
            "contributor": contributor,
            "share_id": share_id,
            "meeting_title": meeting_title,
            "contributed_at": datetime.now().isoformat(timespec="seconds"),
            "engine": embedder.name,
            "format": format_tag,  # 防混维：ressemblyzer-256 / eres2net-192
        }
        return {"embeddings": {"speakers": speakers}, "mapping": vid_map, "metadata": metadata}


# ----------------------------- 说话人聚类（diarization） -----------------------------


def cluster_segments(
    segments: Dict[str, np.ndarray],
    embedder: BaseEmbedder,
    threshold: float = 0.40,
    min_duration_sec: float = 1.5,
) -> Dict[str, int]:
    """把若干音频段按声纹相似度聚成说话人簇。

    返回 {原 segment_id -> cluster_id}，cluster_id 从 0 开始连续编号。
    纯 numpy 凝聚聚类（与 meeting-agent 同口径：duration 加权质心 + 阈值停止）。
    """
    ids = list(segments.keys())
    embs: List[Optional[np.ndarray]] = []
    durs: List[float] = []
    for sid in ids:
        wav = segments.get(sid)
        dur = duration_sec(wav)
        if wav is None or dur < min_duration_sec:
            embs.append(None)
            durs.append(0.0)
            continue
        max_sec = getattr(embedder, "_max_sec", 120)
        emb = embedder.embed(wav, max_sec=max_sec)
        if emb is not None:
            emb = emb / (np.linalg.norm(emb) + 1e-8)
        embs.append(emb)
        durs.append(dur)

    valid_idx = [i for i, e in enumerate(embs) if e is not None]
    if not valid_idx:
        return {sid: i for i, sid in enumerate(ids)}

    n = len(valid_idx)
    clusters = [{"idx": [pos], "emb": embs[orig].copy(), "dur": durs[orig]} for pos, orig in enumerate(valid_idx)]

    def sim(a, b):
        return float(np.dot(a["emb"], b["emb"]))

    sims: Dict[Tuple[int, int], float] = {}
    for i in range(n):
        for j in range(i + 1, n):
            sims[(i, j)] = sim(clusters[i], clusters[j])

    alive = set(range(n))
    while True:
        best = None
        best_s = -1.0
        for i in alive:
            for j in alive:
                if i >= j:
                    continue
                key = (i, j) if i < j else (j, i)
                s = sims.get(key, -1.0)
                if s > best_s:
                    best_s = s
                    best = (i, j)
        if best is None or best_s < threshold:
            break
        i, j = best
        ci, cj = clusters[i], clusters[j]
        total_dur = ci["dur"] + cj["dur"]
        ci["emb"] = (ci["emb"] * ci["dur"] + cj["emb"] * cj["dur"]) / total_dur
        ci["emb"] /= np.linalg.norm(ci["emb"]) + 1e-8
        ci["idx"].extend(cj["idx"])
        ci["dur"] = total_dur
        alive.remove(j)
        for k in alive:
            if k == i:
                continue
            key = (i, k) if i < k else (k, i)
            sims[key] = sim(clusters[i], clusters[k])

    cluster_id_map: Dict[str, int] = {}
    for new_id, old_id in enumerate(sorted(alive)):
        for idx_in_valid in clusters[old_id]["idx"]:
            original_index = valid_idx[idx_in_valid]
            cluster_id_map[ids[original_index]] = new_id

    next_id = len(alive)
    valid_set = set(valid_idx)
    for i, sid in enumerate(ids):
        if i not in valid_set:
            cluster_id_map[sid] = next_id
            next_id += 1

    return cluster_id_map
