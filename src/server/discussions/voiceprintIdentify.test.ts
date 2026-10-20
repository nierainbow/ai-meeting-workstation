import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolcengineFileTranscriber } from "../asr/volcengineFile";
import type { Type4MeFileTranscriber } from "../asr/type4meFile";
import type { MockAsrService } from "../asr/mockAsr";
import { BrainProviderRegistry } from "../codex/brainRegistry";
import { MockCodexProvider } from "../codex/mockCodex";
import { openDatabase } from "../db/database";
import { MemoryStore } from "../memory/memoryStore";
import { LocalSettingsStore } from "../settings/localSettings";
import { EventHub } from "../ws/eventHub";
import type {
  VoiceprintFileUtterance,
  VoiceprintIdentifyResult,
  VoiceprintSidecar
} from "../audio/voiceprintSidecar";
import { DiscussionRepository } from "./repository";
import { createDiscussionRouter } from "./routes";

let tempDir: string;
let server: Server;
let baseUrl: string;
let repository: DiscussionRepository;
let db: ReturnType<typeof openDatabase>;

/** 文件链路写入的 utterance id，用于断言声纹升级结果。 */
let createdUtteranceIds: string[] = [];
/** 最近一次 sidecar /identify 入参，用于断言批量语义。 */
let lastIdentifyInput: { meetingId: string; audioPath: string; utterances: VoiceprintFileUtterance[] } | null = null;
/** 可注入的 sidecar 行为，每个用例在 beforeEach 之后设置。 */
let voiceprintSidecar: VoiceprintSidecar | undefined;
/** Type4Me 文件转写 mock 返回的 audioPath；null 时回退为空结果（不送声纹）。 */
let type4meAudioPath: string | null = null;
/** 创建讨论时覆盖的 asrProvider；undefined 时走默认 funasr。 */
let asrProviderOverride: string | undefined = undefined;

function buildApp(): express.Express {
  const storagePaths = {
    dataDir: tempDir,
    databasePath: join(tempDir, "test.db"),
    discussionsDir: join(tempDir, "discussions")
  };
  const settingsStore = new LocalSettingsStore(storagePaths);
  const memoryStore = new MemoryStore(storagePaths);
  const brainRegistry = { getProvider: () => new MockCodexProvider() } as unknown as BrainProviderRegistry;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/discussions",
    createDiscussionRouter({
      repository,
      brainRegistry,
      settingsStore,
      memoryStore,
      // 文件链路 transcriber mock：写两条带时间戳 utterance 并返回 audioPath。
      funasrFileTranscriber: {
        transcribeUpload: async ({ discussionId }: { discussionId: string; filename: string; audio: Buffer }) => {
          const u1 = repository.addUtterance({
            discussionId,
            speakerLabel: "speaker_0",
            text: "第一段带时间戳的转写",
            startMs: 0,
            endMs: 3000,
            isFinal: true,
            source: "funasr"
          });
          const u2 = repository.addUtterance({
            discussionId,
            speakerLabel: "speaker_0",
            text: "第二段带时间戳的转写",
            startMs: 3500,
            endMs: 7000,
            isFinal: true,
            source: "funasr"
          });
          createdUtteranceIds = [u1.id, u2.id];
          return {
            transcript: "第一段带时间戳的转写\n第二段带时间戳的转写",
            utteranceCount: 2,
            transcriptPath: "/tmp/test.txt",
            audioPath: join(tempDir, "uploads", "test.wav")
          };
        }
      } as unknown as import("../asr/funasrFile").FunasrFileTranscriber,
      getVolcengineFileTranscriber: () =>
        ({ transcribeUpload: async () => ({ transcript: "", utteranceCount: 0, transcriptPath: "" }) }) as unknown as VolcengineFileTranscriber,
      type4meFileTranscriber: {
        transcribeUpload: async ({ discussionId }: { discussionId: string }) => {
          if (!type4meAudioPath) return { transcript: "", utteranceCount: 0, transcriptPath: "" };
          const u = repository.addUtterance({
            discussionId,
            speakerLabel: "speaker_0",
            text: "Type4Me 带时间戳的转写",
            startMs: 1000,
            endMs: 4200,
            isFinal: true,
            source: "type4me"
          });
          createdUtteranceIds = [u.id];
          return { transcript: "Type4Me 带时间戳的转写", utteranceCount: 1, transcriptPath: "/tmp/test-type4me.txt", audioPath: type4meAudioPath };
        }
      } as unknown as Type4MeFileTranscriber,
      eventHub: new EventHub(),
      storagePaths,
      mockAsr: { start: () => undefined, stop: () => undefined } as unknown as MockAsrService,
      voiceprintSidecar
    })
  );
  return app;
}

