#!/usr/bin/env python3
"""T2.7 E2E 回归：workstation 声纹 sidecar 的 Resemblyzer-256 管线对照冻结基线。

两个协议：
1. in-sample（对照基线）：完全复刻 meeting-agent eval/fair_compare.py 的
   full-gallery-match——用 11 场自身标注建库再匹配，唯一替换项是 embedder
   换成 sidecar 的 ResemblyzerEmbedder。目标 overall_top1 >= 0.6939 - 0.005。
2. production（参考指标）：用 16 人主库 pkl 直接匹配（真实使用场景）。
   基线无可比数（主库只有真名，标注里的角色标签不在库中），仅记录。

用法：
  python sidecar/voiceprint/eval_regression.py \
    --eval-dir ../meeting-agent/eval --gallery <master.pkl> [--out <json>]
退出码：in-sample 协议不过线返回 1。
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

import numpy as np

BASELINE_TOP1 = 0.6939  # meeting-agent eval/fair_compare.json Resemblyzer-256
TOLERANCE = 0.005
THRESHOLD = 0.65
MARGIN = 0.08  # 基线协议用的 0.08（注意：线上双条件是 0.05）


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval-dir", required=True)
    parser.add_argument("--gallery", required=True)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    eval_dir = Path(args.eval_dir).resolve()
    sys.path.insert(0, str(eval_dir))
    sys.path.insert(0, str(eval_dir / "_vendor"))
    from yuanbao_voiceprint import load_recording, segments_for_voiceid, SAMPLE_RATE  # noqa: E402
    from voiceprint_shootout import build_gallery, match_recording  # noqa: E402

    sidecar_root = Path(__file__).resolve().parent.parent.parent
    sys.path.insert(0, str(sidecar_root))
    from sidecar.voiceprint.core import Gallery, ResemblyzerEmbedder  # noqa: E402

    jsons = sorted((eval_dir / "meetings_local").rglob("202*-raw-*.json"))
    wav_dir = eval_dir / "loocv_wavs"
    print(f"[t17] 会议数: {len(jsons)}")

    embedder = ResemblyzerEmbedder()  # sidecar 交付件自家嵌入器

    # ── 协议 1：in-sample（对照基线）──
    gal = build_gallery(jsons, wav_dir, embedder, 120)
    all_c = all_t = 0
    per_meeting = []
    for jf in jsons:
        rec = load_recording(str(jf), wav_dir)
        role_by_vid = {str(r.get("voiceId", "")): r.get("nickname", "").strip() for r in rec["role_infos"]}
        annotated = {vid: n for vid, n in role_by_vid.items() if n}
        details = match_recording(str(jf), wav_dir, gal, embedder, THRESHOLD, MARGIN, 120)
        c = t = 0
        for vid, true_name in annotated.items():
            if vid not in details or details[vid]["best_name"] is None:
                continue
            t += 1
            all_t += 1
            if details[vid]["best_name"] == true_name:
                c += 1
                all_c += 1
        per_meeting.append({"meeting": jf.parent.name, "top1": c / t if t else None, "n": t})
        print(f"[t17/in-sample] {jf.parent.name[:12]}… {c}/{t}")
    insample_top1 = all_c / all_t if all_t else 0.0

    # ── 协议 2：production（主库直配，参考指标）──
    master = Gallery(args.gallery)
    names = master.speaker_names
    prod_c = prod_t = 0
    for jf in jsons:
        rec = load_recording(str(jf), wav_dir)
        role_by_vid = {str(r.get("voiceId", "")): r.get("nickname", "").strip() for r in rec["role_infos"]}
        for vid, true_name in {v: n for v, n in role_by_vid.items() if n}.items():
            seg = segments_for_voiceid(rec, vid)
            if len(seg) < SAMPLE_RATE * 0.5:
                continue
            emb = embedder.embed(seg, max_sec=120)
            if emb is None or master._matrix is None:
                continue
            emb_n = emb / (np.linalg.norm(emb) + 1e-8)
            sims = master._matrix @ emb_n
            pred = names[int(np.argmax(sims))]
            prod_t += 1
            if pred == true_name:
                prod_c += 1
    prod_top1 = prod_c / prod_t if prod_t else 0.0
    print(f"[t17/production] {prod_c}/{prod_t} = {prod_top1:.4f}")

    result = {
        "in_sample": {
            "protocol": "fair_compare full-gallery-match, embedder=sidecar ResemblyzerEmbedder",
            "baseline_top1": BASELINE_TOP1,
            "overall_top1": round(insample_top1, 4),
            "overall_top1_n": [all_c, all_t],
            "per_meeting": per_meeting,
            "pass": insample_top1 >= BASELINE_TOP1 - TOLERANCE,
        },
        "production": {
            "protocol": "master-pkl direct match（真实使用场景，仅参考）",
            "overall_top1": round(prod_top1, 4),
            "overall_top1_n": [prod_c, prod_t],
        },
    }
    print(json.dumps(result["in_sample"], ensure_ascii=False, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if result["in_sample"]["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
