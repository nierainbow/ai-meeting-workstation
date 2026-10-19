import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDownloaderForTest, isAssetInstalled } from "./modelDownloader";
import type { ModelDownloaderHttp, HttpResponse, RequestOptions } from "./modelDownloader";

/**
 * 端到端验收：用一个本地 HTTP 镜像扮演 ModelScope，走真实的 node:http
 * 传输（302 重定向 + Range 续传 + 落盘 + 取消），验证 T1.2 的三条验收项：
 *   1. 断网（连接被掐断）后重试，从已落盘的字节续传；
 *   2. 取消后正式目录里不出现半成品，且可以继续续传；
 *   3. 完整下载后 isAssetInstalled 判定为已安装。
 * 镜像对任意 repo 都返回同一组小文件，因此整条 local-transcribe 档位
 * （asr/vad/punc/timestamp 四个模型）都能跑通，且不碰外网、不下大权重。
 */

const MODEL_PT = "MODEL-WEIGHTS-16KB-PADDING-xxxxxx";
const CONFIG_YAML = "model: demo\nsample_rate: 16000\n";
const SEG_DICT = "seg\ndict\n";
const BREAK_AFTER = 7;
const TEMP_FOLDER_NAME = "._____temp";
const FIRST_TIER_REPO = "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch";

type MirrorState = {
  /** 命中 CDN 路径时收到的 Range 头，用来断言续传确实发生。 */
  ranges: string[];
  /** >0 时，权重文件只吐这么多字节就掐断连接（模拟断网）。 */
  breakAfterBytes: number;
  /** 为 true 时权重正文永不到来（模拟连上但不吐数据的网络）。 */
  hangForever: boolean;
};

type Mirror = { origin: string; close: () => Promise<void> };

/** 镜像上的文件清单：与真实仓库同构（权重 + 附属文件 + 一个样板文件）。 */
const FILES: Array<{ path: string; payload: string }> = [
  { path: "config.yaml", payload: CONFIG_YAML },
  { path: "model.pt", payload: MODEL_PT },
  { path: "seg_dict", payload: SEG_DICT },
  { path: "README.md", payload: "readme" }
];

function payloadFor(name: string): Buffer {
  const entry = FILES.find((file) => file.path === name);
  return Buffer.from(entry ? entry.payload : "unknown");
}

function startMirror(state: MirrorState): Promise<Mirror> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const filesMatch = /^\/api\/v1\/models\/iic\/([^/]+)\/repo\/files$/.exec(url.pathname);
    if (filesMatch) {
      const body = JSON.stringify({
        Code: 100,
        Data: {
          Files: FILES.map((file) => ({
            Path: file.path,
            Size: Buffer.byteLength(file.payload),
            Type: "blob"
          }))
        }
      });
      void filesMatch;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }

    // 文件下载入口：和真实接口一样先 302 到 CDN（CDN 地址不带查询参数）。
    const downloadMatch = /^\/api\/v1\/models\/iic\/([^/]+)\/repo$/.exec(url.pathname);
    if (downloadMatch) {
      const filePath = url.searchParams.get("FilePath") ?? "";
      res.writeHead(302, { Location: `/cdn/${downloadMatch[1]}/${filePath}` });
      res.end();
      return;
    }

    const cdnMatch = /^\/cdn\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (cdnMatch) {
      const name = cdnMatch[2];
      const payload = payloadFor(name);
      const isWeight = name === "model.pt";
      const range = req.headers.range;
      if (typeof range === "string") state.ranges.push(range);
      if (isWeight && state.hangForever) {
        res.writeHead(200, { "content-length": String(payload.length) });
        res.write(payload.subarray(0, 1));
        return;
      }
      if (isWeight && state.breakAfterBytes > 0) {
        res.writeHead(200, { "content-length": String(payload.length) });
        res.write(payload.subarray(0, state.breakAfterBytes));
        // 等这一截真正落盘后再掐断，才是「下载到一半断网」，而不是连接刚建就断。
        setTimeout(() => res.socket?.destroy(), 30);
        return;
      }
      if (typeof range === "string") {
        const match = /^bytes=(\d+)-$/.exec(range);
        const from = match ? Number(match[1]) : 0;
        if (from > 0 && from < payload.length) {
          res.writeHead(206, {
            "content-range": `bytes ${from}-${payload.length - 1}/${payload.length}`
          });
          res.end(payload.subarray(from));
          return;
        }
      }
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}

/**
 * 把 ModelScope 域名换成本地镜像的 node:http 传输层（自己跟 302）。
 * 刻意保持薄：续传、落盘、取消这些被测行为都在 ModelDownloader 里。
 */
function mirrorHttp(origin: string): ModelDownloaderHttp {
  const fetchOnce = (url: string, options: RequestOptions): Promise<HttpResponse> =>
    new Promise<HttpResponse>((resolve, reject) => {
      const target = new URL(url.replace("https://www.modelscope.cn", origin));
      const req = httpRequest(
        target,
        { method: options.method ?? "GET", headers: { ...(options.headers ?? {}) } },
        (res) => {
          const location = res.headers.location;
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && typeof location === "string") {
            res.destroy();
            resolve(fetchOnce(new URL(location, target).toString(), options));
            return;
          }
          resolve(res as unknown as HttpResponse);
        }
      );
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(error);
      };
      req.on("error", fail);
      options.onAbort?.(() => fail(new Error("下载已取消。")));
      req.end();
    });
  return { request: fetchOnce };
}

