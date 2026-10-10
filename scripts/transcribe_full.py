#!/usr/bin/env python3
"""元宝级 ASR 管线：降噪 + SenseVoice VAD + Qwen3-ASR 校准。

管线：
  1. ffmpeg afftdn 降噪 + 16kHz 单声道转码
  2. Silero VAD 切分语音段
  3. SenseVoice int8 快速转写（第一遍，定位用）
  4. Qwen3-ASR server 逐段校准（第二遍，高精度）
  5. 输出 speaker_segments.json（格式与 FunASR/Sherpa 兼容）

Usage:
  python scripts/transcribe_full.py --input a.m4a --output-dir ./out
      [--no-calibrate]   # 跳过 Qwen3-ASR 校准，只用 SenseVoice
      [--no-denoise]     # 跳过低降噪
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
import wave
import os
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--no-calibrate", action="store_true", help="跳过 Qwen3-ASR 校准")
    p.add_argument("--no-denoise", action="store_true", help="跳过低降噪")
    p.add_argument("--qwen-port", type=int, default=18791)
    p.add_argument("--num-threads", type=int, default=4)
    return p.parse_args()


def ffmpeg_preprocess(input_path: str, out_wav: str, denoise: bool):
    """ffmpeg 降噪 + 16kHz 单声道"""
    if denoise:
        # afftdn = FFT 自适应降噪，比 afftdn_rnnoise 轻量
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-af", "afftdn=nf=-25,dynaudnorm=f=150",
            "-ar", "16000", "-ac", "1",
            out_wav,
        ]
    else:
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-ar", "16000", "-ac", "1",
            out_wav,
        ]
    subprocess.run(cmd, check=True, capture_output=True)


def start_qwen_server(port: int) -> subprocess.Popen:
    """启动 Qwen3-ASR server"""
    server_bin = "/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server"
    model_dir = "/Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR"
    hotwords = os.path.join(os.path.dirname(__file__), "..", "config", "hotwords", "jiesi.txt")

    # 注意：不传 --hotwords-file，这个版本的 Qwen3-ASR server 在静音/短段时
    # 会把整个热词列表当成输出"念"出来（实测 bug）。热词交给后续 proofread 词表处理。
    cmd = [server_bin, "--model-path", model_dir, "--port", str(port)]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # 等待健康
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                if r.status == 200:
                    return proc
        except Exception:
            time.sleep(1)
    raise RuntimeError("Qwen3-ASR server 启动超时")


def qwen_transcribe(port: int, pcm_bytes: bytes) -> str:
    """调 Qwen3-ASR /transcribe，输入 raw PCM16-LE"""
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/transcribe",
        data=pcm_bytes,
        headers={"Content-Type": "application/octet-stream"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
        return data.get("text", "").strip()


def main() -> int:
    args = parse_args()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: ffmpeg 预处理
    clean_wav = out_dir / "clean_16k.wav"
    print(f"[1/4] ffmpeg 预处理（降噪={not args.no_denoise}）...", flush=True)
    ffmpeg_preprocess(args.input, str(clean_wav), denoise=not args.no_denoise)

    # Step 2: SenseVoice + VAD
    print("[2/4] SenseVoice VAD + 快速转写...", flush=True)
    import numpy as np
    import sherpa_onnx
    import soundfile as sf

    model_dir = Path(os.path.expanduser(
        "~/Library/Application Support/Type4Me/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    ))
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_dir / "model.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        use_itn=True,
        num_threads=args.num_threads,
    )

    audio, sr = sf.read(str(clean_wav), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.silero_vad.model = os.path.expanduser(
        "~/Library/Application Support/Type4Me/models/silero_vad/silero_vad.onnx"
    )
    vad_config.silero_vad.threshold = 0.5
    vad_config.silero_vad.min_speech_duration = 0.25
    vad_config.silero_vad.min_silence_duration = 0.5
    vad_config.sample_rate = 16000
    vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)

    window = 512
    for i in range(0, len(audio) - window, window):
        vad.accept_waveform(audio[i:i+window])
    vad.flush()

    segments = []
    while not vad.empty():
        seg = vad.front
        start_ms = int(seg.start * 1000 / 16000)
        end_ms = int(seg.start * 1000 / 16000 + len(seg.samples) * 1000 / 16000)
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, seg.samples)
        recognizer.decode_stream(stream)
        text = stream.result.text.strip()
        if text:
            segments.append({
                "start": start_ms,
                "end": end_ms,
                "speaker": "spk0",
                "text_sensevoice": text,
                "_samples": seg.samples,
            })
        vad.pop()
    print(f"  VAD 切出 {len(segments)} 段", flush=True)

    # Step 3: Qwen3-ASR 校准
    qwen_proc = None
    if not args.no_calibrate:
        print(f"[3/4] 启动 Qwen3-ASR server (port {args.qwen_port})...", flush=True)
        try:
            qwen_proc = start_qwen_server(args.qwen_port)
            for i, seg in enumerate(segments):
                # float32 -> PCM16-LE
                pcm16 = (np.clip(seg["_samples"], -1, 1) * 32767).astype(np.int16).tobytes()
                try:
                    calibrated = qwen_transcribe(args.qwen_port, pcm16)
                    if calibrated:
                        seg["text"] = calibrated
                    else:
                        seg["text"] = seg["text_sensevoice"]
                except Exception as e:
                    seg["text"] = seg["text_sensevoice"]
                    seg["_calibrate_error"] = str(e)
                if (i + 1) % 20 == 0:
                    print(f"  校准进度 {i+1}/{len(segments)}", flush=True)
            print(f"  Qwen3-ASR 校准完成", flush=True)
        except Exception as e:
            print(f"  Qwen3-ASR 启动失败，回退到 SenseVoice: {e}", flush=True)
            for seg in segments:
                seg["text"] = seg["text_sensevoice"]
    else:
        print("[3/4] 跳过 Qwen3-ASR 校准", flush=True)
        for seg in segments:
            seg["text"] = seg["text_sensevoice"]

    # Step 4: 后处理过滤 Qwen3-ASR 幻觉段
    # 问题：Qwen3-ASR 在静音/短段会"幻觉"出大量专有名词列表
    # 判断：一段文本里包含 >15 个大写缩写/长专有名词 → 回退到 SenseVoice
    import re
    def is_hallucinated(text: str) -> bool:
        # 数大写缩写词（ABC, DBM, CATL 这种）
        acronyms = len(re.findall(r'[A-Z]{2,}', text))
        # 数长专有名词（>6 字的中文词）
        long_words = len(re.findall(r'[\u4e00-\u9fff]{6,}', text))
        return acronyms > 15 or long_words > 10

    filtered_count = 0
    out_segments = []
    for seg in segments:
        final_text = seg["text"]
        if is_hallucinated(final_text):
            # 回退到 SenseVoice 结果
            final_text = seg["text_sensevoice"]
            filtered_count += 1
        out_segments.append({
            "start": seg["start"],
            "end": seg["end"],
            "speaker": seg["speaker"],
            "text": final_text,
        })
    if filtered_count:
        print(f"  过滤了 {filtered_count} 段 Qwen3-ASR 幻觉", flush=True)

    # Step 5: 写出
    print("[4/4] 写出结果...", flush=True)

    transcript = "\n".join(s["text"] for s in out_segments)
    (out_dir / "transcript.txt").write_text(transcript, encoding="utf-8")
    (out_dir / "speaker_segments.json").write_text(
        json.dumps(out_segments, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 对比报告
    sv_chars = sum(len(s["text_sensevoice"]) for s in segments)
    qw_chars = sum(len(s["text"]) for s in out_segments)
    print(json.dumps({
        "segments": len(out_segments),
        "sensevoice_chars": sv_chars,
        "final_chars": qw_chars,
        "calibrated": not args.no_calibrate,
        "denoised": not args.no_denoise,
    }, ensure_ascii=False))

    # 清理
    if qwen_proc:
        qwen_proc.terminate()

    return 0


if __name__ == "__main__":
    sys.exit(main())
