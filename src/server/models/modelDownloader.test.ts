import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDownloaderForTest, MODEL_ASSETS, TIER_ASSETS, isAssetInstalled } from "./modelDownloader";
import type { ModelDownloaderHttp, HttpResponse, RequestOptions } from "./modelDownloader";

type RecordedRequest = { url: string; options?: RequestOptions };

/**
 * 假的 https 层：按 url 子串匹配返回响应。
 * 用真正的 Readable 而不是 PassThrough，因为 end 事件要靠可读侧被消费才触发。
 */
function createFakeHttp(handlers: Array<[string, () => HttpResponse]>, recorder: RecordedRequest[]): ModelDownloaderHttp {
  return {
    async request(url: string, options?: RequestOptions): Promise<HttpResponse> {
      recorder.push({ url, options });
      const entry = handlers.find(([needle]) => url.includes(needle));
      if (!entry) throw new Error(`unexpected url: ${url}`);
      return entry[1]();
    }
  };
}

function streamOf(payload: Buffer): Readable {
  return Readable.from(payload.length > 0 ? [payload] : []);
}

function jsonResponse(body: string): HttpResponse {
  const stream = streamOf(Buffer.from(body)) as unknown as HttpResponse;
  stream.statusCode = 200;
  stream.headers = { "content-type": "application/json" };
  stream.destroy = () => undefined;
  return stream;
}

function binaryResponse(payload: Buffer, contentRange?: string): HttpResponse {
  const stream = streamOf(payload) as unknown as HttpResponse;
  stream.statusCode = 200;
  stream.headers = contentRange ? { "content-range": contentRange } : {};
  stream.destroy = () => undefined;
  return stream;
}

function errorResponse(status: number): HttpResponse {
  const stream = streamOf(Buffer.alloc(0)) as unknown as HttpResponse;
  stream.statusCode = status;
  stream.headers = {};
  stream.destroy = () => undefined;
  return stream;
}

/** 永远不产出数据也不结束的响应，用来挂住下载流程以便取消。 */
function hangingResponse(onCreated: (stream: HttpResponse) => void): HttpResponse {
  const stream = new Readable({ read() {} }) as unknown as HttpResponse;
  stream.statusCode = 200;
  stream.headers = {};
  stream.destroy = () => undefined;
  onCreated(stream);
  return stream;
}

function filesResponse(files: Array<{ Path: string; Size: number; Type: "blob" | "tree" }>): HttpResponse {
  return jsonResponse(JSON.stringify({ Code: 200, Data: { Files: files } }));
}

const VAD_FILES = [
  { Path: "config.yaml", Size: 5, Type: "blob" as const },
  { Path: "model.pt", Size: 8, Type: "blob" as const }
];

/** 把除 vad 之外的模型都标成已安装，让下载流程只处理 vad。 */
function markOtherAssetsInstalled(cacheDir: string): void {
  for (const asset of MODEL_ASSETS) {
    if (asset.key === "vad") continue;
    const dir = join(cacheDir, "iic", asset.repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "x");
    writeFileSync(join(dir, asset.weight), "x");
  }
}

