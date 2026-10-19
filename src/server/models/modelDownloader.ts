import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:https";
import type { ModelAssetDto, ModelAssetStatus, ModelDownloadStatusDto, ModelTierId } from "../../shared/types";

export type ModelAssetDefinition = {
  key: string;
  label: string;
  /** ModelScope 仓库名，实际调用时拼上 iic/ 前缀。 */
  repo: string;
  /** 判定已安装的权重文件名，与 scripts/download_funasr_models.py 一致。 */
  weight: string;
  /** 模型目录里除权重外还必须保留的文件（FunASR 加载时需要）。 */
  extraFiles: string[];
  /** 大致的体积，仅用于在下载开始前给出总量预估（MiB）。 */
  approxMiB: number;
};

/**
 * 模型清单与 scripts/download_funasr_models.py 保持一致；两份定义分别服务
 * Python（命令行安装器）与 TypeScript（桌面壳下载向导）。
 *
 * extraFiles 说明：FunASR 的 AutoModel 只认目录，除了 config.yaml 与权重，还需要
 * 分词/归一化依赖的 seg_dict、tokens.json、jieba 词典、am.mvn（CMVN 统计）；
 * 这些文件在 ModelScope 上是普通 blob，必须一起抓下来。
 */
export const MODEL_ASSETS: ModelAssetDefinition[] = [
  {
    key: "asr",
    label: "语音识别 Paraformer",
    repo: "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    weight: "model.pt",
    extraFiles: ["config.yaml", "seg_dict", "tokens.json", "am.mvn"],
    approxMiB: 944
  },
  {
    key: "vad",
    label: "语音检测 FSMN-VAD",
    repo: "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    weight: "model.pt",
    extraFiles: ["config.yaml"],
    approxMiB: 2
  },
  {
    key: "punc",
    label: "标点恢复 CT-Punc",
    repo: "punc_ct-transformer_cn-en-common-vocab471067-large",
    weight: "model.pt",
    extraFiles: ["config.yaml", "tokens.json", "jieba.c.dict", "jieba_usr_dict"],
    approxMiB: 1074
  },
  {
    key: "timestamp",
    label: "时间戳预测",
    repo: "speech_timestamp_prediction-v1-16k-offline",
    weight: "model.pt",
    extraFiles: ["config.yaml", "seg_dict", "tokens.json", "am.mvn"],
    approxMiB: 152
  },
  {
    key: "speaker",
    label: "说话人识别 Cam++",
    repo: "speech_campplus_sv_zh-cn_16k-common",
    weight: "campplus_cn_common.bin",
    extraFiles: ["config.yaml"],
    approxMiB: 27
  }
];

/** 不需要下载的样板文件：README、示例音频、图片、.gitattributes、configuration.json。 */
const SKIP_FILE_PATTERN = /(^|\/)(README\.md|\.gitattributes|configuration\.json|example|fig)(\/|$)/i;

/** 档位 -> 需要的模型 key。cloud 档不需要任何本地模型。 */
export const TIER_ASSETS: Record<ModelTierId, string[]> = {
  cloud: [],
  "local-transcribe": ["asr", "vad", "punc", "timestamp"],
  offline: ["asr", "vad", "punc", "timestamp", "speaker"]
};

export const MODEL_TIER_LABELS: Record<ModelTierId, string> = {
  cloud: "仅云端识别",
  "local-transcribe": "本地转写",
  offline: "全离线"
};

export const MODEL_TIER_SUMMARIES: Record<ModelTierId, string> = {
  cloud: "不下载任何模型，录音上传到云端识别，需要网络与 API Key。",
  "local-transcribe": "下载约 2.1 GB 模型，本机完成转写，录音不出本机。",
  offline: "在本地转写基础上再下载说话人识别模型（约 2.2 GB），断网也能用。"
};

const MODEL_SCOPE_API = "https://www.modelscope.cn/api/v1/models";
const MODEL_SCOPE_USER_AGENT = "modelscope/1.37.1";
const TEMP_FOLDER_NAME = "._____temp";

function assetByKey(key: string): ModelAssetDefinition | undefined {
  return MODEL_ASSETS.find((asset) => asset.key === key);
}

/** 估算临时目录体积时要看的文件：权重 + FunASR 加载必需的附属文件。 */
function assetFilesForSize(asset: ModelAssetDefinition): string[] {
  return [...asset.extraFiles, asset.weight];
}

