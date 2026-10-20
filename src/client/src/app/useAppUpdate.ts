import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkForUpdate,
  installUpdate,
  isDesktopShell,
  type UpdateCheck,
  type UpdateInstallOutcome
} from "./updater";
import {
  INITIAL_UPDATE_STATE,
  describeUpdateStatus,
  errorMessage,
  hasUpdateBanner,
  type UpdateStateSnapshot
} from "./updateState";

export type UpdateState = {
  check: UpdateCheck | null;
  checking: boolean;
  installing: boolean;
  error: string | null;
  outcome: UpdateInstallOutcome | null;
  /** 是否渲染顶部横幅（App 同时用它给根节点加 workspace-has-update）。 */
  hasBanner: boolean;
  /** 设置页展示的文案与按钮可用性。 */
  status: { text: string; canCheck: boolean; canInstall: boolean };
  /** 手动检查（设置页按钮）：即使已是最新也会给出反馈。 */
  checkNow: () => void;
  install: () => void;
  dismiss: () => void;
};

/**
 * 更新状态机：挂载后自动检查一次；提供手动检查 / install / dismiss。
 *
 * 只在桌面壳里生效：浏览器 dev 模式下 isDesktopShell() 为 false，
 * 不发起任何调用，check 恒为 null，App 因此不渲染更新横幅。
 *
 * 用 ref 保证同一时间只有一个检查在飞：自动检查与用户连点「检查更新」不会并发打
 * 更新服务器（竞态下先返回的旧结果会覆盖新结果）。
 */
export function useAppUpdate(): UpdateState {
  const [snapshot, setSnapshot] = useState<UpdateStateSnapshot>(INITIAL_UPDATE_STATE);
  const [dismissed, setDismissed] = useState(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const runCheck = useCallback((manual: boolean) => {
    if (inFlightRef.current) return;
    if (!isDesktopShell()) return;
    inFlightRef.current = true;
    setSnapshot((current) => ({ ...current, phase: "checking", error: null }));
    checkForUpdate()
      .then((result) => {
        if (!mountedRef.current) return;
        setSnapshot((current) => ({
          ...current,
          phase: "idle",
          check: result,
          error: null,
          manualChecks: current.manualChecks + (manual ? 1 : 0)
        }));
        // 手动检查拿到新版本时，把之前点过的「稍后」复位，否则用户看不到新横幅。
        if (result?.available) setDismissed(false);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setSnapshot((current) => ({
          ...current,
          phase: "error",
          error: errorMessage(cause),
          manualChecks: current.manualChecks + (manual ? 1 : 0)
        }));
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    runCheck(false);
    return () => {
      mountedRef.current = false;
    };
  }, [runCheck]);

  const install = useCallback(() => {
    setSnapshot((current) => ({ ...current, phase: "installing", error: null }));
    installUpdate()
      .then((result) => {
        if (!mountedRef.current) return;
        setSnapshot((current) => ({ ...current, phase: "done", outcome: result }));
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setSnapshot((current) => ({ ...current, phase: "error", error: errorMessage(cause) }));
      });
  }, []);

  const checkNow = useCallback(() => {
    setDismissed(false);
    runCheck(true);
  }, [runCheck]);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    check: snapshot.check,
    checking: snapshot.phase === "checking",
    installing: snapshot.phase === "installing",
    error: snapshot.error,
    outcome: snapshot.outcome,
    hasBanner: hasUpdateBanner(snapshot, dismissed),
    status: describeUpdateStatus(snapshot, dismissed),
    checkNow,
    install,
    dismiss
  };
}
