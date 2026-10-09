import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProofreadRule = {
  wrong: string;
  right: string;
  type?: string;
  note?: string;
  /** 仅在上下文包含任一关键词时才替换（避免误伤） */
  contextHints?: string[];
};

export type ProofreadDictionary = {
  version: string;
  corrections: ProofreadRule[];
  /** 存疑模式：正则，命中后列出原文供人工确认 */
  suspicious?: Array<{ pattern: string; guess: string }>;
};

const EMPTY: ProofreadDictionary = { version: "0", corrections: [] };

export function loadProofreadDictionary(configDir: string): ProofreadDictionary {
  const merged: ProofreadDictionary = { version: "merged", corrections: [] };
  for (const name of ["jiesi.json", "custom.json"]) {
    const p = join(configDir, "proofread", name);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as ProofreadDictionary;
      merged.corrections.push(...parsed.corrections);
      if (parsed.suspicious) merged.suspicious = [...(merged.suspicious ?? []), ...parsed.suspicious];
    } catch (error) {
      // 词表损坏不阻断主流程，仅忽略
      console.warn(`[proofread] 词表 ${name} 解析失败，已跳过:`, error instanceof Error ? error.message : error);
    }
  }
  if (merged.corrections.length === 0 && !merged.suspicious) return EMPTY;
  return merged;
}
