import type { UpdateState } from "./useAppUpdate";

type UpdateBannerProps = {
  state: UpdateState;
};

/**
 * 桌面版更新横幅。
 *
 * 只在确实有更新（或刚安装完）时渲染；浏览器 dev 模式下 useAppUpdate 不会产生
 * check，因此这里自然不渲染任何东西——是否渲染与根节点的 workspace-has-update
 * 类由同一个 UpdateState.hasBanner 决定，两者不会打架（横幅是 fixed 定位，
 * 不占文档流，视图顶部留白靠 CSS 类补）。
 *
 * 安装成功后提示需要重启（macOS / Linux 的 updater 需要重启才生效），
 * 并告诉用户更新前的数据备份落在哪里。
 */
export function UpdateBanner({ state }: UpdateBannerProps) {
  const { check, checking, installing, error, outcome, install, dismiss } = state;

  if (outcome) {
    return (
      <section className="update-banner update-banner-done" role="status">
        <div className="update-banner-text">
          <strong>已安装 {outcome.version}</strong>
          {outcome.needsRestart ? <span>请重启应用以使用新版本。</span> : null}
          <span>
            {outcome.backupDir
              ? "更新前的数据已备份到 " + outcome.backupDir
              : "更新前未能完成数据备份，请手动检查 .local-data/。"}
          </span>
        </div>
      </section>
    );
  }

  if (!check?.available) return null;

  return (
    <section className="update-banner" role="status">
      <div className="update-banner-text">
        <strong>有新版本 {check.version}</strong>
        {check.notes ? <span>{check.notes}</span> : null}
        {error ? <span className="update-banner-error">{error}</span> : null}
      </div>
      <div className="update-banner-actions">
        <button type="button" className="update-banner-install" onClick={install} disabled={installing || checking}>
          {installing ? "正在更新…" : "立即更新"}
        </button>
        <button type="button" className="update-banner-dismiss" onClick={dismiss}>
          稍后
        </button>
      </div>
    </section>
  );
}
