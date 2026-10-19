import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact";

export type CrashKind = "uncaughtException" | "unhandledRejection";

export type CrashRecord = {
  id: string;
  ts: string;
  kind: CrashKind;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
};

/**
 * 崩溃记录环：把进程级崩溃（uncaughtException / unhandledRejection）写入
 * .local-data/logs/crashes.json（同步，因为崩溃处理器里不能依赖异步写入）。
 * 保留最近 maxRecords 条，超出覆盖最旧的。
 *
 * 注意：记录里所有字段都会过 redact，绝不落密钥；context 由调用方传入时也在此再擦一遍。
 */
export class CrashStore {
  private readonly filePath: string;
  private readonly maxRecords: number;

  constructor(logsDir: string, fileName = "crashes.json", maxRecords = 50) {
    this.filePath = join(logsDir, fileName);
    this.maxRecords = maxRecords;
    mkdirSync(logsDir, { recursive: true });
  }

  record(kind: CrashKind, error: unknown, context?: Record<string, unknown>): CrashRecord {
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "unknown crash");
    const record: CrashRecord = {
      id: CrashStore.makeId(),
      ts: new Date().toISOString(),
      kind,
      message: err.message,
      stack: err.stack
    };
    if (context) {
      record.context = redact(context) as Record<string, unknown>;
    }
    const all = this.read().concat(record).slice(-this.maxRecords);
    // 同步写：崩溃时异步不可靠。
    writeFileSync(this.filePath, JSON.stringify(all, null, 2));
    return record;
  }

  list(): CrashRecord[] {
    return this.read();
  }

  count(): number {
    return this.read().length;
  }

  clear(): void {
    writeFileSync(this.filePath, "[]");
  }

  private read(): CrashRecord[] {
    try {
      const raw = readFileSync(this.filePath, "utf8").trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CrashRecord[]) : [];
    } catch {
      return [];
    }
  }

  private static makeId(): string {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
}
