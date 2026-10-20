// T1.3 更新状态机的纯函数部分。
//
// 抽出来的理由：检查更新 / 安装 / 手动「检查更新」按钮共享同一套
// 「进行中 / 出错 / 已完成」的归一化逻辑，放在组件里只能靠渲染快照测，
// 抽成纯函数后可以直接对上游返回的各种畸形数据断言。
//
// 与 UI 的分工：
// - hasUpdateBanner()：决定是否渲染横幅（App 据此加 workspace-has-update 类）；
// - describeUpdateStatus()：设置页「检查更新」一行的文案与按钮可用性；
// - errorMessage()：invoke 抛出的可能不是 Error（Tauri 会抛字符串），统一转文案。

import type { UpdateCheck, UpdateInstallOutcome } from "./updater";

export type UpdatePhase = "idle" | "checking" | "installing" | "done" | "error";

export type UpdateStateSnapshot = {
  phase: UpdatePhase;
  /** 最近一次成功的检查结果；从未成功检查过为 null。 */
  check: UpdateCheck | null;
  /** 用户手动检查的次数（用于「已是最新」也给出反馈）。 */
  manualChecks: number;
  error: string | null;
  outcome: UpdateInstallOutcome | null;
};

export const INITIAL_UPDATE_STATE: UpdateStateSnapshot = {
  phase: "idle",
  check: null,
  manualChecks: 0,
  error: null,
  outcome: null
};

/**
 * 只有 x.y.z（可同时带 -预发布 与 +构建）才算版本号。
 * 与服务端 runningVersion 的校验保持同一形状：预发布段后再出现 '+' 也是合法 semver，
 * 少认一种写法就会把真实版本判成"未知"，自检直接失效。
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isVersionLike(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value.trim());
}

/**
 * 版本自检：桌面壳的真实版本（Rust 侧 package_info，随 /api/config 下发）
 * 与页面实际加载的版本（地址栏 ?appVersion=，App 从 window.location 读，
 * 即 sidecar 静态托管的这份前端）不一致 → 更新后进程里还是旧前端。
 *
 * 典型场景：macOS 上 install 只替换磁盘上的 .app，进程仍在跑旧二进制，
 * 用户看到「已更新」却还是旧界面。返回 null 表示两个版本一致或信息不全。
 */
export function versionMismatchNotice(running: string | null | undefined, client: string | null | undefined): string | null {
  if (!isVersionLike(running) || !isVersionLike(client)) return null;
  if (running === client) return null;
  return `服务端已是 ${running}，页面仍是 ${client}，重启应用后才会生效。`;
}

/** 检查更新走的地址：方便用户排查「内部更新服务器没起」这类问题。 */
export function describeUpdateEndpoint(endpoint: string | null | undefined): string | null {
  return typeof endpoint === "string" && endpoint.trim().length > 0 ? endpoint.trim() : null;
}

/** invoke 抛出的值可能是 Error、字符串或任意对象，统一成可读文案。 */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string" && cause.trim().length > 0) return cause.trim();
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return String(cause);
}

/**
 * 是否显示顶部横幅。
 * - 有可用更新且用户还没点「稍后」→ 显示；
 * - 安装完成 → 显示一次结果（提示重启 + 备份位置）。
 */
export function hasUpdateBanner(state: UpdateStateSnapshot, dismissed: boolean): boolean {
  if (state.phase === "done" && state.outcome) return true;
  if (dismissed) return false;
  return state.check?.available === true && state.outcome === null;
}

/** 设置页「检查更新」行：文案 + 按钮是否可点。 */
export function describeUpdateStatus(
  state: UpdateStateSnapshot,
  dismissed: boolean
): { text: string; canCheck: boolean; canInstall: boolean } {
  const current = state.check?.currentVersion ?? null;
  if (state.phase === "installing") {
    return { text: state.outcome ? `正在安装 ${state.outcome.version}…` : "正在下载并安装更新…", canCheck: false, canInstall: false };
  }
  if (state.phase === "done" && state.outcome) {
    return {
      text: state.outcome.needsRestart
        ? `已安装 ${state.outcome.version}，重启后生效`
        : `已安装 ${state.outcome.version}`,
      canCheck: false,
      canInstall: false
    };
  }
  if (state.phase === "checking") {
    return { text: "正在检查更新…", canCheck: false, canInstall: false };
  }
  if (state.phase === "error") {
    return {
      text: `检查更新失败：${state.error ?? "未知错误"}`,
      canCheck: true,
      canInstall: false
    };
  }
  if (state.check?.available) {
    return {
      text: dismissed ? `新版本 ${state.check.version} 已就绪（已暂缓）` : `发现新版本 ${state.check.version}`,
      canCheck: true,
      canInstall: true
    };
  }
  if (state.check && state.manualChecks > 0) {
    return {
      text: current ? `已是最新版本（${current}）` : "已是最新版本",
      canCheck: true,
      canInstall: false
    };
  }
  return { text: "发布包走内部更新服务器；点「检查更新」立即比对版本", canCheck: true, canInstall: false };
}
