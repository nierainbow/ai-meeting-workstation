import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import type { ChecklistReport, MeetingScene, ProofreadReport, SpeakerStat, TodoItem } from "./types";
import { formatDuration } from "./checklist";

export type ArchiveInput = {
  discussion: DiscussionDetailDto;
  rawUtterances: UtteranceDto[];
  correctedUtterances: UtteranceDto[];
  scene: MeetingScene;
  checklist: ChecklistReport;
  todos: TodoItem[];
  proofread: ProofreadReport;
  speakerStats: SpeakerStat[];
  topicOverride?: string;
};

export function renderArchive(input: ArchiveInput): string {
  const { discussion, rawUtterances: uts, checklist, todos, proofread, speakerStats } = input;
  const title = input.topicOverride || discussion.title || discussion.topic || "未命名会议";
  const date = discussion.createdAt.slice(0, 10).replaceAll("-", "");

  const lines: string[] = [];
  lines.push(`# 会议存档-${title}-${date}`, "");
  lines.push("> 本文件为内部过程存档，含校验报告、校对记录、说话人映射与完整原话，请勿直接转发业务方。", "");

  // 一、完整性校验报告
  lines.push("## 一、完整性校验报告", "");
  lines.push("| 校验项 | 状态 | 详情 |");
  lines.push("|---|---|---|");
  for (const item of checklist.items) {
    const icon = item.status === "pass" ? "✅ 通过" : item.status === "warn" ? "⚠️ 警告" : "❌ 异常";
    lines.push(`| ${item.label} | ${icon} | ${item.detail} |`);
  }
  lines.push("");
  lines.push(`**总体得分**：${checklist.overall}/100`);
  if (checklist.gaps.length > 0) {
    lines.push(`**可疑间断**：${checklist.gaps.join("；")}`);
  }
  lines.push("");

  // 二、说话人统计与映射
  lines.push("## 二、说话人统计与映射", "");
  lines.push("| speakerLabel | 显示名 | 发言条数 | 总字数 | 时间段 |");
  lines.push("|---|---|---|---|---|");
  for (const s of speakerStats) {
    const range = s.firstMs != null && s.lastMs != null ? `${formatDuration(s.firstMs)}-${formatDuration(s.lastMs)}` : "-";
    lines.push(`| ${s.speakerLabel} | ${s.displayName} | ${s.utteranceCount} | ${s.totalChars} | ${range} |`);
  }
  lines.push("");

  // 三、名称校对记录
  lines.push("## 三、名称校对记录", "");
  if (proofread.corrections.length === 0 && proofread.suspicious.length === 0) {
    lines.push("- 本次未命中校对词表。");
  } else {
    if (proofread.corrections.length > 0) {
      lines.push("### 自动校正", "");
      lines.push("| 原词 | 校正为 | 类型 | 命中次数 | 说明 |");
      lines.push("|---|---|---|---|---|");
      for (const c of proofread.corrections) {
        lines.push(`| ${c.wrong} | ${c.right} | ${c.type} | ${c.occurrences.length} | ${c.note ?? ""} |`);
      }
      lines.push("");
    }
    if (proofread.suspicious.length > 0) {
      lines.push("### 存疑待人工确认", "");
      for (const s of proofread.suspicious.slice(0, 20)) {
        lines.push(`- 原文「${s.raw}」疑为「${s.guess}」：${s.context}`);
      }
      lines.push("");
    }
  }

  // 四、待办提取
  lines.push("## 四、待办提取", "");
  if (todos.length === 0) {
    lines.push("- 规则法未识别到明确待办。");
  } else {
    for (const t of todos) {
      const ts = t.timestampMs != null ? `[${formatDuration(t.timestampMs)}]` : "";
      lines.push(`- ${ts} ${t.text}${t.owner ? `（负责人：${t.owner}）` : ""}${t.due ? `（截止：${t.due}）` : ""}`);
    }
  }
  lines.push("");

  // 五、AI 发言记录
  const aiTurns = discussion.aiTurns.filter((t) => t.status === "completed" || t.status === "truncated");
  if (aiTurns.length > 0) {
    lines.push("## 五、AI 参谋发言记录", "");
    for (const t of aiTurns) {
      lines.push(`### ${new Date(t.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}`, "");
      lines.push(`> 提示词：${t.prompt.slice(0, 200)}${t.prompt.length > 200 ? "…" : ""}`, "");
      lines.push(t.response ?? "（无回复）");
      lines.push("");
    }
  }

  // 六、完整逐句转写
  lines.push("## 六、完整逐句转写", "");
  const finalUts = uts.filter((u) => u.isFinal);
  let currentSpeaker = "";
  for (const u of finalUts) {
    if (u.speakerLabel !== currentSpeaker) {
      currentSpeaker = u.speakerLabel;
      lines.push(`### ${displayName(discussion, u)}（${currentSpeaker}）`, "");
    }
    const ts = u.startMs != null ? `[${formatDuration(u.startMs)}] ` : "";
    lines.push(`${ts}${u.text}`);
  }
  lines.push("");

  // 元信息
  lines.push("---", "");
  lines.push(`- 会议 ID：${discussion.id}`);
  lines.push(`- 转写条数：${finalUts.length}`);
  lines.push(`- 场景：${input.scene}`);
  lines.push(`- ASR：${discussion.asrProvider ?? "unknown"}`);
  lines.push("");

  return lines.join("\n");
}

function displayName(discussion: DiscussionDetailDto, u: UtteranceDto): string {
  if (u.participantId) {
    const p = discussion.participants.find((p) => p.id === u.participantId);
    if (p) return p.displayName;
  }
  const binding = discussion.speakerBindings.find((b) => b.speakerLabel === u.speakerLabel);
  if (binding) {
    const p = discussion.participants.find((p) => p.id === binding.participantId);
    if (p) return p.displayName;
  }
  return u.speakerLabel;
}
