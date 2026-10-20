import { raw, Router } from "express";
import { existsSync, rmSync } from "node:fs";
import {
  aiFeedbackSchema,
  bindSpeakerSchema,
  createDiscussionSchema,
  memoryDraftConfirmSchema,
  routeIdSchema,
  triggerAiTurnSchema
} from "../../shared/schemas";
import type { FunasrFileTranscriber } from "../asr/funasrFile";
import type { VolcengineFileTranscriber } from "../asr/volcengineFile";
import type { Type4MeFileTranscriber } from "../asr/type4meFile";
import type { MockAsrService } from "../asr/mockAsr";
import type { BrainProviderRegistry } from "../codex/brainRegistry";
import { TruncatedAiResponseError } from "../codex/provider";
import type { LocalSettingsStore } from "../settings/localSettings";
import { modelForProvider } from "../settings/localSettings";
import type { MemoryStore } from "../memory/memoryStore";
import type { StoragePaths } from "../storage/paths";
import type { EventHub } from "../ws/eventHub";
import { createDiscussionPackage, discussionExportFileStem, renderDiscussionMarkdown } from "./exporters";
import type { DiscussionRepository } from "./repository";
import type { VoiceprintSidecar, VoiceprintFileUtterance } from "../audio/voiceprintSidecar";

/**
 * T2.2 文件转写链路声纹接入的落库逻辑。
 *
 * 把整场带时间戳的 utterance 批量送 sidecar /identify，依据返回把每条 utterance 的
 * speaker_label 升级为「疑似姓名」或「待确认 #n」并写回 DB。
 *
 * 刚性约束（产品化规划第七节）：
 * - 绝不做事实定名：疑似通过也只标「疑似姓名」语义，UI 负责按 疑似 渲染角标；
 * - 时间戳缺失（如 type4me 逐行无时间）或 sidecar 不可用时整段跳过，不影响转写；
 * - 任何异常都吞掉，保证文件转写链路不降级。
 */
async function applyVoiceprintIdentify(input: {
  repository: DiscussionRepository;
  voiceprintSidecar?: VoiceprintSidecar;
  discussionId: string;
  audioPath?: string;
}): Promise<void> {
  if (!input.voiceprintSidecar || !input.audioPath) return;

  const utterances = input.repository.getUtterances(input.discussionId);
  const candidates: VoiceprintFileUtterance[] = utterances
    .filter((utterance) => typeof utterance.startMs === "number" && typeof utterance.endMs === "number")
    .map((utterance) => ({
      id: utterance.id,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      label: utterance.speakerLabel
    }));
  if (candidates.length === 0) return;

  let result: Awaited<ReturnType<VoiceprintSidecar["identifyFile"]>> = null;
  try {
    result = await input.voiceprintSidecar.identifyFile(input.discussionId, input.audioPath, candidates);
  } catch {
    return;
  }
  if (!result) return;

  const speakerByUtterance = new Map<string, { label: string }>();
  for (const cluster of [...result.clusters, ...result.pending]) {
    const label = cluster.疑似 && cluster.疑似姓名 ? cluster.疑似姓名 : `待确认 #${cluster.clusterId}`;
    for (const utteranceId of cluster.utterances) {
      speakerByUtterance.set(utteranceId, { label });
    }
  }

  for (const utterance of utterances) {
    const hit = speakerByUtterance.get(utterance.id);
    if (!hit) continue;
    await input.repository.updateUtteranceSpeaker(input.discussionId, utterance.id, hit.label);
  }
}


