#!/usr/bin/env python3
"""Transcribe audio via the Type4Me Qwen3-ASR server (HTTP).

Design (reverse-engineered from Type4Me):
  - qwen3-asr-server is a standalone FastAPI binary shipped inside Type4Me.app
  - Model lives at /Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR
  - We spawn it ourselves on a FIXED port (18791) so our app does not depend on
    whether Type4Me.app is running.
  - API: POST /transcribe  with raw PCM16-LE bytes  ->  {"text": "..."}
  - Health: GET /health -> {"status":"ok","model_loaded":true}

Usage:
  python scripts/transcribe_qwen_asr.py --input a.wav --output-dir ./out
      [--server-binary /Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server]
      [--model-dir /Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR]
      [--port 18791] [--hotwords-file config/hotwords/jiesi.txt]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

DEFAULT_SERVER = "/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server"
DEFAULT_MODEL = "/Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--server-binary", default=DEFAULT_SERVER)
    p.add_argument("--model-dir", default=DEFAULT_MODEL)
    p.add_argument("--hotwords-file", default="config/hotwords/jiesi.txt")
    p.add_argument("--port", type=int, default=18791)
    p.add_argument("--timeout", type=int, default=300, help="Max seconds for one transcription")
    return p.parse_args()


def wait_health(port: int, timeout: int = 60) -> bool:
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                data = json.loads(resp.read())
                if data.get("model_loaded"):
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def to_pcm16_16k(input_path: str) -> bytes:
    """Convert any audio file to 16kHz mono PCM16 bytes via ffmpeg."""
    import subprocess as sp

    proc = sp.run(
        ["ffmpeg", "-y", "-i", input_path, "-f", "s16le", "-acodec", "pcm_s16le",
         "-ar", "16000", "-ac", "1", "-"],
        capture_output=True, check=True,
    )
    return proc.stdout


def transcribe(pcm: bytes, port: int, timeout: int) -> str:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/transcribe",
        data=pcm,
        headers={"Content-Type": "application/octet-stream"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
        return data.get("text", "")


def main() -> int:
    args = parse_args()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    server_bin = Path(args.server_binary)
    model_dir = Path(args.model_dir)
    if not server_bin.exists():
        print(f"ERROR: qwen3-asr-server binary not found: {server_bin}", file=sys.stderr)
        return 1
    if not model_dir.exists():
        print(f"ERROR: Qwen3-ASR model not found: {model_dir}", file=sys.stderr)
        return 1

    # Check if server already running on our port
    already_running = False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/health", timeout=2) as resp:
            already_running = json.loads(resp.read()).get("model_loaded", False)
    except Exception:
        pass

    proc = None
    if not already_running:
        cmd = [
            str(server_bin),
            "--model-path", str(model_dir),
            "--port", str(args.port),
        ]
        hw = Path(args.hotwords_file)
        if hw.exists():
            cmd += ["--hotwords-file", str(hw)]
        print(f"Starting qwen3-asr-server: {' '.join(cmd)}", file=sys.stderr)
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_health(args.port, timeout=120):
            print("ERROR: qwen3-asr-server failed to become healthy", file=sys.stderr)
            proc.kill()
            return 1

    try:
        pcm = to_pcm16_16k(args.input)
        text = transcribe(pcm, args.port, args.timeout)
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()

    (out_dir / "transcript.txt").write_text(text, encoding="utf-8")
    # No speaker diarization from Qwen3-ASR; emit a single-segment placeholder
    (out_dir / "speaker_segments.json").write_text(
        json.dumps([{"start": 0, "end": 0, "speaker": "spk0", "text": text}], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"chars": len(text), "engine": "qwen3-asr"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
