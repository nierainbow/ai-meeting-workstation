import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceprintSidecar } from "../audio/voiceprintSidecar";
import { openDatabase } from "../db/database";
import { DiscussionRepository } from "../discussions/repository";
import { EventHub } from "../ws/eventHub";
import { createVoiceprintRouter } from "./routes";

describe("voiceprint 路由（T2.4 待确认面板/声纹库）", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let repository: DiscussionRepository;
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  const confirmed: Array<{ clusterId: number; name: string | null }> = [];
  const sidecar: VoiceprintSidecar = {
    health: async () => true,
    identifyFile: async () => null,
    identifyLive: async () => null,
    confirm: async (_m, clusterId, name) => { confirmed.push({ clusterId, name }); return true; },
    galleryList: async () => ({ voices: [{ name: "吴以林", samples: 484 }] }),
    galleryAction: async (a) => ({ ok: true, ...a }),
    finalize: async (meetingId) => ({ ok: true, meetingId, package: "contrib.zip" })
  };

  function makeApp(withSidecar = true) {
    const app = express();
    app.use(express.json());
    app.use("/api/voiceprint", createVoiceprintRouter({ repository, eventHub: new EventHub(), voiceprintSidecar: withSidecar ? sidecar : undefined }));
    return app;
  }

  beforeEach(async () => {
    confirmed.length = 0;
    dir = mkdtempSync(join(tmpdir(), "aimw-vpr-"));
    db = openDatabase(join(dir, "app.db"));
    repository = new DiscussionRepository(db);
    const server = makeApp().listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.on("listening", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  });
  afterEach(async () => { await closeServer(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  async function seedDiscussionWithClusters() {
    const discussion = repository.createDiscussion(
      { title: "评审会", topic: "t", background: "b", projectPath: dir, mode: "real", participants: [{ displayName: "甲" }, { displayName: "乙" }] },
      "thread-vp"
    );
    // 直接落库两条带声纹状态的 utterance
    db.prepare(`INSERT INTO utterances (id, discussion_id, speaker_label, participant_id, text, start_ms, end_ms, is_final, source, raw_event_json, created_at, cluster_id, identify_status, confirmed_by)
      VALUES (?, ?, ?, NULL, ?, 0, 1400, 1, 'file', NULL, ?, ?, ?, NULL)`)
      .run("u1", discussion.id, "疑似 吴以林", "他说我们先对齐目标", new Date().toISOString(), "3", "suspected");
    db.prepare(`INSERT INTO utterances (id, discussion_id, speaker_label, participant_id, text, start_ms, end_ms, is_final, source, raw_event_json, created_at, cluster_id, identify_status, confirmed_by)
      VALUES (?, ?, ?, NULL, ?, 1400, 2800, 1, 'file', NULL, ?, ?, ?, NULL)`)
      .run("u2", discussion.id, "待确认 #5", "我补充一点数据", new Date().toISOString(), "5", "pending");
    return discussion.id;
  }

  it("GET /pending 按簇分组 suspected/pending", async () => {
    const id = await seedDiscussionWithClusters();
    const res = await fetch(`${baseUrl}/api/voiceprint/pending?discussionId=${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { clusters: Array<{ clusterId: string; currentLabel: string; identifyStatus: string; utteranceCount: number }> };
    expect(body.clusters).toHaveLength(2);
    const c3 = body.clusters.find((c) => c.clusterId === "3")!;
    expect(c3.currentLabel).toBe("疑似 吴以林");
    expect(c3.identifyStatus).toBe("suspected");
  });

  it("POST /confirm 具名确认：sidecar 收到 + DB 整簇定名 confirmed", async () => {
    const id = await seedDiscussionWithClusters();
    const res = await fetch(`${baseUrl}/api/voiceprint/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ discussionId: id, clusterId: 3, name: "吴以林" })
    });
    expect(res.status).toBe(200);
    expect(confirmed).toEqual([{ clusterId: 3, name: "吴以林" }]);
    const rows = repository.listUtterancesByIdentifyStatus(id, ["confirmed"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].speakerLabel).toBe("吴以林");
    expect(rows[0].confirmedBy).toBe("local-user");
    expect(repository.listUtterancesByIdentifyStatus(id, ["suspected", "pending"])).toHaveLength(1); // 只剩簇5
  });

  it("POST /confirm 不带名 = 跳过该簇（rejected）", async () => {
    const id = await seedDiscussionWithClusters();
    const res = await fetch(`${baseUrl}/api/voiceprint/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ discussionId: id, clusterId: 5 })
    });
    expect(res.status).toBe(200);
    expect(confirmed).toEqual([{ clusterId: 5, name: null }]);
    expect(repository.listUtterancesByIdentifyStatus(id, ["pending"])).toHaveLength(0);
    expect(repository.listUtterancesByIdentifyStatus(id, ["rejected"])).toHaveLength(1);
  });

  it("GET /gallery 代理 sidecar；未配置 sidecar 时 503", async () => {
    const res = await fetch(`${baseUrl}/api/voiceprint/gallery`);
    expect(res.status).toBe(200);
    const body = await res.json() as { voices: Array<{ name: string }> };
    expect(body.voices[0].name).toBe("吴以林");
    // 无 sidecar 的 app
    const bare = makeApp(false).listen(0, "127.0.0.1");
    await new Promise<void>((r) => bare.on("listening", r));
    const bareUrl = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    const r2 = await fetch(`${bareUrl}/api/voiceprint/gallery`);
    expect(r2.status).toBe(503);
    await new Promise<void>((res2, rej) => bare.close((e) => (e ? rej(e) : res2())));
  });
});
