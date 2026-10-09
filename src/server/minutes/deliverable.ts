import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import type { ChecklistReport, MeetingScene, SpeakerStat, TodoItem } from "./types";
import { SCENE_TEMPLATES } from "./templates";
import { formatDuration } from "./checklist";

export type DeliverableInput = {
  discussion: DiscussionDetailDto;
  correctedUtterances: UtteranceDto[];
  scene: MeetingScene;
  checklist: ChecklistReport;
  todos: TodoItem[];
  speakerStats: SpeakerStat[];
  topicOverride?: string;
};

export function renderDeliverable(input: DeliverableInput): string {
  const { discussion, correctedUtterances: uts, scene, checklist, todos, speakerStats } = input;
  const tpl = SCENE_TEMPLATES[scene];
  const title = input.topicOverride || discussion.title || discussion.topic || "未命名会议";
  const date = discussion.createdAt.slice(0, 10).replaceAll("-", "");
  const durationMs = Math.max(0, ...discussion.audioAssets.map((a) => a.durationMs ?? 0));

  const lines: string[] = [];
  lines.push(`# 会议纪要-${title}-${date}`, "");
  lines.push(`> 本纪要由 AI Meeting Mate 自动整理，经名称校对与完整性校验后生成；如有人名/术语出入，请以录音为准。`, "");

  // 一、基本信息
  lines.push("## 一、基本信息", "");
  lines.push(`- **会议主题**：${title}`);
  lines.push(`- **时间**：${new Date(discussion.createdAt).toLocaleString("zh-CN", { hour12: false })}`);
  if (durationMs > 0) lines.push(`- **时长**：${formatDuration(durationMs)}`);
  lines.push(`- **场景**：${sceneLabel(scene)}`);
  const names = speakerStats.map((s) => s.displayName).filter(Boolean);
  lines.push(`- **参会人**：${names.length > 0 ? names.join("、") : "未命名"}`);
  lines.push("");

  // 二、会议背景
  if (tpl.sections.includes("会议背景")) {
    lines.push("## 二、会议背景", "");
    lines.push(discussion.background?.trim() || "（未填写）");
    lines.push("");
  }

  // 三、核心内容（按说话人聚合）
  const coreSectionIndex = tpl.sections.findIndex((s) => s.includes("核心内容") || s.includes("讨论") || s.includes("问答") || s.includes("主题"));
  if (coreSectionIndex >= 0) {
    lines.push(`## ${sectionNumber(coreSectionIndex + 1)}、${tpl.sections[coreSectionIndex]}`, "");
    for (const stat of speakerStats) {
      const speakerUts = uts.filter((u) => resolveSpeakerLabel(u) === stat.speakerLabel && u.isFinal);
      if (speakerUts.length === 0) continue;
      lines.push(`### ${stat.displayName}（${speakerUts.length} 条发言）`, "");
      // 取每个说话人的关键句：合并到 300 字以内
      const merged = speakerUts.map((u) => u.text.trim()).filter(Boolean).join(" ");
      lines.push(`- ${truncate(merged, 400)}`);
      lines.push("");
    }
  }

  // 四、核心结论 / 决策记录
  const conclusionSectionIdx = tpl.sections.findIndex((s) => s.includes("结论") || s.includes("决策"));
  if (conclusionSectionIdx >= 0) {
    lines.push(`## ${sectionNumber(conclusionSectionIdx + 1)}、${tpl.sections[conclusionSectionIdx]}`, "");
    const conclusions = extractConclusions(uts);
    if (conclusions.length === 0) {
      lines.push("- （会议中未识别到明确结论，建议人工补充）");
    } else {
      for (const c of conclusions.slice(0, 5)) lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // 五、待办事项
  const todoIdx = tpl.sections.findIndex((s) => s.includes("待办") || s.includes("下一步") || s.includes("行动"));
  if (todoIdx >= 0) {
    lines.push(`## ${sectionNumber(todoIdx + 1)}、${tpl.sections[todoIdx]}`, "");
    if (todos.length === 0) {
      lines.push("- （未自动识别到待办，建议人工补充）");
    } else {
      lines.push("| # | 事项 | 负责人 | 截止 |");
      lines.push("|---|---|---|---|");
      todos.forEach((t, i) => {
        lines.push(`| ${i + 1} | ${t.text} | ${t.owner ?? ""} | ${t.due ?? ""} |`);
      });
    }
    lines.push("");
  }

  // 资料来源
  lines.push("---", "");
  lines.push(`**资料来源**：本地会议录音（${uts.filter((u) => u.isFinal).length} 条转写）`);
  if (checklist.overall < 90) {
    lines.push(`**完整性提示**：校验得分 ${checklist.overall}/100，存在 ${checklist.gaps.length} 处时间间断，请对照录音核对。`);
  }
  lines.push("");

  return lines.join("\n");
}

function sectionNumber(n: number): string {
  return ["一", "二", "三", "四", "五", "六", "七", "八"][n - 1] ?? String(n);
}

function sceneLabel(scene: MeetingScene): string {
  switch (scene) {
    case "interview": return "面试";
    case "review": return "项目评审";
    case "requirement": return "需求讨论";
    case "sharing": return "技术分享";
    case "1on1": return "1对1沟通";
    default: return "综合";
  }
}

function resolveSpeakerLabel(u: UtteranceDto): string {
  return u.speakerLabel;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** 规则法提取结论：找"所以/结论/决定/总之/因此/拍板"开头或包含这些词的句子 */
function extractConclusions(uts: UtteranceDto[]): string[] {
  const markers = /(所以|结论是|决定|拍板|总之|因此|下一步定|就这么|那就|结论：|达成共识)/;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of uts) {
    if (!u.isFinal) continue;
    if (!markers.test(u.text)) continue;
    const s = u.text.replace(/\s+/g, " ").trim();
    if (s.length < 10 || s.length > 120) continue;
    const key = s.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
