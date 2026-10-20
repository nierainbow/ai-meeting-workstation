"""声纹 sidecar HTTP 服务（FastAPI，默认 8792）。

端点：
  GET  /health
  POST /identify   {audioPath, utterances:[{id,startMs,endMs,...}], meetingId?, title?}
                   -> ERes2NetV2 聚类 + Resemblyzer 主库匹配
                   -> {meetingId, clusters:[{clusterId, 疑似姓名|null, score, gap, durationSec,
                       utterances, 疑似?}], pending:[...], galleryCount}
  POST /confirm    {meetingId, clusterId, 姓名|null}  -> 暂存人工确认
  GET  /gallery    -> {speakers:[{name, sample_count, total_seconds}], count, path, sha256}
  POST /gallery    {action: rename|merge|delete, ...} -> 编辑主库
  POST /finalize   {meetingId, contributor?, meetingTitle?}
                   -> 累积回库 + 导出贡献三件套（metadata.format=ressemblyzer-256）

安全边界：自动认人结果只以「疑似」呈现，禁止当事实；<1.5s 碎片不进 pending。
"""
from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .audio import SAMPLE_RATE, concat_segments, duration_sec, load_audio
from .config import load_config
from .core import Gallery, cluster_segments, embedder_available, get_embedder, normalize_name


