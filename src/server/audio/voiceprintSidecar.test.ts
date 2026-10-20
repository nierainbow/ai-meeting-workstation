import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductEvent } from "../../shared/events";
import type { AsrProvider } from "../asr/asrProvider";
import type { ServerConfig } from "../config/serverConfig";
import type { VoiceprintSidecar, VoiceprintIdentifyResult } from "./voiceprintSidecar";
import { VoiceprintSidecarClient } from "./voiceprintSidecar";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "../discussions/repository";
import { ensureStoragePaths } from "../storage/paths";
import { EventHub } from "../ws/eventHub";
import { AudioGateway } from "./audioGateway";

type StartSessionInput = Parameters<AsrProvider["startSession"]>[0];

let tempDir: string;
let repository: DiscussionRepository;
let db: ReturnType<typeof openDatabase>;

const REACHABLE_RESULT: VoiceprintIdentifyResult = {
  meetingId: "disc-1",
  clusterCount: 1,
  clusters: [
    {
      clusterId: 1,
      疑似姓名: "张三",
      score: 0.92,
      gap: 0.2,
      疑似: true,
      durationSec: 1.4,
      utterances: [],
      autoName: "张三",
      reason: "主库匹配且双条件达标"
    }
  ],
  pending: [],
  galleryCount: 16
};

function createFakeAsrProvider(): AsrProvider {
  return {
    checkCredentials: () => ({ ok: true }),
    startSession: async (input: StartSessionInput) => {
      let emitted = false;
      return {
        sendAudio: () => {
          if (emitted) return;
          emitted = true;
          input.onFinal({
            speakerLabel: "speaker_0",
            text: "我们开始验证真实转写。",
            startMs: 0,
            endMs: 1400
          });
        },
        close: () => undefined
      };
    }
  };
}

describe("VoiceprintSidecarClient", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    httpServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200).end();
        return;
      }
      if (req.url === "/identify") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { utterances?: Array<{ id?: string }> };
          const result: VoiceprintIdentifyResult = {
            ...REACHABLE_RESULT,
            clusters: [
              {
                ...REACHABLE_RESULT.clusters[0],
                utterances: parsed.utterances?.map((u) => u.id ?? "") ?? []
              }
            ]
          };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
  });

  it("health() 返回 true 且 identifyLive 解析聚类结果", async () => {
    const client = new VoiceprintSidecarClient(baseUrl);
    expect(await client.health()).toBe(true);
    const result = await client.identifyLive("disc-1", "/tmp/x.wav", { id: "u1", startMs: 0, endMs: 1400 });
    expect(result?.clusters[0].疑似姓名).toBe("张三");
    expect(result?.clusters[0].utterances).toEqual(["u1"]);
  });

  it("sidecar 挂掉时 identifyLive 返回 null 且不抛异常（优雅降级）", async () => {
    // 指向一个不存在的端口
    const dead = new VoiceprintSidecarClient("http://127.0.0.1:1", 500);
    await expect(dead.health()).resolves.toBe(false);
    await expect(dead.identifyLive("disc-1", "/tmp/x.wav", { id: "u1" })).resolves.toBeNull();
  });
});

describe("AudioGateway 实时声纹认人", () => {
  let server: Server;
  let baseUrlWs: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "audio-gateway-vp-"));
    const storagePaths = ensureStoragePaths({ dataDir: tempDir } as ServerConfig);
    db = openDatabase(storagePaths.databasePath);
    repository = new DiscussionRepository(db);
    const eventHub = new EventHub();
    server = createServer();
    // 回显真实结果（命中 utterance id 的簇）的假 sidecar
    const fakeSidecar: VoiceprintSidecar = {
      async health() {
        return true;
      },
      async identifyFile() {
        return null;
      },
      async identifyLive(discussionId, _audioPath, utterance) {
        return {
          meetingId: discussionId,
          clusterCount: 1,
          clusters: [
            {
              clusterId: 1,
              疑似姓名: "张三",
              score: 0.92,
              gap: 0.2,
              疑似: true,
              durationSec: 1.4,
              utterances: [utterance.id ?? ""],
              autoName: "张三",
              reason: "主库匹配且双条件达标"
            }
          ],
          pending: [],
          galleryCount: 16
        };
      }
    };
    const audioGateway = new AudioGateway({
      repository,
      eventHub,
      storagePaths,
      getAsrProvider: () => createFakeAsrProvider(),
      voiceprintSidecar: fakeSidecar
    });
    eventHub.attach(server);
    audioGateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrlWs = `ws://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("final utterance 异步送 sidecar 并经 ws 推回 speaker.identify 事件", async () => {
    const discussion = repository.createDiscussion(
      {
        title: "声纹实时认人",
        topic: "验证说话人修正事件",
        background: "验证说话人修正事件",
        projectPath: tempDir,
        mode: "real",
        participants: [{ displayName: "参与人 A" }]
      },
      "thread-1"
    );
    const eventSocket = await openSocket(`${baseUrlWs}/ws?discussionId=${discussion.id}`);
    const events: ProductEvent[] = [];
    const finalEvent = waitForEvent(eventSocket, events, (e) => e.type === "transcript.final");
    const audioSocket = await openSocket(`${baseUrlWs}/audio?discussionId=${discussion.id}&sampleRate=16000`);
    audioSocket.send(Buffer.alloc(3200));
    await finalEvent;
    // speaker.identify 是 fire-and-forget 异步推送，可能在订阅前已到达——先查已收集事件再订阅，消除竞态。
    const existing = events.find((e) => e.type === "speaker.identify");
    const ev = (existing ?? (await waitForEvent(eventSocket, events, (e) => e.type === "speaker.identify"))) as Extract<
      ProductEvent,
      { type: "speaker.identify" }
    >;
    audioSocket.close();
    eventSocket.close();

    expect(ev.payload).toMatchObject({
      discussionId: discussion.id,
      clusterId: 1
    });
    expect(ev.payload.candidates[0].疑似姓名).toBe("张三");
    expect(ev.payload.candidates[0].疑似).toBe(true);
  });
});

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForEvent(
  socket: WebSocket,
  events: ProductEvent[],
  predicate: (event: ProductEvent) => boolean
): Promise<ProductEvent> {
  return new Promise((resolve) => {
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as ProductEvent;
      events.push(event);
      if (predicate(event)) {
        resolve(event);
      }
    });
  });
}
