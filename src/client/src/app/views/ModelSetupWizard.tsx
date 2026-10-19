import { useState } from "react";
import type { ModelSetupStatusDto, ModelTierId } from "../../../../shared/types";
import {
  MODEL_TIER_HINTS,
  canStartModelDownload,
  formatModelBytes,
  modelAssetProgress,
  modelAssetSummary,
  modelDownloadPercent,
  modelProgressHeadline,
  modelResumeHint,
  modelTierOptionsInOrder,
  tierSelectionBlocked
} from "../modelWizard";

/**
 * 首启模型向导：检测到本地模型缺失时弹出，让用户选择档位并下载。
 * 设计约束：
 * - 可随时跳过（记入 onboarding，之后不再自动弹出），跳过不影响云端档使用；
 * - 下载走「临时目录 → 完成后重命名」，取消只留下可续传的分片，不留半成品模型；
 * - 下载中轮询 /api/models 刷新进度，不新增 WebSocket 通道。
 */
export function ModelSetupWizard(props: {
  status: ModelSetupStatusDto;
  isOpen: boolean;
  isBusy: boolean;
  onSelectTier: (tier: ModelTierId) => void;
  onStart: () => void;
  onCancel: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const { status, isOpen, isBusy, onSelectTier, onStart, onCancel, onSkip, onClose } = props;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const tiers = modelTierOptionsInOrder(status.tiers);
  const blocked = tierSelectionBlocked(status);
  const resumeHint = modelResumeHint(status);
  const percent = modelDownloadPercent(status);
  const headline = modelProgressHeadline(status);

  if (!isOpen) return null;

  return (
    <div className="model-wizard-layer open" role="presentation">
      <button type="button" className="model-wizard-backdrop" onClick={onClose} aria-label="关闭模型安装向导" />
      <section className="model-wizard-dialog" role="dialog" aria-modal="true" aria-label="首次启动模型安装">
        <header className="model-wizard-header">
          <div>
            <span>本地模型</span>
            <h2>先装好模型，开会时不用等</h2>
          </div>
          <button type="button" className="model-wizard-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <p className="model-wizard-lede">
          选择转写方式后，应用会从 ModelScope 下载对应模型。第一次下载约需几分钟，之后完全离线也能用；
          也可以先用云端转写，随时回来再装。
        </p>

        <ul className="model-wizard-tiers" aria-label="转写档位">
          {tiers.map((option) => {
            const selected = option.tier === status.tier;
            return (
              <li key={option.tier}>
                <button
                  type="button"
                  className={selected ? "model-wizard-tier selected" : "model-wizard-tier"}
                  aria-pressed={selected}
                  disabled={Boolean(blocked) || isBusy}
                  onClick={() => onSelectTier(option.tier)}
                >
                  <div className="model-wizard-tier-top">
                    <strong>{option.label}</strong>
                    {option.installed ? <em className="model-wizard-badge ready">已就绪</em> : null}
                  </div>
                  <p>{option.summary}</p>
                  <small>{MODEL_TIER_HINTS[option.tier]}</small>
                  <div className="model-wizard-tier-meta">
                    {option.assets.length === 0 ? <span>无需下载</span> : <span>{option.assets.length} 个模型</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <section className="model-wizard-progress" aria-label="下载进度">
          <div className="model-wizard-progress-head">
            <strong>{headline}</strong>
            <span>{percent}%</span>
          </div>
          <div
            className="model-wizard-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="模型下载进度"
          >
            <i style={{ width: percent + "%" }} />
          </div>
          <div className="model-wizard-progress-foot">
            <span>
              {formatModelBytes(status.downloadedBytes)} / {formatModelBytes(status.totalBytes)}
            </span>
            {resumeHint ? <em className="model-wizard-resume">{resumeHint}</em> : null}
          </div>
          {status.error ? <p className="model-wizard-error">{status.error}</p> : null}
          {blocked ? <p className="model-wizard-note">{blocked}</p> : null}
        </section>

        <section className="model-wizard-assets" aria-label="模型清单">
          <button type="button" className="model-wizard-disclosure" onClick={() => setShowAdvanced((current) => !current)}>
            {showAdvanced ? "收起模型清单" : "查看模型清单"}
          </button>
          {showAdvanced ? (
            <ul>
              {status.assets.map((asset) => (
                <li key={asset.key}>
                  <div className="model-wizard-asset-head">
                    <strong>{asset.label}</strong>
                    <span>{modelAssetSummary(asset)}</span>
                  </div>
                  <div className="model-wizard-asset-bar">
                    <i style={{ width: Math.round(modelAssetProgress(asset) * 100) + "%" }} />
                  </div>
                  <small>
                    {asset.modelId}
                    {asset.required ? "" : "（可选）"}
                    {asset.error ? " · " + asset.error : ""}
                  </small>
                </li>
              ))}
              {status.assets.length === 0 ? <li className="model-wizard-empty">当前档位不需要本地模型。</li> : null}
            </ul>
          ) : null}
          <p className="model-wizard-path">
            模型保存位置：<code>{status.cacheDir}</code>
          </p>
        </section>

        <footer className="model-wizard-footer">
          {status.running ? (
            <button type="button" className="model-wizard-secondary" onClick={onCancel} disabled={isBusy}>
              取消下载
            </button>
          ) : (
            <button
              type="button"
              className="model-wizard-primary"
              onClick={onStart}
              disabled={!canStartModelDownload(status) || isBusy}
            >
              开始下载
            </button>
          )}
          <button type="button" className="model-wizard-ghost" onClick={onSkip} disabled={isBusy}>
            暂时跳过
          </button>
          {!status.running && status.progress >= 1 ? (
            <button type="button" className="model-wizard-ghost" onClick={onClose}>
              完成
            </button>
          ) : null}
        </footer>

        <p className="model-wizard-footnote">
          取消只会保留已下载的分片，下次可以断点续传；跳过之后仍可在「设置」里重新打开本向导。
        </p>
      </section>
    </div>
  );
}