describe("modelDownloader", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "aimw-models-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("档位与资产清单和 scripts/download_funasr_models.py 保持一致", () => {
    expect(TIER_ASSETS.cloud).toEqual([]);
    expect(TIER_ASSETS["local-transcribe"]).toEqual(["asr", "vad", "punc", "timestamp"]);
    expect(TIER_ASSETS.offline).toEqual(["asr", "vad", "punc", "timestamp", "speaker"]);
    expect(MODEL_ASSETS.map((asset) => asset.key)).toEqual(["asr", "vad", "punc", "timestamp", "speaker"]);
    for (const asset of MODEL_ASSETS) {
      expect(asset.extraFiles).toContain("config.yaml");
      expect(asset.extraFiles).not.toContain(asset.weight);
    }
  });

  it("跳过 README 等样板文件，只抓模型运行必需的文件", async () => {
    const recorder: RecordedRequest[] = [];
    const files = [
      ...VAD_FILES,
      { Path: "README.md", Size: 999, Type: "blob" as const },
      { Path: ".gitattributes", Size: 999, Type: "blob" as const },
      { Path: "configuration.json", Size: 999, Type: "blob" as const },
      { Path: "example/vad_example.wav", Size: 999, Type: "blob" as const },
      { Path: "fig/struct.png", Size: 999, Type: "blob" as const },
      { Path: "fig", Size: 0, Type: "tree" as const }
    ];
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(files)],
      ["FilePath=config.yaml", () => binaryResponse(Buffer.from("cfg11"))],
      ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
    ];
    markOtherAssetsInstalled(cacheDir);
    const downloader = createDownloaderForTest(createFakeHttp(handlers, recorder), { cacheDir, fileTimeoutMs: 1000 });
    await downloader.start("local-transcribe");

    const requested = recorder.filter((item) => item.url.includes("FilePath=")).map((item) => item.url);
    expect(requested.length).toBe(2);
    for (const url of requested) {
      expect(url).not.toContain("README.md");
      expect(url).not.toContain(".gitattributes");
      expect(url).not.toContain("configuration.json");
      expect(url).not.toContain("example%2F");
      expect(url).not.toContain("fig%2F");
    }
    expect(isAssetInstalled(cacheDir, "vad")).toBe(true);
  });

  it("下载完成后把文件从临时目录搬进正式缓存目录", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    const recorder: RecordedRequest[] = [];
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      ["FilePath=config.yaml", () => binaryResponse(Buffer.from("cfg11"))],
      ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
    ];
    markOtherAssetsInstalled(cacheDir);
    const downloader = createDownloaderForTest(createFakeHttp(handlers, recorder), { cacheDir, fileTimeoutMs: 1000 });
    await downloader.start("local-transcribe");

    const finalDir = join(cacheDir, "iic", vad.repo);
    expect(readFileSync(join(finalDir, "config.yaml"), "utf8")).toBe("cfg11");
    expect(readFileSync(join(finalDir, "model.pt"), "utf8")).toBe("weights!");
    expect(isAssetInstalled(cacheDir, "vad")).toBe(true);
    expect(existsSync(join(cacheDir, "._____temp", "iic", vad.repo))).toBe(false);
    expect(downloader.status().running).toBe(false);
    expect(downloader.status().error).toBeUndefined();
  });

  it("临时目录已有部分文件时发送 Range 头续传", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    const tempDir = join(cacheDir, "._____temp", "iic", vad.repo);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "config.yaml"), Buffer.from("cfg"));

    const recorder: RecordedRequest[] = [];
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      ["FilePath=config.yaml", () => binaryResponse(Buffer.from("11"), "bytes 3-4/5")],
      ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
    ];
    markOtherAssetsInstalled(cacheDir);
    const downloader = createDownloaderForTest(createFakeHttp(handlers, recorder), { cacheDir, fileTimeoutMs: 1000 });
    await downloader.start("local-transcribe");

    const configRequest = recorder.find((item) => item.url.includes("FilePath=config.yaml"));
    expect(configRequest?.options?.headers?.Range).toBe("bytes=3-");
    expect(readFileSync(join(cacheDir, "iic", vad.repo, "config.yaml"), "utf8")).toBe("cfg11");
  });

  it("取消后正式目录不出现半成品，但临时文件保留可续传", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    const recorder: RecordedRequest[] = [];
    let pending: HttpResponse | null = null;
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      ["FilePath=config.yaml", () => hangingResponse((stream) => { pending = stream; })],
      ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
    ];
    markOtherAssetsInstalled(cacheDir);
    const downloader = createDownloaderForTest(createFakeHttp(handlers, recorder), { cacheDir, fileTimeoutMs: 1000 });
    const started = downloader.start("local-transcribe");
    await new Promise((resolve) => setTimeout(resolve, 20));
    downloader.cancel();
    await started;

    expect(isAssetInstalled(cacheDir, "vad")).toBe(false);
    expect(existsSync(join(cacheDir, "iic", vad.repo))).toBe(false);
    expect(existsSync(join(cacheDir, "._____temp", "iic", vad.repo))).toBe(true);
    expect(downloader.status().running).toBe(false);
    expect(downloader.status().error).toBeUndefined();
    expect(pending).not.toBeNull();
  });

  /** 断网重连：第一次下载中途流 error，第二次带着 Range 头续传并收尾。 */
  it("下载中途断网后重试，从已落盘的字节续传", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    const recorder: RecordedRequest[] = [];
    let attempts = 0;
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      [
        "FilePath=model.pt",
        () => {
          attempts += 1;
          if (attempts === 1) {
            // 第一次：只吐出 4 字节就断网（流 error），留下可续传的半截文件。
            const stream = new Readable({ read() {} }) as unknown as HttpResponse;
            stream.statusCode = 200;
            stream.headers = {};
            stream.destroy = () => undefined;
            setTimeout(() => {
              (stream as unknown as { emit: (event: string, payload: unknown) => void }).emit("data", Buffer.from("weig"));
              (stream as unknown as { emit: (event: string, payload: unknown) => void }).emit("error", new Error("ECONNRESET"));
            }, 5);
            return stream;
          }
          // 第二次：服务端按 Range 只补剩余字节。
          return binaryResponse(Buffer.from("hts!"), "bytes 4-8/8");
        }
      ],
      ["FilePath=config.yaml", () => binaryResponse(Buffer.from("cfg11"))]
    ];
    markOtherAssetsInstalled(cacheDir);
    const http = createFakeHttp(handlers, recorder);

    const first = createDownloaderForTest(http, { cacheDir, fileTimeoutMs: 2000 });
    const firstResult = await first.start("local-transcribe");
    expect(firstResult.completed).toBe(false);
    expect(firstResult.error).toContain("ECONNRESET");
    // 断网后正式目录里什么都没有，半截文件只在临时目录。
    expect(existsSync(join(cacheDir, "iic", vad.repo))).toBe(false);
    const partialWeight = join(cacheDir, "._____temp", "iic", vad.repo, "model.pt");
    expect(statSync(partialWeight).size).toBe(4);

    const second = createDownloaderForTest(http, { cacheDir, fileTimeoutMs: 2000 });
    // 重试前先确认 resumed 语义：临时目录有半截 -> 这次是续传。
    const weightRequest = () => recorder.filter((item) => item.url.includes("FilePath=model.pt"));
    const secondResult = await second.start("local-transcribe");
    expect(secondResult.completed).toBe(true);
    expect(weightRequest().length).toBe(2);
    expect(weightRequest()[1]?.options?.headers?.Range).toBe("bytes=4-");
    expect(readFileSync(join(cacheDir, "iic", vad.repo, "model.pt"), "utf8")).toBe("weights!");
    expect(isAssetInstalled(cacheDir, "vad")).toBe(true);
  });

  it("临时目录有半截文件时 resumed=true，干净目录 resumed=false", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    // 让 vad 的下载立刻以 403 结束，这样 start() 很快返回，便于断言 resumed。
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      ["FilePath=config.yaml", () => errorResponse(403)],
      ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
    ];
    markOtherAssetsInstalled(cacheDir);

    const clean = createDownloaderForTest(createFakeHttp(handlers, []), { cacheDir, fileTimeoutMs: 1000 });
    const cleanResult = await clean.start("local-transcribe");
    expect(cleanResult.completed).toBe(false);
    expect(clean.status().resumed).toBe(false);

    const tempDir = join(cacheDir, "._____temp", "iic", vad.repo);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "model.pt"), Buffer.from("part"));
    const dirty = createDownloaderForTest(createFakeHttp(handlers, []), { cacheDir, fileTimeoutMs: 1000 });
    await dirty.start("local-transcribe");
    expect(dirty.status().resumed).toBe(true);
    // 进度起点包含临时目录里已有的 4 字节，不会从 0 重新跳。
    const target = dirty.status().assets.find((asset) => asset.key === "vad");
    expect(clean.status().assets.find((asset) => asset.key === "vad")?.downloadedBytes).toBe(0);
    expect(target?.status).toBe("failed");
  });

  it("服务器返回错误时透出错误信息并标记该资产失败", async () => {
    const recorder: RecordedRequest[] = [];
    const handlers: Array<[string, () => HttpResponse]> = [
      ["/repo/files", () => filesResponse(VAD_FILES)],
      ["FilePath=config.yaml", () => errorResponse(403)]
    ];
    markOtherAssetsInstalled(cacheDir);
    const downloader = createDownloaderForTest(createFakeHttp(handlers, recorder), { cacheDir, fileTimeoutMs: 1000 });
    await downloader.start("local-transcribe");

    const status = downloader.status();
    expect(status.running).toBe(false);
    expect(status.error).toContain("403");
    expect(status.assets.find((asset) => asset.key === "vad")?.status).toBe("failed");
  });
});
