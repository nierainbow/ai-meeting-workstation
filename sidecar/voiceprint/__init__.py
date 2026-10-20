"""离线声纹 sidecar（ai-meeting-workstation）。

Responsibilities:
- POST /identify : audio path + utterance ranges -> ERes2NetV2 clustering -> Resemblyzer
  gallery match -> per-segment {clusterId, 疑似姓名|null, score, gap}
- POST /confirm  : stage a human confirmation {clusterId, 姓名}
- GET/POST /gallery : list / rename / merge / delete
- POST /finalize : accumulate confirmed speakers into the gallery and export the
  contribution trio (metadata.format=ressemblyzer-256)
- GET  /health   : interpreter capability report (which embedders are importable)

Design notes (from meeting-agent/app/voiceprint.py, which is now a read-only archive):
- Manual confirmation is a hard requirement: auto Top-1 is 25-70% and auto-confirm
  precision was 66.7% on an independent 16-person gallery, so auto names are only
  ever surfaced as "疑似：姓名？" and never as fact.
- Fragments shorter than min_duration_sec (1.5s) never enter the pending queue.
- The 16-person master gallery is 256-dim Resemblyzer; eres2net-192 is only used
  for clustering (diarization), never for the gallery match.
"""
from .config import SidecarConfig, load_config
from .core import Gallery, cluster_segments, get_embedder

__all__ = ["SidecarConfig", "load_config", "Gallery", "cluster_segments", "get_embedder"]
