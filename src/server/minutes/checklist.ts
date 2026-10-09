import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import type { ChecklistItem, ChecklistReport } from "./types";

/**
 * 5 项完整性校验（对齐杰思 SOP v4.1 Step 5）：
 * 1. 录音时长    —— 从 audio_assets.duration_ms 取
 * 2. 转写覆盖率  —— 最后一条 endMs / 总时长
 * 3. 时间戳连续性 —— 相邻 utterance 间隔 > 60s 记可疑间断
 * 4. 说话人识别  —— speakerLabel 去重数量
 * 5. 内容可读性  —— 空文本/乱码抽样
 */
export function runChecklist(discussion: DiscussionDetailDto): ChecklistReport {
  const finalUts = discussion.utterances.filter((u) => u.isFinal);
  const totalMs = Math.max(0, ...discussion.audioAssets.map((a) => a.durationMs ?? 0));
  const lastEndMs = Math.max(0, ...finalUts.map((u) => u.endMs ?? u.startMs ?? 0));

  const items: ChecklistItem[] = [];

  // 1. 录音时长
  if (totalMs <= 0) {
    items.push({ key: "duration", label: "录音时长", status: "warn", detail: "未读取到音频时长元数据，无法核对" });
  } else {
    items.push({
      key: "duration",
      label: "录音时长",
      status: "pass",
      detail: `${formatDuration(totalMs)}`
    });
  }

  // 2. 转写覆盖率
  if (totalMs > 0 && lastEndMs > 0) {
    const coverage = lastEndMs / totalMs;
    const status = coverage >= 0.9 ? "pass" : coverage >= 0.7 ? "warn" : "fail";
    items.push({
      key: "coverage",
      label: "转写覆盖率",
      status,
      detail: `最后时间戳 ${formatDuration(lastEndMs)}，覆盖率 ${(coverage * 100).toFixed(1)}%`
    });
  } else {
    items.push({ key: "coverage", label: "转写覆盖率", status: "warn", detail: "缺少时间戳，无法计算覆盖率" });
  }

  // 3. 时间戳连续性
  const gaps: string[] = [];
  for (let i = 1; i < finalUts.length; i += 1) {
    const prevEnd = finalUts[i - 1].endMs ?? finalUts[i - 1].startMs;
    const curStart = finalUts[i].startMs;
    if (prevEnd == null || curStart == null) continue;
    const gap = curStart - prevEnd;
    if (gap > 60_000) gaps.push(`${formatDuration(prevEnd)}-${formatDuration(curStart)}`);
  }
  items.push({
    key: "continuity",
    label: "时间戳连续性",
    status: gaps.length === 0 ? "pass" : "warn",
    detail: gaps.length === 0 ? "无明显间断" : `发现 ${gaps.length} 处可疑间断：${gaps.join("、")}`
  });

  // 4. 说话人识别
  const speakerSet = new Set(finalUts.map((u) => u.speakerLabel));
  const boundCount = finalUts.filter((u) => u.participantId).length;
  if (speakerSet.size === 0) {
    items.push({ key: "speaker", label: "说话人识别", status: "fail", detail: "无转写内容" });
  } else if (speakerSet.size === 1) {
    items.push({ key: "speaker", label: "说话人识别", status: "warn", detail: "仅检测到 1 个说话人，可能未开启分离" });
  } else {
    items.push({
      key: "speaker",
      label: "说话人识别",
      status: "pass",
      detail: `已区分 ${speakerSet.size} 个说话人，其中 ${boundCount} 条已绑定参会人`
    });
  }

  // 5. 内容可读性
  const emptyCount = finalUts.filter((u) => u.text.trim().length === 0).length;
  const garbageRate = finalUts.length === 0 ? 0 : emptyCount / finalUts.length;
  items.push({
    key: "readability",
    label: "内容可读性",
    status: garbageRate < 0.05 ? "pass" : "warn",
    detail: `${finalUts.length} 条转写，空文本 ${emptyCount} 条（${(garbageRate * 100).toFixed(1)}%）`
  });

  const score =
    items.reduce((sum, item) => sum + (item.status === "pass" ? 100 : item.status === "warn" ? 60 : 20), 0) / items.length;

  return { items, overall: Math.round(score), gaps };
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export { formatDuration };
