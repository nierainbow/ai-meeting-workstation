// T1.3 验收线束的纯逻辑单测：镜像 updater.rs 的 5 个 cargo test，
// 并用 simulateUpgradeLossless 证明「0.1.0 -> 0.1.1 平滑升级数据无损」这一验收标准。
//
// 之所以在 JS 里再写一遍：Rust 侧的 backup_data_dir_at 已经由 cargo test 覆盖，
// 但发布机之外（无 cargo / minisign）无法跑真·签名升级；本文件把「数据无损契约」
// 抽成与 Rust 完全一致的 Node 实现并单测，让验收可独立于工具链执行。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupDataDirAt,
  countFiles,
  simulateUpgradeLossless,
  parseProbeLines,
  findInstallResult,
  assertCheck,
  assertInstall,
} from "./verify-update-upgrade.mjs";

let root;
beforeAll(() => {
  root = mkTmp();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkTmp() {
  const dir = join(tmpdir(), "aimw-verify-test-" + process.pid + "-" + Date.now());
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 同步建一个带真实内容的 .local-data/（镜像 Rust 测试里的 seed_data_dir）。
function seedDataDir(base) {
  const data = join(base, ".local-data");
  mkdirSync(join(data, "tasks/t-1"), { recursive: true });
  writeFileSync(join(data, "settings.json"), JSON.stringify({ brain: "ark" }));
  writeFileSync(join(data, "tasks/t-1/transcript.md"), "# 会议\n一行内容");
  return data;
}

function exists(p) {
  return existsSync(p);
}

describe("备份契约（与 updater.rs backup_data_dir_at 一致）", () => {
  it("把 .local-data/ 复制到数据目录父级的 backups/ 下", () => {
    const base = join(root, "copy");
    mkdirSync(base, { recursive: true });
    const data = seedDataDir(base);
    const backup = backupDataDirAt(data, "0.1.1", null, 1);
    expect(backup.kind).toBe("backup");
    expect(backup.backupDir).toBe(join(base, "backups", "pre-update-0.1.1-1"));
    const copied = join(backup.backupDir, ".local-data");
    expect(countFiles(copied)).toBe(2);
    expect(readFileSync(join(copied, "tasks/t-1/transcript.md"), "utf8")).toBe("# 会议\n一行内容");
  });

  it("优先落在运行 .app 同级的 backups/", () => {
    const base = join(root, "app-sibling");
    mkdirSync(join(base, "data"), { recursive: true });
    const data = seedDataDir(join(base, "data"));
    const app = join(base, "Applications/AI Meeting Workstation.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    const backup = backupDataDirAt(data, "0.1.1", app, 1);
    expect(backup.kind).toBe("backup");
    expect(backup.backupDir).toBe(join(base, "Applications", "backups", "pre-update-0.1.1-1"));
    expect(exists(join(backup.backupDir, ".local-data/settings.json"))).toBe(true);
  });

  it("数据目录不存在时返回 none（全新安装不算备份失败）", () => {
    const data = join(root, "missing/.local-data");
    const backup = backupDataDirAt(data, "0.1.1", null, 1);
    expect(backup.kind).toBe("none");
  });

  it("backup 目录名按版本+timestamp，互不覆盖", () => {
    const d1 = seedDataDir(join(root, "x1"));
    const d2 = seedDataDir(join(root, "x2"));
    const a = backupDataDirAt(d1, "0.1.1", null, 1);
    const b = backupDataDirAt(d2, "0.1.2", null, 2);
    expect(a.kind).toBe("backup");
    expect(b.kind).toBe("backup");
    expect(a.backupDir).not.toBe(b.backupDir);
    expect(a.backupDir).toContain("pre-update-0.1.1-1");
    expect(b.backupDir).toContain("pre-update-0.1.2-2");
  });
});

describe("0.1.0 -> 0.1.1 平滑升级数据无损（验收核心）", () => {
  it("备份先于替换，从备份还原后逐字节无损", () => {
    const base = join(root, "upgrade");
    mkdirSync(base, { recursive: true });
    const data = seedDataDir(base);
    const result = simulateUpgradeLossless({ source: data, version: "0.1.1", nowSecs: 1 });
    expect(result.lossless).toBe(true);
    expect(readFileSync(join(data, "settings.json"), "utf8")).toBe(JSON.stringify({ brain: "ark" }));
    expect(readFileSync(join(data, "tasks/t-1/transcript.md"), "utf8")).toBe("# 会议\n一行内容");
    expect(exists(join(data, ".installed"))).toBe(false);
  });

  it("有真实数据时（多文件/深层目录）同样无损", () => {
    const base = join(root, "upgrade-deep");
    mkdirSync(base, { recursive: true });
    const data = join(base, ".local-data");
    mkdirSync(join(data, "a/b/c"), { recursive: true });
    writeFileSync(join(data, "settings.json"), '{"x":1}');
    writeFileSync(join(data, "a/b/c/note.md"), "deep content");
    const result = simulateUpgradeLossless({ source: data, version: "0.1.1", nowSecs: 1 });
    expect(result.lossless).toBe(true);
    expect(countFiles(data)).toBe(2);
  });
});

describe("探针 JSON 解析与断言（镜像 updater_probe.rs）", () => {
  it("忽略非 JSON 行，提取 check/install", () => {
    const text = [
      "[probe] reqwest 直连 ...",
      JSON.stringify({ ok: true, action: "check", currentVersion: "0.1.0", available: true, version: "0.1.1", notes: "fix" }),
      JSON.stringify({ stage: "downloaded", version: "0.1.1", bytes: 1234 }),
      JSON.stringify({ ok: true, action: "install", currentVersion: "0.1.0", version: "0.1.1", downloadUrl: "http://x", bytes: 1234, extractPath: "/Apps/AI.app" })
    ].join("\n");
    const lines = parseProbeLines(text);
    expect(lines.length).toBe(3);
    const install = findInstallResult(lines);
    expect(install.action).toBe("install");
    expect(install.extractPath).toBe("/Apps/AI.app");
  });

  it("check 验收：0.1.0 看到 0.1.1 可升级", () => {
    const report = { ok: true, action: "check", currentVersion: "0.1.0", available: true, version: "0.1.1" };
    expect(assertCheck(report, { fromVersion: "0.1.0", toVersion: "0.1.1" }).ok).toBe(true);
  });

  it("check 验收：available=false 视为失败", () => {
    const report = { ok: true, action: "check", currentVersion: "0.1.0", available: false, version: null };
    const res = assertCheck(report, { fromVersion: "0.1.0", toVersion: "0.1.1" });
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toContain("available=false");
  });

  it("install 验收：备份失败/缺解包路径/健康检查未过均判失败", () => {
    const okReport = { ok: true, action: "install", currentVersion: "0.1.0", version: "0.1.1", extractPath: "/Apps/AI.app" };
    expect(assertInstall(okReport).ok).toBe(true);
    const failReport = { ...okReport, backup_failed: true, extractPath: undefined, health_error: "health bad" };
    const res = assertInstall(failReport);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});