/**
 * 已安装判据与 scripts/download_funasr_models.py 完全相同：config.yaml 与权重
 * 必须同时存在，且兼容旧版（<cache>/iic/）与新版（<cache>/models/iic/）两种布局。
 */
export function isAssetInstalled(cacheDir: string, key: string): boolean {
  const asset = assetByKey(key);
  if (!asset) return false;
  return ["models/iic", "iic"].some((layout) => {
    const base = join(cacheDir, layout, asset.repo);
    return existsSync(join(base, "config.yaml")) && existsSync(join(base, asset.weight));
  });
}

/** 首启检测：给出尚未安装的模型 key 清单。 */
export function detectMissingAssets(cacheDir: string): string[] {
  return MODEL_ASSETS.filter((asset) => !isAssetInstalled(cacheDir, asset.key)).map((asset) => asset.key);
}

type ModelScopeFileEntry = {
  Path: string;
  Size: number;
  Type: "blob" | "tree";
};


type PendingDownload = {
  key: string;
  files: ModelScopeFileEntry[];
  index: number;
};

export type ModelDownloaderDeps = {
  cacheDir: string;
  fileTimeoutMs: number;
};

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  destroy(): void;
  pipe<T>(destination: T): T;
  setEncoding?(encoding: string): void;
};

export type RequestOptions = {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /**
   * 请求建立期间（还没拿到响应）的取消钩子。实现方应在调用后调用 onAbort
   * 注册一个能中断本次请求的函数；取消时 downloader 会调它，让卡在
   * 「连上了但服务端不回包」的请求立刻失败退出，而不是把 running 挂住。
   */
  onAbort?: (abort: () => void) => void;
};

export type ModelDownloaderHttp = {
  request(url: string, options?: RequestOptions): Promise<HttpResponse>;
};

/** 请求发出后最多等这么久还没响应就失败；0 表示不设超时（仅测试用）。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 用 node 内置 https 发请求，跟随 302 重定向到 ModelScope LFS CDN。
 *
 * - CDN 的 URL 带 auth_key 且会过期，因此每次都要重新走 API 拿新的 Location，
 *   不能缓存 CDN 地址（缓存后再次下载会拿到 403 denied by req auth）。
 * - CDN 有 UA ACL，默认 UA 会被拒（denied by UA ACL = blacklist），
 *   必须伪装成 modelscope SDK 的 UA。
 */
export const nodeModelDownloaderHttp: ModelDownloaderHttp = {
  async request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const response = await new Promise<HttpResponse>((resolve, reject) => {
      const req = request(
        url,
        {
          method: options.method ?? "GET",
          headers: {
            "User-Agent": MODEL_SCOPE_USER_AGENT,
            ...(options.headers ?? {})
          }
        },
        (res) => {
          const location = res.headers.location;
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && typeof location === "string") {
            res.destroy();
            resolve(nodeModelDownloaderHttp.request(location, options));
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
      req.on("error", (error: Error) => fail(error));
      if (REQUEST_TIMEOUT_MS > 0) {
        req.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error("连接 ModelScope 超时。")));
      }
      // 取消时立刻掐断连接，避免下载器一直停在 running。
      options.onAbort?.(() => fail(new Error("下载已取消。")));
      req.end();
    });
    return response;
  }
};

/** 只暴露给测试：把 https 依赖换成可注入的假实现。 */
export function createDownloaderForTest(http: ModelDownloaderHttp, deps: ModelDownloaderDeps): ModelDownloader {
  return new ModelDownloader(deps, http);
}

export class ModelDownloader {
  private current: PendingDownload | null = null;
  /** 等待响应阶段（还没开始写盘）的取消入口。 */
  private pendingRequestAbort: (() => void) | null = null;
  private readonly state: ModelDownloadStatusDto;
  private readonly listeners = new Set<(status: ModelDownloadStatusDto) => void>();
  private cancelled = false;
  private activeAbort: (() => void) | null = null;

  constructor(
    private readonly deps: ModelDownloaderDeps,
    private readonly http: ModelDownloaderHttp = nodeModelDownloaderHttp
  ) {
    this.state = {
      tier: "cloud",
      running: false,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      assets: this.describeAssets("cloud"),
      resumed: false
    };
  }

  status(): ModelDownloadStatusDto {
    return {
      ...this.state,
      assets: this.state.assets.map((asset) => ({ ...asset }))
    };
  }

