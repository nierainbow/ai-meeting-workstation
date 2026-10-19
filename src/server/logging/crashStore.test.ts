import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrashStore } from "./crashStore";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-crash-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CrashStore", () => {
  it("records a crash as a JSON array entry", () => {
    const store = new CrashStore(dir);
    const rec = store.record("uncaughtException", new Error("boom"), { phase: "startup" });
    expect(rec.kind).toBe("uncaughtException");
    expect(rec.message).toBe("boom");
    expect(rec.stack).toBeTruthy();

    const raw = JSON.parse(readFileSync(join(dir, "crashes.json"), "utf8"));
    expect(raw.length).toBe(1);
    expect(raw[0].message).toBe("boom");
    expect(raw[0].context.phase).toBe("startup");
  });

  it("redacts secrets in crash context", () => {
    const store = new CrashStore(dir);
    store.record("unhandledRejection", new Error("x"), { apiKey: "sk-secret" });
    const raw = JSON.parse(readFileSync(join(dir, "crashes.json"), "utf8"));
    expect(raw[0].context.apiKey).toBe("[REDACTED]");
  });

  it("caps the ring buffer at maxRecords", () => {
    const store = new CrashStore(dir, "crashes.json", 3);
    for (let i = 0; i < 10; i++) store.record("uncaughtException", new Error("e" + i));
    const raw = JSON.parse(readFileSync(join(dir, "crashes.json"), "utf8"));
    expect(raw.length).toBe(3);
    expect(raw[raw.length - 1].message).toBe("e9");
  });

  it("survives un-Error values", () => {
    const store = new CrashStore(dir);
    store.record("unhandledRejection", "just a string");
    const raw = JSON.parse(readFileSync(join(dir, "crashes.json"), "utf8"));
    expect(raw[0].message).toBe("just a string");
  });

  it("count and list report persisted records", () => {
    const store = new CrashStore(dir);
    store.record("uncaughtException", new Error("a"));
    store.record("uncaughtException", new Error("b"));
    expect(store.count()).toBe(2);
    expect(store.list().length).toBe(2);
  });
});
