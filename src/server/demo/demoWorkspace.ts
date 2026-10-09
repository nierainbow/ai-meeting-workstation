import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DemoBootstrapDto, DemoFallbackResultDto } from "../../shared/types";
import type { FunasrFileTranscriber } from "../asr/funasrFile";
import type { DiscussionRepository } from "../discussions/repository";
import type { MemoryStore } from "../memory/memoryStore";
import type { StoragePaths } from "../storage/paths";
import type { EventHub } from "../ws/eventHub";

export const DEMO_CUSTOMER_ID = "demo-customer";

const DEMO_CUSTOMER_PROFILE = [
  "# 示例客户档案（演示数据）",
  "",
  "## 客户做什么",
  "这是一个用于演示的示例客户档案，展示 AI 会议伴侣如何记录客户会议、沉淀决策与待办。",
  "",
  "## 当前阶段",
  "正在评估 AI 会议工具在客户会议、内部评审和项目跟进中的落地方式。",
  "",
  "## 核心团队",
  "- 主持人：负责组织会议与推进决策。",
  "- 业务方：负责汇报进展与提出需求。",
  "- AI 参谋：负责整理纪要、提炼待办与风险提示。",
  "",
  "## 演示目标",
  "讨论如何把客户会议中的决策、风险和行动项沉淀为可复用的企业上下文。",
  "",
  "## 演示边界",
  "本档案及所有人物、业务与数字均为演示数据，不对应任何真实客户。",
  ""
].join("\n");

const DEMO_MEETING_BACKGROUND =
  "示例客户经营复盘演示：讨论客户续约风险、交付知识沉淀和下一阶段 AI 会议参谋试点。所有企业、人物与业务内容均为演示数据。";

const DEMO_PARTICIPANTS = [
  { displayName: "主持人（业务方）" },
  { displayName: "产品负责人（业务方）" },
  { displayName: "AI 参谋" }
];

export function createDemoStoragePaths(basePaths: StoragePaths): StoragePaths {
  const dataDir = join(basePaths.dataDir, "demo");
  const paths = {
    dataDir,
    databasePath: join(dataDir, "app.db"),
    discussionsDir: join(dataDir, "discussions")
  };
  mkdirSync(paths.discussionsDir, { recursive: true });
  return paths;
}

export class DemoWorkspace {
  private readonly fallbackLoads = new Map<string, Promise<DemoFallbackResultDto>>();

  constructor(
    private readonly deps: {
      repository: DiscussionRepository;
      memoryStore: MemoryStore;
      funasrFileTranscriber: FunasrFileTranscriber;
      eventHub: EventHub;
      storagePaths: StoragePaths;
      fallbackAudioPath: string;
    }
  ) {
    assertDemoRoot(deps.storagePaths.dataDir);
  }

  bootstrap(): DemoBootstrapDto {
    const customer = this.deps.memoryStore.saveCustomer({
      id: DEMO_CUSTOMER_ID,
      displayName: "示例客户（演示）",
      profile: DEMO_CUSTOMER_PROFILE,
      recentCount: 5
    });

    return {
      mode: "demo",
      customer,
      meeting: {
        background: DEMO_MEETING_BACKGROUND,
        participants: DEMO_PARTICIPANTS
      },
      fallbackAudio: {
        available: existsSync(this.deps.fallbackAudioPath),
        filename: basename(this.deps.fallbackAudioPath),
        label: "示例客户经营复盘（本地 FunASR）"
      },
      isolation: {
        database: "separate",
        customers: "separate",
        recordings: "separate"
      }
    };
  }

  reset(): DemoBootstrapDto {
    if (this.fallbackLoads.size > 0) {
      throw new Error("兜底录音仍在处理中，请完成后再重置演示空间。");
    }
    this.deps.repository.clearAllDiscussions();
    this.resetDirectory(this.deps.storagePaths.discussionsDir);
    this.resetDirectory(this.deps.memoryStore.customersDir);
    return this.bootstrap();
  }

  async loadFallbackAudio(discussionId: string): Promise<DemoFallbackResultDto> {
    const activeLoad = this.fallbackLoads.get(discussionId);
    if (activeLoad) return activeLoad;

    const load = this.transcribeFallbackAudio(discussionId);
    this.fallbackLoads.set(discussionId, load);
    try {
      return await load;
    } finally {
      this.fallbackLoads.delete(discussionId);
    }
  }

  private async transcribeFallbackAudio(discussionId: string): Promise<DemoFallbackResultDto> {
    const discussion = this.deps.repository.getDiscussion(discussionId);
    if (!discussion) throw new Error("演示会议不存在，请先在演示模式中开始会议。");
    if (!existsSync(this.deps.fallbackAudioPath)) throw new Error("预置兜底录音缺失，请重新检查演示资源。");

    const markerPath = join(this.deps.storagePaths.discussionsDir, discussionId, "demo-fallback-loaded.json");
    const wasAlreadyLoaded =
      existsSync(markerPath) ||
      discussion.audioAssets.some((asset) => basename(asset.path) === basename(this.deps.fallbackAudioPath));
    if (wasAlreadyLoaded) {
      const current = this.deps.repository.getDiscussionOrThrow(discussionId);
      return {
        alreadyLoaded: true,
        transcript: current.utterances.filter((item) => item.isFinal).map((item) => item.text).join("\n"),
        utteranceCount: current.utterances.filter((item) => item.isFinal).length,
        discussion: current
      };
    }

    const result = await this.deps.funasrFileTranscriber.transcribeUpload({
      discussionId,
      filename: basename(this.deps.fallbackAudioPath),
      audio: readFileSync(this.deps.fallbackAudioPath)
    });
    const updated = this.deps.repository.getDiscussionOrThrow(discussionId);
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ loadedAt: new Date().toISOString(), utteranceCount: result.utteranceCount }, null, 2)}\n`,
      "utf8"
    );
    this.deps.eventHub.publish(discussionId, { type: "discussion.updated", discussion: updated });
    return { ...result, alreadyLoaded: false, discussion: updated };
  }

  private resetDirectory(path: string): void {
    const root = resolve(this.deps.storagePaths.dataDir);
    const target = resolve(path);
    if (target === root || !target.startsWith(`${root}${sep}`)) {
      throw new Error("演示重置目标越界，已停止清理。");
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
  }
}

function assertDemoRoot(path: string): void {
  if (basename(resolve(path)) !== "demo") {
    throw new Error("演示数据根目录必须以 demo 命名，已拒绝启动演示重置能力。");
  }
}
