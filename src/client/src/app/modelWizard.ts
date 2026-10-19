import type { ModelAssetDto, ModelSetupStatusDto, ModelTierId } from "../../../shared/types";

/** 首启模型向导的纯逻辑：字节格式化、进度百分比、按钮可用性、状态摘要。 */

export const MODEL_TIER_HINTS: Record<ModelTierId, string> = {
  cloud: "只用云端转写，不下载任何本地模型，随时可以改回本地。",
  "local-transcribe": "下载本地语音模型，转写在本机完成，不依赖网络。",
  offline: "在本地转写基础上再下载说话人模型，会议全程可离线。"
};

/** 把字节数格式化成中文界面友好的短字符串（1024 进制）。 */
export function formatModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return String(Math.max(1, Math.round(bytes / 1024))) + " KB";
  const mb = bytes / 1024 / 1024;
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : mb.toFixed(0)) + " MB";
  return ((mb / 1024) < 10 ? (mb / 1024).toFixed(1) : (mb / 1024).toFixed(0)) + " GB";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 下载进度的 0-1 浮点。优先用总体字节数；还没拿到总大小（totalBytes 为 0）时
 * 退化成「已完成模型数 / 总模型数」，避免进度条一直停在 0。
 */
export function modelDownloadProgress(status: ModelSetupStatusDto): number {
  if (Number.isFinite(status.totalBytes) && status.totalBytes > 0) {
    return clamp01(status.downloadedBytes / status.totalBytes);
  }
  const assets = status.assets;
  if (assets.length === 0) return status.running ? 0 : 1;
  const done = assets.filter((asset) => asset.status === "installed").length;
  return clamp01(done / assets.length);
}

export function modelDownloadPercent(status: ModelSetupStatusDto): number {
  return Math.round(modelDownloadProgress(status) * 100);
}

/** 进度条上方的一行摘要。 */
export function modelProgressHeadline(status: ModelSetupStatusDto): string {
  if (!status.running && status.error) return "下载失败";
  if (!status.running) {
    return status.progress >= 1 ? "模型已就绪" : "等待开始";
  }
  const active = status.assets.find((asset) => asset.status === "downloading");
  const label = active ? active.label : (status.currentLabel ?? "正在下载");
  return label + " · " + formatModelBytes(status.downloadedBytes) + " / " + formatModelBytes(status.totalBytes);
}

/** 是否可以点「开始下载」：空闲中就能点。 */
export function canStartModelDownload(status: ModelSetupStatusDto): boolean {
  return !status.running;
}

/** 下载中禁止切换档位的提示文案；空闲时返回 null。 */
export function tierSelectionBlocked(status: ModelSetupStatusDto): string | null {
  if (status.running) return "已有下载任务正在进行，可先取消再切换档位。";
  return null;
}

/** 续传说明：命中了本地已有分片时提示用户不会从 0 开始。 */
export function modelResumeHint(status: ModelSetupStatusDto): string | null {
  if (!status.resumed) return null;
  if (status.running) return "检测到未完成的下载，已从上次中断处继续。";
  return null;
}

/** 单个模型卡片的字节摘要；已安装时显示「已安装」。 */
export function modelAssetSummary(asset: ModelAssetDto): string {
  if (asset.status === "installed") return "已安装";
  if (asset.totalBytes > 0) return formatModelBytes(asset.totalBytes);
  return "体积待定";
}

export function modelAssetProgress(asset: ModelAssetDto): number {
  if (asset.status === "installed") return 1;
  if (asset.totalBytes <= 0) return 0;
  return clamp01(asset.downloadedBytes / asset.totalBytes);
}

/** 按 仅云端 / 本地转写 / 全离线 的固定顺序排档位卡片。 */
export function modelTierOptionsInOrder<T extends { tier: ModelTierId }>(options: T[]): T[] {
  const order: ModelTierId[] = ["cloud", "local-transcribe", "offline"];
  return [...options].sort((left, right) => order.indexOf(left.tier) - order.indexOf(right.tier));
}

/** 是否还要继续轮询下载状态。 */
export function shouldPollModelStatus(status: ModelSetupStatusDto): boolean {
  return status.running;
}
