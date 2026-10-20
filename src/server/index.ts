import "dotenv/config";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { customerProfileSchema, settingsUpdateSchema } from "../shared/schemas";
import { AudioGateway } from "./audio/audioGateway";
import { VoiceprintSidecarClient } from "./audio/voiceprintSidecar";
import { FunasrFileTranscriber } from "./asr/funasrFile";
import { MockAsrService } from "./asr/mockAsr";
import { VolcengineAsrProvider } from "./asr/volcengineAsr";
import { VolcengineFileTranscriber } from "./asr/volcengineFile";
import { Type4MeFileTranscriber } from "./asr/type4meFile";
import { Type4meAsrProvider } from "./asr/type4meLive";
import { BrainProviderRegistry } from "./codex/brainRegistry";
import { loadServerConfig } from "./config/serverConfig";
import { openDatabase } from "./db/database";
import { DemoWorkspace, createDemoStoragePaths } from "./demo/demoWorkspace";
import { createDemoRouter } from "./demo/routes";
import { createDiscussionRouter } from "./discussions/routes";
import { DiscussionRepository } from "./discussions/repository";
import { MemoryStore } from "./memory/memoryStore";
import { LocalSettingsStore } from "./settings/localSettings";
import { ModelDownloader, MODEL_TIER_LABELS, MODEL_TIER_SUMMARIES, TIER_ASSETS, detectMissingAssets, isAssetInstalled } from "./models/modelDownloader";
import { ModelOnboardingStore, needsModelOnboarding } from "./models/onboarding";
import { createModelsRouter } from "./models/routes";
import type { ModelTierId } from "../shared/types";
import { ensureStoragePaths } from "./storage/paths";
import { runDiagnostics } from "./config/diagnostics";
import { CrashStore } from "./logging/crashStore";
import { createDiagnosticsRouter } from "./logging/diagnosticsRoute";
import { StructuredLogger } from "./logging/logger";
import { EventHub } from "./ws/eventHub";

/**
 * 前端地址栏里的 ?appVersion=（main.rs 启动时注入）只用来比对，不做任何路由。
 * 只接受 x.y.z[-pre][+build] 形态，其他值一律视为缺失，避免把任意串回显给界面。
 */
function requestsVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // 与服务端自己上报的版本同形状：预发布段和 +构建段可以同时出现（0.9.1-rc.1+build7）。
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

/**
 * 进程内实际运行的版本：优先 APP_VERSION（Tauri 壳注入），否则读工作目录下的 package.json。
 * 两者都拿不到时返回 null，健康检查本身照常可用。
 */
