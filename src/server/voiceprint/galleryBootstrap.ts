import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 声纹主库自举（T2.5）：把 meeting-agent 冻结仓库里的 16 人主库
 * 校验 sha256 后拷贝到 <dataDir>/voiceprint/gallery.pkl。
 * 主库永不进本仓库 git（见 meeting-agent/assets/VOICEPRINT_MANIFEST.md）。
 */
export const VOICEPRINT_GALLERY_SHA256 =
  "1ffc5b3d44b6ca7d79d054d449d021703fd93d8c9a40819fc41dcda8ae40a965";

export type GalleryBootstrapResult =
  | { status: "present"; path: string }
  | { status: "copied"; path: string; from: string }
  | { status: "missing"; path: string; triedSources: string[] }
  | { status: "hash-mismatch"; path: string; from: string; actual: string };

export function defaultGallerySources(): string[] {
  const envSrc = process.env.VOICEPRINT_GALLERY_SRC?.trim();
  const candidates: string[] = [];
  if (envSrc) candidates.push(envSrc);
  // 开发态：仓库与 meeting-agent 同级
  candidates.push(join(process.cwd(), "..", "meeting-agent", "assets", "speaker_gallery_master.pkl"));
  return candidates;
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function ensureVoiceprintGallery(
  dataDir: string,
  sources: string[] = defaultGallerySources(),
  expectedSha256: string = VOICEPRINT_GALLERY_SHA256
): GalleryBootstrapResult {
  const target = join(dataDir, "voiceprint", "gallery.pkl");
  if (existsSync(target)) return { status: "present", path: target };
  for (const from of sources) {
    if (!existsSync(from)) continue;
    const actual = sha256OfFile(from);
    if (actual !== expectedSha256) {
      return { status: "hash-mismatch", path: target, from, actual };
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
    return { status: "copied", path: target, from };
  }
  return { status: "missing", path: target, triedSources: sources };
}
