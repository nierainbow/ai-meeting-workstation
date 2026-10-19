import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip } from "./zip";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zip-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildZip (STORE, dependency-free)", () => {
  it("produces a valid zip that unzip can verify and extract", () => {
    const a = Buffer.from("manifest content");
    const b = Buffer.from("日志第一行\n日志第二行");
    const zipPath = join(dir, "pkg.zip");
    writeFileSync(zipPath, buildZip([
      { name: "manifest.json", data: a },
      { name: "logs/app.log", data: b }
    ]));

    // 完整性校验：unzip -t 退出 0 表示无损坏。
    const testOut = execSync("unzip -t " + JSON.stringify(zipPath) + " 2>&1", { encoding: "utf8" });
    expect(testOut).toContain("No errors detected");

    // 内容还原：解出的文件与原数据一致。
    const extractedA = execSync("unzip -p " + JSON.stringify(zipPath) + " manifest.json 2>/dev/null", { encoding: "utf8" });
    expect(extractedA).toBe("manifest content");
    const extractedB = execSync("unzip -p " + JSON.stringify(zipPath) + " logs/app.log 2>/dev/null", { encoding: "utf8" });
    expect(extractedB).toBe("日志第一行\n日志第二行");
  });

  it("supports empty entry set", () => {
    const buf = buildZip([]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThanOrEqual(22); // 仅 EOCD
  });

  it("handles unicode file names", () => {
    const zipPath = join(dir, "u.zip");
    writeFileSync(zipPath, buildZip([{ name: "诊断/环境.json", data: Buffer.from("中") }]));
    const out = execSync("unzip -t " + JSON.stringify(zipPath) + " 2>&1", { encoding: "utf8" });
    expect(out).toContain("No errors detected");
  });
});
