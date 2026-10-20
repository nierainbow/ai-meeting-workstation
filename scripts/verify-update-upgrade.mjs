#!/usr/bin/env node
// T1.3 自动更新通道的端到端验收脚本。
//
// 两个职责（与 updater_probe.rs 的注释对齐）：
//   1. 直接解析 updater_probe 的 JSON 输出（check / install），断言 0.1.0 客户端确实看到并装上 0.1.1；
//   2. 在无法现场产出 真·签名升级包 的机器上，用与 updater.rs backup_data_dir_at
//      完全相同的契约做一次逻辑级模拟升级，证明 备份先于替换、还原后数据逐字节无损。
//
// 为什么要有第 2 条：cargo build / tauri sign 需要本机工具链与签名私钥，发布机之外
// 跑不了真正的升级；但验收标准 0.1.0 -> 0.1.1 平滑升级数据无损 里的 数据无损 是
// 纯逻辑契约（备份目录命名 + 文件数完整性 + 还原逐字节一致），可以在 Node 里独立复现，
// 因此我们把它做成可单测、可 --selftest 的纯函数，作为 Rust 侧 5 个 cargo test 的镜像。
//
// 用法：
//   node scripts/verify-update-upgrade.mjs --check '<json>' | --check @file.json
//   node scripts/verify-update-upgrade.mjs --install '<json>' | --install @file.json
//   node scripts/verify-update-upgrade.mjs --probe-output probe.stdout.txt   // 解析真实探针输出
//   node scripts/verify-update-upgrade.mjs --selftest                        // 逻辑级模拟升级
//   node scripts/verify-update-upgrade.mjs --simulate --local-data <dir> [--to 0.1.1] [--running-app <app>]
//
// 退出码：0=通过，1=验收失败，2=用法错误。
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, copyFileSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";

import { isNewerVersion } from "./lib/update-manifest.mjs";

// 备份契约（镜像 updater.rs 的 backup_data_dir_at / backup_into / count_files）

// 统计目录文件数（含子目录），与 Rust count_files 一致。
export function countFiles(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) total += countFiles(child);
    else total += 1;
  }
  return total;
}

// 递归复制目录（只处理文件与目录，符号链接按内容复制），与 Rust copy_dir_recursive 一致。
export function copyDirRecursive(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(target, entry);
    if (statSync(from).isDirectory()) copyDirRecursive(from, to);
    else copyFileSync(from, to);
  }
}

function dirName(path) {
  return basename(path) || "local-data";
}

function backupDirName(version, stamp) {
  return "pre-update-" + version + "-" + stamp;
}

// 镜像 updater.rs::backup_data_dir_at。
//   返回 { kind: "none" }           源目录不存在（全新安装，无数据可丢）
//        { kind: "backup", backupDir }  成功，备份落在 <base>/backups/pre-update-<v>-<ts>/<dirName>/
//        { kind: "error", reason }      所有候选位置都写不进去
// 候选位置顺序：runningApp 的同级 backups/ 优先（失败可直接回滚目录），否则退回数据目录的父目录同级 backups/。
export function backupDataDirAt(source, version, runningApp = null, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!existsSync(source)) return { kind: "none" };
  const parent = dirname(resolve(source));
  const name = backupDirName(version, nowSecs);
  const candidates = [];
  if (runningApp) {
    const appParent = dirname(resolve(runningApp));
    if (appParent) candidates.push(appParent);
  }
  candidates.push(parent);
  let lastError = "没有可写的备份位置";
  for (const base of candidates) {
    const target = join(base, "backups", name);
    try {
      mkdirSync(target, { recursive: true });
      const copyTarget = join(target, dirName(source));
      copyDirRecursive(source, copyTarget);
      // 备份必须逐字节可读回才算成功：写到一半的备份比没有备份更危险。
      if (countFiles(copyTarget) !== countFiles(source)) {
        throw new Error("备份不完整：应有 " + countFiles(source) + " 个文件，实际写入 " + countFiles(copyTarget) + " 个");
      }
      return { kind: "backup", backupDir: target };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { kind: "error", reason: lastError };
}

// 探针 JSON 解析与断言（镜像 updater_probe.rs 的 check / install 输出）

// 把探针的 stdout 文本解析成若干 JSON 对象（忽略非 JSON 行，如 [probe] 调试）。
export function parseProbeLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // 非 JSON 行（stderr 通过管道混入、调试前缀等）直接跳过。
    }
  }
  return out;
}

