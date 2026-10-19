import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelTierId } from "../../shared/types";

export const ONBOARDING_FILE_NAME = "onboarding.json";

export type ModelOnboardingState = {
  /** 文件格式版本，便于以后加字段时向前兼容。 */
  version: 1;
  /** 用户是否明确表示"现在不下载模型"（跳过向导）。 */
  skipped: boolean;
  /** 用户选定的档位；下载完成或主动跳过后写入。 */
  tier?: ModelTierId;
  /** 档位所需模型是否已全部就位（下载成功或档位本身不需要模型）。 */
  ready: boolean;
  updatedAt: string;
};

const EMPTY_STATE: ModelOnboardingState = {
  version: 1,
  skipped: false,
  ready: false,
  updatedAt: ""
};

/**
 * 首启向导的"别再问我"记忆。
 *
 * 单独放一个小文件而不是塞进 settings.local.json：这里只有向导的调度状态，
 * 不涉及任何凭据，也不需要走设置页的保存链路；坏了最多是向导再出现一次。
 */
export class ModelOnboardingStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "models", ONBOARDING_FILE_NAME);
  }

  read(): ModelOnboardingState {
    if (!existsSync(this.filePath)) return { ...EMPTY_STATE };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ModelOnboardingState>;
      return {
        version: 1,
        skipped: Boolean(parsed.skipped),
        tier: isTierId(parsed.tier) ? parsed.tier : undefined,
        ready: Boolean(parsed.ready),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
      };
    } catch {
      // 文件损坏时按"没记过"处理，让向导重新出现，而不是把用户卡在错误状态里。
      return { ...EMPTY_STATE };
    }
  }

  write(state: Omit<ModelOnboardingState, "version" | "updatedAt">): ModelOnboardingState {
    const next: ModelOnboardingState = {
      version: 1,
      ...state,
      updatedAt: new Date().toISOString()
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    // 先写临时文件再 rename，避免下载途中进程被杀留下写坏的 JSON。
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
    return next;
  }

  markSkipped(): ModelOnboardingState {
    return this.write({ ...this.read(), skipped: true });
  }

  markTierReady(tier: ModelTierId): ModelOnboardingState {
    return this.write({ ...this.read(), tier, ready: true, skipped: true });
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}

export function isTierId(value: unknown): value is ModelTierId {
  return value === "cloud" || value === "local-transcribe" || value === "offline";
}

/**
 * 是否需要弹首启向导：还有模型没装，且用户既没跳过也没完成过某个档位。
 * cloud 档本身不需要模型，因此「跳过」之后即使一个模型都不装也不算异常状态。
 */
export function needsModelOnboarding(input: { missingAssets: string[]; state: ModelOnboardingState }): boolean {
  if (input.missingAssets.length === 0) return false;
  if (input.state.ready) return false;
  return !input.state.skipped;
}
