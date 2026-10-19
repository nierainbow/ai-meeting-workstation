import type { AsrProviderType, BrainProviderType, PublicAppSettingsDto } from "../../../shared/types";

/** 火山方舟 Coding Plan 已验证可直调的模型（2026-10-09 用客户 Key 逐一实测）。 */
export const CODING_PLAN_MODELS: Array<{ id: string; label: string }> = [
  { id: "ark-code-latest", label: "ark-code-latest（跟随控制台切换）" },
  { id: "doubao-seed-2.1-pro", label: "Doubao-Seed-2.1-pro" },
  { id: "doubao-seed-2.1-lite", label: "Doubao-Seed-2.1-lite" },
  { id: "doubao-seed-2.1-turbo", label: "Doubao-Seed-2.1-turbo" },
  { id: "doubao-seed-2.0-pro", label: "Doubao-Seed-2.0-pro" },
  { id: "doubao-seed-2.0-code", label: "Doubao-Seed-2.0-code" },
  { id: "doubao-seed-2.0-mini", label: "Doubao-Seed-2.0-mini" },
  { id: "doubao-seed-2.0-lite", label: "Doubao-Seed-2.0-lite（即将下线）" },
  { id: "doubao-seed-evolving", label: "Doubao-Seed-Evolving" },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
  { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
  { id: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
  { id: "kimi-k3", label: "Kimi-K3" },
  { id: "kimi-k2.8-preview", label: "Kimi-K2.8-Preview" },
  { id: "kimi-k2.7-code", label: "Kimi-K2.7-Code" },
  { id: "glm-5.3", label: "GLM-5.3" },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash" },
  { id: "minimax-m3", label: "MiniMax-M3" }
];

export function defaultModelForBrain(provider: BrainProviderType, settings: PublicAppSettingsDto | null): string {
  if (provider === "deepseek") return settings?.deepseekModel || "deepseek-v4-pro";
  if (provider === "claude-cli") return settings?.claudeModel || "opus";
  if (provider === "codex-cli") return settings?.codexModel || "";
  if (provider === "openai") return settings?.openaiModel || "gpt-5.6";
  if (provider === "volcengine") return settings?.volcengineBrainModel || "ark-code-latest";
  if (provider === "local-qwen") return "qwen-local";
  return "mock";
}

export function cloudNotice(brainProvider: BrainProviderType, asrProvider: AsrProviderType): string {
  const exitsMachine: string[] = [];
  if (brainProvider === "deepseek" || brainProvider === "openai" || brainProvider === "volcengine") exitsMachine.push("AI 大脑");
  if (asrProvider === "volcengine") exitsMachine.push("实时转写音频");
  if (asrProvider === "volcengine-file") exitsMachine.push("上传的录音文件");
  if (exitsMachine.length === 0) return "本地 CLI / FunASR 路径：会议数据默认不出机。";
  return `${exitsMachine.join("、")}会调用云端服务，请只使用客户自己的 key 和授权数据。`;
}