def _sha256(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Range(BaseModel):
    """毫秒区间。"""

    startMs: int
    endMs: int


class Utterance(BaseModel):
    """一条发言：一个区间（startMs/endMs）或多区间（ranges，按顺序拼接）。

    多区间用于把同一说话人的多个句子区间合成一段音频（与 meeting-agent 的
    voice_id -> [(start_ms,end_ms), ...] 段音频同口径），保证聚类输入可比。
    id 缺省时依次用 label / u<index>。
    """

    id: Optional[str] = None
    startMs: Optional[int] = Field(default=None, description="区间起点（毫秒），单区间时用")
    endMs: Optional[int] = Field(default=None, description="区间终点（毫秒），单区间时用")
    ranges: Optional[List[Range]] = Field(default=None, description="多区间，按顺序拼接")
    label: Optional[str] = Field(default=None, description="上游说话人标签（如 speaker_0）")

    def resolved_id(self, index: int) -> str:
        return self.id or self.label or f"u{index}"

    def resolved_ranges(self) -> List[Tuple[int, int]]:
        if self.ranges:
            return [(r.startMs, r.endMs) for r in self.ranges]
        if self.startMs is None or self.endMs is None:
            raise HTTPException(400, "utterance 需要 startMs/endMs 或 ranges")
        return [(self.startMs, self.endMs)]


class IdentifyRequest(BaseModel):
    audioPath: str
    utterances: List[Utterance]
    meetingId: Optional[str] = None
    title: Optional[str] = None


class ConfirmRequest(BaseModel):
    meetingId: str
    clusterId: int
    name: Optional[str] = Field(default=None, description="确认姓名；null 表示跳过/拒绝该簇")


class GalleryActionRequest(BaseModel):
    action: str = Field(..., description="rename | merge | delete")
    old: Optional[str] = None
    new: Optional[str] = None
    src: Optional[str] = None
    dst: Optional[str] = None
    name: Optional[str] = None


class FinalizeRequest(BaseModel):
    meetingId: str
    contributor: Optional[str] = "local"
    meetingTitle: Optional[str] = None


class Session:
    """一次 /identify 的进程内会话：保存段落音频、聚类映射与人工确认暂存。"""

    def __init__(self, meeting_id: str, title: str, audio_path: str) -> None:
        self.meeting_id = meeting_id
        self.title = title
        self.audio_path = audio_path
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.segments: Dict[str, object] = {}
        self.cluster_map: Dict[str, int] = {}
        self.cluster_audio: Dict[int, object] = {}
        self.cluster_durations: Dict[int, float] = {}
        self.confirmed: Dict[int, Optional[str]] = {}
        self.auto_mapping: Dict[int, Optional[str]] = {}
        self.details: List[dict] = []


def create_app(config=None) -> FastAPI:
    cfg = config or load_config()
    app = FastAPI(title="voiceprint-sidecar", version="0.9.0")
    sessions: Dict[str, Session] = {}

    gallery = Gallery(
        cfg.gallery_path,
        threshold=cfg.threshold,
        margin=cfg.margin,
        max_sec=cfg.max_sec,
        min_duration_sec=cfg.min_duration_sec,
    )

    # ---- 首启自举：把 16 人主库从 meeting-agent/assets 迁到 .local-data/voiceprint/ ----
    if not cfg.gallery_path.exists() and cfg.master_gallery_source.exists():
        cfg.gallery_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cfg.master_gallery_source, cfg.gallery_path)
        gallery = Gallery(
            cfg.gallery_path,
            threshold=cfg.threshold,
            margin=cfg.margin,
            max_sec=cfg.max_sec,
            min_duration_sec=cfg.min_duration_sec,
        )

    def _match_embedder():
        if not embedder_available(cfg.embedder):
            raise HTTPException(503, f"匹配后端 {cfg.embedder} 不可用（缺依赖），请用 VOICEPRINT_PYTHON_PATH 指向含 resemblyzer 的解释器")
        return get_embedder(cfg.embedder)

    def _cluster_embedder():
        if not embedder_available(cfg.cluster_embedder):
            raise HTTPException(503, f"聚类后端 {cfg.cluster_embedder} 不可用（缺依赖），请用 VOICEPRINT_PYTHON_PATH 指向含 funasr 的解释器")
        return get_embedder(cfg.cluster_embedder)

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": True,
            "service": "voiceprint-sidecar",
            "port": cfg.port,
            "embedder": cfg.embedder,
            "clusterEmbedder": cfg.cluster_embedder,
            "embedderAvailable": embedder_available(cfg.embedder),
            "clusterEmbedderAvailable": embedder_available(cfg.cluster_embedder),
            "galleryPath": str(cfg.gallery_path),
            "galleryCount": gallery.speaker_count,
            "gallerySha256": _sha256(cfg.gallery_path),
            "minDurationSec": cfg.min_duration_sec,
            "threshold": cfg.threshold,
            "margin": cfg.margin,
            "clusterThreshold": cfg.cluster_threshold,
        }

    @app.post("/identify")
    def identify(req: IdentifyRequest) -> dict:
        audio_path = Path(req.audioPath).expanduser()
        if not audio_path.exists():
            raise HTTPException(400, f"音频文件不存在：{audio_path}")
        if not req.utterances:
            raise HTTPException(400, "utterances 不能为空")

        meeting_id = req.meetingId or uuid.uuid4().hex[:12]
        wav = load_audio(audio_path)

        # 1) 每条 utterance 拼出自己的波形（与 meeting-agent 的 seg audio 同口径）
        session = Session(meeting_id, req.title or "", str(audio_path))
        for index, utt in enumerate(req.utterances):
            seg = concat_segments(wav, utt.resolved_ranges())
            session.segments[utt.resolved_id(index)] = seg

        # 2) ERes2NetV2 聚类（diarization）
        session.cluster_map = cluster_segments(
            session.segments, _cluster_embedder(), threshold=cfg.cluster_threshold, min_duration_sec=cfg.min_duration_sec
        )

        # 3) 每簇拼接波形 -> Resemblyzer 主库匹配（簇级匹配，与 pipeline 一致）
        for seg_id, cid in session.cluster_map.items():
            seg = session.segments[seg_id]
            session.cluster_audio.setdefault(cid, [])
            session.cluster_audio[cid].append(seg)

        cluster_wavs: Dict[int, object] = {}
        for cid, parts in session.cluster_audio.items():
            import numpy as np

            joined = np.concatenate(parts).astype("float32") if parts else None
            cluster_wavs[cid] = joined
            session.cluster_durations[cid] = duration_sec(joined)

        mapping, details, _pending = gallery.match_segments(cluster_wavs, _match_embedder())
        session.details = [d.to_dict() for d in details]
        session.auto_mapping = {int(k): v for k, v in mapping.items()}
        session.confirmed = dict(session.auto_mapping)

        clusters_out: List[dict] = []
        for cid in sorted(cluster_wavs):
            detail = next((d for d in session.details if int(d["voice_id"]) == int(cid)), None)
            best_name = detail["best_name"] if detail else None
            best_score = detail["best_score"] if detail else 0.0
            gap = detail["gap"] if detail else 0.0
            assigned = detail["assigned"] if detail else False
            seg_ids = sorted([sid for sid, c in session.cluster_map.items() if c == cid])
            clusters_out.append(
                {
                    "clusterId": cid,
                    "疑似姓名": best_name if assigned else None,
                    "score": best_score,
                    "gap": gap,
                    "durationSec": round(session.cluster_durations.get(cid, 0.0), 1),
                    "utterances": seg_ids,
                    "疑似": bool(assigned),
                    "autoName": best_name,
                    "reason": detail["reason"] if detail else "",
                }
            )

        pending = [c for c in clusters_out if not c["疑似"] and c["durationSec"] >= cfg.min_duration_sec]
        sessions[meeting_id] = session

        return {
            "meetingId": meeting_id,
            "title": session.title,
            "audioPath": str(audio_path),
            "clusterCount": len(clusters_out),
            "clusters": clusters_out,
            "pending": pending,
            "galleryCount": gallery.speaker_count,
            "note": "自动认人仅为「疑似」，必须人工确认后才能作为事实展示。",
        }

    @app.post("/confirm")
    def confirm(req: ConfirmRequest) -> dict:
        session = sessions.get(req.meetingId)
        if session is None:
            raise HTTPException(404, f"会话不存在：{req.meetingId}（/identify 结果只在进程内有效）")
        if req.clusterId not in session.cluster_audio:
            raise HTTPException(400, f"clusterId 不存在：{req.clusterId}")
        name = normalize_name(req.name) if req.name else None
        if name is not None and not name:
            name = None
        session.confirmed[req.clusterId] = name
        return {
            "meetingId": req.meetingId,
            "clusterId": req.clusterId,
            "name": name,
            "confirmed": session.confirmed,
        }

    @app.get("/gallery")
    def gallery_list() -> dict:
        return {
            "path": str(cfg.gallery_path),
            "sha256": _sha256(cfg.gallery_path),
            "count": gallery.speaker_count,
            "speakers": gallery.stats(),
        }

    @app.post("/gallery")
    def gallery_action(req: GalleryActionRequest) -> dict:
        action = req.action.strip().lower()
        if action == "rename":
            if not req.old or not req.new:
                raise HTTPException(400, "rename 需要 old 和 new")
            ok = gallery.rename(req.old, normalize_name(req.new))
        elif action == "merge":
            if not req.src or not req.dst:
                raise HTTPException(400, "merge 需要 src 和 dst")
            ok = gallery.merge(req.src, req.dst)
        elif action == "delete":
            if not req.name:
                raise HTTPException(400, "delete 需要 name")
            ok = gallery.delete(req.name)
        else:
            raise HTTPException(400, f"未知 action：{req.action}")
        if not ok:
            raise HTTPException(400, "操作失败：姓名不存在或参数无效")
        return {
            "ok": True,
            "action": action,
            "count": gallery.speaker_count,
            "speakers": gallery.stats(),
        }

    @app.post("/finalize")
    def finalize(req: FinalizeRequest) -> dict:
        session = sessions.get(req.meetingId)
        if session is None:
            raise HTTPException(404, f"会话不存在：{req.meetingId}")

        embedder = _match_embedder()
        # 用整段（utterance 级）音频累积，与 meeting-agent finalize 同口径
        seg_mapping: Dict[str, Optional[str]] = {}
        for seg_id, cid in session.cluster_map.items():
            name = session.confirmed.get(cid)
            if name:
                seg_mapping[seg_id] = name

        upd = gallery.update_from_mapping(session.segments, seg_mapping, embedder, source_label=session.title or req.meetingId)

        cfg.contrib_root.mkdir(parents=True, exist_ok=True)
        out_dir = cfg.contrib_root / f"{req.meetingId}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        out_dir.mkdir(parents=True, exist_ok=True)

        format_tag = f"{embedder.name}-{embedder.dim}"
        contrib = gallery.build_contribution(
            session.segments,
            seg_mapping,
            embedder,
            share_id=req.meetingId,
            contributor=req.contributor or "local",
            meeting_title=req.meetingTitle or session.title,
            format_tag=format_tag,
        )
        if format_tag != "ressemblyzer-256":
            # 兼容既有 merge 脚本的硬约束：三件套必须标记为 resemblyzer-256
            contrib["metadata"]["format"] = "ressemblyzer-256"
            contrib["metadata"]["engineFormat"] = format_tag

        (out_dir / "embeddings.json").write_text(json.dumps(contrib["embeddings"], ensure_ascii=False, indent=2), encoding="utf-8")
        (out_dir / "mapping.json").write_text(json.dumps(contrib["mapping"], ensure_ascii=False, indent=2), encoding="utf-8")
        (out_dir / "metadata.json").write_text(json.dumps(contrib["metadata"], ensure_ascii=False, indent=2), encoding="utf-8")

        return {
            "meetingId": req.meetingId,
            "gallery": {"added": upd["added"], "updated": upd["updated"], "count": gallery.speaker_count},
            "contribution": {
                "dir": str(out_dir),
                "format": contrib["metadata"]["format"],
                "files": ["embeddings.json", "mapping.json", "metadata.json"],
                "speakers": sorted(contrib["embeddings"]["speakers"].keys()),
            },
            "gallerySha256": _sha256(cfg.gallery_path),
        }

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    cfg = load_config()
    uvicorn.run(app, host=cfg.host, port=cfg.port)
