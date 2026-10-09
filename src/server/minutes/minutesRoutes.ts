import { Router } from "express";
import type { DiscussionRepository } from "../discussions/repository";
import { MinutesEngine } from "./engine";
import type { MeetingScene } from "./types";
import { MEETING_SCENES } from "./types";

const SCENE_VALUES = new Set<MeetingScene>(MEETING_SCENES.map((s) => s.value));

export function createMinutesRouter(deps: { repository: DiscussionRepository; configDir: string }): Router {
  const router = Router();
  const engine = new MinutesEngine({ configDir: deps.configDir });

  // 场景列表
  router.get("/scenes", (_req, res) => {
    res.json(MEETING_SCENES);
  });

  // 预览：返回校验报告 + 待办 + 校对报告 + 两份 MD 全文
  router.get("/:id/preview", (req, res) => {
    const discussion = deps.repository.getDiscussion(req.params.id);
    if (!discussion) {
      res.status(404).json({ error: "discussion not found" });
      return;
    }
    const scene = parseScene(req.query.scene);
    const topicOverride = typeof req.query.topic === "string" ? req.query.topic : undefined;
    const result = engine.generate(discussion, scene, topicOverride);
    res.json({
      scene,
      checklist: result.checklist,
      todos: result.todos,
      proofread: result.proofread,
      deliverableMarkdown: result.deliverableMarkdown,
      archiveMarkdown: result.archiveMarkdown,
      deliverableFilename: result.deliverableFilename,
      archiveFilename: result.archiveFilename
    });
  });

  // 下载交付件
  router.get("/:id/deliverable.md", (req, res) => {
    const discussion = deps.repository.getDiscussion(req.params.id);
    if (!discussion) {
      res.status(404).json({ error: "discussion not found" });
      return;
    }
    const result = engine.generate(discussion, parseScene(req.query.scene), typeof req.query.topic === "string" ? req.query.topic : undefined);
    res
      .status(200)
      .type("text/markdown; charset=utf-8")
      .attachment(result.deliverableFilename)
      .send(result.deliverableMarkdown);
  });

  // 下载存档包
  router.get("/:id/archive.md", (req, res) => {
    const discussion = deps.repository.getDiscussion(req.params.id);
    if (!discussion) {
      res.status(404).json({ error: "discussion not found" });
      return;
    }
    const result = engine.generate(discussion, parseScene(req.query.scene), typeof req.query.topic === "string" ? req.query.topic : undefined);
    res
      .status(200)
      .type("text/markdown; charset=utf-8")
      .attachment(result.archiveFilename)
      .send(result.archiveMarkdown);
  });

  return router;
}

function parseScene(value: unknown): MeetingScene {
  if (typeof value === "string" && SCENE_VALUES.has(value as MeetingScene)) return value as MeetingScene;
  return "default";
}
