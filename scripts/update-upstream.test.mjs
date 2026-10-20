// T1.3 更新通道的上游（服务器侧）单测：发布产物 → 静态服务器 → 客户端判定 全链路纯逻辑。
//
// 这里不起 Tauri、不打包 app，只验证最容易悄悄坏掉的三个接缝：
//   1. 发布的 manifest 能被服务器端点命中（路由与发布布局必须一致）；
//   2. 服务器不会把 /updates/ 之外的路径或 ../ 逃逸读出去；
//   3. 客户端拿到 0.1.0 的 manifest 时判定「有 0.1.1 可升级」，拿到同版本时判定「已是最新」。
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildManifest, isNewerVersion, parseManifestRoute, parseSemver } from "./lib/update-manifest.mjs";

describe("manifest 路由（与 tauri.conf.json endpoint 模板对齐）", () => {
  it("解析 {{target}}/{{arch}}/{{current_version}} 形式", () => {
    expect(parseManifestRoute("/updates/darwin-aarch64/aarch64/0.1.0")).toEqual({ target: "darwin-aarch64" });
  });

  it("拒绝非 manifest 路径与越界 target", () => {
    expect(parseManifestRoute("/updates/darwin-aarch64/latest.json")).toBeNull();
    expect(parseManifestRoute("/updates/../etc/passwd")).toBeNull();
    expect(parseManifestRoute("/updates/a/b/c/d")).toBeNull();
  });
});

describe("semver 比较（客户端是否提示更新）", () => {
  it("按数值而非字符串比较", () => {
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
  });

  it("同版本与非法版本都不算更新", () => {
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "latest")).toBe(false);
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
  });
});

describe("buildManifest", () => {
  it("产出 Static 格式并拼出可下载的 url", () => {
    const manifest = buildManifest({
      version: "0.1.1",
      notes: "修复若干问题",
      pubDate: "2026-10-20T00:00:00.000Z",
      target: "darwin-aarch64",
      signature: "sig-demo",
      baseUrl: "http://127.0.0.1:8788/",
      archiveName: "AI Meeting Workstation.app.tar.gz"
    });
    expect(manifest.version).toBe("0.1.1");
    expect(manifest.platforms["darwin-aarch64"].signature).toBe("sig-demo");
    expect(manifest.platforms["darwin-aarch64"].url).toBe(
      "http://127.0.0.1:8788/updates/darwin-aarch64/AI%20Meeting%20Workstation.app.tar.gz"
    );
  });

  it("拒绝越界 target 与缺失签名", () => {
    expect(() =>
      buildManifest({ version: "0.1.1", target: "../evil", signature: "s", baseUrl: "http://x", archiveName: "a" })
    ).toThrow();
    expect(() =>
      buildManifest({ version: "0.1.1", target: "darwin-aarch64", signature: "", baseUrl: "http://x", archiveName: "a" })
    ).toThrow();
  });
});

describe("静态更新服务器（真实 HTTP 往返）", () => {
  let root;
  let server;
  let baseUrl;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "aimw-updates-"));
    const targetDir = join(root, "darwin-aarch64");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "latest.json"),
      JSON.stringify(
        buildManifest({
          version: "0.1.1",
          notes: "0.1.1 测试包",
          pubDate: "2026-10-20T00:00:00.000Z",
          target: "darwin-aarch64",
          signature: "sig-demo",
          baseUrl: "http://127.0.0.1:0",
          archiveName: "AI Meeting Workstation.app.tar.gz"
        })
      )
    );
    await writeFile(join(targetDir, "AI Meeting Workstation.app.tar.gz.sig"), "sig-demo\n");
    await writeFile(join(root, "secret.txt"), "should-not-be-served");

    server = createServer((request, response) => {
      const pathname = decodeURIComponent((request.url ?? "/").split("?")[0]);
      const route = parseManifestRoute(pathname);
      const mapping = route
        ? { file: join(root, route.target, "latest.json"), type: "application/json" }
        : pathname.startsWith("/updates/") &&
            !pathname.slice("/updates/".length).split("/").some((s) => s === ".." || s === "." || s === "")
          ? { file: join(root, pathname.slice("/updates/".length)), type: "application/octet-stream" }
          : null;
      if (!mapping || !mapping.file.startsWith(root)) {
        response.writeHead(404).end("not found");
        return;
      }
      import("node:fs").then(({ createReadStream }) => {
        const stream = createReadStream(mapping.file);
        stream.on("error", () => response.writeHead(404).end("not found"));
        stream.once("open", () => response.writeHead(200, { "content-type": mapping.type }));
        stream.pipe(response);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = "http://127.0.0.1:" + server.address().port;
  }, 20000);

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("0.1.0 客户端按 endpoint 模板取到 0.1.1 manifest", async () => {
    const response = await fetch(baseUrl + "/updates/darwin-aarch64/aarch64/0.1.0");
    expect(response.status).toBe(200);
    const manifest = await response.json();
    expect(manifest.version).toBe("0.1.1");
    expect(isNewerVersion("0.1.0", manifest.version)).toBe(true);
  });

  it("更新包文件名带空格也能取到签名文件", async () => {
    const response = await fetch(baseUrl + "/updates/darwin-aarch64/" + encodeURIComponent("AI Meeting Workstation.app.tar.gz.sig"));
    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe("sig-demo");
  });

  it("/updates/ 之外的路径一律 404", async () => {
    expect((await fetch(baseUrl + "/secret.txt")).status).toBe(404);
    expect((await fetch(baseUrl + "/updates/../secret.txt")).status).toBe(404);
  });
});
