#!/usr/bin/env node
// 组装 Tauri 内嵌的 Node sidecar：server bundle + 精简 prod node_modules + 官方 Node 运行时。
// 用法：node scripts/build-sidecar.mjs [--with-node]
//   --with-node 会从 nodejs.org 下载官方 Node 发行版（约 108MB）；日常迭代可省略，
//   直接用系统 node 起 sidecar 调试。
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri/sidecar");
const withNode = process.argv.includes("--with-node");
const NODE_VERSION = "22.22.3";

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

execFileSync(
  join(root, "node_modules/.bin/esbuild"),
  [
    "src/server/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    `--outfile=${join(out, "server/server.mjs")}`,
    "--external:better-sqlite3",
    "--external:dotenv",
    "--banner:js=import { createRequire as __cr } from \"module\"; const require = __cr(import.meta.url);",
    "--log-level=warning"
  ],
  { cwd: root, stdio: "inherit" }
);

// 桌面壳里 server 被打成 server/server.mjs，funasrFile.ts 用 import.meta.url 反推
// ../../../scripts/transcribe_audio.py 会落到 bundle 之外，所以把脚本放到 server.mjs 同级，
// 由 main.rs 注入 FUNASR_TRANSCRIBE_SCRIPT 指到它。
mkdirSync(join(out, "server/scripts"), { recursive: true });
cpSync(join(root, "scripts/transcribe_audio.py"), join(out, "server/scripts/transcribe_audio.py"));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "aimw-sidecar", private: true, type: "module" }, null, 2) + "\n"
);
execFileSync(
  "npm",
  ["install", "--no-audit", "--no-fund", "--omit=dev", "--cache", "/tmp/npmcache", "express", "better-sqlite3", "ws", "zod", "dotenv"],
  { cwd: out, stdio: "inherit" }
);

if (withNode) {
  const tmp = join("/tmp", `node-dist-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tarball = join(tmp, "node.tar.xz");
  execFileSync(
    "curl",
    [
      "-sSL",
      "--max-time",
      "600",
      "-o",
      tarball,
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.xz`
    ],
    { stdio: "inherit" }
  );
  execFileSync("tar", ["-xf", tarball, "-C", tmp], { stdio: "inherit" });
  mkdirSync(join(out, "node/bin"), { recursive: true });
  cpSync(join(tmp, `node-v${NODE_VERSION}-darwin-arm64/bin/node`), join(out, "node/bin/node"));
  rmSync(tmp, { recursive: true, force: true });
}

function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += statSync(full).size;
    }
  }
  return total;
}

console.log(`sidecar 就绪：${out}`);
console.log(`体积：${(dirSize(out) / 1024 / 1024).toFixed(1)} MB`);
if (!withNode) console.log("（未内嵌 Node 运行时，加 --with-node 才会下载官方发行版）");
