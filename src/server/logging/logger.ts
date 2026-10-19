import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { redact, redactSecretsInText } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export type LoggerOptions = {
  minLevel?: LogLevel;
  maxStringLength?: number;
  /** 最多保留多少天的日志文件，超出在每次写入时清理。0 表示不清理。 */
  maxDays?: number;
};

export type LogEntry = {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
};

/**
 * 结构化日志：把每条记录写成 JSON 行，落到 logsDir 下按天轮转的文件。
 * - 所有字段经过 redact：敏感字段名整段擦除，超长字符串截断（不落转写全文）。
 * - 同时镜像到 stdout（脱敏后的单行预览），方便开发期观察。
 * - 可选 attachConsoleTee：把全局 console.* 也汇入结构化日志，确保既有 console 输出不漏。
 */
export class StructuredLogger {
  private readonly logsDir: string;
  private readonly minLevel: LogLevel;
  private readonly maxStringLength: number;
  private readonly maxDays: number;
  private currentDate: string;
  private writeChain: Promise<void> = Promise.resolve();
  private consoleTeeAttached = false;

  constructor(logsDir: string, options: LoggerOptions = {}) {
    this.logsDir = logsDir;
    this.minLevel = options.minLevel ?? "info";
    this.maxStringLength = options.maxStringLength ?? 2000;
    this.maxDays = options.maxDays ?? 14;
    this.currentDate = StructuredLogger.todayLocal();
    void mkdir(this.logsDir, { recursive: true });
  }

  private static todayLocal(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  private fileNameFor(date: string): string {
    return "app-" + date + ".log";
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg
    };
    if (fields) {
      const clean = redact(fields, this.maxStringLength) as Record<string, unknown>;
      for (const [k, v] of Object.entries(clean)) entry[k] = v;
    }
    const line = JSON.stringify(entry) + "\n";

    const date = StructuredLogger.todayLocal();
    if (date !== this.currentDate) this.currentDate = date;

    const filePath = join(this.logsDir, this.fileNameFor(date));
    this.writeChain = this.writeChain
      .then(() => appendFile(filePath, line))
      .then(() => {
        if (this.maxDays > 0) void this.pruneOldFiles(date);
      })
      .catch(() => {
        // 写失败不应影响主流程；至多回退到 stderr。
        try {
          process.stderr.write("[logger] failed to append log line\n");
        } catch {
          /* ignore */
        }
      });

    this.mirrorToConsole(level, msg, entry);
  }

  // 直接写 stdout/stderr，绕开 console.*，避免 attachConsoleTee 包裹后产生递归。
  private mirrorToConsole(level: LogLevel, msg: string, entry: LogEntry): void {
    // 已挂 console tee 时，原始 console 输出与结构化落盘都已在 tee 里完成，这里不再重复打印到 stdout。
    if (this.consoleTeeAttached) return;
    const preview = msg + (Object.keys(entry).length > 3 ? " " + JSON.stringify(this.dropMeta(entry)) : "");
    const line = "[" + level + "] " + redactSecretsInText(preview) + "\n";
    if (level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  }

  private dropMeta(entry: LogEntry): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (k === "ts" || k === "level" || k === "msg") continue;
      out[k] = v;
    }
    return out;
  }

  private async pruneOldFiles(today: string): Promise<void> {
    try {
      const files = await readdir(this.logsDir);
      const dates = files
        .filter((f) => f.startsWith("app-") && f.endsWith(".log"))
        .map((f) => f.slice("app-".length, -".log".length))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const keepIndex = Math.max(0, dates.length - this.maxDays);
      const toRemove = dates.slice(0, keepIndex).filter((d) => d < today);
      await Promise.all(
        toRemove.map((d) => rm(join(this.logsDir, this.fileNameFor(d)), { force: true }).catch(() => undefined))
      );
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 等待所有缓冲写完成（进程退出前调用）。 */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * 把全局 console.* 也汇入结构化日志（仅副作用于当前进程，幂等）。
   * 确保既有 console 输出同样落到 .local-data/logs/ 并保持脱敏。
   */
  attachConsoleTee(): void {
    if (this.consoleTeeAttached) return;
    this.consoleTeeAttached = true;
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error
    };
    const tee = (level: LogLevel, args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");
      this.log(level, redactSecretsInText(text.slice(0, this.maxStringLength)));
    };
    console.log = (...args: unknown[]) => {
      original.log.apply(console, args);
      tee("info", args);
    };
    console.info = (...args: unknown[]) => {
      original.info.apply(console, args);
      tee("info", args);
    };
    console.warn = (...args: unknown[]) => {
      original.warn.apply(console, args);
      tee("warn", args);
    };
    console.error = (...args: unknown[]) => {
      original.error.apply(console, args);
      tee("error", args);
    };
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