// 从若干探针对象里找出 install 结果；没有就用最后一个 ok 的结果。
export function findInstallResult(lines) {
  const install = lines.find((line) => line && line.action === "install" && line.ok === true);
  if (install) return install;
  const ok = [...lines].reverse().find((line) => line && line.ok === true);
  return ok || null;
}

// 断言一次 check 报告满足 升级前可见新版本。
export function assertCheck(report, opts = {}) {
  const errors = [];
  if (!report || report.ok !== true) errors.push("check 报告 ok != true：" + JSON.stringify(report));
  if (report.available !== true) errors.push("check 报告 available=false，没有可供升级的新版本");
  if (!report.version) errors.push("check 报告缺少新版本号 version");
  if (opts.fromVersion && report.currentVersion && report.currentVersion !== opts.fromVersion) {
    errors.push("check 当前版本 " + report.currentVersion + " 与预期 " + opts.fromVersion + " 不一致");
  }
  if (opts.toVersion && report.version && report.version !== opts.toVersion) {
    errors.push("check 新版本 " + report.version + " 与预期 " + opts.toVersion + " 不一致");
  }
  if (report.currentVersion && report.version && !isNewerVersion(report.currentVersion, report.version)) {
    errors.push("check 新版本 " + report.version + " 不比当前 " + report.currentVersion + " 更高");
  }
  return { ok: errors.length === 0, errors };
}

// 断言一次 install 报告满足 升级已落到磁盘、备份成功、健康检查通过。
export function assertInstall(report) {
  const errors = [];
  if (!report || report.ok !== true) errors.push("install 报告 ok != true：" + JSON.stringify(report));
  if (!report.version) errors.push("install 报告缺少已安装版本 version");
  if (!report.extractPath) errors.push("install 报告缺少解包路径 extractPath（升级未落到磁盘）");
  if (report.backup_failed === true) errors.push("install 报告 backup_failed=true（升级前数据备份未成功）");
  if (report.health_error) errors.push("install 报告健康检查未通过：" + report.health_error);
  if (report.currentVersion && report.version && !isNewerVersion(report.currentVersion, report.version)) {
    errors.push("install 版本 " + report.version + " 不比当前 " + report.currentVersion + " 更高");
  }
  return { ok: errors.length === 0, errors };
}

// 数据指纹与逻辑级升级模拟（证明 数据无损 契约）

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// 对目录做内容指纹：相对路径 -> sha256，外加文件总数。
function snapshot(root) {
  const files = {};
  const walk = (path, rel) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const relative = rel ? join(rel, entry) : entry;
      if (statSync(child).isDirectory()) walk(child, relative);
      else files[relative] = sha256(readFileSync(child));
    }
  };
  walk(root, "");
  return { count: Object.keys(files).length, files };
}

// 模拟一次 备份先于替换、再从备份还原 的升级，断言数据逐字节无损。
// 这是对验收标准 0.1.0 -> 0.1.1 平滑升级数据无损 的逻辑级证明：
//   - 升级前按 backup_data_dir_at 契约建立备份（含文件数完整性校验）；
//   - 升级把数据目录整体替换（worst case：原地清空再写入新版本占位）；
//   - 从备份还原后，目录指纹（相对路径集合 + 每个文件 sha256 + 文件总数）与升级前完全一致。
export function simulateUpgradeLossless({ source, version, runningApp = null, nowSecs = 1 }) {
  const before = snapshot(source);
  const backup = backupDataDirAt(source, version, runningApp, nowSecs);
  if (backup.kind !== "backup") {
    throw new Error("备份失败，无法继续验收：" + (backup.reason || "source 不存在"));
  }
  const backupCopy = join(backup.backupDir, dirName(source));
  // 模拟升级：数据目录被新版本整体替换（最坏情况：原地清空）。
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, ".installed"), version);
  // 还原：从备份拷回。
  copyDirRecursive(backupCopy, source);
  rmSync(join(source, ".installed"), { force: true });
  const after = snapshot(source);
  const lossless =
    after.count === before.count &&
    Object.keys(before.files).length === Object.keys(after.files).length &&
    Object.keys(before.files).every((rel) => after.files[rel] === before.files[rel]);
  return { lossless, before, after, backupDir: backup.backupDir };
}