function tempCache(): string {
  return mkdtempSync(join(tmpdir(), "aimw-model-mirror-"));
}

function repoFinalDir(cacheDir: string, repo: string): string {
  return join(cacheDir, "iic", repo);
}

function repoTempDir(cacheDir: string, repo: string): string {
  return join(cacheDir, TEMP_FOLDER_NAME, "iic", repo);
}

describe("模型下载端到端（本地 ModelScope 镜像）", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function withMirror(state: MirrorState): Promise<Mirror> {
    const mirror = await startMirror(state);
    cleanups.push(mirror.close);
    return mirror;
  }

  it("整档下载后全部落盘并判定为已安装，样板文件被跳过", async () => {
    const mirror = await withMirror({ ranges: [], breakAfterBytes: 0, hangForever: false });
    const cacheDir = tempCache();
    tempDirs.push(cacheDir);
    const downloader = createDownloaderForTest(mirrorHttp(mirror.origin), { cacheDir, fileTimeoutMs: 5000 });

    const result = await downloader.start("local-transcribe");

    expect(result.completed).toBe(true);
    expect(downloader.status().progress).toBe(1);
    expect(downloader.status().running).toBe(false);
    for (const key of ["asr", "vad", "punc", "timestamp"]) {
      expect(isAssetInstalled(cacheDir, key)).toBe(true);
    }
    const asrDir = repoFinalDir(cacheDir, FIRST_TIER_REPO);
    expect(readFileSync(join(asrDir, "config.yaml"), "utf8")).toBe(CONFIG_YAML);
    expect(readFileSync(join(asrDir, "model.pt"), "utf8")).toBe(MODEL_PT);
    // README.md 属于样板文件，不该出现在正式目录里。
    expect(existsSync(join(asrDir, "README.md"))).toBe(false);
    // 下载结束后临时目录要清干净。
    expect(existsSync(join(cacheDir, TEMP_FOLDER_NAME))).toBe(false);
  });

  it("断网后重试从已落盘的字节续传，最终补齐整个权重", async () => {
    const state: MirrorState = { ranges: [], breakAfterBytes: BREAK_AFTER, hangForever: false };
    const mirror = await withMirror(state);
    const cacheDir = tempCache();
    tempDirs.push(cacheDir);
    const http = mirrorHttp(mirror.origin);
    const first = createDownloaderForTest(http, { cacheDir, fileTimeoutMs: 5000 });

    const broken = await first.start("local-transcribe");

    expect(broken.completed).toBe(false);
    expect(broken.error).toBeTruthy();
    // 正式目录里什么都没有；半截文件只留在临时目录。
    expect(existsSync(repoFinalDir(cacheDir, FIRST_TIER_REPO))).toBe(false);
    expect(statSync(join(repoTempDir(cacheDir, FIRST_TIER_REPO), "model.pt")).size).toBe(BREAK_AFTER);

    // 网络恢复：同一个 cacheDir 再启动一次。
    state.breakAfterBytes = 0;
    const second = createDownloaderForTest(http, { cacheDir, fileTimeoutMs: 5000 });
    const resumed = await second.start("local-transcribe");

    expect(resumed.completed).toBe(true);
    expect(second.status().resumed).toBe(true);
    expect(state.ranges).toContain(`bytes=${BREAK_AFTER}-`);
    expect(readFileSync(join(repoFinalDir(cacheDir, FIRST_TIER_REPO), "model.pt"), "utf8")).toBe(MODEL_PT);
    expect(isAssetInstalled(cacheDir, "asr")).toBe(true);
  });

  it("取消后正式目录不留半成品，重新开始仍能续传完成", async () => {
    const state: MirrorState = { ranges: [], breakAfterBytes: 0, hangForever: true };
    const mirror = await withMirror(state);
    const cacheDir = tempCache();
    tempDirs.push(cacheDir);
    const downloader = createDownloaderForTest(mirrorHttp(mirror.origin), { cacheDir, fileTimeoutMs: 5000 });

    // start 会因为权重正文永不到来而挂住，不能 await；等 1 字节真正落盘再取消，
    // 这样断言的才是「下载到一半被取消」，而不是「还没开始就取消」。
    const running = downloader.start("local-transcribe").catch(() => undefined);
    const partialPath = join(repoTempDir(cacheDir, FIRST_TIER_REPO), "model.pt");
    await vi.waitFor(() => expect(existsSync(partialPath)).toBe(true));
    downloader.cancel();
    await running;

    expect(downloader.status().running).toBe(false);
    expect(downloader.status().error).toBeUndefined();
    // 取消只留下可续传的临时分片，正式目录里没有半成品模型。
    expect(existsSync(repoFinalDir(cacheDir, FIRST_TIER_REPO))).toBe(false);
    expect(statSync(join(repoTempDir(cacheDir, FIRST_TIER_REPO), "model.pt")).size).toBe(1);

    // 网络恢复后重新开始，之前落盘的 1 字节成为续传起点。
    state.hangForever = false;
    const restarted = createDownloaderForTest(mirrorHttp(mirror.origin), { cacheDir, fileTimeoutMs: 5000 });
    const result = await restarted.start("local-transcribe");

    expect(result.completed).toBe(true);
    expect(state.ranges).toContain("bytes=1-");
    expect(readFileSync(join(repoFinalDir(cacheDir, FIRST_TIER_REPO), "model.pt"), "utf8")).toBe(MODEL_PT);
    expect(isAssetInstalled(cacheDir, "asr")).toBe(true);
  });
});