function runningVersion(): string | null {
  const injected = process.env.APP_VERSION?.trim();
  if (injected) return injected;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

const config = loadServerConfig();
const storagePaths = ensureStoragePaths(config);

// 本地日志与崩溃收集：结构化日志落 .local-data/logs/（脱敏），崩溃写入环缓冲并挂进程级处理器。
const logsDir = storagePaths.logsDir ?? join(storagePaths.dataDir, "logs");
const logger = new StructuredLogger(logsDir);
const crashStore = new CrashStore(logsDir);
// 把既有 console 输出也汇入结构化日志（脱敏后落盘），确保诊断包信息完整。
logger.attachConsoleTee();
logger.info("server starting", { version: runningVersion(), dataDir: storagePaths.dataDir });

process.on("uncaughtException", (error: Error) => {
  crashStore.record("uncaughtException", error);
  console.error("[崩溃] uncaughtException:", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  crashStore.record("unhandledRejection", reason);
  console.error("[崩溃] unhandledRejection:", reason);
});

const db = openDatabase(storagePaths.databasePath);
const repository = new DiscussionRepository(db);
const eventHub = new EventHub();
const settingsStore = new LocalSettingsStore(storagePaths);
const memoryStore = new MemoryStore(storagePaths);
const brainRegistry = new BrainProviderRegistry(settingsStore);
const mockAsr = new MockAsrService(repository, eventHub);
const funasrFileTranscriber = new FunasrFileTranscriber(
  { repository, storagePaths },
  {
    pythonPath: config.funasrPythonPath,
    asrHome: config.funasrAsrHome,
    modelCacheDir: config.modelCache.dir,
    timeoutMs: config.funasrFileTimeoutMs,
    device: config.funasrDevice,
    hotwordFile: config.funasrHotwordFile
  }
);
const getVolcengineFileTranscriber = (targetRepository = repository, targetStoragePaths = storagePaths) => {
  const settings = settingsStore.load();
  return new VolcengineFileTranscriber(
    { repository: targetRepository, storagePaths: targetStoragePaths },
    { apiKey: settings.volcengineApiKey || config.volcengineAsr.apiKey }
  );
};
// 声纹 sidecar 客户端（VOICEPRINT_SIDECAR_URL 未配置则跳过实时认人，优雅降级）。
const voiceprintSidecar = config.voiceprintSidecarUrl
  ? new VoiceprintSidecarClient(config.voiceprintSidecarUrl)
  : undefined;

const audioGateway = new AudioGateway({
  repository,
  eventHub,
  storagePaths,
  getAsrProvider: (discussion) => {
    if (discussion.asrProvider === "type4me" || discussion.asrProvider === "type4me-live") {
      return type4meLiveAsrProvider();
    }
    if (discussion.asrProvider !== "volcengine") return undefined;
    const settings = settingsStore.load();
    return new VolcengineAsrProvider({
      apiKey: settings.volcengineApiKey || config.volcengineAsr.apiKey,
      resourceId: settings.volcengineResourceId || config.volcengineAsr.resourceId,
      endpoint: settings.volcengineEndpoint || config.volcengineAsr.endpoint
    });
  },
  voiceprintSidecar
});
const demoStoragePaths = createDemoStoragePaths(storagePaths);
const demoDb = openDatabase(demoStoragePaths.databasePath);
const demoRepository = new DiscussionRepository(demoDb);
const demoMemoryStore = new MemoryStore(demoStoragePaths);
const demoMockAsr = new MockAsrService(demoRepository, eventHub);
const demoFunasrFileTranscriber = new FunasrFileTranscriber(
  { repository: demoRepository, storagePaths: demoStoragePaths },
  {
    pythonPath: config.funasrPythonPath,
    asrHome: config.funasrAsrHome,
    modelCacheDir: config.modelCache.dir,
    timeoutMs: config.funasrFileTimeoutMs,
    device: config.funasrDevice,
    hotwordFile: config.funasrHotwordFile
  }
);
const type4meFileTranscriberFor = (targetRepository: DiscussionRepository, targetStoragePaths: typeof storagePaths) =>
  new Type4MeFileTranscriber(
    { repository: targetRepository, storagePaths: targetStoragePaths },
    {
      serverPath: config.type4meAsr.serverPath,
      modelPath: config.type4meAsr.modelPath,
      port: config.type4meAsr.port,
      hotwordsFile: config.type4meAsr.hotwordsFile,
      timeoutMs: config.type4meAsr.fileTimeoutMs
    }
  );
const type4meFileTranscriber = type4meFileTranscriberFor(repository, storagePaths);
const type4meLiveAsrProvider = () =>
  new Type4meAsrProvider({
    serverPath: config.type4meAsr.serverPath,
    modelPath: config.type4meAsr.modelPath,
    port: config.type4meAsr.port,
    hotwordsFile: config.type4meAsr.hotwordsFile
  });
const demoAudioGateway = new AudioGateway({
  repository: demoRepository,
  eventHub,
  storagePaths: demoStoragePaths,
  socketPath: "/demo-audio",
  getAsrProvider: (discussion) => {
    if (discussion.asrProvider === "type4me" || discussion.asrProvider === "type4me-live") {
      return type4meLiveAsrProvider();
    }
    if (discussion.asrProvider !== "volcengine") return undefined;
    const settings = settingsStore.load();
    return new VolcengineAsrProvider({
      apiKey: settings.volcengineApiKey || config.volcengineAsr.apiKey,
      resourceId: settings.volcengineResourceId || config.volcengineAsr.resourceId,
      endpoint: settings.volcengineEndpoint || config.volcengineAsr.endpoint
    });
  },
  voiceprintSidecar
});
const demoWorkspace = new DemoWorkspace({
  repository: demoRepository,
  memoryStore: demoMemoryStore,
  funasrFileTranscriber: demoFunasrFileTranscriber,
  eventHub,
  storagePaths: demoStoragePaths,
  fallbackAudioPath: resolve("assets/demo/chengyuan-tech-fallback-open-kokoro.wav")
});

const modelDownloader = new ModelDownloader({
  cacheDir: config.modelCache.dir,
  fileTimeoutMs: config.modelCache.fileTimeoutMs
});
const modelOnboarding = new ModelOnboardingStore(storagePaths.dataDir);

const app = express();
const server = createServer(app);
eventHub.attach(server);
audioGateway.attach(server);
demoAudioGateway.attach(server);

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "ai-meeting-workstation",
    mode: config.defaultMode,
    // 更新通道验收用：health 里的版本号必须是**这次启动真正跑起来的**版本。
    // Tauri 侧会请求它并与前端地址栏里的 ?appVersion= 比对，
    // 两者一致才说明新包已经接管（见 updater.rs::health_version）。
    version: runningVersion()
  });
});

