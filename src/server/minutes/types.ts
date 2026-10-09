import type { DiscussionDetailDto, UtteranceDto } from "../../shared/types";

export type MeetingScene =
  | "default"
  | "interview"
  | "review"
  | "requirement"
  | "sharing"
  | "1on1";

export const MEETING_SCENES: ReadonlyArray<{ value: MeetingScene; label: string; hint: string }> = [
  { value: "default", label: "综合纪要", hint: "默认场景，按主题分节" },
  { value: "interview", label: "面试", hint: "区分提问/回答，突出结论与待办" },
  { value: "review", label: "项目评审", hint: "强化决策记录与待确认事项" },
  { value: "requirement", label: "需求讨论", hint: "提取需求点与待澄清项" },
  { value: "sharing", label: "技术分享", hint: "按主题分段，提取关键知识点" },
  { value: "1on1", label: "1对1沟通", hint: "最精简，只留结论与下一步" }
];

export type ChecklistStatus = "pass" | "warn" | "fail";

export type ChecklistItem = {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
};

export type ChecklistReport = {
  items: ChecklistItem[];
  overall: number; // 0-100
  gaps: string[]; // 可疑间断点 "mm:ss-mm:ss"
};

export type TodoItem = {
  text: string;
  owner?: string;
  due?: string;
  module?: string;
  sourceUtteranceId: string;
  timestampMs?: number;
};

export type ProofreadCorrection = {
  wrong: string;
  right: string;
  type: string;
  note?: string;
  occurrences: Array<{ utteranceId: string; speaker: string; timestampMs?: number; context: string }>;
};

export type ProofreadReport = {
  corrections: ProofreadCorrection[];
  suspicious: Array<{ raw: string; guess: string; context: string }>;
};

export type SpeakerStat = {
  speakerLabel: string;
  displayName: string;
  utteranceCount: number;
  totalChars: number;
  firstMs?: number;
  lastMs?: number;
};

export type MinutesInput = {
  discussion: DiscussionDetailDto;
  scene: MeetingScene;
  /** 校对后的纯文本 utterances（用于交付件） */
  correctedUtterances: UtteranceDto[];
  /** 原始 utterances（用于存档包） */
  rawUtterances: UtteranceDto[];
  checklist: ChecklistReport;
  todos: TodoItem[];
  proofread: ProofreadReport;
  speakerStats: SpeakerStat[];
  /** 用户自定义主题（覆盖 discussion.title） */
  topicOverride?: string;
};

export type MinutesResult = {
  deliverableMarkdown: string;
  archiveMarkdown: string;
  deliverableFilename: string;
  archiveFilename: string;
  checklist: ChecklistReport;
  todos: TodoItem[];
  proofread: ProofreadReport;
};
