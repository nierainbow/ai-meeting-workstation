import { describe, expect, it } from "vitest";
import { normalizeInstallOutcome, normalizeUpdateCheck } from "./updater";
import {
  INITIAL_UPDATE_STATE,
  describeUpdateEndpoint,
  describeUpdateStatus,
  errorMessage,
  hasUpdateBanner,
  isVersionLike,
  versionMismatchNotice,
  type UpdateStateSnapshot
} from "./updateState";

function snapshot(patch: Partial<UpdateStateSnapshot>): UpdateStateSnapshot {
  return { ...INITIAL_UPDATE_STATE, ...patch };
}

const current = { currentVersion: "0.1.0", available: false, version: null, notes: null };
const available = { currentVersion: "0.1.0", available: true, version: "0.1.1", notes: "修复若干问题" };

describe("versionMismatchNotice", () => {
  it("stays quiet when both sides agree", () => {
    expect(versionMismatchNotice("0.9.1", "0.9.1")).toBeNull();
  });

  it("explains a stale page after an in-place update", () => {
    expect(versionMismatchNotice("0.9.1", "0.9.0")).toBe(
      "服务端已是 0.9.1，页面仍是 0.9.0，重启应用后才会生效。"
    );
  });

  it("ignores missing or malformed versions instead of guessing", () => {
    expect(versionMismatchNotice(null, "0.9.0")).toBeNull();
    expect(versionMismatchNotice("0.9.1", undefined)).toBeNull();
    expect(versionMismatchNotice("dev", "0.9.0")).toBeNull();
    expect(versionMismatchNotice("0.9.1", "")).toBeNull();
  });
});

describe("isVersionLike", () => {
  it("accepts semver with prerelease and build metadata like the server does", () => {
    expect(isVersionLike("0.9.0")).toBe(true);
    expect(isVersionLike("0.9.0-rc.1+build7")).toBe(true);
    expect(isVersionLike(" 1.2.3 ")).toBe(true);
  });

  it("rejects anything the server would not report", () => {
    expect(isVersionLike("0.9")).toBe(false);
    expect(isVersionLike("v0.9.0")).toBe(false);
    expect(isVersionLike("")).toBe(false);
    expect(isVersionLike(9)).toBe(false);
  });
});

describe("describeUpdateEndpoint", () => {
  it("returns the configured endpoint verbatim for the settings page", () => {
    expect(describeUpdateEndpoint("http://127.0.0.1:8788/updates/{{target}}")).toBe(
      "http://127.0.0.1:8788/updates/{{target}}"
    );
  });

  it("treats blank or missing endpoints as unknown", () => {
    expect(describeUpdateEndpoint("   ")).toBeNull();
    expect(describeUpdateEndpoint(null)).toBeNull();
    expect(describeUpdateEndpoint(undefined)).toBeNull();
  });
});

describe("normalizeUpdateCheck", () => {
  it("keeps a well-formed update payload", () => {
    expect(normalizeUpdateCheck(available)).toEqual(available);
  });

  it("drops an available flag that has no target version", () => {
    // 壳里 available 与 version 理论上同生同灭；版本号缺失时宁可当作「没有更新」，
    // 也不要渲染出一个「新版本 null」的横幅。
    expect(normalizeUpdateCheck({ currentVersion: "0.1.0", available: true, version: null })).toEqual({
      currentVersion: "0.1.0",
      available: false,
      version: null,
      notes: null
    });
  });

  it("ignores non-object payloads and missing current version", () => {
    expect(normalizeUpdateCheck(null)).toBeNull();
    expect(normalizeUpdateCheck("0.1.1")).toBeNull();
    expect(normalizeUpdateCheck({ available: true, version: "0.1.1" })).toBeNull();
  });

  it("normalizes empty notes to null so the banner renders no empty span", () => {
    expect(normalizeUpdateCheck({ currentVersion: "0.1.0", available: false, version: null, notes: "" })?.notes).toBeNull();
  });
});