app.get("/api/config", (_request, response) => {
  // 静态托管（桌面壳）与 express 同源，浏览器里可能长期缓存 /api/config：
  // 更新后不重新拉配置就会继续显示旧版本号，所以这里显式禁掉缓存。
  response.setHeader("Cache-Control", "no-store");
  const settings = settingsStore.load();
  const volcengineAsr = new VolcengineAsrProvider({
    apiKey: settings.volcengineApiKey || config.volcengineAsr.apiKey,
    resourceId: settings.volcengineResourceId || config.volcengineAsr.resourceId,
    endpoint: settings.volcengineEndpoint || config.volcengineAsr.endpoint
  });
  response.json({
    defaultProjectPath: config.defaultProjectPath,
    defaultMode: config.defaultMode,
    asrConfigured: volcengineAsr.checkCredentials().ok,
    codexProvider: config.codexProvider,
    settings: settingsStore.publicSettings(),
    // 首启模型向导：缺少本地模型且没跳过时才需要展示，见 ModelSetupStatusDto.needsSetup。
    models: {
      ...modelDownloader.status(),
      cacheDir: config.modelCache.dir,
      missingAssets: detectMissingAssets(config.modelCache.dir),
      needsSetup: needsModelOnboarding({
        missingAssets: detectMissingAssets(config.modelCache.dir),
        state: modelOnboarding.read()
      }),
      tiers: (Object.keys(TIER_ASSETS) as ModelTierId[]).map((tier) => ({
        tier,
        label: MODEL_TIER_LABELS[tier],
        summary: MODEL_TIER_SUMMARIES[tier],
        assets: TIER_ASSETS[tier],
        installed: TIER_ASSETS[tier].every((key) => isAssetInstalled(config.modelCache.dir, key))
      }))
    },
    // 更新通道：当前真正运行的版本 + 客户端地址栏里的版本。
    // 两者不一致意味着窗口还是旧页面（更新已装好但没重启），界面要提示重启而不是假装生效。
    update: {
      runningVersion: runningVersion(),
      clientVersion: requestsVersion(_request.query.appVersion)
    }
  });
});

app.get("/api/settings", (_request, response) => {
  response.json(settingsStore.publicSettings());
});

app.put("/api/settings", (request, response) => {
  const parsed = settingsUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  response.json(settingsStore.save(parsed.data));
});

app.get("/api/customers", (_request, response) => {
  response.json(memoryStore.listCustomers());
});

app.get("/api/customers/:id", (request, response) => {
  try {
    response.json(memoryStore.getCustomer(request.params.id, settingsStore.load().recentMemoryCount));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "客户不存在。" });
  }
});

app.post("/api/customers", (request, response) => {
  const parsed = customerProfileSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    response.status(201).json(memoryStore.saveCustomer(parsed.data));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "保存客户档案失败。" });
  }
});

app.use(
  "/api/demo",
  createDemoRouter({
    workspace: demoWorkspace,
    memoryStore: demoMemoryStore,
    settingsStore
  })
);

app.use(
  "/api/demo/discussions",
  createDiscussionRouter({
    repository: demoRepository,
    mockAsr: demoMockAsr,
    brainRegistry,
    settingsStore,
    memoryStore: demoMemoryStore,
    funasrFileTranscriber: demoFunasrFileTranscriber,
    getVolcengineFileTranscriber: () => getVolcengineFileTranscriber(demoRepository, demoStoragePaths),
    type4meFileTranscriber: type4meFileTranscriberFor(demoRepository, demoStoragePaths),
    eventHub,
    storagePaths: demoStoragePaths,
    voiceprintSidecar
  })
);

app.use(
  "/api/discussions",
  createDiscussionRouter({
    repository,
    mockAsr,
    brainRegistry,
    settingsStore,
    memoryStore,
    funasrFileTranscriber,
    getVolcengineFileTranscriber: () => getVolcengineFileTranscriber(),
    type4meFileTranscriber,
    eventHub,
    storagePaths,
    voiceprintSidecar
  })
);

app.use(
  "/api/models",
  createModelsRouter({ downloader: modelDownloader, cacheDir: config.modelCache.dir, onboarding: modelOnboarding })
);

// 本地诊断包：崩溃清单 + 一键导出（脱敏，不自动上传）。详见 src/server/logging/diagnosticsRoute.ts。
app.use(
  "/api/diagnostics",
  createDiagnosticsRouter({
    logsDir,
    crashStore,
    runDiagnostics,
    getAppVersion: runningVersion,
    extraEnv: { dataDir: storagePaths.dataDir }
  })
);

// 桌面壳（Tauri）与打包发布都靠这一层把 dist/client 交给同源的 8787 端口；
// 开发模式下该目录通常不存在，此时保持旧的 vite 5173 代理行为不变。
if (existsSync(config.clientDistDir)) {
  app.use(express.static(config.clientDistDir));
  app.get(/^(?!\/api|\/audio|\/demo-audio|\/ws).*/, (_request, response) => {
    response.sendFile(join(config.clientDistDir, "index.html"));
  });
  console.log(`静态客户端目录：${config.clientDistDir}`);
}

const secretStatus = settingsStore.secretStatus();

server.listen(config.port, config.host, () => {
  console.log(`AI Meeting Workstation server listening on http://${config.host}:${config.port}`);
  logger.info("server listening", { host: config.host, port: config.port, mode: config.defaultMode });
  const backendNote = secretStatus.available ? "" : "（不可用，本次运行使用进程内内存）";
  console.log(`密钥存储后端：${secretStatus.backend}${backendNote}`);
  if (secretStatus.plaintextOnDisk) {
    console.warn(`[安全提醒] 检测到 ${settingsStore.settingsPath} 仍存在明文密钥，已尝试自动迁移到系统钥匙串。`);
  }
  for (const reminder of secretStatus.rotateReminder) console.warn(reminder);
});
