import { Router } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosticReport } from "../config/diagnostics";
import type { CrashRecord, CrashStore } from "./crashStore";
import { redactSecretsInText } from "./redact";
import { buildZip } from "./zip";

export type DiagnosticsRouterDeps = {
  logsDir: string;
  crashStore: CrashStore;
  runDiagnostics: (env?: NodeJS.ProcessEnv, cwd?: string) => Promise<DiagnosticReport>;
  getAppVersion: () => string | null;
  /** 额外要塞进环境摘要的、非敏感的运行时信息（如 dataDir）。 */
  extraEnv?: Record<string, unknown>;
};

/** 只报告「是否配置」的敏感环境变量名；诊断包里绝不出现任何真实值。 */
const SENSITIVE_ENV_NAMES = [
  "VOLCENGINE_ASR_API_KEY",
  "VOLCENGINE_ASR_RESOURCE_ID",
  "VOLCENGINE_ASR_ENDPOINT",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ARK_API_KEY",
  "CODEX_OPENAI_API_KEY",
  "VOLCENGINE_BRAIN_API_KEY"
];

function buildEnvironmentSummary(deps: DiagnosticsRouterDeps): Record<string, unknown> {
  const env = process.env;
  const secretsPresent: Record<string, boolean> = {};
  for (const name of SENSITIVE_ENV_NAMES) {
    secretsPresent[name] = Boolean(env[name] && String(env[name]).trim());
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round((process.memoryUsage().rss ?? 0) / (1024 * 1024)),
    envVarCount: Object.keys(env).length,
    secretsPresent,
    ...(deps.extraEnv ?? {})
  };
}

function readRecentLogs(logsDir: string, maxFiles = 14): { name: string; data: Buffer }[] {
  let files: string[] = [];
  try {
    files = readdirSync(logsDir)
      .filter((f) => f.startsWith("app-") && f.endsWith(".log"))
      .sort()
      .slice(-maxFiles);
  } catch {
    return [];
  }
  return files.map((name) => {
    const raw = readFileSync(join(logsDir, name), "utf8");
    // 再擦一遍：结构化字段已由 logger 脱敏，这里兜底处理 console 捕获到的原始文本。
    const cleaned = raw
      .split("\n")
      .map((line) => redactSecretsInText(line))
      .join("\n");
    return { name: "logs/" + name, data: Buffer.from(cleaned, "utf8") };
  });
}

export function createDiagnosticsRouter(deps: DiagnosticsRouterDeps): Router {
  const router = Router();

  router.get("/crashes", (_request, response) => {
    const records: CrashRecord[] = deps.crashStore.list();
    response.json({ count: records.length, records });
  });

  router.get("/export", async (_request, response) => {
    const generatedAt = new Date();
    const version = deps.getAppVersion();
    const doctor = await deps.runDiagnostics();
    const crashes = deps.crashStore.list();

    const manifest = {
      appName: "ai-meeting-workstation",
      generatedAt: generatedAt.toISOString(),
      appVersion: version,
      purpose: "本地诊断包：用于反馈问题时附带，不含任何密钥，也不含转写全文。",
      redactionNote: "所有敏感字段已擦除；日志超长字符串已截断；环境变量只报告是否配置，不报告值。",
      includes: ["manifest.json", "environment.json", "doctor.json", "crashes.json", "logs/*"]
    };

    const environment = buildEnvironmentSummary(deps);

    const entries = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") },
      { name: "environment.json", data: Buffer.from(JSON.stringify(environment, null, 2), "utf8") },
      { name: "doctor.json", data: Buffer.from(JSON.stringify(doctor, null, 2), "utf8") },
      { name: "crashes.json", data: Buffer.from(JSON.stringify(crashes, null, 2), "utf8") },
      ...readRecentLogs(deps.logsDir)
    ];

    const zipBuffer = buildZip(entries);
    const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
    const fileName = "ai-meeting-workstation-diagnostics-" + stamp + ".zip";

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", 'attachment; filename="' + fileName + '"');
    response.setHeader("Cache-Control", "no-store");
    response.send(zipBuffer);
  });

  return router;
}
