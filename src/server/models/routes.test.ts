import express from "express";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_ASSETS, TIER_ASSETS, createDownloaderForTest, isAssetInstalled } from "./modelDownloader";
import type { ModelDownloaderHttp, HttpResponse, RequestOptions } from "./modelDownloader";
import { createModelsRouter } from "./routes";
import { ModelOnboardingStore } from "./onboarding";

type RecordedRequest = { url: string; options?: RequestOptions };

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

function binaryResponse(payload: Buffer): HttpResponse {
  const stream = streamOf(payload) as unknown as HttpResponse;
  stream.statusCode = 200;
  stream.headers = {};
  stream.destroy = () => undefined;
  return stream;
}

/**
 * 永远不产出数据也不结束的响应，用来挂住下载流程以便取消。
 * 同时把 onAbort 接通：取消时让请求本身失败，和真实的 https 层行为一致。
 */
function hangingResponse(onCreated: (stream: HttpResponse) => void): HttpResponse {
  const stream = new Readable({ read() {} }) as unknown as HttpResponse;
  stream.statusCode = 200;
  stream.headers = {};
  stream.destroy = () => undefined;
  onCreated(stream);
  return stream;
}

/** 挂起且可被取消的响应：取消时让请求 promise 以「已取消」失败。 */
function cancellableHang(options?: RequestOptions): Promise<HttpResponse> {
  return new Promise<HttpResponse>((_resolve, reject) => {
    options?.onAbort?.(() => reject(new Error("下载已取消。")));
  });
}

function filesResponse(files: Array<{ Path: string; Size: number; Type: "blob" | "tree" }>): HttpResponse {
  return jsonResponse(JSON.stringify({ Code: 200, Data: { Files: files } }));
}

const VAD_FILES = [
  { Path: "config.yaml", Size: 5, Type: "blob" as const },
  { Path: "model.pt", Size: 8, Type: "blob" as const }
];

function createFakeHttp(
  handlers: Array<[string, (options?: RequestOptions) => HttpResponse | Promise<HttpResponse>]>,
  recorder: RecordedRequest[]
): ModelDownloaderHttp {
  return {
    async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
      recorder.push({ url, options });
      const entry = handlers.find(([needle]) => url.includes(needle));
      if (!entry) throw new Error(`unexpected url: ${url}`);
      // handler 里可以通过 options.onAbort 注册「取消时掐断这次请求」的钩子。
      return entry[1](options);
    }
  };
}

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

const VAD_HANDLERS: Array<[string, () => HttpResponse | Promise<HttpResponse>]> = [
  ["/repo/files", () => filesResponse(VAD_FILES)],
  ["FilePath=config.yaml", () => binaryResponse(Buffer.from("cfg11"))],
  ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
];

