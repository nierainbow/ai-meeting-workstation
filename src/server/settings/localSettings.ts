import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AsrProviderType, BrainProviderType, PublicAppSettingsDto } from "../../shared/types";
import type { SettingsUpdateRequest } from "../../shared/schemas";
import type { StoragePaths } from "../storage/paths";
import { createSecretStore, keychainRef, KEYCHAIN_REF_PREFIX, type SecretStore } from "./keychain";

export type LocalSettings = {
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
  claudePath: string;
  claudeModel: string;
  claudeFallbackModel: string;
  codexPath: string;
  codexModel: string;
  cliTimeoutMs: number;
  deepseekBaseUrl: string;
  deepseekModel: string;
  deepseekApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  volcengineApiKey: string;
  volcengineResourceId: string;
  volcengineEndpoint: string;
  volcengineBrainApiKey: string;
  volcengineBrainBaseUrl: string;
  volcengineBrainModel: string;
  recentMemoryCount: number;
  cloudAcknowledged: boolean;
};

const DEFAULT_SETTINGS: LocalSettings = {
  asrProvider: "volcengine",
  brainProvider: "deepseek",
  brainModel: "deepseek-v4-pro",
  claudePath: "claude",
  claudeModel: "opus",
  claudeFallbackModel: "sonnet",
  codexPath: "codex",
  codexModel: "",
  cliTimeoutMs: 180000,
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-pro",
  deepseekApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "gpt-5.6",
  openaiApiKey: "",
  volcengineApiKey: "",
  volcengineResourceId: "volc.seedasr.sauc.duration",
  volcengineEndpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  volcengineBrainApiKey: "",
  volcengineBrainBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  volcengineBrainModel: "ark-code-latest",
  recentMemoryCount: 5,
  cloudAcknowledged: false
};

