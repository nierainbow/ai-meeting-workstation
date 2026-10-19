import { describe, expect, it } from "vitest";
import type { ModelAssetDto, ModelSetupStatusDto } from "../../../shared/types";
import {
  canStartModelDownload,
  formatModelBytes,
  modelAssetProgress,
  modelAssetSummary,
  modelDownloadPercent,
  modelDownloadProgress,
  modelProgressHeadline,
  modelResumeHint,
  modelTierOptionsInOrder,
  shouldPollModelStatus,
  tierSelectionBlocked
} from "./modelWizard";

function asset(overrides: Partial<ModelAssetDto> = {}): ModelAssetDto {
  return {
    key: "asr",
    label: "Paraformer 声学模型",
    modelId: "iic/speech_paraformer-large",
    required: true,
    downloadedBytes: 0,
    totalBytes: 0,
    status: "missing",
    ...overrides
  };
}

function status(overrides: Partial<ModelSetupStatusDto> = {}): ModelSetupStatusDto {
  return {
    tier: "local-transcribe",
    running: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    assets: [],
    resumed: false,
    cacheDir: "/tmp/models",
    missingAssets: ["asr"],
    needsSetup: true,
    tiers: [],
    ...overrides
  };
}

describe("model byte formatting", () => {
  it("formats KB, MB and GB with 1024 units", () => {
    expect(formatModelBytes(0)).toBe("0 MB");
    expect(formatModelBytes(512)).toBe("1 KB");
    expect(formatModelBytes(2 * 1024)).toBe("2 KB");
    expect(formatModelBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatModelBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatModelBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("model download progress", () => {
  it("derives progress from total bytes", () => {
    const current = status({ running: true, downloadedBytes: 512, totalBytes: 2048 });
    expect(modelDownloadProgress(current)).toBe(0.25);
    expect(modelDownloadPercent(current)).toBe(25);
  });

  it("falls back to installed asset count when the size is unknown", () => {
    const current = status({
      running: true,
      totalBytes: 0,
      assets: [asset({ key: "asr" }), asset({ key: "vad", status: "installed", downloadedBytes: 10, totalBytes: 10 })]
    });
    expect(modelDownloadProgress(current)).toBe(0.5);
  });

  it("clamps out-of-range and non-finite values", () => {
    expect(modelDownloadProgress(status({ downloadedBytes: 5000, totalBytes: 1000 }))).toBe(1);
    expect(modelDownloadProgress(status({ running: true, downloadedBytes: 10, totalBytes: Number.NaN }))).toBe(0);
  });

  it("treats an idle tier with no assets as already complete", () => {
    // cloud 档不需要任何模型：空闲 + 空清单 = 100%，进度条直接走满。
    expect(modelDownloadProgress(status({ tier: "cloud" }))).toBe(1);
  });
});

describe("model progress headline", () => {
  it("shows the active asset label with byte counters while downloading", () => {
    const current = status({
      running: true,
      downloadedBytes: 300 * 1024 * 1024,
      totalBytes: 1.2 * 1024 * 1024 * 1024,
      assets: [asset({ status: "downloading", downloadedBytes: 300 * 1024 * 1024 })]
    });
    expect(modelProgressHeadline(current)).toBe("Paraformer 声学模型 · 300 MB / 1.2 GB");
  });

  it("reports failure and idle states without inventing numbers", () => {
    expect(modelProgressHeadline(status({ running: false, error: "网络中断" }))).toBe("下载失败");
    expect(modelProgressHeadline(status({ running: false }))).toBe("等待开始");
  });

  it("falls back to currentLabel when no asset is marked downloading", () => {
    const current = status({ running: true, currentLabel: "CT-Transformer 标点模型", downloadedBytes: 1, totalBytes: 2 });
    expect(modelProgressHeadline(current)).toBe("CT-Transformer 标点模型 · 1 KB / 1 KB");
  });
});

describe("model wizard gating", () => {
  it("blocks starting a second download while one is running", () => {
    expect(canStartModelDownload(status({ running: true }))).toBe(false);
    expect(canStartModelDownload(status())).toBe(true);
    expect(tierSelectionBlocked(status({ running: true }))).toContain("正在进行");
    expect(tierSelectionBlocked(status())).toBeNull();
  });

  it("keeps polling only while the download runs", () => {
    expect(shouldPollModelStatus(status({ running: true }))).toBe(true);
    expect(shouldPollModelStatus(status())).toBe(false);
  });

  it("explains resumption only during a resumed run", () => {
    expect(modelResumeHint(status({ running: true, resumed: true }))).toContain("上次中断处继续");
    expect(modelResumeHint(status({ running: false, resumed: true }))).toBeNull();
    expect(modelResumeHint(status({ running: true }))).toBeNull();
  });
});

describe("model asset cards", () => {
  it("summarises installed assets and pending sizes", () => {
    expect(modelAssetSummary(asset({ status: "installed" }))).toBe("已安装");
    expect(modelAssetSummary(asset({ totalBytes: 320 * 1024 * 1024 }))).toBe("320 MB");
    expect(modelAssetSummary(asset())).toBe("体积待定");
  });

  it("computes per-asset progress defensively", () => {
    expect(modelAssetProgress(asset({ status: "installed" }))).toBe(1);
    expect(modelAssetProgress(asset({ downloadedBytes: 5, totalBytes: 10 }))).toBe(0.5);
    expect(modelAssetProgress(asset({ downloadedBytes: 5 }))).toBe(0);
  });
});

describe("model tier ordering", () => {
  it("keeps cloud, local-transcribe, offline in display order", () => {
    const cards = [
      { tier: "offline" as const, label: "全离线" },
      { tier: "cloud" as const, label: "仅云端" },
      { tier: "local-transcribe" as const, label: "本地转写" }
    ];
    expect(modelTierOptionsInOrder(cards).map((card) => card.tier)).toEqual(["cloud", "local-transcribe", "offline"]);
  });
});
