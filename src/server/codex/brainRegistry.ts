import type { BrainProviderType } from "../../shared/types";
import { modelForProvider, type LocalSettingsStore } from "../settings/localSettings";
import { ClaudeCliProvider } from "./claudeCli";
import { CodexCliProvider } from "./codexCli";
import { MockCodexProvider } from "./mockCodex";
import { OpenAiCompatibleProvider } from "./openAiCompatible";
import type { CodexProvider } from "./provider";

export class BrainProviderRegistry {
  constructor(private readonly settingsStore: LocalSettingsStore) {}

  getProvider(providerType?: BrainProviderType, modelOverride?: string): CodexProvider {
    const settings = this.settingsStore.load();
    const provider = providerType ?? settings.brainProvider;
    const model = modelOverride || modelForProvider(settings, provider);

    if (provider === "mock") return new MockCodexProvider();
    if (provider === "claude-cli") {
      // CLI backends are only for users running their own local subscription.
      // Never package or distribute a developer's Claude/Codex token with this product.
      return new ClaudeCliProvider({
        cliPath: settings.claudePath,
        model: model || settings.claudeModel,
        fallbackModel: settings.claudeFallbackModel,
        timeoutMs: settings.cliTimeoutMs
      });
    }
    if (provider === "codex-cli") {
      return new CodexCliProvider({
        cliPath: settings.codexPath,
        model: model || undefined,
        timeoutMs: settings.cliTimeoutMs
      });
    }
    if (provider === "deepseek") {
      return new OpenAiCompatibleProvider({
        label: "DeepSeek",
        baseUrl: settings.deepseekBaseUrl,
        apiKey: settings.deepseekApiKey,
        model: model || settings.deepseekModel,
        timeoutMs: 90000
      });
    }
    if (provider === "openai") {
      return new OpenAiCompatibleProvider({
        label: "OpenAI",
        baseUrl: settings.openaiBaseUrl,
        apiKey: settings.openaiApiKey,
        model: model || settings.openaiModel,
        timeoutMs: 90000
      });
    }
    if (provider === "volcengine") {
      // 火山方舟「大脑」走 Coding Plan 专属端点（/api/coding/v3），只有白名单模型
      // （ark-code-latest / doubao-seed-2.0-code 等）可用。该 key 与模型在服务器端
      // 通过 volcengineBrainModel 统一配置，绝不能沿用讨论里可能残留的 deepseek-* 等
      // 非兼容模型名，否则会被方舟直接拒绝（"does not support the coding plan feature"）。
      // 因此此处一律使用服务端配置模型，忽略任何外部传入的 modelOverride。
      return new OpenAiCompatibleProvider({
        label: "火山方舟",
        baseUrl: settings.volcengineBrainBaseUrl,
        apiKey: settings.volcengineBrainApiKey,
        model: settings.volcengineBrainModel,
        timeoutMs: 90000,
        endpointPath: "/chat/completions"
      });
    }
    if (provider === "local-qwen") {
      throw new Error("本地 Qwen 大脑接口已预留，但本轮未实现。");
    }
    throw new Error(`未知大脑 provider：${String(provider)}`);
  }
}