describe("normalizeInstallOutcome", () => {
  it("keeps backup info reported by the shell", () => {
    expect(
      normalizeInstallOutcome({
        version: "0.1.1",
        backupDir: "/Users/me/Library/Application Support/backups/pre-update-0.1.1-1",
        backupFailed: false,
        needsRestart: true
      })
    ).toEqual({
      version: "0.1.1",
      backupDir: "/Users/me/Library/Application Support/backups/pre-update-0.1.1-1",
      backupFailed: false,
      needsRestart: true
    });
  });

  it("treats a missing backup directory as a failed backup", () => {
    // 备份失败时 Rust 侧把 backupDir 置 null、backupFailed 置 true；
    // 字段缺失同样按「备份未知」处理，宁可提示用户手动检查。
    expect(normalizeInstallOutcome({ version: "0.1.1", backupFailed: true })).toEqual({
      version: "0.1.1",
      backupDir: null,
      backupFailed: true,
      needsRestart: true
    });
  });

  it("rejects payloads without a version", () => {
    expect(() => normalizeInstallOutcome(null)).toThrow("无法识别");
    expect(() => normalizeInstallOutcome({ backupDir: "/tmp" })).toThrow("缺少版本号");
  });
});

describe("hasUpdateBanner", () => {
  it("shows nothing while idle in a non-desktop environment", () => {
    expect(hasUpdateBanner(INITIAL_UPDATE_STATE, false)).toBe(false);
  });

  it("shows the banner for an available update and hides it after 稍后", () => {
    const state = snapshot({ check: available });
    expect(hasUpdateBanner(state, false)).toBe(true);
    expect(hasUpdateBanner(state, true)).toBe(false);
  });

  it("keeps showing the result banner after installation", () => {
    const state = snapshot({
      phase: "done",
      check: available,
      outcome: { version: "0.1.1", backupDir: "/tmp/b", backupFailed: false, needsRestart: true }
    });
    expect(hasUpdateBanner(state, true)).toBe(true);
  });
});

describe("describeUpdateStatus", () => {
  it("says nothing until the first manual check finishes", () => {
    expect(describeUpdateStatus(INITIAL_UPDATE_STATE, false).text).toContain("检查更新");
  });

  it("reports up-to-date only after a manual check", () => {
    expect(describeUpdateStatus(snapshot({ check: current }), false).text).not.toContain("已是最新");
    expect(describeUpdateStatus(snapshot({ check: current, manualChecks: 1 }), false).text).toBe(
      "已是最新版本（0.1.0）"
    );
  });

  it("offers install while an update is available", () => {
    const status = describeUpdateStatus(snapshot({ check: available }), false);
    expect(status.canInstall).toBe(true);
    expect(status.text).toBe("发现新版本 0.1.1");
  });

  it("locks both buttons while installing", () => {
    const status = describeUpdateStatus(snapshot({ phase: "installing", check: available }), false);
    expect(status).toEqual({ text: "正在下载并安装更新…", canCheck: false, canInstall: false });
  });

  it("asks for a restart after a successful install", () => {
    const status = describeUpdateStatus(
      snapshot({
        phase: "done",
        outcome: { version: "0.1.1", backupDir: null, backupFailed: true, needsRestart: true }
      }),
      false
    );
    expect(status.text).toBe("已安装 0.1.1，重启后生效");
    expect(status.canCheck).toBe(false);
  });

  it("surfaces the error and allows retry", () => {
    const status = describeUpdateStatus(snapshot({ phase: "error", error: "连接更新服务器失败" }), false);
    expect(status.text).toBe("检查更新失败：连接更新服务器失败");
    expect(status.canCheck).toBe(true);
  });
});

describe("errorMessage", () => {
  it("unwraps Tauri string rejections and Error objects", () => {
    expect(errorMessage(new Error("字符串直接抛"))).toBe("字符串直接抛");
    expect(errorMessage("更新服务器不可达")).toBe("更新服务器不可达");
    expect(errorMessage({ message: "签名校验失败" })).toBe("签名校验失败");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
