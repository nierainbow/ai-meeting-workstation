import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { customerProfileSchema, settingsUpdateSchema } from "../shared/schemas";
import { AudioGateway } from "./audio/audioGateway";
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
import { ensureStoragePaths } from "./storage/paths";
import { EventHub } from "./ws/eventHub";

const config = loadServerConfig();
const storagePaths = ensureStoragePaths(config);
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
  }
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
  }
});
const demoWorkspace = new DemoWorkspace({
  repository: demoRepository,
  memoryStore: demoMemoryStore,
  funasrFileTranscriber: demoFunasrFileTranscriber,
  eventHub,
  storagePaths: demoStoragePaths,
  fallbackAudioPath: resolve("assets/demo/chengyuan-tech-fallback-open-kokoro.wav")
});

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
    mode: config.defaultMode
  });
});

app.get("/api/config", (_request, response) => {
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
    settings: settingsStore.publicSettings()
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
    storagePaths: demoStoragePaths
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
    storagePaths
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
  const backendNote = secretStatus.available ? "" : "（不可用，本次运行使用进程内内存）";
  console.log(`密钥存储后端：${secretStatus.backend}${backendNote}`);
  if (secretStatus.plaintextOnDisk) {
    console.warn(`[安全提醒] 检测到 ${settingsStore.settingsPath} 仍存在明文密钥，已尝试自动迁移到系统钥匙串。`);
  }
  for (const reminder of secretStatus.rotateReminder) console.warn(reminder);
});
