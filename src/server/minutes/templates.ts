import type { MeetingScene } from "./types";

export type SceneTemplate = {
  value: MeetingScene;
  /** 交付件章节（按顺序） */
  sections: string[];
  /** 是否强化决策记录 */
  emphasizeDecisions?: boolean;
  /** 是否区分提问/回答 */
  qaMode?: boolean;
  /** 篇幅红线（行数上限） */
  softLineCap: number;
};

export const SCENE_TEMPLATES: Record<MeetingScene, SceneTemplate> = {
  default: {
    value: "default",
    sections: ["基本信息", "会议背景", "核心内容", "核心结论", "待办事项"],
    softLineCap: 200
  },
  interview: {
    value: "interview",
    sections: ["基本信息", "会议背景", "问答要点", "面试结论", "待办事项"],
    qaMode: true,
    softLineCap: 150
  },
  review: {
    value: "review",
    sections: ["基本信息", "会议背景", "讨论要点", "决策记录", "待确认事项", "待办事项"],
    emphasizeDecisions: true,
    softLineCap: 200
  },
  requirement: {
    value: "requirement",
    sections: ["基本信息", "会议背景", "需求清单", "待澄清项", "待办事项"],
    softLineCap: 200
  },
  sharing: {
    value: "sharing",
    sections: ["基本信息", "会议背景", "主题分段", "关键知识点", "后续参考"],
    softLineCap: 180
  },
  "1on1": {
    value: "1on1",
    sections: ["基本信息", "讨论要点", "结论", "下一步"],
    softLineCap: 80
  }
};
