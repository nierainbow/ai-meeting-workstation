import { Router } from "express";
import { z } from "zod";
import type { ModelTierId, ModelSetupStatusDto } from "../../shared/types";
import { MODEL_TIER_LABELS, MODEL_TIER_SUMMARIES, TIER_ASSETS, detectMissingAssets, isAssetInstalled } from "./modelDownloader";
import type { ModelDownloader } from "./modelDownloader";
import { needsModelOnboarding } from "./onboarding";
import type { ModelOnboardingStore } from "./onboarding";

const modelTierSchema = z.enum(["cloud", "local-transcribe", "offline"]);

/**
 * /api/models —— 首启模型向导与下载进度。
 *
 * GET    /api/models            当前档位、进度、档位卡片与首启调度状态
 * POST   /api/models/start      { tier } 开始下载（进行中返回 409）
 * POST   /api/models/cancel     取消下载（保留临时分片，正式目录不留半成品）
 * POST   /api/models/skip       记住「现在不下载」，向导不再自动弹出
 */
export function createModelsRouter(deps: {
  downloader: ModelDownloader;
  cacheDir: string;
  onboarding: ModelOnboardingStore;
}): Router {
  const router = Router();

  function snapshot(): ModelSetupStatusDto {
    const downloadStatus = deps.downloader.status();
    const missingAssets = detectMissingAssets(deps.cacheDir);
    const onboarding = deps.onboarding.read();
    return {
      ...downloadStatus,
      cacheDir: deps.cacheDir,
      missingAssets,
      needsSetup: needsModelOnboarding({ missingAssets, state: onboarding }),
      tiers: (Object.keys(TIER_ASSETS) as ModelTierId[]).map((tier) => ({
        tier,
        label: MODEL_TIER_LABELS[tier],
        summary: MODEL_TIER_SUMMARIES[tier],
        assets: TIER_ASSETS[tier],
        installed: TIER_ASSETS[tier].every((key) => isAssetInstalled(deps.cacheDir, key))
      }))
    };
  }

  router.get("/", (_request, response) => {
    response.json(snapshot());
  });

  router.post("/start", async (request, response) => {
    const parsed = modelTierSchema.safeParse(request.body?.tier);
    if (!parsed.success) {
      response.status(400).json({ error: "tier 必须是 cloud / local-transcribe / offline 之一。" });
      return;
    }
    if (deps.downloader.status().running) {
      response.status(409).json({ error: "已有模型下载任务正在进行，请先取消或等待完成。" });
      return;
    }
    const result = await deps.downloader.start(parsed.data);
    // 只有真正把该档位的模型下全（或档位本身不需要模型）才算走完向导；
    // 取消与失败都留着 needsSetup，下次启动还会再问，不会把人卡在装了一半的状态。
    if (result.completed) deps.onboarding.markTierReady(parsed.data);
    response.json(snapshot());
  });

  router.post("/cancel", (_request, response) => {
    deps.downloader.cancel();
    response.json(snapshot());
  });

  router.post("/skip", (_request, response) => {
    deps.onboarding.markSkipped();
    response.json(snapshot());
  });

  return router;
}
