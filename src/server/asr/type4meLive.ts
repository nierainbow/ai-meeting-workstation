import { existsSync } from "node:fs";
import { spawnCommand, stopProcessTree } from "../process/platformCommand";
import type { ChildProcess } from "node:child_process";
import type { AsrProvider, AsrProviderStartInput, TranscriptCandidate } from "./asrProvider";

export type Type4meLiveConfig = {
  serverPath?: string;
  modelPath?: string;
  port?: number;
  hotwordsFile?: string;
  startupTimeoutMs?: number;
  /** 单段转写超时 */
  transcribeTimeoutMs?: number;
  /** 最长分段时长（毫秒），到点强制转写 */
  maxSegmentMs?: number;
  /** 静音多久后判定一句话结束（毫秒） */
  silenceMs?: number;
  /** 判定"有人说话"的 RMS 阈值（int16 振幅） */
  rmsThreshold?: number;
  fetch?: typeof fetch;
};

export const TYPE4ME_LIVE_DEFAULTS = {
  serverPath: "/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server",
  modelPath: "/Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR",
  port: 8791,
  startupTimeoutMs: 120_000,
  transcribeTimeoutMs: 60_000,
  maxSegmentMs: 8_000,
  silenceMs: 700,
  rmsThreshold: 120
} as const;

const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // PCM16 mono: 32 bytes/ms

/** 模块级单例：多个实时会话共用同一个 8791 实例，不重复拉起。 */
let sharedServerProcess: ChildProcess | null = null;

