"""声纹 sidecar 配置：env 优先，缺省落到 workstation 约定路径。

与 meeting-agent/config.yaml 的 voiceprint 段保持同口径：
  embedder 'ressemblyzer', threshold 0.65, margin 0.05, max_sec 120,
  min_duration_sec 1.5, cluster_embedder 'eres2net', cluster_threshold 0.40

声纹主库只登记路径 + sha256，pkl 本体永不进 git（见 .gitignore 的 *.pkl）。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# meeting-agent 的 16 人主库（T2.1 首启自举源，只读引用）
MASTER_GALLERY_SOURCE = "meeting-agent/assets/speaker_gallery_master.pkl"


def _default_workstation_root() -> Path:
    # sidecar/voiceprint/config.py -> ai-meeting-workstation 仓库根
    return Path(__file__).resolve().parents[2]


def _resolve_master_gallery(root: Path, env_value: str) -> Path:
    """定位 meeting-agent 的 16 人主库。

    env 覆盖优先；否则按候选位置找：仓库内嵌 / 同级工作区目录 / 上两级工作区目录。
    """
    if env_value.strip():
        return Path(env_value.strip())
    candidates = [
        root / MASTER_GALLERY_SOURCE,
        root.parent / MASTER_GALLERY_SOURCE,
        root.parent.parent / MASTER_GALLERY_SOURCE,
    ]
    for cand in candidates:
        if cand.exists():
            return cand
    return candidates[0]


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class SidecarConfig:
    host: str
    port: int
    data_dir: Path
    gallery_path: Path
    contrib_root: Path
    master_gallery_source: Path

    # 匹配主库（Resemblyzer-256）
    embedder: str
    threshold: float
    margin: float
    max_sec: int
    min_duration_sec: float

    # 聚类（diarization，ERes2NetV2-192）
    cluster_embedder: str
    cluster_threshold: float

    # 模型缓存：模型权重走 ModelScope，复用 ~/.cache/modelscope
    modelscope_cache: Path

    @property
    def voiceprint_dir(self) -> Path:
        return self.gallery_path.parent


def load_config(env: dict | None = None) -> SidecarConfig:
    env = dict(os.environ if env is None else env)
    root = _default_workstation_root()
    data_dir = Path(env.get("VOICEPRINT_DATA_DIR", "").strip() or (root / ".local-data"))

    gallery_path = Path(
        env.get("VOICEPRINT_GALLERY", "").strip() or (data_dir / "voiceprint" / "gallery.pkl")
    )
    contrib_root = Path(
        env.get("VOICEPRINT_CONTRIB_ROOT", "").strip() or (data_dir / "voiceprint" / "contrib")
    )
    master_source = _resolve_master_gallery(root, env.get("VOICEPRINT_MASTER_GALLERY", ""))

    cache = env.get("MODELSCOPE_CACHE", "").strip()
    modelscope_cache = Path(cache) if cache else Path.home() / ".cache" / "modelscope"

    return SidecarConfig(
        host=env.get("VOICEPRINT_HOST", "127.0.0.1"),
        port=int(env.get("VOICEPRINT_PORT", "8792")),
        data_dir=data_dir,
        gallery_path=gallery_path,
        contrib_root=contrib_root,
        master_gallery_source=master_source,
        embedder=env.get("VOICEPRINT_EMBEDDER", "ressemblyzer"),
        threshold=_float_env("VOICEPRINT_THRESHOLD", 0.65),
        margin=_float_env("VOICEPRINT_MARGIN", 0.05),
        max_sec=int(_float_env("VOICEPRINT_MAX_SEC", 120)),
        min_duration_sec=_float_env("VOICEPRINT_MIN_DURATION_SEC", 1.5),
        cluster_embedder=env.get("VOICEPRINT_CLUSTER_EMBEDDER", "eres2net"),
        cluster_threshold=_float_env("VOICEPRINT_CLUSTER_THRESHOLD", 0.40),
        modelscope_cache=modelscope_cache,
    )
