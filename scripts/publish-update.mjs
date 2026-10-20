#!/usr/bin/env node
// T1.3 发布更新包：把 tauri build 产出的 .app 打包成 updater 需要的 tar.gz + 签名，
// 再写一份 Static 格式 manifest（latest.json）到 dist/updates/<target>/。
//
// 用法：
//   node scripts/publish-update.mjs [--version 0.9.1] [--notes "修复若干问题"] [--root dist/updates]
//   node scripts/publish-update.mjs --dry-run     # 只打印将要做什么，不打包不签名
//
// 产出布局（scripts/update-server.mjs 直接托管）：
//   <root>/<target>/AI Meeting Workstation.app.tar.gz
//   <root>/<target>/AI Meeting Workstation.app.tar.gz.sig
//   <root>/<target>/latest.json   -> { version, notes, pub_date, platforms: { <target>: { signature, url } } }
//   <root>/<target>/<version>.json -> 该版本的归档 manifest（审计留痕，服务器同样可访问）
//
// 前置：tauri.conf.json / package.json / Cargo.toml / Cargo.lock 四处版本已同步
// （scripts/check-version.mjs），且已跑过 npm run build:desktop。
//
// **私钥不随机型落盘**：默认读 $AIMW_UPDATER_PRIVATE_KEY（minisign 私钥全文）或
// $AIMW_UPDATER_PRIVATE_KEY_PATH；config/updater/ 下的本地私钥仅供开发机，
// 发布流水线里应由密钥管理系统注入。私钥缺失时直接失败，绝不回退到「不签名」。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, isValidTarget, parseSemver } from "./lib/update-manifest.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGET = process.env.TAURI_ENV_TARGET_TRIPLE || "darwin-aarch64";

function parseArgs(argv) {
  const options = {
    version: null,
    fromRelease: null,
    notes: "",
    root: resolve(projectRoot, "dist/updates"),
    target: DEFAULT_TARGET,
    // 私钥默认落在项目外的用户目录：config/updater/ 里的私钥曾几乎被 git add -A 带进仓库。
    privateKeyPath:
      process.env.AIMW_UPDATER_PRIVATE_KEY_PATH ||
      resolve(homedir(), ".config/aimw/updater/aimw-updater.key"),
    baseUrl: process.env.AIMW_UPDATE_BASE_URL || "http://127.0.0.1:8788",
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--version") {
      options.version = argv[index + 1];
      index += 1;
    } else if (value === "--from-release") {
      options.fromRelease = argv[index + 1];
      index += 1;
    } else if (value === "--notes") {
      options.notes = argv[index + 1];
      index += 1;
    } else if (value === "--root") {
      options.root = resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--target") {
      options.target = argv[index + 1];
      index += 1;
    } else if (value === "--key") {
      options.privateKeyPath = resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--base-url") {
      options.baseUrl = argv[index + 1];
      index += 1;
    } else if (value === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error("未知参数：" + value);
    }
  }
  return options;
}

/** 私钥优先取环境变量（流水线/CI），再落回文件（开发机）。 */
function readPrivateKey(path) {
  const inline = process.env.AIMW_UPDATER_PRIVATE_KEY;
  if (inline && inline.trim().length > 0) return inline.trim();
  if (!existsSync(path)) {
    console.error("[aimw-update] 找不到签名私钥：" + path);
    console.error("[aimw-update] 可用 AIMW_UPDATER_PRIVATE_KEY 注入私钥全文，或 AIMW_UPDATER_PRIVATE_KEY_PATH 指定路径。");
    console.error("[aimw-update] 首次生成：npm run tauri -- signer generate -w ~/.config/aimw/updater/aimw-updater.key -p '' --ci");
    process.exit(1);
  }
  return readFileSync(path, "utf8").trim();
}

/**
 * 从 tauri signer 的输出里取出签名本身。
 * 输出形如：
 *   Your file was signed successfully, ...
 *   /path/to/file.sig
 *
 *   Public signature:
 *   dW50cnVzdGVkIGNvbW1lbnQ6...
 * 也兼容只打印 blob 的旧版本：找不到标记时退回整段输出的最后一个非空行。
 */