  onChange(listener: (status: ModelDownloadStatusDto) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 开始下载某个档位。返回 completed=false 表示被取消或失败（错误信息在 status().error）。
   * 调用方据此决定是否把该档位标记为「向导已完成」。
   */
  async start(tier: ModelTierId): Promise<{ completed: boolean; cancelled: boolean; error?: string }> {
    if (this.current) return { completed: false, cancelled: false, error: "已有下载任务在进行。" };
    const keys = TIER_ASSETS[tier] ?? [];
    this.cancelled = false;
    const assets = this.describeAssets(tier);
    const resumed = keys.some((key) => this.hasPartialDownload(key));
    this.state.tier = tier;
    this.state.running = true;
    this.state.progress = 0;
    this.state.currentLabel = undefined;
    this.state.error = undefined;
    this.state.resumed = resumed;
    this.state.assets = assets;
    this.state.downloadedBytes = 0;
    this.state.totalBytes = assets.reduce((sum, asset) => sum + asset.totalBytes, 0);
    // 续传时把临时目录里已有的字节算进起点，进度条才不会从 0 重新跳一遍。
    for (const asset of this.state.assets) {
      asset.downloadedBytes = this.partialBytes(asset.key);
    }
    this.recomputeProgress();
    this.emit();

    try {
      for (const key of keys) {
        if (this.cancelled) break;
        const asset = assetByKey(key);
        if (!asset) continue;
        if (isAssetInstalled(this.deps.cacheDir, key)) {
          this.markInstalled(key);
          continue;
        }
        const files = await this.listRepoFiles(asset.repo);
        const targets = files.filter((file) => file.Type === "blob" && !SKIP_FILE_PATTERN.test(file.Path));
        const download = this.beginAsset(asset, targets);
        this.current = download;
        await this.runDownload(download);
        this.current = null;
        if (this.cancelled) break;
      }
      if (this.cancelled) {
        this.state.running = false;
        this.state.currentLabel = undefined;
        this.state.error = undefined;
        this.emit();
        return { completed: false, cancelled: true };
      }
      this.state.running = false;
      this.state.progress = 1;
      this.state.currentLabel = undefined;
      this.state.assets = this.describeAssets(tier);
      this.state.downloadedBytes = this.state.totalBytes;
      this.emit();
      return { completed: true, cancelled: false };
    } catch (error) {
      if (error instanceof CancelledError) {
        this.state.running = false;
        this.state.currentLabel = undefined;
        this.state.error = undefined;
        this.emit();
        return { completed: false, cancelled: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.finishWithError(message);
      return { completed: false, cancelled: false, error: message };
    }
  }

  cancel(): void {
    if (!this.current && !this.state.running) return;
    this.cancelled = true;
    // 立刻把状态落定成「已停止」：用户点了取消，接口必须马上返回非下载中，
    // 不能等下载协程解开（那是异步的），否则界面会短暂停在「下载中」。
    // 下载协程随后解开时走 CancelledError 分支，只会重复写同样的终态。
    this.state.running = false;
    this.state.currentLabel = undefined;
    this.state.error = undefined;
    for (const asset of this.state.assets) {
      if (asset.status === "downloading") {
        asset.status = "missing";
      }
    }
    this.emit();
    // 两处都可能挂着：响应已到、正在往磁盘写；以及请求刚发出、还没拿到响应。
    // 后者没有 activeAbort，只能靠 onAbort 掐断连接。
    if (this.activeAbort) this.activeAbort();
    if (this.pendingRequestAbort) this.pendingRequestAbort();
  }

  private beginAsset(asset: ModelAssetDefinition, files: ModelScopeFileEntry[]): PendingDownload {
    const target = this.state.assets.find((item) => item.key === asset.key);
    if (target) {
      target.status = "downloading";
      target.downloadedBytes = 0;
      const total = files.reduce((sum, file) => sum + file.Size, 0);
      if (total > 0) target.totalBytes = total;
    }
    this.state.currentLabel = asset.label;
    this.state.error = undefined;
    this.emit();
    return { key: asset.key, files, index: 0 };
  }

  private async runDownload(download: PendingDownload): Promise<void> {
    const asset = assetByKey(download.key);
    if (!asset) return;
    const finalDir = join(this.deps.cacheDir, "iic", asset.repo);
    const tempDir = join(this.deps.cacheDir, TEMP_FOLDER_NAME, "iic", asset.repo);
    mkdirSync(tempDir, { recursive: true });

    for (const file of download.files) {
      if (this.cancelled) throw new CancelledError();
      await this.downloadFile(asset.repo, file.Path, file.Size, join(tempDir, file.Path), download.key);
      if (this.cancelled) throw new CancelledError();
    }

    mkdirSync(finalDir, { recursive: true });
    for (const file of download.files) {
      const from = join(tempDir, file.Path);
      const to = join(finalDir, file.Path);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    rmSync(tempDir, { recursive: true, force: true });
    this.pruneTempDirs();
    this.markInstalled(asset.key);
  }

  /**
   * 单文件下载：先看临时目录里已有多少字节，再发 Range 请求续传。
   * 只在全部字节落地后才由调用方 rename 到正式目录，因此取消时正式目录
   * 里不会出现「只有 config.yaml 没有权重」的半成品模型。
   */
  private async downloadFile(
    repo: string,
    path: string,
    totalSize: number,
    targetPath: string,
    assetKey: string
  ): Promise<void> {
    mkdirSync(dirname(targetPath), { recursive: true });
    const existing = existsSync(targetPath) ? statSync(targetPath).size : 0;
    if (totalSize > 0 && existing >= totalSize) return;

    const url = `${MODEL_SCOPE_API}/iic/${repo}/repo?Revision=master&FilePath=${encodeURIComponent(path)}`;
    const headers: Record<string, string> = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // onAbort 由 http 实现同步调用，这里先挂上取消入口再 await：
    // 否则「请求已发出、响应还没回来」这段窗口里取消会无从下手。
    let requestAbort: (() => void) | null = null;
    const pending = this.http.request(url, {
      headers,
      onAbort: (abort) => {
        requestAbort = abort;
        if (this.cancelled) abort();
      }
    });
    this.pendingRequestAbort = () => requestAbort?.();
    let response: HttpResponse;
    try {
      response = await pending;
    } catch (error) {
      // 请求是被取消掐断的，按正常取消路径收尾，不当成网络错误上报。
      if (this.cancelled) throw new CancelledError();
      throw error;
    } finally {
      this.pendingRequestAbort = null;
    }
    const status = response.statusCode ?? 0;
    if (status !== 200 && status !== 206) {
      throw new Error(`下载 ${path} 失败：服务器返回 ${status}。`);
    }
    const contentRange = response.headers["content-range"];
    const total = typeof contentRange === "string" ? Number(contentRange.split("/")[1]) : totalSize;

    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(targetPath, existing > 0 ? { flags: "a" } : undefined);
      let received = existing;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const abort = () => {
        // 取消时不能 destroy 写流：那样会丢掉还在缓冲区里的字节，下次续传就
        // 得从头再来。先掐断响应不再收新数据，再用 end() 让已收字节落盘。
        response.destroy();
        stream.end(finish);
      };
      this.activeAbort = abort;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        const target = this.state.assets.find((item) => item.key === assetKey);
        if (target) target.downloadedBytes += chunk.length;
        this.recomputeProgress();
        this.emit();
      });
      response.on("error", (error: Error) => {
        this.activeAbort = null;
        // 响应是被取消掐断的，已收字节仍要落盘，不当成错误上报。
        if (this.cancelled) {
          stream.end(finish);
          return;
        }
        stream.destroy();
        reject(error);
      });
      response.pipe(stream);
      stream.on("error", (error: Error) => {
        this.activeAbort = null;
        if (this.cancelled) {
          finish();
          return;
        }
        reject(error);
      });
      stream.on("close", () => {
        this.activeAbort = null;
        if (this.cancelled) {
          finish();
          return;
        }
        if (total > 0 && received < total) {
          reject(new Error(`下载 ${path} 中断：已接收 ${received}/${total} 字节。`));
          return;
        }
        finish();
      });
    });

    if (this.cancelled) throw new CancelledError();
    void total;
  }