async function createDiscussionAndUpload(): Promise<{ discussionId: string; response: Response }> {
  const create = await fetch(`${baseUrl}/api/discussions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      background: "声纹接入验证",
      projectPath: tempDir,
      participants: [{ displayName: "参与人 A" }, { displayName: "参与人 B" }],
      mode: "mock",
      ...(asrProviderOverride ? { asrProvider: asrProviderOverride } : {})
    })
  });
  expect(create.status).toBe(201);
  const { id } = (await create.json()) as { id: string };
  const response = await fetch(`${baseUrl}/api/discussions/${id}/audio-upload?filename=test.wav`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("fake audio")
  });
  return { discussionId: id, response };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "voiceprint-routes-"));
  createdUtteranceIds = [];
  lastIdentifyInput = null;
  voiceprintSidecar = undefined;
  type4meAudioPath = null;
  asrProviderOverride = undefined;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function startServer(): Promise<void> {
  db = openDatabase(join(tempDir, "test.db"));
  repository = new DiscussionRepository(db);
  server = createServer(buildApp());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not start");
  baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
}

describe("T2.2 文件转写链路声纹接入", () => {
  it("把疑似姓名与待确认 #n 写回 utterance.speaker_label", async () => {
    voiceprintSidecar = {
      health: async () => true,
      identifyLive: async () => null,
      identifyFile: async (meetingId, audioPath, utterances) => {
        lastIdentifyInput = { meetingId, audioPath, utterances };
        const [u1, u2] = utterances;
        return {
          meetingId,
          clusterCount: 2,
          clusters: [
            {
              clusterId: 1,
              疑似姓名: "吴以林",
              score: 0.839,
              gap: 0.2,
              durationSec: 3,
              utterances: [u1.id ?? ""],
              疑似: true,
              autoName: null,
              reason: "主库匹配通过双条件"
            }
          ],
          pending: [
            {
              clusterId: 2,
              疑似姓名: null,
              score: 0.4,
              gap: 0.01,
              durationSec: 3.5,
              utterances: [u2.id ?? ""],
              疑似: false,
              autoName: null,
              reason: "未达疑似门槛"
            }
          ],
          galleryCount: 16
        } as VoiceprintIdentifyResult;
      }
    };

    await startServer();
    const { discussionId, response } = await createDiscussionAndUpload();
    expect(response.status).toBe(201);
    expect(lastIdentifyInput).not.toBeNull();
    // sidecar 收到的是带时间戳的整场 utterance，而非单点。
    expect(lastIdentifyInput?.utterances.length).toBe(2);

    const [u1, u2] = createdUtteranceIds;
    const labels = repository
      .getUtterances(discussionId)
      .map((u) => ({ id: u.id, label: u.speakerLabel }));
    const find = (id: string) => labels.find((l) => l.id === id)?.label;
    expect(find(u1)).toBe("吴以林");
    expect(find(u2)).toBe("待确认 #2");
  });

  it("sidecar 不可用时整段跳过、speaker_label 不变、转写链路不降级", async () => {
    // 不注入 voiceprintSidecar → 路由保持 undefined，应静默跳过。
    await startServer();
    const { discussionId, response } = await createDiscussionAndUpload();
    expect(response.status).toBe(201);
    const labels = repository
      .getUtterances(discussionId)
      .map((u) => ({ id: u.id, label: u.speakerLabel }));
    // 未接入 sidecar：保持原 speaker_0，不应抛错或改标签。
    expect(labels.every((l) => l.label === "speaker_0")).toBe(true);
    expect(lastIdentifyInput).toBeNull();
  });


  it("Type4Me 文件链路同样把 audioPath 送 sidecar /identify 并具名", async () => {
    // 复现 T2.2 范围缺陷：type4meFile.transcribeUpload 历史上不返回 audioPath，
    // 导致 routes 读取 audioPath 为 undefined 而整段跳过声纹。修复后必须透传。
    type4meAudioPath = join(tempDir, "uploads", "test-type4me.wav");
    asrProviderOverride = "type4me";
    voiceprintSidecar = {
      health: async () => true,
      identifyLive: async () => null,
      identifyFile: async (meetingId, audioPath, utterances) => {
        lastIdentifyInput = { meetingId, audioPath, utterances };
        const [u1] = utterances;
        return {
          meetingId,
          clusterCount: 1,
          clusters: [
            {
              clusterId: 1,
              疑似姓名: "李雷",
              score: 0.72,
              gap: 0.08,
              durationSec: 3.2,
              utterances: [u1.id ?? ""],
              疑似: true,
              autoName: null,
              reason: "主库匹配通过双条件"
            }
          ],
          pending: [],
          galleryCount: 16
        } as VoiceprintIdentifyResult;
      }
    };

    await startServer();
    const { discussionId, response } = await createDiscussionAndUpload();
    expect(response.status).toBe(201);
    // routes 必须读取 Type4Me 返回的 audioPath 并透传给 sidecar。
    expect(lastIdentifyInput?.audioPath).toBe(type4meAudioPath);
    expect(lastIdentifyInput?.utterances.length).toBe(1);

    const labels = repository
      .getUtterances(discussionId)
      .map((u) => ({ id: u.id, label: u.speakerLabel }));
    const find = (id: string) => labels.find((l) => l.id === id)?.label;
    expect(find(createdUtteranceIds[0])).toBe("李雷");
  });

  it("sidecar 返回 null（降级）时不改标签", async () => {
    voiceprintSidecar = {
      health: async () => true,
      identifyLive: async () => null,
      identifyFile: async () => null // 模拟 sidecar 超时/非 2xx
    };
    await startServer();
    const { discussionId, response } = await createDiscussionAndUpload();
    expect(response.status).toBe(201);
    const labels = repository
      .getUtterances(discussionId)
      .map((u) => ({ id: u.id, label: u.speakerLabel }));
    expect(labels.every((l) => l.label === "speaker_0")).toBe(true);
  });
});
