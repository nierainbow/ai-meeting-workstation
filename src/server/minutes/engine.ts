import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";
import { loadProofreadDictionary } from "../proofread/dictionary";
import { applyProofread } from "../proofread/corrector";
import { runChecklist } from "./checklist";
import { extractTodos } from "./todos";
import { renderDeliverable } from "./deliverable";
import { renderArchive } from "./archive";
import type { MeetingScene, MinutesResult, SpeakerStat } from "./types";

export type EngineConfig = {
  configDir: string; // 指向 config/ 目录
};

export class MinutesEngine {
  constructor(private readonly cfg: EngineConfig) {}

  generate(discussion: DiscussionDetailDto, scene: MeetingScene, topicOverride?: string): MinutesResult {
    const rawUtterances = discussion.utterances.filter((u) => u.isFinal);

    // 1) 名称校对（交付件自动校正，存档包留痕）
    const dict = loadProofreadDictionary(this.cfg.configDir);
    const { correctedUtterances, report: proofreadReport } = applyProofread(rawUtterances, dict);

    // 2) 5 项完整性校验
    const checklist = runChecklist(discussion);

    // 3) 待办提取
    const todos = extractTodos(rawUtterances);

    // 4) 说话人统计
    const speakerStats = buildSpeakerStats(discussion, rawUtterances);

    // 5) 渲染双文件
    const deliverableMarkdown = renderDeliverable({
      discussion,
      correctedUtterances,
      scene,
      checklist,
      todos,
      speakerStats,
      topicOverride
    });
    const archiveMarkdown = renderArchive({
      discussion,
      rawUtterances,
      correctedUtterances,
      scene,
      checklist,
      todos,
      proofread: proofreadReport,
      speakerStats,
      topicOverride
    });

    const date = discussion.createdAt.slice(0, 10).replaceAll("-", "");
    const topic = (topicOverride || discussion.title || discussion.topic || "未命名会议").replace(/[\\/:*?"<>|]/g, "-");

    return {
      deliverableMarkdown,
      archiveMarkdown,
      deliverableFilename: `会议纪要-${topic}-${date}.md`,
      archiveFilename: `会议存档-${topic}-${date}.md`,
      checklist,
      todos,
      proofread: proofreadReport
    };
  }
}

function buildSpeakerStats(discussion: DiscussionDetailDto, uts: UtteranceDto[]): SpeakerStat[] {
  const byLabel = new Map<string, SpeakerStat>();
  for (const u of uts) {
    const label = u.speakerLabel;
    const display = resolveName(discussion, u);
    const stat =
      byLabel.get(label) ??
      ({
        speakerLabel: label,
        displayName: display,
        utteranceCount: 0,
        totalChars: 0,
        firstMs: u.startMs,
        lastMs: u.endMs
      } satisfies SpeakerStat);
    stat.utteranceCount += 1;
    stat.totalChars += u.text.length;
    if (u.startMs != null && (stat.firstMs == null || u.startMs < stat.firstMs)) stat.firstMs = u.startMs;
    if (u.endMs != null && (stat.lastMs == null || u.endMs > stat.lastMs)) stat.lastMs = u.endMs;
    byLabel.set(label, stat);
  }
  return [...byLabel.values()].sort((a, b) => b.totalChars - a.totalChars);
}

function resolveName(discussion: DiscussionDetailDto, u: UtteranceDto): string {
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
