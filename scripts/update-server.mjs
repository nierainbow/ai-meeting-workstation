#!/usr/bin/env node
// T1.3 内部静态更新服务器：把 dist/updates/ 托管成 Tauri updater 的 manifest 端点。
//
// 用法：
//   node scripts/update-server.mjs [--port 8788] [--host 127.0.0.1] [--root dist/updates]
//   node scripts/update-server.mjs --target darwin-aarch64   # 只托管某一个目标（可选）
//
// 约定（由 scripts/publish-update.mjs 产出）：
//   <root>/<target>/latest.json           manifest（Static 格式）
//   <root>/<target>/<version>.json        按版本归档的同一份 manifest
//   <root>/<target>/<file>.tar.gz         更新包
//   <root>/<target>/<file>.tar.gz.sig     签名
//
// 端点模板见 tauri.conf.json 的 plugins.updater.endpoints：
//   http://127.0.0.1:8788/updates/{{target}}/{{arch}}/{{current_version}}
// {{arch}} 与 {{current_version}} 只是让请求可区分（便于以后做灰度/断点），
// 本实现忽略它们，始终返回该 target 的 latest.json —— 版本大小比较由插件在客户端完成。
// 路由解析与 manifest 生成共用 scripts/lib/update-manifest.mjs，两侧不会漂移。
//
// 注意：这个端点是 **Rust 侧** 的 tauri-plugin-updater 去请求的，不是 WebView 里的 JS，
// 所以不受 8787 同源约束影响，也不需要 CORS 头。
//
// 安全边界名：默认只监听 127.0.0.1（与客户端默认 endpoint 一致）；要放到内网静态服务器上，
// 用 --host 0.0.0.0 或直接拷 dist/updates 到任意静态站点（nginx 等），布局完全兼容。
import { createReadStream, promises as fsPromises } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isValidTarget, parseManifestRoute } from "./lib/update-manifest.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = resolve(projectRoot, "dist/updates");

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".sig": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function parseArgs(argv) {
  const options = {
    port: 8788,
    host: "127.0.0.1",
    root: defaultRoot,
    target: process.env.TAURI_ENV_TARGET_TRIPLE ?? null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--port") {
      const next = Number(argv[index + 1]);
      if (!Number.isInteger(next) || next <= 0 || next > 65535) {
        throw new Error("--port 需要 1-65535 的端口");
      }
      options.port = next;
      index += 1;
    } else if (value === "--host") {
      options.host = argv[index + 1];
      index += 1;
    } else if (value === "--root") {
      options.root = resolve(argv[index + 1]);
      index += 1;
    } else if (value === "--target") {
      options.target = argv[index + 1];
      index += 1;
    } else {
      throw new Error("未知参数：" + value);
    }
  }
  const fromEnv = Number(process.env.AIMW_UPDATE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) {
    options.port = fromEnv;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/** manifest 端点：/updates/<target>/<arch>/<current_version> → <root>/<target>/latest.json */
export function manifestPathFor(pathname, root = defaultRoot) {
  const route = parseManifestRoute(pathname);
  if (!route) return null;
  return resolve(join(root, route.target, "latest.json"));
}

/** 把 /updates/ 下的 URL 路径映射成 root 内的真实文件；越权返回 null。 */
export function resolveFile(pathname, root = defaultRoot, onlyTarget = null) {
  if (!pathname.startsWith("/updates/")) return null;
  const relative = pathname.slice("/updates/".length);
  if (relative.length === 0) return null;
  // 逐段校验：不允许 ..、空段或绝对路径段混进来。
  const segments = relative.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  const target = onlyTarget ?? options.target;
  if (target !== null && segments[0] !== target) return null;
  if (!isValidTarget(segments[0])) return null;
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

async function sendFile(response, filePath, contentType) {
  const info = await fsPromises.stat(filePath);
  if (!info.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    // 更新检查必须每次都打到服务器：缓存的 manifest 会让客户端错过新版本。
    "cache-control": "no-store"
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
    stream.pipe(response);
  });
}

export const server = createServer((request, response) => {
  const handler = async () => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const manifest = manifestPathFor(pathname);
    if (manifest) {
      await sendFile(response, manifest, MIME[".json"]);
      return;
    }
    const filePath = resolveFile(pathname);
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    await sendFile(response, filePath, MIME[extname(filePath)] ?? "application/octet-stream");
  };

  handler().catch((error) => {
    if (error?.code === "ENOENT") {
      if (!response.headersSent) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("not found");
      return;
    }
    console.error("[aimw-update]", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("internal error");
  });
});

// 被 import（单测）时不监听端口；直接运行时才起服务。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(options.port, options.host, () => {
    console.log("[aimw-update] 内部更新服务器已启动 http://" + options.host + ":" + options.port + "/updates");
    console.log("[aimw-update] 静态根目录 " + options.root + (options.target ? "（仅 " + options.target + "）" : ""));
  });
}