// settings.local.json 里只允许出现这四把钥匙的「引用」，明文 Key 一律进系统钥匙串。
const SECRET_FIELDS = ["deepseekApiKey", "openaiApiKey", "volcengineApiKey", "volcengineBrainApiKey"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

const SECRET_ENV: Record<SecretField, string> = {
  deepseekApiKey: "DEEPSEEK_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  volcengineApiKey: "VOLCENGINE_ASR_API_KEY",
  volcengineBrainApiKey: "VOLCENGINE_BRAIN_API_KEY"
};

export type SettingsSecretStatus = {
  backend: SecretStore["backend"];
  available: boolean;
  /** 磁盘上是否仍有历史遗留的明文 Key（迁移未完成或后端不可用）。 */
  plaintextOnDisk: boolean;
  /** 提示用户去各厂商控制台轮换已经泄漏过的 Key。 */
  rotateReminder: string[];
};

export class LocalSettingsStore {
  readonly settingsPath: string;
  readonly customersDir: string;
  private readonly secrets: SecretStore;
  /** 钥匙串不可用（Windows DPAPI 桩 / 无 login keychain）时缓存本次进程写入的 Key。 */
  private readonly memoryFallback = new Map<SecretField, string>();

  constructor(
    private readonly storagePaths: StoragePaths,
    private readonly env: NodeJS.ProcessEnv = process.env,
    secrets: SecretStore = createSecretStore()
  ) {
    this.settingsPath = join(storagePaths.dataDir, "settings.local.json");
    this.customersDir = join(storagePaths.dataDir, "customers");
    this.secrets = secrets;
    mkdirSync(this.customersDir, { recursive: true });
  }

  load(): LocalSettings {
    const fileSettings = existsSync(this.settingsPath) ? readJson(this.settingsPath) : {};
    this.migratePlaintextSecrets(fileSettings);
    const secrets = this.readSecrets(fileSettings);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...fileSettings,
      ...secrets
    };

    return {
      ...merged,
      claudePath: readEnv(this.env.CLAUDE_CLI_PATH, merged.claudePath),
      codexPath: readEnv(this.env.CODEX_CLI_PATH, merged.codexPath),
      codexModel: readEnv(this.env.CODEX_MODEL, merged.codexModel),
      deepseekApiKey: readEnv(this.env[SECRET_ENV.deepseekApiKey], merged.deepseekApiKey),
      openaiApiKey: readEnv(this.env[SECRET_ENV.openaiApiKey], merged.openaiApiKey),
      volcengineApiKey: readEnv(this.env[SECRET_ENV.volcengineApiKey], merged.volcengineApiKey),
      volcengineResourceId: readEnv(this.env.VOLCENGINE_ASR_RESOURCE_ID, merged.volcengineResourceId),
      volcengineEndpoint: readEnv(this.env.VOLCENGINE_ASR_ENDPOINT, merged.volcengineEndpoint),
      volcengineBrainApiKey: readEnv(this.env[SECRET_ENV.volcengineBrainApiKey], merged.volcengineBrainApiKey),
      volcengineBrainBaseUrl: readEnv(this.env.VOLCENGINE_BRAIN_BASE_URL, merged.volcengineBrainBaseUrl),
      volcengineBrainModel: readEnv(this.env.VOLCENGINE_BRAIN_MODEL, merged.volcengineBrainModel)
    };
  }

  save(update: SettingsUpdateRequest): PublicAppSettingsDto {
    const currentFileSettings = existsSync(this.settingsPath) ? readJson(this.settingsPath) : {};
    this.migratePlaintextSecrets(currentFileSettings);
    const nextFileSettings: Record<string, unknown> = {
      ...currentFileSettings,
      ...dropUndefined({
        asrProvider: update.asrProvider,
        brainProvider: update.brainProvider,
        brainModel: update.brainModel,
        claudeModel: update.claudeModel,
        claudeFallbackModel: update.claudeFallbackModel,
        codexModel: update.codexModel,
        deepseekModel: update.deepseekModel,
        openaiModel: update.openaiModel,
        volcengineResourceId: update.volcengineResourceId,
        volcengineEndpoint: update.volcengineEndpoint,
        volcengineBrainBaseUrl: update.volcengineBrainBaseUrl,
        volcengineBrainModel: update.volcengineBrainModel,
        recentMemoryCount: update.recentMemoryCount,
        cloudAcknowledged: update.cloudAcknowledged
      })
    };

    for (const field of SECRET_FIELDS) {
      const incoming = update[field];
      if (incoming === undefined) continue;
      this.writeSecret(field, incoming.trim(), nextFileSettings);
    }

    mkdirSync(this.storagePaths.dataDir, { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(nextFileSettings, null, 2)}\n`, "utf8");
    return this.publicSettings();
  }

  publicSettings(): PublicAppSettingsDto {
    const settings = this.load();
    return {
      asrProvider: settings.asrProvider,
      brainProvider: settings.brainProvider,
      brainModel: settings.brainModel || modelForProvider(settings),
      claudeModel: settings.claudeModel,
      claudeFallbackModel: settings.claudeFallbackModel || undefined,
      codexModel: settings.codexModel || undefined,
      deepseekModel: settings.deepseekModel,
      openaiModel: settings.openaiModel,
      volcengineBrainModel: settings.volcengineBrainModel,
      volcengineBrainBaseUrl: settings.volcengineBrainBaseUrl,
      volcengineResourceId: settings.volcengineResourceId,
      volcengineEndpoint: settings.volcengineEndpoint,
      recentMemoryCount: settings.recentMemoryCount,
      cloudAcknowledged: settings.cloudAcknowledged,
      keys: {
        deepseek: Boolean(settings.deepseekApiKey),
        openai: Boolean(settings.openaiApiKey),
        volcengine: Boolean(settings.volcengineApiKey),
        volcengineBrain: Boolean(settings.volcengineBrainApiKey)
      },
      cli: {
        claudePath: settings.claudePath,
        codexPath: settings.codexPath
      },
      storage: {
        settingsPath: this.settingsPath,
        customersDir: this.customersDir
      },
      secrets: this.secretStatus()
    };
  }

  secretStatus(): SettingsSecretStatus {
    const fileSettings = existsSync(this.settingsPath) ? readJson(this.settingsPath) : {};
    const plaintextOnDisk = SECRET_FIELDS.some((field) => hasPlaintextSecret(fileSettings, field));
    return {
      backend: this.secrets.backend,
      available: this.secrets.available,
      plaintextOnDisk,
      rotateReminder: plaintextOnDisk
        ? [
            "检测到本机 settings.local.json 里仍保存着明文 API Key。",
            "请打开页面设置重新保存一次对应 Key，把它写进系统钥匙串。",
            "这些 Key 曾以明文落盘，建议到各厂商控制台轮换：火山方舟（Ark Coding Plan）、DeepSeek、OpenAI、火山 ASR。"
          ]
        : []
    };
  }

  /** 首启自动迁移：把历史明文 Key 搬进钥匙串，磁盘上只留引用。 */
  private migratePlaintextSecrets(fileSettings: Partial<LocalSettings>): void {
    if (!existsSync(this.settingsPath)) return;
    const pending = SECRET_FIELDS.filter((field) => hasPlaintextSecret(fileSettings, field));
    if (pending.length === 0) return;

    const next: Record<string, unknown> = { ...fileSettings };
    const migrated: SecretField[] = [];
    for (const field of pending) {
      const value = fileSettings[field];
      if (typeof value !== "string") continue;
      try {
        this.secrets.set(field, value);
        this.memoryFallback.delete(field);
        next[field] = keychainRef(field);
        migrated.push(field);
      } catch {
        // 钥匙串不可写时保留原值，让 secretStatus() 报告明文残留。
        break;
      }
    }
    if (migrated.length === 0) return;

    mkdirSync(this.storagePaths.dataDir, { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  private readSecrets(fileSettings: Partial<LocalSettings>): Record<SecretField, string> {
    const result = {} as Record<SecretField, string>;
    for (const field of SECRET_FIELDS) {
      const stored = fileSettings[field];
      if (typeof stored === "string" && stored.startsWith(KEYCHAIN_REF_PREFIX)) {
        result[field] = this.readSecret(field);
        continue;
      }
      // 迁移失败留下的明文 / 没有任何记录：按空串处理，env 覆盖仍然生效。
      result[field] = typeof stored === "string" && stored.length > 0 ? stored : "";
    }
    return result;
  }

  private readSecret(field: SecretField): string {
    if (!this.secrets.available) return this.memoryFallback.get(field) ?? "";
    try {
      return this.secrets.get(field);
    } catch {
      return this.memoryFallback.get(field) ?? "";
    }
  }

  private writeSecret(field: SecretField, value: string, nextFileSettings: Record<string, unknown>): void {
    if (!value) {
      this.secrets.remove(field);
      this.memoryFallback.delete(field);
      nextFileSettings[field] = keychainRef(field);
      return;
    }
    try {
      this.secrets.set(field, value);
      this.memoryFallback.delete(field);
    } catch {
      // 后端不可用（Windows DPAPI 桩、无 login keychain）：本次进程内仍可用的内存态，
      // 并保留磁盘引用，避免把明文重新写回去。
      this.memoryFallback.set(field, value);
    }
    nextFileSettings[field] = keychainRef(field);
  }
}

export function modelForProvider(settings: LocalSettings, provider: BrainProviderType = settings.brainProvider): string {
  if (provider === "deepseek") return settings.deepseekModel;
  if (provider === "openai") return settings.openaiModel;
  if (provider === "claude-cli") return settings.claudeModel;
  if (provider === "codex-cli") return settings.codexModel;
  if (provider === "volcengine") return settings.volcengineBrainModel;
  return settings.brainModel || "mock";
}

function hasPlaintextSecret(fileSettings: Partial<LocalSettings>, field: SecretField): boolean {
  const value = fileSettings[field];
  return typeof value === "string" && value.length > 0 && !value.startsWith(KEYCHAIN_REF_PREFIX);
}

function readJson(path: string): Partial<LocalSettings> {
  return JSON.parse(readFileSync(path, "utf8")) as Partial<LocalSettings>;
}

function readEnv(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value.trim() : fallback;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
