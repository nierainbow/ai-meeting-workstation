import type { UtteranceDto } from "../../shared/types";
import type { ProofreadDictionary } from "./dictionary";
import type { ProofreadCorrection, ProofreadReport } from "../minutes/types";

export type ProofreadApplyResult = {
  correctedUtterances: UtteranceDto[];
  report: ProofreadReport;
};

/**
 * 扫描所有 utterance，按词表替换错别字；替换结果写入 correctedUtterances，
 * 命中详情写入 report（进存档包，不进交付件）。
 */
export function applyProofread(utterances: UtteranceDto[], dict: ProofreadDictionary): ProofreadApplyResult {
  const correctionIndex = new Map<string, ProofreadCorrection>();
  const suspiciousHits: ProofreadReport["suspicious"] = [];

  const correctedUtterances = utterances.map((u) => {
    let text = u.text;
    for (const rule of dict.corrections) {
      if (!text.includes(rule.wrong)) continue;
      if (rule.contextHints && rule.contextHints.length > 0) {
        const hasHint = rule.contextHints.some((hint) => text.includes(hint));
        if (!hasHint) continue;
      }
      const occurrences = countOccurrences(text, rule.wrong);
      text = text.split(rule.wrong).join(rule.right);

      const key = `${rule.wrong}->${rule.right}`;
      const entry =
        correctionIndex.get(key) ??
        ({
          wrong: rule.wrong,
          right: rule.right,
          type: rule.type ?? "同音字",
          note: rule.note,
          occurrences: []
        } satisfies ProofreadCorrection);
      for (let i = 0; i < occurrences; i += 1) {
        entry.occurrences.push({
          utteranceId: u.id,
          speaker: u.speakerLabel,
          timestampMs: u.startMs,
          context: clipContext(u.text, rule.wrong)
        });
      }
      correctionIndex.set(key, entry);
    }

    if (dict.suspicious) {
      for (const s of dict.suspicious) {
        try {
          const re = new RegExp(s.pattern, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(u.text)) !== null) {
            suspiciousHits.push({
              raw: m[0],
              guess: s.guess,
              context: clipContext(u.text, m[0])
            });
          }
        } catch {
          // 正则错误忽略
        }
      }
    }

    if (text === u.text) return u;
    return { ...u, text };
  });

  return {
    correctedUtterances,
    report: {
      corrections: [...correctionIndex.values()],
      suspicious: suspiciousHits.slice(0, 50)
    }
  };
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0;
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}

function clipContext(text: string, hit: string, radius = 20): string {
  const idx = text.indexOf(hit);
  if (idx === -1) return text.slice(0, 60);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + hit.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