function extractSignature(stdout) {
  const trimmed = stdout.trim();
  const marker = "Public signature:";
  const index = trimmed.indexOf(marker);
  if (index >= 0) {
    // 只取紧跟标记的那一行：tauri signer 后面还会打一句提示语
    // ("Make sure to include this into the signature field of your update server.")，
    // 整段吞下去会让 tauri-plugin-updater 解析签名失败并报成
    // "Could not fetch a valid release JSON from the remote"（根因极难定位）。
    const rest = trimmed.slice(index + marker.length);
    const line = (rest.split("\n")[0] ?? "").trim();
    if (line.length > 0) return line;
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  return last.startsWith("dW50cnVzdGVk") ? last : null;
}

const options = parseArgs(process.argv.slice(2));

/**
 * 把本次产物归档成「一次可回放的发布」：<root>/<target>/releases/<version>/。
 * 用途：验收脚本 build-0.9.0 要用 0.9.0 的安装包，但 latest.json 只指向最新版本，
 * 归档目录让任意历史版本都能重复发布，也让回滚有明确的入口。
 */
function archiveRelease(outDir, version, files) {
  const releaseDir = join(outDir, "releases", version);
  mkdirSync(releaseDir, { recursive: true });
  for (const file of files) {
    copyFileSync(join(outDir, file), join(releaseDir, file));
  }
  return releaseDir;
}

/** 版本默认取 package.json，与 check-version.mjs 的四处同步保持一致。 */
const defaultVersion = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
// --from-release 只是重放，版本号来自归档，不必也不该跟 package.json 对齐。
const version = options.fromRelease ?? options.version ?? defaultVersion;
if (!parseSemver(version)) {
  console.error("[aimw-update] 版本号必须是 x.y.z：" + version);
  process.exit(1);
}
if (!isValidTarget(options.target)) {
  console.error("[aimw-update] 非法的 --target：" + options.target);
  process.exit(1);
}

const productName = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8")).productName;
const appName = productName + ".app";

// --from-release <version>：把归档里的某个历史版本重新发布成 latest.json。
// 验收「0.9.0 客户端发现 0.9.1」时要用它：否则包已经打成 0.9.1，装不出 0.9.0 的基线。
if (options.fromRelease) {
  const archiveManifest = join(options.root, options.target, "releases", version, version + "-release.json");
  if (!existsSync(archiveManifest)) {
    console.error("[aimw-update] 找不到归档的发布记录：" + archiveManifest);
    console.error("[aimw-update] 先正常发布会生成；也可以直接从 releases/<version>/ 恢复。");
    process.exit(1);
  }
  const stored = JSON.parse(readFileSync(archiveManifest, "utf8"));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const archiveDir = join(options.root, options.target, "releases", version);
  const outDir = join(options.root, options.target);
  const files = [appName + ".tar.gz", appName + ".tar.gz.sig"];
  for (const file of files) {
    if (!existsSync(join(archiveDir, file))) {
      console.error("[aimw-update] 归档缺少更新包文件：" + join(archiveDir, file));
      process.exit(1);
    }
    copyFileSync(join(archiveDir, file), join(outDir, file));
  }
  const manifest =
    String(stored.baseUrl ?? "").replace(/\/+$/, "") === baseUrl
      ? { version: stored.version, notes: stored.notes, pub_date: stored.pub_date, platforms: stored.platforms }
      : buildManifest({
          version: stored.version,
          notes: stored.notes,
          pubDate: stored.pub_date,
          target: options.target,
          signature: stored.platforms?.[options.target]?.signature ?? "",
          baseUrl,
          archiveName: appName + ".tar.gz"
        });
  writeFileSync(join(outDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("[aimw-update] 已把归档版本 " + stored.version + " 重新发布为 latest.json");
  console.log("[aimw-update] 更新包      " + join(outDir, appName + ".tar.gz"));
  console.log("[aimw-update] 下载地址    " + manifest.platforms[options.target].url);
  process.exit(0);
}

const bundleDir = join(projectRoot, "src-tauri/target/release/bundle/macos");
const appPath = join(bundleDir, appName);

if (options.dryRun) {
  console.log("[aimw-update] dry-run：");
  console.log("  版本     " + version);
  console.log("  目标     " + options.target);
  console.log("  产物     " + appPath + (existsSync(appPath) ? "（存在）" : "（缺失，实际发布会失败）"));
  console.log("  输出     " + join(options.root, options.target));
  console.log("  私钥     " + (process.env.AIMW_UPDATER_PRIVATE_KEY ? "<env AIMW_UPDATER_PRIVATE_KEY>" : options.privateKeyPath));
  process.exit(0);
}

if (!existsSync(appPath)) {
  console.error("[aimw-update] 找不到打包产物：" + appPath);
  console.error("[aimw-update] 请先跑 npm run build:desktop");
  process.exit(1);
}
const privateKey = readPrivateKey(options.privateKeyPath);

const outDir = join(options.root, options.target);
mkdirSync(outDir, { recursive: true });

// tar 必须保留 .app 的相对结构，updater 解压时按 <ProductName>.app 还原。
const archiveName = appName + ".tar.gz";
const archivePath = join(outDir, archiveName);
const tar = spawnSync("tar", ["-czf", archivePath, "-C", bundleDir, appName], { stdio: "inherit" });
if (tar.status !== 0) {
  console.error("[aimw-update] 打包 .app 失败：tar 退出码 " + tar.status);
  process.exit(1);
}

// 签名：必须传字面量私钥（signer sign 不接受路径），并绑定版本防止 manifest 被换号。
// 注意用 spawnSync 而不是 execFileSync：签名失败时**绝不能**把 stderr 里带出来的
// 私钥片段写进日志，所以下面只打印预先裁剪过的原因。
const sign = spawnSync(
  join(projectRoot, "node_modules/.bin/tauri"),
  ["signer", "sign", archivePath, "--private-key", privateKey, "--password", "", "--app-version", version],
  { encoding: "utf8", env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: undefined } }
);
if (sign.status !== 0) {
  const reason = String(sign.stderr || sign.stdout || "")
    .replace(/\s+/g, " ")
    .replace(/[\w+/=]{40,}/g, "<已隐去>")
    .slice(0, 400);
  console.error("[aimw-update] 签名失败（退出码 " + sign.status + "）：" + reason);
  process.exit(1);
}
// tauri signer 的 stdout 是一段说明文字，真正的签名（minisign 文本 blob）在
// "Public signature:" 之后；直接拿 stdout 会把说明文字写进 manifest，客户端验签必失败。
const signature = extractSignature(String(sign.stdout));
if (!signature) {
  console.error("[aimw-update] 签名命令成功但输出里找不到 Public signature 段，拒绝发布未签名 manifest。");
  process.exit(1);
}
writeFileSync(archivePath + ".sig", signature + "\n");

const manifest = buildManifest({
  version,
  notes: options.notes,
  pubDate: new Date().toISOString(),
  target: options.target,
  signature,
  baseUrl: options.baseUrl,
  archiveName
});
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(join(outDir, "latest.json"), manifestText);
// 归档：latest.json 会被下一次发布覆盖，按版本留一份，便于回滚/审计。
writeFileSync(join(outDir, version + ".json"), manifestText);

// 归档带上 baseUrl：回放旧版本时（--from-release）manifest 里的下载地址必须仍指向现役服务器。
const releaseManifest = JSON.stringify(
  { ...manifest, baseUrl: options.baseUrl.replace(/\/+$/, "") },
  null,
  2
);
writeFileSync(join(outDir, version + "-release.json"), releaseManifest + "\n");
const releaseDir = archiveRelease(outDir, version, [
  archiveName,
  archiveName + ".sig",
  "latest.json",
  version + "-release.json"
]);

console.log("[aimw-update] 版本        " + version);
console.log("[aimw-update] 目标        " + options.target);
console.log("[aimw-update] 更新包      " + archivePath);
console.log("[aimw-update] 体积        " + (statSync(archivePath).size / 1024 / 1024).toFixed(2) + " MiB");
console.log("[aimw-update] 下载地址    " + manifest.platforms[options.target].url);
console.log("[aimw-update] manifest    " + join(outDir, "latest.json"));
console.log("[aimw-update] 归档        " + releaseDir);
console.log("[aimw-update] 启动服务    node scripts/update-server.mjs --root " + options.root);