export function createDiscussionRouter(deps: {
  repository: DiscussionRepository;
  mockAsr: MockAsrService;
  brainRegistry: BrainProviderRegistry;
  settingsStore: LocalSettingsStore;
  memoryStore: MemoryStore;
  funasrFileTranscriber: FunasrFileTranscriber;
  getVolcengineFileTranscriber: () => VolcengineFileTranscriber;
  type4meFileTranscriber: Type4MeFileTranscriber;
  eventHub: EventHub;
  storagePaths: StoragePaths;
  /** 声纹 sidecar 客户端；为空表示不启用文件链路声纹认人（不阻塞转写）。 */
  voiceprintSidecar?: VoiceprintSidecar;
}): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    const parsed = createDiscussionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const settings = deps.settingsStore.load();
      const brainProvider = parsed.data.brainProvider ?? settings.brainProvider;
      const asrProvider = parsed.data.asrProvider ?? settings.asrProvider;
      const brainModel = parsed.data.brainModel || modelForProvider(settings, brainProvider);
      const createInput = { ...parsed.data, brainProvider, asrProvider, brainModel };
      const provider = deps.brainRegistry.getProvider(brainProvider, brainModel);
      const codexThreadId = await provider.createThread({ discussion: createInput });
      const discussion = deps.repository.createDiscussion(createInput, codexThreadId);
      response.status(201).json(discussion);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "AI 大脑会话创建失败。" });
    }
  });

  router.get("/", (_request, response) => {
    response.json(deps.repository.listDiscussionSummaries());
  });

  router.get("/:id", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response.json(discussion);
  });

  router.post("/:id/speaker-bindings", (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = bindSpeakerSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }

    const binding = deps.repository.bindSpeaker(params.data.id, body.data);
    const discussion = deps.repository.getDiscussionOrThrow(params.data.id);
    if (discussion.customerId) {
      const participant = discussion.participants.find((item) => item.id === body.data.participantId);
      if (participant) deps.memoryStore.rememberSpeaker(discussion.customerId, body.data.speakerLabel, participant.displayName);
    }
    deps.eventHub.publish(params.data.id, { type: "speaker.binding.updated", binding });
    deps.eventHub.publish(params.data.id, { type: "discussion.updated", discussion });
    response.json(binding);
  });

  router.post("/:id/audio-upload", raw({ type: "*/*", limit: "200mb" }), async (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      response.status(400).json({ error: "请上传非空音频文件。" });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    try {
      const encodedHeader = readStringHeader(request.headers["x-filename"]);
      const filename =
        (encodedHeader ? safeDecodeHeader(encodedHeader) : "") ||
        new URLSearchParams(String(request.url).split("?")[1] || "").get("filename") ||
        "upload.wav";
      const transcriber =
        discussion.asrProvider === "volcengine-file"
          ? deps.getVolcengineFileTranscriber()
          : discussion.asrProvider === "type4me"
            ? deps.type4meFileTranscriber
            : deps.funasrFileTranscriber;
      const result = await transcriber.transcribeUpload({
        discussionId: discussion.id,
        filename,
        audio: request.body
      });

      // T2.2 文件转写链路接入声纹：转写完成后把整场带时间戳的 utterance 一次性送
      // sidecar 做聚类 + 主库匹配，再把说话人升级为「疑似姓名」或「待确认 #n」。
      // sidecar 不可用 / 无音频路径 / 无时间戳时静默跳过（绝不阻塞转写回显）。
      await applyVoiceprintIdentify({
        repository: deps.repository,
        voiceprintSidecar: deps.voiceprintSidecar,
        discussionId: discussion.id,
        audioPath: "audioPath" in result ? (result as { audioPath: string }).audioPath : undefined
      });

      const updated = deps.repository.getDiscussionOrThrow(discussion.id);
      deps.eventHub.publish(discussion.id, { type: "discussion.updated", discussion: updated });
      response.status(201).json({ ...result, discussion: updated });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "录音文件识别失败。" });
    }
  });

  router.get("/:id/export/markdown", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response
      .status(200)
      .type("text/markdown; charset=utf-8")
      .attachment(`${discussionExportFileStem(discussion)}.md`)
      .send(renderDiscussionMarkdown(discussion));
  });

  router.get("/:id/export/package", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    response
      .status(200)
      .type("application/zip")
      .attachment(`${discussionExportFileStem(discussion)}.zip`)
      .send(createDiscussionPackage(discussion, deps.storagePaths));
  });

  router.post("/:id/ai-turns", async (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = triggerAiTurnSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(params.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const utterances = deps.repository.listFinalUtterancesSinceLastAiTurn(discussion.id);
    const provider = deps.brainRegistry.getProvider(discussion.brainProvider, discussion.brainModel);
    const settings = deps.settingsStore.load();
    const memoryContext = deps.memoryStore.buildPromptContext(discussion.customerId, settings.recentMemoryCount);
    const turnInput = { discussion, utterances, memoryContext, guidance: body.data.guidance };
    const prompt = provider.buildPrompt(turnInput);
    const triggerStartUtteranceId = utterances.at(0)?.id;
    const triggerEndUtteranceId = utterances.at(-1)?.id;

    try {
      const responseText = await provider.respond(turnInput);
      const aiTurn = deps.repository.createCompletedAiTurn({
        discussionId: discussion.id,
        codexThreadId: discussion.codexThreadId,
        prompt,
        response: responseText,
        triggerStartUtteranceId,
        triggerEndUtteranceId
      });

      deps.eventHub.publish(discussion.id, { type: "codex.turn.completed", aiTurn });
      response.status(201).json(aiTurn);
    } catch (error) {
      if (error instanceof TruncatedAiResponseError) {
        const aiTurn = deps.repository.createTruncatedAiTurn({
          discussionId: discussion.id,
          codexThreadId: discussion.codexThreadId,
          prompt,
          response: error.partialResponse,
          triggerStartUtteranceId,
          triggerEndUtteranceId
        });

        deps.eventHub.publish(discussion.id, { type: "codex.turn.truncated", aiTurn });
        response.status(201).json(aiTurn);
        return;
      }
      const message = error instanceof Error ? error.message : "AI 大脑发言失败。";
      const aiTurn = deps.repository.createFailedAiTurn({
        discussionId: discussion.id,
        codexThreadId: discussion.codexThreadId,
        prompt,
        errorMessage: message,
        triggerStartUtteranceId,
        triggerEndUtteranceId
      });

      deps.eventHub.publish(discussion.id, { type: "codex.turn.failed", aiTurnId: aiTurn.id, message });
      response.status(503).json(aiTurn);
    }
  });

  router.post("/:id/ai-turns/:aiTurnId/feedback", (request, response) => {
    const params = routeIdSchema.safeParse({ id: request.params.id });
    const body = aiFeedbackSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }
    try {
      const aiTurn = deps.repository.markAiTurnFeedback({
        discussionId: params.data.id,
        aiTurnId: request.params.aiTurnId,
        rating: body.data.rating
      });
      response.json(aiTurn);
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "AI 发言不存在。" });
    }
  });

  router.post("/:id/memory-draft", async (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }
    if (!discussion.customerId) {
      response.status(400).json({ error: "当前会议未选择客户，无法沉淀客户记忆。" });
      return;
    }
    try {
      const provider = deps.brainRegistry.getProvider(discussion.brainProvider, discussion.brainModel);
      const draftText = await provider.completePrompt({
        prompt: deps.memoryStore.buildMemoryDraftPrompt(discussion),
        cwd: discussion.projectPath
      });
      const draft = deps.memoryStore.createDraft({
        customerId: discussion.customerId,
        discussionId: discussion.id,
        content: draftText
      });
      response.status(201).json(draft);
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "记忆草稿起草失败。" });
    }
  });

  router.post("/:id/memory-draft/confirm", (request, response) => {
    const params = routeIdSchema.safeParse(request.params);
    const body = memoryDraftConfirmSchema.safeParse(request.body);
    if (!params.success) {
      response.status(400).json({ error: params.error.flatten() });
      return;
    }
    if (!body.success) {
      response.status(400).json({ error: body.error.flatten() });
      return;
    }
    const discussion = deps.repository.getDiscussion(params.data.id);
    if (!discussion?.customerId) {
      response.status(400).json({ error: "当前会议未选择客户，无法确认客户记忆。" });
      return;
    }
    const memory = deps.memoryStore.confirmDraft({
      customerId: discussion.customerId,
      discussionId: discussion.id,
      content: body.data.content
    });
    response.json({ memory, customer: deps.memoryStore.getCustomer(discussion.customerId) });
  });

  router.post("/:id/end", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    deps.mockAsr.stop(parsed.data.id);
    const discussion = deps.repository.endDiscussion(parsed.data.id);
    deps.eventHub.publish(parsed.data.id, { type: "discussion.updated", discussion });
    response.json(discussion);
  });

  router.delete("/:id/audio", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const assets = discussion.audioAssets;
    for (const asset of assets) {
      if (existsSync(asset.path)) rmSync(asset.path, { force: true });
    }
    deps.repository.deleteAudioAssets(parsed.data.id);
    response.json(deps.repository.getDiscussionOrThrow(parsed.data.id));
  });

  router.delete("/:id", (request, response) => {
    const parsed = routeIdSchema.safeParse(request.params);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const discussion = deps.repository.getDiscussion(parsed.data.id);
    if (!discussion) {
      response.status(404).json({ error: "discussion not found" });
      return;
    }

    const discussionDir = `${deps.storagePaths.discussionsDir}/${parsed.data.id}`;
    if (existsSync(discussionDir)) rmSync(discussionDir, { recursive: true, force: true });
    const deleted = deps.repository.deleteDiscussion(parsed.data.id);
    response.json({ deleted });
  });

  return router;
}

function readStringHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeDecodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