describe("createModelsRouter", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "models-routes-"));
    const app = express();
    app.use(express.json());
    app.use(
      "/api/models",
      createModelsRouter({
        downloader: createDownloaderForTest(createFakeHttp(VAD_HANDLERS, []), {
          cacheDir: tempDir,
          fileTimeoutMs: 3000
        }),
        cacheDir: tempDir,
        onboarding: new ModelOnboardingStore(tempDir)
      })
    );
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not start");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("GET 返回档位卡片、缓存目录与首启调度状态", async () => {
    const response = await fetch(`${baseUrl}/api/models`);
    const body = (await response.json()) as {
      cacheDir: string;
      missingAssets: string[];
      needsSetup: boolean;
      tiers: Array<{ tier: string; label: string; assets: string[]; installed: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.cacheDir).toBe(tempDir);
    expect(body.needsSetup).toBe(true);
    // 一个模型都没装：三档都未就绪，cloud 档资产为空。
    expect(body.missingAssets.length).toBeGreaterThan(0);
    expect(body.tiers.map((tier) => tier.tier)).toEqual(["cloud", "local-transcribe", "offline"]);
    const cloud = body.tiers.find((tier) => tier.tier === "cloud");
    expect(cloud?.assets).toEqual(TIER_ASSETS.cloud);
    expect(cloud?.installed).toBe(true);
    expect(body.tiers.every((tier) => tier.installed === !tier.assets.some((key) => body.missingAssets.includes(key)))).toBe(true);
  });

  it("start 用非法 tier 返回 400，用 cloud 档直接走完向导", async () => {
    const bad = await fetch(`${baseUrl}/api/models/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "everything" })
    });
    expect(bad.status).toBe(400);

    const cloud = await fetch(`${baseUrl}/api/models/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: "cloud" })
    });
    const body = (await cloud.json()) as { needsSetup: boolean; tier: string; progress: number };

    expect(cloud.status).toBe(200);
    // cloud 档不需要任何模型：进度立刻拉满，向导走完。
    expect(body.progress).toBe(1);
    expect(body.needsSetup).toBe(false);
  });

  it("下载中重复 start 返回 409", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/models",
      createModelsRouter({
        downloader: createDownloaderForTest(
          createFakeHttp(
            [["/repo/files", () => hangingResponse(() => undefined)]],
            []
          ),
          { cacheDir: tempDir, fileTimeoutMs: 3000 }
        ),
        cacheDir: tempDir,
        onboarding: new ModelOnboardingStore(tempDir)
      })
    );
    const busyServer = createServer(app);
    await new Promise<void>((resolve) => {
      busyServer.listen(0, "127.0.0.1", resolve);
    });
    const address = busyServer.address();
    if (!address || typeof address === "string") throw new Error("busy server did not start");
    const busyUrl = `http://127.0.0.1:${address.port}`;

    try {
      markOtherAssetsInstalled(tempDir);
      // 文件列表请求被挂起，start 一直在 awaited，这条请求本身不会返回；
      // 重点是它已经把下载器标记成 running，第二个 start 应该被 409 拦住。
      fetch(`${busyUrl}/api/models/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "local-transcribe" })
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const second = await fetch(`${busyUrl}/api/models/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "offline" })
      });
      expect(second.status).toBe(409);
      expect((await second.json()).error).toContain("已有");
    } finally {
      busyServer.closeAllConnections?.();
      await new Promise<void>((resolve) => busyServer.close(() => resolve()));
    }
  });

  it("取消后 needsSetup 仍然为 true，正式目录不出现半成品", async () => {
    const app = express();
    app.use(express.json());
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    app.use(
      "/api/models",
      createModelsRouter({
        downloader: createDownloaderForTest(
          createFakeHttp(
            [
              ["/repo/files", () => filesResponse(VAD_FILES)],
              ["FilePath=config.yaml", (options) => cancellableHang(options)],
              ["FilePath=model.pt", () => binaryResponse(Buffer.from("weights!"))]
            ],
            []
          ),
          { cacheDir: tempDir, fileTimeoutMs: 3000 }
        ),
        cacheDir: tempDir,
        onboarding: new ModelOnboardingStore(tempDir)
      })
    );
    const cancelServer = createServer(app);
    await new Promise<void>((resolve) => {
      cancelServer.listen(0, "127.0.0.1", resolve);
    });
    const address = cancelServer.address();
    if (!address || typeof address === "string") throw new Error("cancel server did not start");
    const cancelUrl = `http://127.0.0.1:${address.port}`;

    try {
      markOtherAssetsInstalled(tempDir);
      // config.yaml 的响应被挂起，start 不会返回；不等它。
      const running = fetch(`${cancelUrl}/api/models/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "local-transcribe" })
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cancelled = await fetch(`${cancelUrl}/api/models/cancel`, { method: "POST" });
      const body = (await cancelled.json()) as {
        needsSetup: boolean;
        running: boolean;
        error?: string;
      };

      expect(cancelled.status).toBe(200);
      expect(body.running).toBe(false);
      expect(body.error).toBeUndefined();
      // 取消不算完成：下次启动还会再问，不会卡在装了一半的状态。
      expect(body.needsSetup).toBe(true);
      // 正式目录里没有半成品，分片只在临时目录。
      expect(isAssetInstalled(tempDir, "vad")).toBe(false);
      expect(existsSync(join(tempDir, "iic", vad.repo))).toBe(false);
      expect(existsSync(join(tempDir, "._____temp", "iic", vad.repo))).toBe(true);
      // 取消后 start 会带着 cancelled 结果返回，这条请求可以自然收尾。
      await running;
    } finally {
      cancelServer.closeAllConnections?.();
      await new Promise<void>((resolve) => cancelServer.close(() => resolve()));
    }
  });

  it("skip 之后向导不再自动弹出", async () => {
    const skipped = await fetch(`${baseUrl}/api/models/skip`, { method: "POST" });
    const body = (await skipped.json()) as { needsSetup: boolean };

    expect(skipped.status).toBe(200);
    expect(body.needsSetup).toBe(false);
    expect(existsSync(join(tempDir, "models", "onboarding.json"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(tempDir, "models", "onboarding.json"), "utf8")) as { skipped: boolean };
    expect(saved.skipped).toBe(true);
  });

  it("cloud 档跳过之后即使没有模型也能用（跳过源于档位本身不需要）", async () => {
    const skipped = await fetch(`${baseUrl}/api/models/skip`, { method: "POST" });
    expect(skipped.status).toBe(200);

    const status = (await (await fetch(`${baseUrl}/api/models`)).json()) as {
      needsSetup: boolean;
      tiers: Array<{ tier: string; installed: boolean }>;
    };
    // 跳过后 needsSetup=false，但 cloud 档是"不需要模型"而非"已装好"。
    expect(status.needsSetup).toBe(false);
    const cloud = status.tiers.find((tier) => tier.tier === "cloud");
    expect(cloud?.installed).toBe(true);
    // 本地档依然显示未就绪，用户之后可以主动打开向导补装。
    const local = status.tiers.find((tier) => tier.tier === "local-transcribe");
    expect(local?.installed).toBe(false);
  });

  it("续传时进度起点包含临时目录里已有的字节", async () => {
    const vad = MODEL_ASSETS.find((asset) => asset.key === "vad")!;
    const partialDir = join(tempDir, "._____temp", "iic", vad.repo);
    mkdirSync(partialDir, { recursive: true });
    writeFileSync(join(partialDir, "model.pt"), Buffer.from("part"));
    markOtherAssetsInstalled(tempDir);

    const app = express();
    app.use(express.json());
    app.use(
      "/api/models",
      createModelsRouter({
        downloader: createDownloaderForTest(createFakeHttp(VAD_HANDLERS, []), {
          cacheDir: tempDir,
          fileTimeoutMs: 3000
        }),
        cacheDir: tempDir,
        onboarding: new ModelOnboardingStore(tempDir)
      })
    );
    const resumeServer = createServer(app);
    await new Promise<void>((resolve) => {
      resumeServer.listen(0, "127.0.0.1", resolve);
    });
    const address = resumeServer.address();
    if (!address || typeof address === "string") throw new Error("resume server did not start");
    const resumeUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await fetch(`${resumeUrl}/api/models/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "local-transcribe" })
      });
      const body = (await started.json()) as {
        progress: number;
        needsSetup: boolean;
      };
      expect(started.status).toBe(200);
      // 已有 4 字节分片，进度起点大于 0（后面 config.yaml 也会补上）。
      expect(body.progress).toBeGreaterThan(0);
      expect(body.progress).toBeLessThanOrEqual(1);
      // 下载完成后向导走完。
      expect(body.needsSetup).toBe(false);
      expect(isAssetInstalled(tempDir, "vad")).toBe(true);
      // 续传时服务端补的是「整个文件」（测试用的假 CDN 不看 Range），
      // 所以按 4 字节分片 + 8 字节追加 = 12 字节；真实 CDN 会按 Range 只补剩余 4 字节。
      // 这里只验证「分片被续上而不是被丢弃/覆盖」。
      const finalSize = statSync(join(tempDir, "iic", vad.repo, "model.pt")).size;
      expect(finalSize).toBe(12);
      expect(readFileSync(join(tempDir, "iic", vad.repo, "model.pt"), "utf8")).toBe("partweights!");
      expect(existsSync(partialDir)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => resumeServer.close(() => resolve()));
    }
  });
});
