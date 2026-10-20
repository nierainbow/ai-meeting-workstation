/**
 * 声纹 sidecar（FastAPI，默认 8792）的 Node 调用客户端。
 *
 * 设计要点（来自《任务计划-P0-P2》T2.2/T2.3 与产品化规划第七节刚性约束）：
 * - 实时链路中每条 final utterance 异步送 sidecar，**绝不阻塞**转写回显；
 * - sidecar 挂掉 / 超时 / 返回非 2xx，一律优雅降级：identify 返回 null，
 *   调用方不抛错、不进日志敏感信息，转写链路完全不受影响；
 * - 自动认人结果只承载「疑似」语义，不做任何事实定名（UI 侧按 疑似 渲染角标）。
 */
export interface VoiceprintLiveUtterance {
  id?: string;
  startMs?: number;
  endMs?: number;
  label?: string;
}

/** 文件链路 /identify 批量送的一段（带单区间时间戳，与 sidecar Utterance 同口径）。 */
export interface VoiceprintFileUtterance {
  id?: string;
  startMs?: number;
  endMs?: number;
  label?: string;
}

export interface VoiceprintCluster {
  clusterId: number;
  /** 双条件（score>=0.65 且 gap>=0.05）通过时的疑似姓名；否则 null。 */
  疑似姓名: string | null;
  score: number;
  gap: number;
  durationSec: number;
  /** 该簇包含的 utterance id 列表（与请求里的 id 同口径）。 */
  utterances: string[];
  /** 是否达到「疑似」自动命名门槛（UI 角标据此渲染）。 */
  疑似: boolean;
  autoName: string | null;
  reason: string;
}

export interface VoiceprintIdentifyResult {
  meetingId: string;
  clusterCount: number;
  clusters: VoiceprintCluster[];
  pending: VoiceprintCluster[];
  galleryCount: number;
}

export interface VoiceprintSidecar {
  identifyFile(
    discussionId: string,
    audioPath: string,
    utterances: VoiceprintFileUtterance[]
  ): Promise<VoiceprintIdentifyResult | null>;
  identifyLive(
    discussionId: string,
    audioPath: string,
    utterance: VoiceprintLiveUtterance
  ): Promise<VoiceprintIdentifyResult | null>;
  health(): Promise<boolean>;
}

export class VoiceprintSidecarClient implements VoiceprintSidecar {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 8000
  ) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2000))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 文件转写完成后，把本场**全部**带时间戳的 utterance 一次性送给 sidecar 做
   * 聚类 + 主库匹配（批量，让 sidecar 在簇级匹配，与 meeting-agent 同口径）。
   * 失败/超时时返回 null（不抛异常，保证文件转写链路不降级）。
   *
   * 上层据此把 utterance.speaker 升级为「疑似姓名」或「待确认 #n」并落库。
   */
  async identifyFile(
    discussionId: string,
    audioPath: string,
    utterances: VoiceprintFileUtterance[],
    fileTimeoutMs: number = 60_000
  ): Promise<VoiceprintIdentifyResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fileTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/identify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioPath,
          meetingId: discussionId,
          utterances: utterances.map((utterance) => ({
            id: utterance.id,
            startMs: utterance.startMs,
            endMs: utterance.endMs,
            label: utterance.label
          }))
        }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      return (await response.json()) as VoiceprintIdentifyResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 异步送一条 final utterance 给 sidecar 做声纹匹配。
   * 失败/超时时返回 null（不抛异常，保证转写链路不降级）。
   */
  async identifyLive(
    discussionId: string,
    audioPath: string,
    utterance: VoiceprintLiveUtterance
  ): Promise<VoiceprintIdentifyResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/identify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioPath,
          meetingId: discussionId,
          utterances: [
            {
              id: utterance.id,
              startMs: utterance.startMs,
              endMs: utterance.endMs,
              label: utterance.label
            }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      return (await response.json()) as VoiceprintIdentifyResult;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
