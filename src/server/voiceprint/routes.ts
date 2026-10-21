import { Router } from "express";
import { z } from "zod";
import type { DiscussionRepository } from "../discussions/repository";
import type { EventHub } from "../ws/eventHub";
import type { VoiceprintSidecar } from "../audio/voiceprintSidecar";

const confirmSchema = z.object({
  discussionId: z.string().min(1),
  clusterId: z.number().int(),
  /** 确认姓名；null/缺省 = 跳过该簇（rejected）。 */
  name: z.string().min(1).nullish(),
  confirmedBy: z.string().min(1).default("local-user")
});

/**
 * T2.4 待确认面板 + 声纹库管理的服务端路由。
 * 全部代理 sidecar（/confirm /gallery /finalize）并同步本地 DB 三列；
 * sidecar 未配置时返回 503 而不是报错页面。
 */
export function createVoiceprintRouter(deps: {
  repository: DiscussionRepository;
  eventHub: EventHub;
  voiceprintSidecar?: VoiceprintSidecar;
}): Router {
  const router = Router();

  const requireSidecar = (): VoiceprintSidecar => {
    if (!deps.voiceprintSidecar || !deps.voiceprintSidecar.confirm) {
      const error = new Error("声纹 sidecar 未启用（未配置 VOICEPRINT_SIDECAR_URL）");
      (error as { status?: number }).status = 503;
      throw error;
    }
    return deps.voiceprintSidecar;
  };

  // 待确认面板数据：按簇分组 suspected/pending 的 utterance
  router.get("/pending", (request, response) => {
    const discussionId = String(request.query.discussionId ?? "");
    if (!discussionId) {
      response.status(400).json({ error: "discussionId required" });
      return;
    }
    const rows = deps.repository.listUtterancesByIdentifyStatus(discussionId, ["suspected", "pending"]);
    const byCluster = new Map<string, { clusterId: string; currentLabel: string; identifyStatus: string; utterances: typeof rows }>();
    for (const row of rows) {
      const key = row.clusterId ?? "unknown";
      const bucket = byCluster.get(key) ?? { clusterId: key, currentLabel: row.speakerLabel, identifyStatus: row.identifyStatus ?? "pending", utterances: [] };
      bucket.utterances.push(row);
      byCluster.set(key, bucket);
    }
    response.json({
      discussionId,
      clusters: [...byCluster.values()].map((bucket) => ({
        clusterId: bucket.clusterId,
        currentLabel: bucket.currentLabel,
        identifyStatus: bucket.identifyStatus,
        utteranceCount: bucket.utterances.length,
        samples: bucket.utterances.slice(0, 3).map((u) => ({ id: u.id, text: u.text.slice(0, 80), startMs: u.startMs, endMs: u.endMs }))
      }))
    });
  });

  // 人工确认 / 跳过
  router.post("/confirm", async (request, response) => {
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { discussionId, clusterId, name, confirmedBy } = parsed.data;
    try {
      const sidecar = requireSidecar();
      const ok = await sidecar.confirm!(discussionId, clusterId, name ?? null);
      if (!ok) {
        response.status(502).json({ error: "sidecar 确认失败或不可用" });
        return;
      }
      const updated = deps.repository.confirmClusterIdentification(discussionId, String(clusterId), name ?? null, confirmedBy);
      const discussion = deps.repository.getDiscussion(discussionId);
      if (discussion) deps.eventHub.publish(discussionId, { type: "discussion.updated", discussion });
      response.json({ ok: true, updated, status: name ? "confirmed" : "rejected" });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      response.status(status).json({ error: error instanceof Error ? error.message : "confirm failed" });
    }
  });

  // 声纹库读取
  router.get("/gallery", async (_request, response) => {
    try {
      const gallery = await requireSidecar().galleryList!();
      if (gallery === null) {
        response.status(502).json({ error: "sidecar 不可用" });
        return;
      }
      response.json(gallery);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "gallery failed" });
    }
  });

  // 声纹库操作（rename|merge|delete）
  router.post("/gallery", async (request, response) => {
    try {
      const result = await requireSidecar().galleryAction!(request.body ?? {});
      if (result === null) {
        response.status(502).json({ error: "sidecar 操作失败或不可用" });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "gallery action failed" });
    }
  });

  // 会议收尾：产出贡献包
  router.post("/finalize", async (request, response) => {
    const body = (request.body ?? {}) as { meetingId?: string; meetingTitle?: string; contributor?: string };
    if (!body.meetingId) {
      response.status(400).json({ error: "meetingId required" });
      return;
    }
    try {
      const result = await requireSidecar().finalize!(body.meetingId, { contributor: body.contributor, meetingTitle: body.meetingTitle });
      if (result === null) {
        response.status(502).json({ error: "sidecar 不可用" });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "finalize failed" });
    }
  });

  return router;
}
