import { Router } from "express";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { DiscussionRepository } from "../discussions/repository";

type Deps = {
  repository: DiscussionRepository;
  scriptsDir: string;
};

export function createImportRouter({ repository, scriptsDir }: Deps) {
  const router = Router();

  // POST /api/import/yuanbao
  router.post("/yuanbao", async (request, response) => {
    const { url, title, scene = "review" } = request.body as {
      url?: string;
      title?: string;
      scene?: string;
    };

    if (!url || !url.includes("yuanbao.tencent.com")) {
      return response.status(400).json({ error: "请提供有效的元宝分享链接（yuanbao.tencent.com）" });
    }

    const outDir = join(tmpdir(), `yuanbao-import-${randomUUID()}`);
    mkdirSync(outDir, { recursive: true });

    const scriptPath = resolve(scriptsDir, "import_yuanbao.py");

    try {
      // 1. 调 sidecar 拉取并解析
      const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
        execFile(
          "python3",
          [scriptPath, "--url", url, "--output-dir", outDir],
          { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdoutStr) => {
            if (error) rejectPromise(new Error(`sidecar 失败: ${error.message}\n${stdoutStr}`));
            else resolvePromise(stdoutStr);
          }
        );
      });

      const result = JSON.parse(stdout.trim());
      if (!result.ok) throw new Error(result.error || "元宝解析失败");

      // 2. 读元数据和分段
      const meta = JSON.parse(readFileSync(join(outDir, "yuanbao_meta.json"), "utf8"));
      const segments = JSON.parse(readFileSync(join(outDir, "speaker_segments.json"), "utf8"));

      // 3. 创建 discussion
      const codexThreadId = `yuanbao-${Date.now()}`;
      const discussion = repository.createDiscussion({
        title: title || meta.title || "元宝导入会议",
        topic: "元宝导入",
        background: `来源：${url}`,
        projectPath: outDir,
        participants: [],
        mode: "real",
      }, codexThreadId);

      // 4. 插入 utterances
      for (const seg of segments) {
        repository.addUtterance({
          discussionId: discussion.id,
          speakerLabel: seg.speaker || "spk0",
          text: seg.text,
          startMs: seg.start || 0,
          endMs: seg.end || (seg.start || 0) + 3000,
          isFinal: true,
          source: "yuanbao",
        });
      }

      response.json({
        ok: true,
        discussionId: discussion.id,
        title: discussion.title,
        sentenceCount: segments.length,
        durationMs: meta.durationMs || 0,
        scene,
      });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
