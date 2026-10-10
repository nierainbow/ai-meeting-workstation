#!/usr/bin/env python3
"""
声纹聚类：对 VAD 切出的每段音频提取 embedding，聚类得到 speaker labels。
两阶段交付：
  阶段一（自动）：推断 spk0/spk1/spk2...，立即出纪要
  阶段二（人工）：用户在前端确认姓名后，存入库下次直接匹配

用法：
  python scripts/diarize_speakers.py --wav /path/to/clean.wav --segments /path/to/speaker_segments.json
  输出：更新 speaker_segments.json 里的 speaker 字段
"""
import argparse
import json
import numpy as np
from pathlib import Path

def cosine_distance(a, b):
    return 1 - np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True, help="干净的 16kHz mono wav 文件")
    ap.add_argument("--segments", required=True, help="speaker_segments.json 路径")
    ap.add_argument("--threshold", type=float, default=0.7, help="聚类阈值，越大越容易合并")
    ap.add_argument("--min-segments", type=int, default=3, help="少于这个段数的 speaker 合并到最近的")
    args = ap.parse_args()

    from resemblyzer import VoiceEncoder, preprocess_wav
    encoder = VoiceEncoder()

    segs = json.loads(Path(args.segments).read_text())
    print(f"加载 {len(segs)} 段，提取声纹 embedding...")

    wav = preprocess_wav(args.wav)
    embeddings = []
    for i, s in enumerate(segs):
        start = s["start"] / 1000.0
        end = s["end"] / 1000.0
        seg_wav = wav[int(start * 16000):int(end * 16000)]
        if len(seg_wav) < 1600:  # 少于 0.1 秒不提取
            embeddings.append(None)
            continue
        emb = encoder.embed_utterance(seg_wav)
        embeddings.append(emb)
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(segs)}")

    # 聚类：贪心，第一段作为 spk0
    speaker_embeddings = []  # 每个 speaker 的平均 embedding
    speaker_counts = []
    for i, emb in enumerate(embeddings):
        if emb is None:
            segs[i]["speaker"] = "spk0"
            continue
        if not speaker_embeddings:
            speaker_embeddings.append(emb)
            speaker_counts.append(1)
            segs[i]["speaker"] = "spk0"
            continue
        # 找最近的 speaker
        distances = [cosine_distance(emb, se) for se in speaker_embeddings]
        best_idx = int(np.argmin(distances))
        best_dist = distances[best_idx]
        if best_dist < args.threshold:
            # 归到这个 speaker，更新平均 embedding
            speaker_counts[best_idx] += 1
            speaker_embeddings[best_idx] = (
                speaker_embeddings[best_idx] * (speaker_counts[best_idx] - 1) + emb
            ) / speaker_counts[best_idx]
            segs[i]["speaker"] = f"spk{best_idx}"
        else:
            # 新建 speaker
            speaker_embeddings.append(emb)
            speaker_counts.append(1)
            segs[i]["speaker"] = f"spk{len(speaker_embeddings)-1}"

    # 合并段数太少的 speaker
    for spk_idx in range(len(speaker_embeddings)):
        if speaker_counts[spk_idx] < args.min_segments:
            # 找最近的其他 speaker
            others = [i for i in range(len(speaker_embeddings)) if i != spk_idx and speaker_counts[i] >= args.min_segments]
            if others:
                best = min(others, key=lambda i: cosine_distance(speaker_embeddings[spk_idx], speaker_embeddings[i]))
                for s in segs:
                    if s["speaker"] == f"spk{spk_idx}":
                        s["speaker"] = f"spk{best}"

    # 统计
    from collections import Counter
    counts = Counter(s["speaker"] for s in segs)
    print(f"聚类完成：{len(counts)} 个 speaker")
    for spk, cnt in sorted(counts.items()):
        print(f"  {spk}: {cnt} 段")

    Path(args.segments).write_text(json.dumps(segs, ensure_ascii=False, indent=2))
    print(f"已更新 {args.segments}")

if __name__ == "__main__":
    main()
