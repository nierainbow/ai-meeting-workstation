import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { DiscussionRepository } from "../discussions/repository";
import type { StoragePaths } from "../storage/paths";
import { commandSucceeds, spawnCommand, stopProcessTree } from "../process/platformCommand";

export type Type4meUploadResult = {
  transcript: string;
  utteranceCount: number;
  transcriptPath: string;
  /** 落盘的音频绝对路径，文件转写后送声纹 sidecar 时复用（避免重复解码）。 */
  audioPath: string;
};

export type Type4meFileTranscriberConfig = {
  /** Type4Me 自带的 qwen3-asr-server 可执行文件 */
  serverPath?: string;
  /** Qwen3-ASR 模型目录（safetensors） */
  modelPath?: string;
  /** 本机固定端口（Type4Me 官方实例用临时端口，工作台自己拉起可控实例） */
  port?: number;
  /** 热词文件（默认复用 Type4Me 的 hotwords.txt） */
  hotwordsFile?: string;
  /** 单次转写超时（含长录音） */
  timeoutMs?: number;
  /** 首次拉起 server 等模型加载完成的超时 */
  startupTimeoutMs?: number;
  /** ffmpeg 路径（可用则优先，解码任意格式；缺失时 macOS 回退 afconvert） */
  ffmpegPath?: string;
  fetch?: typeof fetch;
};

export const TYPE4ME_DEFAULTS = {
  serverPath: "/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server",
  modelPath: "/Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR",
  port: 8791,
  hotwordsFile: join(homedir(), "Library", "Application Support", "Type4Me", "hotwords.txt"),
  timeoutMs: 30 * 60 * 1000,
  startupTimeoutMs: 120_000,
  ffmpegPath: "ffmpeg"
} as const;

const SAMPLE_RATE = 16000;

/**
 * 复用本机 Type4Me 的 Qwen3-ASR 引擎做录音文件转写：
 * 1. 探活 http://127.0.0.1:<port>/health，没起就用 Type4Me 自带二进制拉起固定端口实例；
 * 2. 用 ffmpeg（或 macOS afconvert）把任意音频解码成 PCM16-LE / 16kHz / 单声道；
 * 3. POST /transcribe 原始 PCM，拿回 {"text": "..."}。
 * 全程只访问 127.0.0.1，不出网。
 */
export class Type4MeFileTranscriber {
  private readonly serverPath: string;
  private readonly modelPath: string;
  private readonly port: number;
  private readonly hotwordsFile?: string;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly ffmpegPath: string;
  private readonly request: typeof fetch;
  private serverProcess: ChildProcess | null = null;
  private ffmpegAvailable: boolean | null = null;

  constructor(
    private readonly deps: {
      repository: DiscussionRepository;
      storagePaths: StoragePaths;
    },
    config: Type4meFileTranscriberConfig = {}
  ) {
    this.serverPath = config.serverPath ?? TYPE4ME_DEFAULTS.serverPath;
    this.modelPath = config.modelPath ?? TYPE4ME_DEFAULTS.modelPath;
    this.port = config.port ?? TYPE4ME_DEFAULTS.port;
    this.hotwordsFile = config.hotwordsFile;
    this.timeoutMs = config.timeoutMs ?? TYPE4ME_DEFAULTS.timeoutMs;
    this.startupTimeoutMs = config.startupTimeoutMs ?? TYPE4ME_DEFAULTS.startupTimeoutMs;
    this.ffmpegPath = config.ffmpegPath ?? TYPE4ME_DEFAULTS.ffmpegPath;
    this.request = config.fetch ?? fetch;
  }

  async transcribeUpload(input: { discussionId: string; filename: string; audio: Buffer }): Promise<Type4meUploadResult> {
    if (!existsSync(this.serverPath)) {
      throw new Error(`未找到 Type4Me 的 qwen3-asr-server：${this.serverPath}。请确认已安装 Type4Me，或用 TYPE4ME_ASR_SERVER_PATH 指定路径。`);
    }
    if (!existsSync(this.modelPath)) {
      throw new Error(`未找到 Qwen3-ASR 模型目录：${this.modelPath}。请确认 Type4Me 已下载本地引擎，或用 TYPE4ME_ASR_MODEL_PATH 指定路径。`);
    }
    if (this.hotwordsFile && !existsSync(this.hotwordsFile)) {
      throw new Error(`Type4Me 热词文件不存在：${this.hotwordsFile}`);
    }

    const discussionDir = join(this.deps.storagePaths.discussionsDir, input.discussionId);
    const uploadDir = join(discussionDir, "uploads", `${Date.now()}-${safeFilename(input.filename)}`);
    const outputDir = join(uploadDir, "type4me-output");
    mkdirSync(outputDir, { recursive: true });
    const audioPath = join(uploadDir, safeFilename(input.filename));
    await writeFile(audioPath, input.audio);

    try {
      await this.ensureServer();
      const pcm = await this.decodeToPcm16kMono(audioPath, extensionOf(input.filename));
      const transcript = await this.transcribePcm(pcm);

      const transcriptPath = join(outputDir, "transcript.txt");
      await writeFile(transcriptPath, transcript, "utf8");
      const utteranceCount = this.writeUtterances(input.discussionId, transcript);

      this.deps.repository.createAudioAsset({
        discussionId: input.discussionId,
        path: audioPath,
        format: extensionOf(input.filename) || "audio",
        source: "browser"
      });

      return { transcript, utteranceCount, transcriptPath, audioPath };
    } finally {
      /* 临时解码文件在 runAfconvert 内自行清理；ffmpeg 直接输出到内存管道 */
    }
  }

