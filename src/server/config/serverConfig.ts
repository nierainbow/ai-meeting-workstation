import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { DiscussionMode } from "../../shared/types";
import { defaultPythonCommand, venvPythonPath } from "../process/platformCommand";

export type CodexProviderMode = "mock" | "cli";
export type FunasrDevice = "auto" | "cpu" | "mps";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  clientDevOrigin: string;
  clientDistDir: string;
  defaultProjectPath: string;
  defaultMode: DiscussionMode;
  codexProvider: CodexProviderMode;
  codexCliPath: string;
  codexCliTimeoutMs: number;
  funasrFileTimeoutMs: number;
  funasrDevice: FunasrDevice;
  funasrHotwordFile: string;
  funasrPythonPath: string;
  funasrAsrHome: string;
  codexModel?: string;
  volcengineAsr: {
    apiKey?: string;
    resourceId?: string;
    endpoint: string;
  };
  type4meAsr: {
    serverPath: string;
    modelPath: string;
    port: number;
    hotwordsFile?: string;
    fileTimeoutMs: number;
  };
  modelCache: {
    /** ModelScope 缓存根目录，下载的模型放这里。 */
    dir: string;
    /** 单个文件下载超时（毫秒）。 */
    fileTimeoutMs: number;
  };
  /** 声纹 sidecar（FastAPI，默认 8792）基址；为空表示不启用实时声纹认人。 */
  voiceprintSidecarUrl?: string;
};

export function resolveFunasrRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): {
  pythonPath: string;
  asrHome: string;
} {
  const legacyAsrHome = resolve(cwd, "../..");
  const defaultAsrHome = existsSync(join(cwd, ".modelscope_cache"))
    ? cwd
    : existsSync(join(legacyAsrHome, ".modelscope_cache")) ? legacyAsrHome : cwd;
  const asrHome = resolve(cwd, env.FUNASR_HOME?.trim() || defaultAsrHome);
  const bundledPython = venvPythonPath(join(asrHome, ".venv"), platform);
  const pythonPath = env.FUNASR_PYTHON_PATH?.trim() || (existsSync(bundledPython) ? bundledPython : defaultPythonCommand(platform));
  return { pythonPath, asrHome };
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): ServerConfig {
  const port = readPort(env.APP_PORT ?? "8787");
  const codexCliTimeoutMs = readPositiveNumber(env.CODEX_CLI_TIMEOUT_MS ?? "120000", "CODEX_CLI_TIMEOUT_MS");
  const funasrFileTimeoutMs = readPositiveNumber(
    env.FUNASR_FILE_TIMEOUT_MS ?? "21600000",
    "FUNASR_FILE_TIMEOUT_MS"
  );
  const funasrDevice = readFunasrDevice(env.FUNASR_DEVICE ?? "auto");
  const funasrHotwordFile = resolve(cwd, env.FUNASR_HOTWORD_FILE?.trim() || "config/hotwords/active.txt");
  const funasrRuntime = resolveFunasrRuntime(env, cwd);
  const codexProvider = env.CODEX_PROVIDER === "mock" ? "mock" : "cli";
  const codexCliPath = env.CODEX_CLI_PATH ?? "codex";
  if (codexProvider === "cli" && !codexCliPath.trim()) {
    throw new Error("CODEX_PROVIDER=cli 时必须配置 CODEX_CLI_PATH，请检查 .env。");
  }

  const voiceprintSidecarUrl = env.VOICEPRINT_SIDECAR_URL?.trim();

  return {
    host: env.APP_HOST ?? "127.0.0.1",
    port,
    dataDir: resolve(env.APP_DATA_DIR ?? ".local-data"),
    clientDevOrigin: env.CLIENT_DEV_ORIGIN ?? "http://127.0.0.1:5173",
    clientDistDir: resolve(cwd, env.CLIENT_DIST_DIR?.trim() || "dist/client"),
    defaultProjectPath: env.DISCUSSION_DEFAULT_PROJECT_PATH ?? process.cwd(),
    defaultMode: "real",
    codexProvider,
    codexCliPath,
    codexCliTimeoutMs,
    funasrFileTimeoutMs,
    funasrDevice,
    funasrHotwordFile,
    funasrPythonPath: funasrRuntime.pythonPath,
    funasrAsrHome: funasrRuntime.asrHome,
    codexModel: env.CODEX_MODEL || undefined,
    volcengineAsr: {
      apiKey: env.VOLCENGINE_ASR_API_KEY || undefined,
      resourceId: env.VOLCENGINE_ASR_RESOURCE_ID || undefined,
      endpoint: env.VOLCENGINE_ASR_ENDPOINT ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    },
    type4meAsr: {
      serverPath:
        env.TYPE4ME_ASR_SERVER_PATH?.trim() ||
        "/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server",
      modelPath: env.TYPE4ME_ASR_MODEL_PATH?.trim() || "/Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR",
      port: readType4mePort(env.TYPE4ME_ASR_PORT ?? "8791"),
      hotwordsFile: env.TYPE4ME_ASR_HOTWORDS_FILE?.trim() || defaultType4meHotwordsFile(platform),
      fileTimeoutMs: readPositiveNumber(env.TYPE4ME_FILE_TIMEOUT_MS ?? "1800000", "TYPE4ME_FILE_TIMEOUT_MS")
    },
    modelCache: {
      dir: resolveModelCacheDir(env, cwd, funasrRuntime.asrHome, resolve(env.APP_DATA_DIR ?? ".local-data")),
      fileTimeoutMs: readPositiveNumber(
        env.MODEL_DOWNLOAD_FILE_TIMEOUT_MS ?? "1800000",
        "MODEL_DOWNLOAD_FILE_TIMEOUT_MS"
      )
    },
    voiceprintSidecarUrl: voiceprintSidecarUrl || undefined
  };
}

/**
 * 模型缓存落点：显式 MODELSCOPE_CACHE 优先；否则沿用 asrHome 下已有的缓存
 * （开发机与既有安装不动）；全新安装落到 APP_DATA_DIR 下——打包后的 .app 里
 * Resources 目录是只读的，模型必须写进用户数据目录才下载得动。
 */
export function resolveModelCacheDir(
  env: NodeJS.ProcessEnv,
  cwd: string,
  asrHome: string,
  dataDir: string
): string {
  const explicit = env.MODELSCOPE_CACHE?.trim();
  if (explicit) return resolve(cwd, explicit);
  const legacy = join(asrHome, ".modelscope_cache");
  if (existsSync(legacy)) return legacy;
  return join(dataDir, ".modelscope_cache");
}

// Type4Me 的 qwen3-asr-server 由 Type4Me 启动时会带上这个热词文件；工作台自己的实例默认复用同一份。
function defaultType4meHotwordsFile(platform: NodeJS.Platform): string | undefined {
  if (platform !== "darwin") return undefined;
  return join(homedir(), "Library", "Application Support", "Type4Me", "hotwords.txt");
}

function readType4mePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`TYPE4ME_ASR_PORT 必须是 1-65535 的数字，请检查 .env。当前值：${value}`);
  }
  return parsed;
}

function readFunasrDevice(value: string): FunasrDevice {
  if (value === "auto" || value === "cpu" || value === "mps") return value;
  throw new Error(`FUNASR_DEVICE 必须是 auto、cpu 或 mps。当前值：${value}`);
}

function readPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`APP_PORT 必须是 1-65535 的数字，请检查 .env。当前值：${value}`);
  }
  return parsed;
}

function readPositiveNumber(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} 必须是大于 0 的数字，请检查 .env。当前值：${value}`);
  }
  return parsed;
}
