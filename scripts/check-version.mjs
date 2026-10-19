#!/usr/bin/env node
// 校验四处版本号一致（发布前必跑）：package.json / tauri.conf.json / Cargo.toml / Cargo.lock。
// 用法：
//   node scripts/check-version.mjs              # 只比文件之间是否一致
//   node scripts/check-version.mjs --tag v0.9.0 # 顺带校验 git tag 与版本一致
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const tomlString = (value) => value.trim().replace(/^"|"$/g, "");

const pkg = JSON.parse(read("package.json"));
const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));

/** 逐行解析 Cargo.toml，取 [package] 段的 version（不依赖正则转义，稳）。 */
function cargoTomlVersion() {
  let inPackage = false;
  for (const line of read("src-tauri/Cargo.toml").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (inPackage && trimmed.startsWith("version")) {
      const value = trimmed.slice("version".length).split("=")[1];
      if (value === undefined) break;
      return tomlString(value);
    }
  }
  throw new Error("Cargo.toml 里找不到 [package] 段的 version");
}

/** 逐段解析 Cargo.lock，取 name = "ai-meeting-workstation" 那一节的 version。 */
function cargoLockVersion() {
  let inOwnPackage = false;
  for (const line of read("src-tauri/Cargo.lock").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      inOwnPackage = false;
      continue;
    }
    if (trimmed.startsWith("name = ")) {
      inOwnPackage = tomlString(trimmed.slice("name = ".length)) === "ai-meeting-workstation";
      continue;
    }
    if (inOwnPackage && trimmed.startsWith("version")) {
      const value = trimmed.slice("version".length).split("=")[1];
      if (value !== undefined) return tomlString(value);
    }
  }
  throw new Error("Cargo.lock 里找不到 ai-meeting-workstation 条目");
}

const sources = {
  "package.json": pkg.version,
  "src-tauri/tauri.conf.json": tauriConf.version,
  "src-tauri/Cargo.toml": cargoTomlVersion(),
  "src-tauri/Cargo.lock": cargoLockVersion()
};

const tagArgIndex = process.argv.indexOf("--tag");
if (tagArgIndex !== -1) {
  const tag = process.argv[tagArgIndex + 1];
  if (!tag) throw new Error("--tag 需要传 tag 名，如 --tag v0.9.0");
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: root, stdio: "ignore" });
  } catch {
    console.error(`✗ git tag ${tag} 不存在`);
    process.exit(1);
  }
  sources[`git tag ${tag}`] = tag.replace(/^v/, "");
}

const unique = [...new Set(Object.values(sources))];
if (unique.length === 1) {
  console.log(`✓ 版本号一致：${unique[0]}`);
  for (const [file, version] of Object.entries(sources)) console.log(`  ${file}: ${version}`);
  process.exit(0);
}
console.error("✗ 版本号不一致：");
for (const [file, version] of Object.entries(sources)) console.error(`  ${file}: ${version}`);
console.error("请同步 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock");
process.exit(1);