  private async listRepoFiles(repo: string): Promise<ModelScopeFileEntry[]> {
    const url = `${MODEL_SCOPE_API}/iic/${repo}/repo/files?Revision=master`;
    let requestAbort: (() => void) | null = null;
    const pending = this.http.request(url, {
      onAbort: (abort) => {
        requestAbort = abort;
        if (this.cancelled) abort();
      }
    });
    this.pendingRequestAbort = () => requestAbort?.();
    let response: HttpResponse;
    try {
      response = await pending;
    } catch (error) {
      if (this.cancelled) throw new CancelledError();
      throw error;
    } finally {
      this.pendingRequestAbort = null;
    }
    if ((response.statusCode ?? 0) !== 200) {
      throw new Error(`获取模型文件列表失败：服务器返回 ${response.statusCode ?? 0}。`);
    }
    const body = await readBody(response);
    const parsed = JSON.parse(body) as { Code?: number; Data?: { Files?: ModelScopeFileEntry[] } };
    const files = parsed.Data?.Files ?? [];
    return files.filter((file) => file.Type === "blob");
  }

  /**
   * 下载完成后把临时目录里空掉的父级一起清掉，别留下一串
   * `._____temp/iic/...` 空壳目录（容易被误认为是装了一半的模型）。
   */
  private pruneTempDirs(): void {
    const root = join(this.deps.cacheDir, TEMP_FOLDER_NAME);
    if (!existsSync(root)) return;
    // 从临时目录的 iic/ 子层往上收，空的就删掉；收到根这一层时停下来，
    // 绝不能越过 root 去删缓存目录本身。root 空了也一起删，避免留下
    // ._____temp 空壳被误认成「装了一半」。
    let current = join(root, "iic");
    while (current.startsWith(root)) {
      if (!existsSync(current)) {
        current = dirname(current);
        continue;
      }
      if (readdirSync(current).length > 0) break;
      rmSync(current, { recursive: true, force: true });
      if (current === root) break;
      current = dirname(current);
    }
  }

