import { Router } from "express";
import type { DiscussionRepository } from "../discussions/repository";
import type { LocalSettingsStore } from "../settings/localSettings";
import { MinutesEngine } from "./engine";
import { polishAllUtterances } from "./polish";
import type { MeetingScene } from "./types";
import { MEETING_SCENES } from "./types";

const SCENE_VALUES = new Set<MeetingScene>(MEETING_SCENES.map((s) => s.value));

export function createMinutesRouter(deps: {
  repository: DiscussionRepository;
  configDir: string;
  settingsStore?: LocalSettingsStore;
}): Router {
  const router = Router();
  const engine = new MinutesEngine({ configDir: deps.configDir });

  // 场景列表
  router.get("/scenes", (_req, res) => {
    res.json(MEETING_SCENES);
  });

  // 预览：返回校验报告 + 待办 + 校对报告 + 两份 MD 全文
  router.get("/:id/preview", async (req, res) => {
    const discussion = deps.repository.getDiscussion(req.params.id);
    if (!discussion) {
      res.status(404).json({ error: "discussion not found" });
      return;
    }
    const scene = parseScene(req.query.scene);
    const topicOverride = typeof req.query.topic === "string" ? req.query.topic : undefined;
    const wantPolish = req.query.polish === "true";

    // 可选 LLM 润色
    let discussionToUse = discussion;
    if (wantPolish && deps.settingsStore) {
      const settings = deps.settingsStore.load();
      const finalUtterances = discussion.utterances.filter((u) => u.isFinal);
      const polished = await polishAllUtterances(finalUtterances, settings);
      discussionToUse = { ...discussion, utterances: polished };
    }

    const result = engine.generate(discussionToUse, scene, topicOverride);
    res.json({
      scene,
      polished: wantPolish,
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
  router.get("/:id/deliverable.md", async (req, res) => {
    const discussion = deps.repository.getDiscussion(req.params.id);
    if (!discussion) {
      res.status(404).json({ error: "discussion not found" });
      return;
    }
    const wantPolish = req.query.polish === "true";
    let discussionToUse = discussion;
    if (wantPolish && deps.settingsStore) {
      const settings = deps.settingsStore.load();
      const finalUtterances = discussion.utterances.filter((u) => u.isFinal);
      const polished = await polishAllUtterances(finalUtterances, settings);
      discussionToUse = { ...discussion, utterances: polished };
    }
    const result = engine.generate(discussionToUse, parseScene(req.query.scene), typeof req.query.topic === "string" ? req.query.topic : undefined);
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
