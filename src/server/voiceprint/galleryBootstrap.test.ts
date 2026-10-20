import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureVoiceprintGallery } from "./galleryBootstrap";

describe("ensureVoiceprintGallery (T2.5)", () => {
  let dir: string;
  const content = Buffer.from("fake-ressemblyzer-256-gallery");
  const sha = createHash("sha256").update(content).digest("hex");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aimw-vp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("源校验通过则拷贝到 <dataDir>/voiceprint/gallery.pkl", () => {
    const src = join(dir, "master.pkl"); writeFileSync(src, content);
    const dataDir = join(dir, "data");
    const r = ensureVoiceprintGallery(dataDir, [src], sha);
    expect(r.status).toBe("copied");
    expect(existsSync(join(dataDir, "voiceprint", "gallery.pkl"))).toBe(true);
  });

  it("已存在则不重复拷贝", () => {
    const src = join(dir, "master.pkl"); writeFileSync(src, content);
    const dataDir = join(dir, "data");
    ensureVoiceprintGallery(dataDir, [src], sha);
    rmSync(src);
    expect(ensureVoiceprintGallery(dataDir, [src], sha).status).toBe("present");
  });

  it("哈希不匹配拒绝拷贝", () => {
    const src = join(dir, "master.pkl"); writeFileSync(src, "tampered");
    const r = ensureVoiceprintGallery(join(dir, "data"), [src], sha);
    expect(r.status).toBe("hash-mismatch");
    expect(existsSync(join(dir, "data", "voiceprint", "gallery.pkl"))).toBe(false);
  });

  it("无源时报 missing", () => {
    const r = ensureVoiceprintGallery(join(dir, "data"), [join(dir, "nope.pkl")], sha);
    expect(r.status).toBe("missing");
  });
});
