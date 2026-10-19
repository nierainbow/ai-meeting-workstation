import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoragePaths } from "../storage/paths";
import { LocalSettingsStore } from "./localSettings";
import { KEYCHAIN_REF_PREFIX, keychainRef, type SecretStore } from "./keychain";

class FakeSecretStore implements SecretStore {
  readonly backend: "keychain" | "dpapi" | "file" = "keychain";
  readonly available: boolean;
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];
  failSet = false;

  constructor(available = true) {
    this.available = available;
  }

  get(account: string): string {
    if (!this.available) return "";
    return this.values.get(account) ?? "";
  }

  set(account: string, value: string): void {
    // 与真实 DPAPI 桩一致：不可用时写入也必须失败，上层才会回退到内存态。
    if (!this.available || this.failSet) throw new Error("钥匙串写入失败");
    this.values.set(account, value);
  }

  remove(account: string): void {
    this.removed.push(account);
    this.values.delete(account);
  }
}

function createStore(secrets: SecretStore): { store: LocalSettingsStore; storagePaths: StoragePaths; settingsPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "local-settings-keychain-"));
  const storagePaths = {
    dataDir,
    databasePath: join(dataDir, "test.db"),
    discussionsDir: join(dataDir, "discussions")
  };
  mkdirSync(storagePaths.discussionsDir, { recursive: true });
  const store = new LocalSettingsStore(storagePaths, {}, secrets);
  return { store, storagePaths, settingsPath: store.settingsPath };
}

function writeSettings(settingsPath: string, value: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf8");
}

function readDisk(settingsPath: string): Record<string, string> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, string>;
}

let tempDirs: string[] = [];

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("LocalSettingsStore 密钥迁移", () => {
  let secrets: FakeSecretStore;

  beforeEach(() => {
    secrets = new FakeSecretStore();
  });

  it("首次启动把明文 Key 迁进钥匙串，磁盘只留引用", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "settings-migrate-")));
    const settingsPath = join(dir, "settings.local.json");
    writeSettings(settingsPath, {
      brainProvider: "volcengine",
      volcengineBrainApiKey: "ark-plain-secret",
      deepseekApiKey: "sk-plain-secret"
    });
    const store = new LocalSettingsStore(
      { dataDir: dir, databasePath: join(dir, "test.db"), discussionsDir: join(dir, "discussions") },
      {},
      secrets
    );

    const loaded = store.load();

    expect(loaded.volcengineBrainApiKey).toBe("ark-plain-secret");
    expect(loaded.deepseekApiKey).toBe("sk-plain-secret");
    expect(secrets.values.get("volcengineBrainApiKey")).toBe("ark-plain-secret");
    expect(secrets.values.get("deepseekApiKey")).toBe("sk-plain-secret");
    const disk = readDisk(settingsPath);
    expect(disk.volcengineBrainApiKey).toBe(keychainRef("volcengineBrainApiKey"));
    expect(disk.deepseekApiKey).toBe(keychainRef("deepseekApiKey"));
    expect(readFileSync(settingsPath, "utf8")).not.toContain("ark-plain-secret");
    expect(store.secretStatus().plaintextOnDisk).toBe(false);
    expect(store.secretStatus().rotateReminder).toEqual([]);
  });

  it("保存新 Key 后磁盘无明文，读回的是钥匙串里的真值", () => {
    const { store, settingsPath } = createStore(secrets);
    track(store.settingsPath.replace("/settings.local.json", ""));

    store.save({ volcengineBrainApiKey: "ark-new-secret" } as never);
    const disk = readDisk(settingsPath);

    expect(disk.volcengineBrainApiKey).toBe(keychainRef("volcengineBrainApiKey"));
    expect(readFileSync(settingsPath, "utf8")).not.toContain("ark-new-secret");
    expect(store.load().volcengineBrainApiKey).toBe("ark-new-secret");
    expect(store.publicSettings().keys.volcengineBrain).toBe(true);
  });

  it("保存空串会清除钥匙串条目并报告未配置", () => {
    const { store, settingsPath } = createStore(secrets);
    track(store.settingsPath.replace("/settings.local.json", ""));
    store.save({ volcengineBrainApiKey: "ark-to-clear" } as never);

    store.save({ volcengineBrainApiKey: "" } as never);

    expect(secrets.removed).toContain("volcengineBrainApiKey");
    expect(secrets.values.has("volcengineBrainApiKey")).toBe(false);
    expect(store.load().volcengineBrainApiKey).toBe("");
    expect(store.publicSettings().keys.volcengineBrain).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).not.toContain("ark-to-clear");
  });

  it("磁盘残留明文时 secretStatus 给出轮换提醒", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "settings-plain-")));
    const settingsPath = join(dir, "settings.local.json");
    writeSettings(settingsPath, { volcengineBrainApiKey: "ark-plain-secret" });
    const store = new LocalSettingsStore(
      { dataDir: dir, databasePath: join(dir, "test.db"), discussionsDir: join(dir, "discussions") },
      {},
      new FakeSecretStore().failSet ? secrets : (() => {
        const broken = new FakeSecretStore();
        broken.failSet = true;
        return broken;
      })()
    );

    const status = store.secretStatus();

    expect(status.plaintextOnDisk).toBe(true);
    expect(status.rotateReminder.length).toBeGreaterThan(0);
    expect(status.rotateReminder.join(" ")).toContain("轮换");
    // 迁移失败时不能把明文抹掉
    expect(readDisk(settingsPath).volcengineBrainApiKey).toBe("ark-plain-secret");
  });

  it("钥匙串不可用时回退到进程内内存，且不会把明文写回磁盘", () => {
    const unavailable = new FakeSecretStore(false);
    const { store, settingsPath } = createStore(unavailable);
    track(store.settingsPath.replace("/settings.local.json", ""));

    store.save({ volcengineBrainApiKey: "ark-memory-only" } as never);
    const loaded = store.load();

    expect(loaded.volcengineBrainApiKey).toBe("ark-memory-only");
    expect(readFileSync(settingsPath, "utf8")).not.toContain("ark-memory-only");
    expect(readDisk(settingsPath).volcengineBrainApiKey).toBe(keychainRef("volcengineBrainApiKey"));
    expect(store.secretStatus().available).toBe(false);
  });

  it("非密钥字段与密钥引用可以共存，互不影响", () => {
    const { store, settingsPath } = createStore(secrets);
    track(store.settingsPath.replace("/settings.local.json", ""));
    store.save({ volcengineBrainApiKey: "ark-keep", volcengineBrainModel: "ark-code-latest" } as never);

    store.save({ volcengineBrainModel: "doubao-seed-2.1-pro" } as never);

    const loaded = store.load();
    expect(loaded.volcengineBrainModel).toBe("doubao-seed-2.1-pro");
    expect(loaded.volcengineBrainApiKey).toBe("ark-keep");
    expect(readDisk(settingsPath).volcengineBrainApiKey).toBe(keychainRef("volcengineBrainApiKey"));
    expect(KEYCHAIN_REF_PREFIX).toBe("keychain:");
  });
});
