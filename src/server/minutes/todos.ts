import type { UtteranceDto } from "../../shared/types";
import type { TodoItem } from "./types";

/**
 * 规则法待办提取：不依赖 LLM 也能跑。
 * 命中关键词 → 抽出该句作为候选待办；再尝试识别 owner / due。
 */
const ACTION_PATTERNS = [
  /(需要|得要|得|要).{0,30}(完成|提交|跟进|落实|出|给|发|整理|写|改|测|确认|对接)/,
  /(请|麻烦|烦请|建议|必须|务必).{0,30}(跟进|落实|完成|提交|确认|反馈|回复)/,
  /(下一步|后续|接下来|待办|行动项|TODO|Action|action item).{0,40}/,
  /(负责人|owner|Owner).{0,30}(是|为|:|：)/,
  /(截止|deadline|Deadline|本周|下周|明天|后天|周五|周一|月底|月初).{0,20}前/
];

const DUE_PATTERNS = [
  /(本周[一二三四五六日天]?)/,
  /(下周[一二三四五六日天]?)/,
  /(明天|后天|大后天)/,
  /(\d{1,2}月\d{1,2}[日号])/,
  /(周[一二三四五六日天])/,
  /(月底|月初|季末|年末)/
];

const OWNER_HINTS = ["我来", "我负责", "我跟进", "老王", "老李", "小张", "小李", "张工", "李工"];

export function extractTodos(utterances: UtteranceDto[]): TodoItem[] {
  const todos: TodoItem[] = [];
  const seen = new Set<string>();
  for (const u of utterances) {
    const text = u.text.trim();
    if (text.length < 6 || text.length > 200) continue;
    const hit = ACTION_PATTERNS.some((re) => re.test(text));
    if (!hit) continue;
    const key = text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);

    const due = DUE_PATTERNS.map((re) => text.match(re)?.[0]).find(Boolean);
    const owner = OWNER_HINTS.find((hint) => text.includes(hint));

    todos.push({
      text: text.replace(/\s+/g, " ").trim(),
      owner: owner,
      due,
      sourceUtteranceId: u.id,
      timestampMs: u.startMs
    });
  }
  // 最多保留 15 条
  return todos.slice(0, 15);
}