async function healthOk(port: number, request: typeof fetch): Promise<boolean> {
  try {
    const response = await request(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 探活 127.0.0.1:<port>；没起就用 Type4Me 自带二进制拉一个固定端口实例并等模型加载。 */
export async function ensureType4meServer(config: {
  serverPath: string;
  modelPath: string;
  port: number;
  hotwordsFile?: string;
  startupTimeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<void> {
  const request = config.fetch ?? fetch;
  const startupTimeoutMs = config.startupTimeoutMs ?? TYPE4ME_LIVE_DEFAULTS.startupTimeoutMs;
  if (await healthOk(config.port, request)) return;

  if (!sharedServerProcess || sharedServerProcess.exitCode !== null) {
    const args = ["--model-path", config.modelPath, "--port", String(config.port)];
    if (config.hotwordsFile && existsSync(config.hotwordsFile)) {
      args.push("--hotwords-file", config.hotwordsFile);
    }
    sharedServerProcess = spawnCommand(config.serverPath, args, { stdio: "ignore" });
    sharedServerProcess.on("error", () => {
      /* 启动失败由下方 health 轮询统一兜底报错 */
    });
  }

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    if (await healthOk(config.port, request)) return;
    if (sharedServerProcess && sharedServerProcess.exitCode !== null) {
      throw new Error(
        `Type4Me ASR server 启动失败（exit ${sharedServerProcess.exitCode}）。请确认 Type4Me 已安装且本地引擎可用：${config.serverPath}`
      );
    }
  }
  stopProcessTree(sharedServerProcess);
  sharedServerProcess = null;
  throw new Error(`Type4Me ASR server 在 ${Math.round(startupTimeoutMs / 1000)} 秒内未就绪（127.0.0.1:${config.port}）。`);
}

export type LiveSegment = {
  pcm: Buffer;
  startMs: number;
  endMs: number;
  reason: "silence" | "max_length";
};

/**
 * 把 16kHz/mono/PCM16 麦克风流切成适合 /transcribe 的段：
 * - 检测到语音后，静音超过 silenceMs 即断句；
 * - 单段最长 maxSegmentMs 强制断句；
 * - 长时间纯静音直接丢弃，避免堆积。
 */
export class LivePcmSegmenter {
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private seenSpeech = false;
  private trailingSilenceBytes = 0;
  private consumedMs = 0;

  readonly maxSegmentBytes: number;
  readonly silenceBytes: number;

  constructor(
    private readonly options: {
      maxSegmentMs?: number;
      silenceMs?: number;
      rmsThreshold?: number;
    } = {}
  ) {
    this.maxSegmentBytes = msToBytes(options.maxSegmentMs ?? TYPE4ME_LIVE_DEFAULTS.maxSegmentMs);
    this.silenceBytes = msToBytes(options.silenceMs ?? TYPE4ME_LIVE_DEFAULTS.silenceMs);
  }

  get bufferedMs(): number {
    return Math.round(this.bufferedBytes / BYTES_PER_MS);
  }

  /** 喂入一段 PCM；返回需要立即转写的段（若有）。 */
  push(chunk: Buffer): LiveSegment | null {
    if (chunk.byteLength === 0) return null;

    this.buffer.push(chunk);
    this.bufferedBytes += chunk.byteLength;

    if (isSpeech(chunk, this.options.rmsThreshold ?? TYPE4ME_LIVE_DEFAULTS.rmsThreshold)) {
      this.seenSpeech = true;
      this.trailingSilenceBytes = 0;
    } else if (this.seenSpeech) {
      this.trailingSilenceBytes += chunk.byteLength;
    }

    if (!this.seenSpeech) {
      // 纯静音：只保留最近 1 秒，防止连接刚建立时的空白堆积
      if (this.bufferedBytes > BYTES_PER_MS * 1000) {
        const dropped = this.bufferedBytes - BYTES_PER_MS * 1000;
        this.consumeBytes(dropped);
      }
      return null;
    }

    if (this.trailingSilenceBytes >= this.silenceBytes) {
      return this.takeSegment("silence");
    }
    if (this.bufferedBytes >= this.maxSegmentBytes) {
      return this.takeSegment("max_length");
    }
    return null;
  }

  /** 会话结束时把剩余音频作为最后一段取出（可能为 null）。 */
  flushRemaining(): LiveSegment | null {
    if (!this.seenSpeech || this.bufferedBytes === 0) return null;
    return this.takeSegment("silence");
  }

  private takeSegment(reason: LiveSegment["reason"]): LiveSegment {
    const pcm = Buffer.concat(this.buffer);
    const startMs = this.consumedMs;
    const endMs = startMs + Math.round(pcm.byteLength / BYTES_PER_MS);
    this.buffer = [];
    this.bufferedBytes = 0;
    this.seenSpeech = false;
    this.trailingSilenceBytes = 0;
    this.consumedMs = endMs;
    return { pcm, startMs, endMs, reason };
  }

  private consumeBytes(count: number): void {
    let remaining = count;
    while (remaining > 0 && this.buffer.length > 0) {
      const head = this.buffer[0];
      if (head.byteLength <= remaining) {
        remaining -= head.byteLength;
        this.buffer.shift();
      } else {
        this.buffer[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    this.bufferedBytes -= count - remaining;
    this.consumedMs += Math.round((count - remaining) / BYTES_PER_MS);
  }
}

function isSpeech(chunk: Buffer, rmsThreshold: number): boolean {
  let sumSquares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < chunk.byteLength; offset += 2) {
    const sample = chunk.readInt16LE(offset);
    sumSquares += sample * sample;
    samples += 1;
  }
  if (samples === 0) return false;
  const rms = Math.sqrt(sumSquares / samples);
  return rms >= rmsThreshold;
}

function msToBytes(ms: number): number {
  return Math.round(ms * BYTES_PER_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 实时会议的 Type4Me ASR：浏览器 ws 已推送 16kHz/mono/PCM16（App.tsx float32ToPcm16
 * 下采样），直接按静音/最大时长分段，逐段 POST 本机 qwen3-asr-server /transcribe，
 * 每段产出一条 final utterance。全程只访问 127.0.0.1，不出网、不需要任何 API Key。
 */
export class Type4meAsrProvider implements AsrProvider {
  private readonly serverPath: string;
  private readonly modelPath: string;
  private readonly port: number;
  private readonly hotwordsFile?: string;
  private readonly startupTimeoutMs: number;
  private readonly transcribeTimeoutMs: number;
  readonly segmenterOptions: { maxSegmentMs: number; silenceMs: number; rmsThreshold: number };  private readonly request: typeof fetch;

  constructor(config: Type4meLiveConfig = {}) {
    this.serverPath = config.serverPath ?? TYPE4ME_LIVE_DEFAULTS.serverPath;
    this.modelPath = config.modelPath ?? TYPE4ME_LIVE_DEFAULTS.modelPath;
    this.port = config.port ?? TYPE4ME_LIVE_DEFAULTS.port;
    this.hotwordsFile = config.hotwordsFile;
    this.startupTimeoutMs = config.startupTimeoutMs ?? TYPE4ME_LIVE_DEFAULTS.startupTimeoutMs;
    this.transcribeTimeoutMs = config.transcribeTimeoutMs ?? TYPE4ME_LIVE_DEFAULTS.transcribeTimeoutMs;
    this.segmenterOptions = {
      maxSegmentMs: config.maxSegmentMs ?? TYPE4ME_LIVE_DEFAULTS.maxSegmentMs,
      silenceMs: config.silenceMs ?? TYPE4ME_LIVE_DEFAULTS.silenceMs,
      rmsThreshold: config.rmsThreshold ?? TYPE4ME_LIVE_DEFAULTS.rmsThreshold
    };
    this.request = config.fetch ?? fetch;
  }

  checkCredentials(): ReturnType<AsrProvider["checkCredentials"]> {
    const missing: string[] = [];
    if (!existsSync(this.serverPath)) missing.push(`Type4Me qwen3-asr-server：${this.serverPath}`);
    if (!existsSync(this.modelPath)) missing.push(`Qwen3-ASR 模型目录：${this.modelPath}`);
    if (missing.length > 0) {
      return {
        ok: false,
        message: `本机 Type4Me 实时引擎未就绪，缺少：${missing.join("；")}。请确认 Type4Me 已安装并下载本地引擎。`
      };
    }
    return { ok: true };
  }

  async startSession(input: AsrProviderStartInput): Promise<Type4meAsrSession> {
    await ensureType4meServer({
      serverPath: this.serverPath,
      modelPath: this.modelPath,
      port: this.port,
      hotwordsFile: this.hotwordsFile,
      startupTimeoutMs: this.startupTimeoutMs,
      fetch: this.request
    });
    const session = new Type4meAsrSession(this, input);
    return session;
  }

  async transcribePcm(pcm: Buffer): Promise<string> {
    const response = await this.request(`http://127.0.0.1:${this.port}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(pcm),
      signal: AbortSignal.timeout(this.transcribeTimeoutMs)
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Type4Me Qwen3-ASR 转写失败（HTTP ${response.status}）：${detail || "无错误详情"}`);
    }
    const data = (await response.json()) as { text?: string };
    return String(data.text ?? "").trim();
  }
}

export class Type4meAsrSession {
  private readonly segmenter: LivePcmSegmenter;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly provider: Type4meAsrProvider,
    private readonly callbacks: AsrProviderStartInput
  ) {
    this.segmenter = new LivePcmSegmenter(provider.segmenterOptions);
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return;
    const segment = this.segmenter.push(chunk);
    if (segment) this.enqueueTranscribe(segment);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const remaining = this.segmenter.flushRemaining();
    if (remaining) this.enqueueTranscribe(remaining);
    // 关闭后等待队列排空（有上限），确保最后一段转写落库
    void Promise.race([this.queue, delay(30_000)]).catch(() => undefined);
  }

  private enqueueTranscribe(segment: LiveSegment): void {
    this.queue = this.queue
      .then(async () => {
        if (segment.pcm.byteLength === 0) return;
        const text = await this.provider.transcribePcm(segment.pcm);
        if (!text) return;
        this.callbacks.onLog?.({
          direction: "server",
          eventType: "receiving",
          requestId: `type4me-live:${segment.startMs}-${segment.endMs}`,
          payloadSummary: `final ${text.length} chars (${segment.reason})`
        });
        const utterance: TranscriptCandidate = {
          speakerLabel: "speaker_0",
          text,
          startMs: segment.startMs,
          endMs: segment.endMs
        };
        this.callbacks.onFinal(utterance);
      })
      .catch((error: unknown) => {
        this.callbacks.onError(error instanceof Error ? error.message : "Type4Me 实时转写失败。");
      });
  }
}
