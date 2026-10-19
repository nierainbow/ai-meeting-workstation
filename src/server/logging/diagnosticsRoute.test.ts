import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrashStore } from "./crashStore";
import { createDiagnosticsRouter } from "./diagnosticsRoute";

const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";

describe("diagnosticsRoute", () => {
  let tempDir: string;
  let logsDir: string;
  let server: Server;
  let baseUrl: string;
  let crashStore: CrashStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "diagnostics-route-"));
    logsDir = join(tempDir, "logs");
    crashStore = new CrashStore(logsDir);
    // 模拟一次「故意崩溃」被进程级处理器捕获并落盘。
    crashStore.record("uncaughtException", new Error("boom: deliberate test crash"));
    // 抓一条含密钥的 console 日志，验证导出时被脱敏。
    writeFileSync(join(logsDir, "app-2026-01-01.log"), "info token=" + secret + " done\n");

    const router = createDiagnosticsRouter({
      logsDir,
      crashStore,
      runDiagnostics: async () => ({ title: "AI Discussion Doctor", items: [], ok: true, issueCount: 0 }),
      getAppVersion: () => "9.9.9-test",
      extraEnv: { dataDir: tempDir }
    } as Parameters<typeof createDiagnosticsRouter>[0]);

    const app = express();
    app.use("/api/diagnostics", router);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not start");
    baseUrl = "http://127.0.0.1:" + address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists recorded crashes via /crashes", async () => {
    const res = await fetch(baseUrl + "/api/diagnostics/crashes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; records: unknown[] };
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.records)).toBe(true);
  });

  it("export produces a valid, self-contained, redacted diagnostics zip (download, not upload)", async () => {
    const res = await fetch(baseUrl + "/api/diagnostics/export");
    expect(res.status).toBe(200);
    // 必须是下载（不自动上传）：响应头声明 attachment。
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(res.headers.get("content-type")).toContain("application/zip");

    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // 本地校验 zip 结构合法（unzip -t）。
    const zipPath = join(tempDir, "diag.zip");
    writeFileSync(zipPath, buffer);
    const { execSync } = await import("node:child_process");
    const verify = execSync('unzip -t "' + zipPath + '"', { encoding: "utf-8" });
    expect(verify).toContain("No errors detected");
    // 关键条目齐全。
    const list = execSync('unzip -l "' + zipPath + '"', { encoding: "utf-8" });
    for (const name of ["manifest.json", "environment.json", "doctor.json", "crashes.json", "logs/app-2026-01-01.log"]) {
      expect(list).toContain(name);
    }
    // 导出的日志里密钥被擦除，绝不以明文出现在诊断包。
    const logEntry = execSync('unzip -p "' + zipPath + '" "logs/app-2026-01-01.log"', { encoding: "utf-8" });
    expect(logEntry).not.toContain(secret);
    expect(logEntry).toContain("token=[REDACTED]");
  });
});
