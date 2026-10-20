// T1.3 客户端更新桥接层。
//
// 设计取舍：**不引入 @tauri-apps/api**。
// - 浏览器 dev 模式（npm run dev:client，端口 5173）没有 __TAURI_INTERNALS__，
//   引入官方包会让 dev 模式在调用期炸掉；
// - 这里只需要 invoke 两个能力，自写薄封装比拉一个依赖更可控。
// 非 Tauri 环境下 checkForUpdate() 一律返回 null，App 直接不渲染更新横幅。
//
// 本文件只做「调用 + 归一化」，不做状态管理（状态机在 useAppUpdate.ts，
// 纯函数部分在 updateState.ts，可单测）。

export type UpdateCheck = {
  currentVersion: string;
  available: boolean;
  version: string | null;
  notes: string | null;
};

export type UpdateInstallOutcome = {
  version: string;
  backupDir: string | null;
  backupFailed: boolean;
  needsRestart: boolean;
};

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvoke;
  };
};

/** 取 Tauri 的 invoke；非桌面壳环境返回 null。 */
function tauriInvoke(): TauriInvoke | null {
  const internals = (window as TauriWindow).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

/** 桌面壳内为 true；浏览器 dev 模式为 false。 */
export function isDesktopShell(): boolean {
  return tauriInvoke() !== null;
}

/**
 * Rust 侧 updater_check 的对外契约：缺失/类型不对的字段一律降级成安全值，
 * 避免壳切换期间字段改名把 UI 打挂（例如 error 字段变成 undefined 时渲染出 "undefined"）。
 */
export function normalizeUpdateCheck(raw: unknown): UpdateCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const currentVersion = typeof value.currentVersion === "string" ? value.currentVersion : "";
  if (currentVersion.length === 0) return null;
  const version = typeof value.version === "string" && value.version.length > 0 ? value.version : null;
  return {
    currentVersion,
    available: value.available === true && version !== null,
    version,
    notes: typeof value.notes === "string" && value.notes.length > 0 ? value.notes : null
  };
}

/** Rust 侧 updater_install 的对外契约；字段缺失时按「需要重启、备份未知」处理。 */
export function normalizeInstallOutcome(raw: unknown): UpdateInstallOutcome {
  if (!raw || typeof raw !== "object") {
    throw new Error("更新安装返回了无法识别的结果。");
  }
  const value = raw as Record<string, unknown>;
  const version = typeof value.version === "string" ? value.version : "";
  if (version.length === 0) {
    throw new Error("更新安装返回了无法识别的结果（缺少版本号）。");
  }
  return {
    version,
    backupDir: typeof value.backupDir === "string" && value.backupDir.length > 0 ? value.backupDir : null,
    backupFailed: value.backupFailed === true,
    needsRestart: value.needsRestart !== false
  };
}

/** 调用 updater_check；非 Tauri 环境返回 null（表示「不打扰用户」）。 */
export async function checkForUpdate(): Promise<UpdateCheck | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return normalizeUpdateCheck(await invoke("updater_check"));
}

/** 调用 updater_install：Rust 侧会先备份 .local-data/ 再下载安装。 */
export async function installUpdate(): Promise<UpdateInstallOutcome> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error("自动更新仅在桌面版可用。");
  }
  return normalizeInstallOutcome(await invoke("updater_install"));
}