  private hasPartialDownload(key: string): boolean {
    const asset = assetByKey(key);
    if (!asset) return false;
    const tempDir = join(this.deps.cacheDir, TEMP_FOLDER_NAME, "iic", asset.repo);
    if (!existsSync(tempDir)) return false;
    return existsSync(join(tempDir, asset.weight));
  }

  /** 临时目录里已落盘的字节数，用于续传时给出真实的进度起点。 */
  private partialBytes(key: string): number {
    const asset = assetByKey(key);
    if (!asset) return 0;
    const tempDir = join(this.deps.cacheDir, TEMP_FOLDER_NAME, "iic", asset.repo);
    if (!existsSync(tempDir)) return 0;
    let total = 0;
    for (const file of assetFilesForSize(asset)) {
      const path = join(tempDir, file);
      if (existsSync(path)) total += statSync(path).size;
    }
    return total;
  }

  private describeAssets(tier: ModelTierId): ModelAssetDto[] {
    const keys = TIER_ASSETS[tier] ?? [];
    return keys.map((key) => {
      const asset = assetByKey(key);
      const base = {
        key,
        required: true,
        downloadedBytes: 0
      };
      if (!asset) {
        return {
          ...base,
          label: key,
          modelId: "",
          totalBytes: 0,
          status: "missing" as ModelAssetStatus
        };
      }
      return {
        ...base,
        label: asset.label,
        modelId: `iic/${asset.repo}`,
        totalBytes: asset.approxMiB * 1024 * 1024,
        status: this.isInstalled(asset.key) ? "installed" : "missing"
      };
    });
  }

  private isInstalled(key: string): boolean {
    return isAssetInstalled(this.deps.cacheDir, key);
  }

  private markInstalled(key: string): void {
    const asset = this.state.assets.find((item) => item.key === key);
    if (asset) {
      asset.status = "installed";
      asset.downloadedBytes = asset.totalBytes;
    }
    this.recomputeProgress();
    this.emit();
  }

  private recomputeProgress(): void {
    this.state.downloadedBytes = this.state.assets.reduce((sum, item) => sum + item.downloadedBytes, 0);
    this.state.totalBytes = this.state.assets.reduce((sum, item) => sum + item.totalBytes, 0);
    this.state.progress = this.state.totalBytes > 0 ? this.state.downloadedBytes / this.state.totalBytes : 0;
  }

  private finishWithError(message: string): void {
    this.state.running = false;
    this.state.error = message;
    this.state.currentLabel = undefined;
    const asset = this.state.assets.find((item) => item.status === "downloading");
    if (asset) asset.status = "failed";
    this.emit();
  }

  private emit(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

function readBody(response: HttpResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("error", reject);
    response.on("end", () => resolve(body));
  });
}

export function modelTempDir(cacheDir: string, repo: string): string {
  return join(cacheDir, TEMP_FOLDER_NAME, "iic", repo);
}
