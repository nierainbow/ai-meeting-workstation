#!/usr/bin/env python3
"""Generate jiesi hotwords + proofread dictionary from the canonical reference table.

Single source of truth: 杰思集团名称校对参考表.md
(The same table that powers Type4Me hotwords via update_type4me_hotwords.py.)

Outputs:
  config/hotwords/jiesi.txt     -- one term per line, fed to sherpa-onnx / Qwen3-ASR
  config/proofread/jiesi.json   -- {"错误词": {"correct": "正确词", "kind": "person|company|term"}}

Usage:
  python scripts/build_jiesi_config.py \
      [--source /Volumes/RainData/WorkDocs/jiesi-work-document/00.系统/工作系统/references/杰思集团名称校对参考表.md]
      [--config-dir config]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Reuse the extraction logic from the workspace sync script
WORKSPACE_SCRIPTS = "/Volumes/RainData/WorkDocs/jiesi-work-document/00.系统/工作系统/scripts"
if WORKSPACE_SCRIPTS not in sys.path:
    sys.path.insert(0, WORKSPACE_SCRIPTS)

DEFAULT_SOURCE = os.path.join(
    "/Volumes/RainData/WorkDocs/jiesi-work-document",
    "00.系统/工作系统/references/杰思集团名称校对参考表.md",
)


def infer_kind(term: str) -> str:
    """Heuristic: guess whether a correct term is a person / company / term."""
    if any(k in term for k in ["公司", "集团", "厂", "分公司", "股份", "有限"]):
        return "company"
    if any(k in term for k in ["系统", "OA", "NC", "MES", "DCS", "BI", "DBM"]):
        return "system"
    if len(term) <= 4 and re.search(r"[一-鿿]", term) and not any(
        c in term for c in "铜箔金锂电材"
    ):
        # short Chinese word, likely a person name (rough heuristic)
        return "person"
    return "term"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--config-dir", default="config")
    args = ap.parse_args()

    source = Path(args.source)
    if not source.exists():
        print(f"ERROR: reference table not found: {source}", file=sys.stderr)
        return 1

    # Import extraction functions from the workspace script
    import update_type4me_hotwords as sync

    hotwords = sync.extract_from_markdown(str(source))
    snippets = sync.extract_snippets(str(source))

    # Write hotwords.txt
    config_dir = Path(args.config_dir)
    hw_dir = config_dir / "hotwords"
    hw_dir.mkdir(parents=True, exist_ok=True)
    (hw_dir / "jiesi.txt").write_text(
        "\n".join(sorted(hotwords)) + "\n", encoding="utf-8"
    )

    # Write proofread/jiesi.json
    pr_dir = config_dir / "proofread"
    pr_dir.mkdir(parents=True, exist_ok=True)
    proofread = {}
    for wrong, correct in sorted(snippets.items()):
        proofread[wrong] = {
            "correct": correct,
            "kind": infer_kind(correct),
            "source": "杰思集团名称校对参考表",
        }
    (pr_dir / "jiesi.json").write_text(
        json.dumps(proofread, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(json.dumps({
        "hotwords": len(hotwords),
        "proofread_rules": len(proofread),
        "hotwords_file": str(hw_dir / "jiesi.txt"),
        "proofread_file": str(pr_dir / "jiesi.json"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