  /** 探活；没起就用 Type4Me 自带二进制在本机固定端口拉一个实例。 */
  private async ensureServer(): Promise<void> {
    if (await this.healthOk()) return;

    if (!this.serverProcess || this.serverProcess.exitCode !== null) {
      const args = ["--model-path", this.modelPath, "--port", String(this.port)];
      if (this.hotwordsFile && existsSync(this.hotwordsFile)) {
        args.push("--hotwords-file", this.hotwordsFile);
      }
      const child = spawnCommand(this.serverPath, args, { stdio: "ignore" });
      this.serverProcess = child;
      child.on("error", () => {
        /* 启动失败由下方 health 轮询统一兜底报错 */
      });
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      await delay(500);
      if (await this.healthOk()) return;
      if (this.serverProcess && this.serverProcess.exitCode !== null) {
        throw new Error(
          `Type4Me ASR server 启动失败（exit ${this.serverProcess.exitCode}）。请确认 Type4Me 已安装且本地引擎可用：${this.serverPath}`
        );
      }
    }
    stopProcessTree(this.serverProcess);
    this.serverProcess = null;
    throw new Error(`Type4Me ASR server 在 ${Math.round(this.startupTimeoutMs / 1000)} 秒内未就绪（127.0.0.1:${this.port}）。`);
  }

  private async healthOk(): Promise<boolean> {
    try {
      const response = await this.request(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async transcribePcm(pcm: Buffer): Promise<string> {
    if (pcm.byteLength === 0) return "";
    const response = await this.request(`http://127.0.0.1:${this.port}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(pcm),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Type4Me Qwen3-ASR 转写失败（HTTP ${response.status}）：${detail || "无错误详情"}`);
    }
    const data = (await response.json()) as { text?: string };
    return String(data.text ?? "").trim();
  }

  private async decodeToPcm16kMono(audioPath: string, extension: string): Promise<Buffer> {
    if (this.hasFfmpeg()) return this.runFfmpeg(audioPath);
    if (process.platform === "darwin") return this.runAfconvert(audioPath, extension);
    throw new Error("Type4Me 转写需要 ffmpeg 解码音频；请安装 ffmpeg 或改用 macOS（afconvert 兜底）。");
  }

  private hasFfmpeg(): boolean {
    if (this.ffmpegAvailable === null) {
      this.ffmpegAvailable = commandSucceeds(this.ffmpegPath, ["-version"]);
    }
    return this.ffmpegAvailable;
  }

  private runFfmpeg(inputPath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawnCommand(
        this.ffmpegPath,
        ["-v", "error", "-y", "-i", inputPath, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
          return;
        }
        reject(new Error(`ffmpeg 解码音频失败（exit ${code}）：${stderr.trim() || "无错误输出"}`));
      });
    });
  }

  private async runAfconvert(inputPath: string, extension: string): Promise<Buffer> {
    const workDir = join(tmpdir(), `type4me-afconvert-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const outputPath = join(workDir, `out.${extension || "wav"}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawnCommand(
          "afconvert",
          ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", inputPath, outputPath],
          { stdio: "ignore" }
        );
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`afconvert 解码音频失败（exit ${code}）。该格式不受 macOS 支持时可安装 ffmpeg 后重试。`));
        });
      });
      return extractPcmFromWav(await readFile(outputPath));
    } finally {
      await cleanupTemp(workDir);
    }
  }

  private writeUtterances(discussionId: string, transcript: string): number {
    const lines = transcript
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      this.deps.repository.addUtterance({
        discussionId,
        speakerLabel: "speaker_0",
        text: line,
        isFinal: true,
        source: "type4me"
      });
    }
    return lines.length;
  }
}

/** 从 WAV（RIFF）里剥出 data 块的原始 PCM 字节。 */
export function extractPcmFromWav(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("afconvert 输出不是合法的 WAV 文件。");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const end = Math.min(offset + 8 + chunkSize, wav.length);
      return wav.subarray(offset + 8, end);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error("WAV 文件缺少 data 块，无法提取 PCM。");
}

function extensionOf(filename: string): string {
  const match = basename(filename).match(/\.([A-Za-z0-9]{1,5})$/);
  return match ? match[1].toLowerCase() : "wav";
}

function safeFilename(value: string): string {
  return basename(value || "upload.wav").replace(/[^0-9A-Za-z\u4e00-\u9fa5_.-]+/g, "-").slice(0, 120) || "upload.wav";
}

async function cleanupTemp(path: string): Promise<void> {
  await rm(path).catch(() => undefined);
}

function rm(path: string): Promise<void> {
  return unlink(path).then(
    () => undefined,
    () => undefined
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