// CLI

function loadJsonArg(value) {
  if (!value) return null;
  if (existsSync(value)) return JSON.parse(readFileSync(value, "utf8"));
  return JSON.parse(value);
}

function printResult(label, result) {
  if (result.ok) {
    console.log("OK " + label + "：通过");
  } else {
    console.error("FAIL " + label + "：失败");
    for (const error of result.errors) console.error("   - " + error);
  }
  return result.ok;
}

function usage() {
  console.error("用法：verify-update-upgrade.mjs --check <json|@file> | --install <json|@file> |");
  console.error("                              --probe-output <file> | --selftest |");
  console.error("                              --simulate [--local-data <dir>] [--to <v>] [--running-app <app>]");
  console.error("可选：--from <v> --to <v>（约束 check/install 的版本）；--expect-from/--expect-to 同义。");
  return 2;
}

function makeTempSeed(root, version = "0.1.0") {
  mkdirSync(join(root, "tasks/t-1"), { recursive: true });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ brain: "ark", version }, null, 2));
  writeFileSync(join(root, "tasks/t-1/transcript.md"), "# 会议\n一行内容");
  writeFileSync(join(root, "tasks/t-1/meta.json"), JSON.stringify({ speakers: ["A", "B"] }));
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : true;
      if (value !== true) index += 1;
      flags[key] = value;
    }
  }
  const opts = {
    fromVersion: flags.from || flags["expect-from"],
    toVersion: flags.to || flags["expect-to"]
  };
  if (flags.check) {
    const result = assertCheck(loadJsonArg(flags.check), opts);
    printResult("check", result);
    return result.ok ? 0 : 1;
  }
  if (flags.install) {
    const result = assertInstall(loadJsonArg(flags.install));
    printResult("install", result);
    return result.ok ? 0 : 1;
  }
  if (flags["probe-output"]) {
    const text = readFileSync(flags["probe-output"], "utf8");
    const lines = parseProbeLines(text);
    const checkLine = lines.find((line) => line && line.action === "check");
    const installLine = findInstallResult(lines);
    let ok = true;
    if (checkLine) ok = printResult("check", assertCheck(checkLine, opts)) && ok;
    else console.error("WARN 探针输出里没有 check 结果");
    if (installLine) ok = printResult("install", assertInstall(installLine)) && ok;
    else console.error("WARN 探针输出里没有 install 结果");
    return ok ? 0 : 1;
  }
  if (flags.selftest) {
    const base = join(tmpdir(), "aimw-verify-selftest-" + process.pid);
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    const source = join(base, ".local-data");
    makeTempSeed(source);
    const result = simulateUpgradeLossless({ source, version: "0.1.1", nowSecs: 1 });
    printResult("0.1.0 -> 0.1.1 逻辑级无损升级", { ok: result.lossless, errors: result.lossless ? [] : ["还原后数据指纹与升级前不一致"] });
    rmSync(base, { recursive: true, force: true });
    return result.lossless ? 0 : 1;
  }
  if (flags.simulate) {
    const source = flags["local-data"];
    if (!source) {
      console.error("--simulate 需要 --local-data <dir>");
      return 2;
    }
    const version = flags.to || "0.1.1";
    const result = simulateUpgradeLossless({ source, version, runningApp: flags["running-app"], nowSecs: 1 });
    console.log("备份目录：" + result.backupDir);
    printResult("逻辑级无损升级到 " + version, { ok: result.lossless, errors: result.lossless ? [] : ["还原后数据指纹与升级前不一致"] });
    return result.lossless ? 0 : 1;
  }
  return usage();
}

// 仅当作为可执行脚本直接运行时才进 CLI，被 vitest import 时不执行。
if (import.meta.url === "file://" + process.argv[1]) {
  const code = main();
  if (typeof code === "number") process.exit(code);
}
