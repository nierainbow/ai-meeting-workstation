import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "./logger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-logger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function latestLogFile(): string {
  const files = readdirSync(dir).filter((f) => f.startsWith("app-") && f.endsWith(".log")).sort();
  return files.length ? join(dir, files[files.length - 1]) : "";
}

describe("StructuredLogger", () => {
  it("writes redacted JSON lines to .local-data style logs dir", async () => {
    const logger = new StructuredLogger(dir);
    logger.info("启动服务", { port: 8787, volcengineApiKey: "sk-secret" });
    logger.error("转写失败", { discussionId: "abc", stack: "x".repeat(50) });
    await logger.flush();

    const content = readFileSync(latestLogFile(), "utf8").trim().split("\n");
    expect(content.length).toBe(2);

    const first = JSON.parse(content[0]);
    expect(first.level).toBe("info");
    expect(first.msg).toBe("启动服务");
    expect(first.port).toBe(8787);
    // 敏感字段被擦除
    expect(first.volcengineApiKey).toBe("[REDACTED]");

    const second = JSON.parse(content[1]);
    expect(second.level).toBe("error");
    expect(second.discussionId).toBe("abc");
  });

  it("respects minLevel", async () => {
    const logger = new StructuredLogger(dir, { minLevel: "warn" });
    logger.debug("不应出现");
    logger.info("也不应出现");
    logger.warn("应该出现");
    await logger.flush();

    const content = readFileSync(latestLogFile(), "utf8").trim().split("\n");
    expect(content.length).toBe(1);
    expect(JSON.parse(content[0]).level).toBe("warn");
  });

  it("truncates long strings (no full transcription)", async () => {
    const logger = new StructuredLogger(dir, { maxStringLength: 20 });
    logger.info("转写片段", { transcript: "一".repeat(1000) });
    await logger.flush();
    const first = JSON.parse(readFileSync(latestLogFile(), "utf8").trim().split("\n")[0]);
    expect((first.transcript as string).length).toBeLessThan(1000);
    expect(first.transcript).toContain("truncated");
  });

  it("creates a dated file name under logs dir", async () => {
    const logger = new StructuredLogger(dir);
    logger.info("hi");
    await logger.flush();
    const file = latestLogFile();
    expect(file).toMatch(/app-\d{4}-\d{2}-\d{2}\.log$/);
  });
});
