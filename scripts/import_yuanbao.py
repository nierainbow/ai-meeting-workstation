#!/usr/bin/env python3
"""Import a Tencent Yuanbao meeting recording into the local pipeline.

Mirrors the SOP v4.1 Step 1-3:
  1. Fetch the share page (handles virtual scroll by reading __NEXT_DATA__)
  2. Parse voiceSentences / voiceMinutes / recorder metadata
  3. Emit transcript.txt + speaker_segments.json + yuanbao_meta.json
     (same layout as transcribe_audio.py / transcribe_sherpa.py output)

Usage:
  python scripts/import_yuanbao.py --url "https://yuanbao.tencent.com/e/rm/xxxx" \
      --output-dir ./out [--cookie "..." ]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True, help="Yuanbao share URL, e.g. https://yuanbao.tencent.com/e/rm/xxxx")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--cookie", default="", help="Browser cookie if the page returns 403")
    return p.parse_args()


def fetch_html(url: str, cookie: str) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_next_data(html: str) -> dict:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        raise RuntimeError("未找到 __NEXT_DATA__，元宝页面结构可能已变更或访问受限")
    return json.loads(m.group(1))


def main() -> int:
    args = parse_args()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    html = fetch_html(args.url, args.cookie)
    data = extract_next_data(html)
    page_props = data.get("props", {}).get("pageProps", {})

    sentences = page_props.get("voiceSentences", [])
    minutes = page_props.get("voiceMinutes", [])
    recorder = page_props.get("recorder", {}) or {}

    if not sentences:
        print(json.dumps({"error": "无 voiceSentences，录音可能仍在处理中或链接失效"}, ensure_ascii=False))
        return 1

    # Group sentences by voiceId into speaker segments (consecutive same speaker)
    segments = []
    cur_speaker = None
    cur_buf: list[dict] = []

    def flush():
        nonlocal cur_buf, cur_speaker
        if not cur_buf:
            return
        text = "".join(s["sourceText"] for s in cur_buf).strip()
        if text:
            segments.append({
                "start": cur_buf[0]["startTime"],
                "end": cur_buf[-1]["startTime"] + 2000,  # rough end
                "speaker": f"spk{cur_speaker}",
                "text": text,
            })
        cur_buf = []

    for s in sentences:
        vid = s.get("voiceId", 0)
        if vid != cur_speaker:
            flush()
            cur_speaker = vid
        cur_buf.append(s)
    flush()

    # Flat transcript
    transcript_text = "\n".join(s["sourceText"] for s in sentences)

    # AI minutes summary (from Yuanbao itself, optional)
    ai_summary = "\n".join(m.get("content", "") for m in minutes if m.get("content"))

    # Metadata
    meta = {
        "source": "yuanbao",
        "url": args.url,
        "title": recorder.get("title", "未命名会议"),
        "durationMs": recorder.get("durationMs", 0),
        "isSplitSpeaker": recorder.get("isSplitSpeaker", False),
        "startTime": recorder.get("startTime", 0),
        "sentenceCount": len(sentences),
        "aiSummary": ai_summary,
    }

    (out_dir / "transcript.txt").write_text(transcript_text, encoding="utf-8")
    (out_dir / "speaker_segments.json").write_text(
        json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "yuanbao_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(json.dumps({
        "title": meta["title"],
        "durationMs": meta["durationMs"],
        "sentences": len(sentences),
        "segments": len(segments),
        "hasAiSummary": bool(ai_summary),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
