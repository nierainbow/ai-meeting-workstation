#!/usr/bin/env python3
"""声纹 sidecar 入口：

    ./sidecar/voiceprint/server.py

等价于 python -m uvicorn sidecar.voiceprint.app:app --port 8792。
解释器由调用方指定（VOICEPRINT_PYTHON_PATH / .venv/bin/python / python3）。
"""
import os
import sys
from pathlib import Path

# 允许以脚本方式直接运行：把仓库根加入 sys.path，使 `sidecar.voiceprint` 可导入
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import uvicorn  # noqa: E402

from sidecar.voiceprint.config import load_config  # noqa: E402


def main() -> None:
    cfg = load_config()
    # 模型权重走 ModelScope，确保 funasr/modelscope 读到同一份缓存
    os.environ.setdefault("MODELSCOPE_CACHE", str(cfg.modelscope_cache))
    uvicorn.run(
        "sidecar.voiceprint.app:app",
        host=cfg.host,
        port=cfg.port,
        log_level=os.environ.get("VOICEPRINT_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
