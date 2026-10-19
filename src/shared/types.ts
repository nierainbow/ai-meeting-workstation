export type DiscussionStatus = "draft" | "active" | "ended";
export type DiscussionMode = "mock" | "real";
export type AsrProviderType = "mock" | "volcengine" | "volcengine-file" | "funasr" | "type4me" | "type4me-live";
export type BrainProviderType = "mock" | "codex-cli" | "claude-cli" | "deepseek" | "openai" | "local-qwen" | "volcengine";
export type UtteranceSource = "mock" | "volcengine" | "volcengine-file" | "funasr" | "type4me" | "upload";
export type AiTurnStatus = "pending" | "streaming" | "completed" | "truncated" | "failed";
export type AiTurnType = "summary" | "challenge" | "risk" | "next_step";
export type AiFeedbackRating = "useful" | "bad";

/** 首启模型下载档位：仅云端 / 本地转写 / 全离线。 */
export type ModelTierId = "cloud" | "local-transcribe" | "offline";

/** 单个本地模型的下载/安装状态。 */
export type ModelAssetStatus = "missing" | "downloading" | "installed" | "failed";

export type ModelAssetDto = {
  /** 稳定标识，前端透传给后端做跳过/取消。 */
  key: string;
  label: string;
  /** ModelScope 模型 id（iic/...）。 */
  modelId: string;
  /** 该档位是否必需。非必需模型（如 Cam++ 说话人）缺失不阻断主流程。 */
  required: boolean;
  /** 已下载字节数。 */
  downloadedBytes: number;
  /** 预估总字节数；未开始下载时为 0。 */
  totalBytes: number;
  status: ModelAssetStatus;
  error?: string;
};

/** 下载任务整体状态，供进度条渲染。 */
export type ModelDownloadStatusDto = {
  tier: ModelTierId;
  running: boolean;
  /** 0-1；未知时为 0。 */
  progress: number;
  currentLabel?: string;
  downloadedBytes: number;
  totalBytes: number;
  assets: ModelAssetDto[];
  error?: string;
  /** 断点续传生效说明：命中的是本地已有分片还是全新开始。 */
  resumed: boolean;
};

/** 向导里的档位卡片：选哪个档位、要下多少东西、现在装没装。 */
export type ModelTierOptionDto = {
  tier: ModelTierId;
  label: string;
  summary: string;
  /** 该档位需要的模型 key；cloud 为空数组。 */
  assets: string[];
  /** 该档位所需模型是否已全部就位。 */
  installed: boolean;
};

/**
 * GET /api/models 的返回体：下载进度 + 首启向导调度状态。
 * needsSetup 为 true 时前端应展示首启向导（用户明确跳过后不再出现）。
 */
export type ModelSetupStatusDto = ModelDownloadStatusDto & {
  /** 模型缓存目录，界面上提示模型存哪儿用。 */
  cacheDir: string;
  tiers: ModelTierOptionDto[];
  needsSetup: boolean;
  /** 尚未安装的模型 key 清单。 */
  missingAssets: string[];
};


export type ParticipantDto = {
  id: string;
  discussionId: string;
  displayName: string;
  role?: string;
  sortOrder: number;
};

export type DiscussionDto = {
  id: string;
  title: string;
  topic: string;
  background?: string;
  projectPath: string;
  mode: DiscussionMode;
  customerId?: string;
  asrProvider?: AsrProviderType;
  brainProvider?: BrainProviderType;
  brainModel?: string;
  codexThreadId?: string;
  status: DiscussionStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  participants: ParticipantDto[];
};

export type DiscussionDetailDto = DiscussionDto & {
  speakerBindings: SpeakerBindingDto[];
  utterances: UtteranceDto[];
  aiTurns: AiTurnDto[];
  audioAssets: AudioAssetDto[];
};

export type DiscussionSummaryDto = Pick<
  DiscussionDto,
  "id" | "title" | "topic" | "status" | "mode" | "asrProvider" | "createdAt" | "startedAt" | "endedAt"
> & {
  finalUtteranceCount: number;
  aiTurnCount: number;
  participantCount: number;
  participantNames: string[];
  hasAudioAssets: boolean;
};

export type SpeakerBindingDto = {
  id: string;
  discussionId: string;
  speakerLabel: string;
  participantId: string;
  createdAt: string;
  updatedAt: string;
};

export type UtteranceDto = {
  id: string;
  discussionId: string;
  speakerLabel: string;
  participantId?: string;
  text: string;
  startMs?: number;
  endMs?: number;
  isFinal: boolean;
  source: UtteranceSource;
  createdAt: string;
};

export type AiTurnDto = {
  id: string;
  discussionId: string;
  turnType?: AiTurnType;
  codexThreadId?: string;
  triggerStartUtteranceId?: string;
  triggerEndUtteranceId?: string;
  prompt: string;
  response?: string;
  status: AiTurnStatus;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  feedbackRating?: AiFeedbackRating;
  feedbackCreatedAt?: string;
};

export type AudioAssetDto = {
  id: string;
  discussionId: string;
  path: string;
  format: string;
  durationMs?: number;
  source: "browser";
  createdAt: string;
};

export type PublicAppSettingsDto = {
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
  claudeModel: string;
  claudeFallbackModel?: string;
  codexModel?: string;
  deepseekModel: string;
  openaiModel: string;
  volcengineBrainModel: string;
  volcengineBrainBaseUrl: string;
  volcengineResourceId: string;
  volcengineEndpoint: string;
  recentMemoryCount: number;
  cloudAcknowledged: boolean;
  keys: {
    deepseek: boolean;
    openai: boolean;
    volcengine: boolean;
    volcengineBrain: boolean;
  };
  cli: {
    claudePath: string;
    codexPath: string;
  };
  storage: {
    settingsPath: string;
    customersDir: string;
  };
  secrets?: {
    backend: string;
    available: boolean;
    plaintextOnDisk: boolean;
    rotateReminder: string[];
  };
};

export type CustomerSummaryDto = {
  id: string;
  displayName: string;
  memoryCount: number;
  updatedAt?: string;
};

export type RollingMemoryDto = {
  id: string;
  customerId: string;
  sourceDiscussionId: string;
  content: string;
  createdAt: string;
};

export type CustomerDetailDto = CustomerSummaryDto & {
  profile: string;
  recentCount: number;
  recentMemories: RollingMemoryDto[];
  speakerMap: Record<string, string>;
  paths: {
    profile: string;
    rollingMemory: string;
    draftsDir: string;
  };
};

export type MemoryDraftDto = {
  id: string;
  customerId: string;
  discussionId: string;
  content: string;
  status: "draft" | "confirmed";
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDataScope = "normal" | "demo";

export type DemoBootstrapDto = {
  mode: "demo";
  customer: CustomerDetailDto;
  meeting: {
    background: string;
    participants: Array<{
      displayName: string;
    }>;
  };
  fallbackAudio: {
    available: boolean;
    filename: string;
    label: string;
  };
  isolation: {
    database: "separate";
    customers: "separate";
    recordings: "separate";
  };
};

export type DemoFallbackResultDto = {
  alreadyLoaded: boolean;
  transcript: string;
  utteranceCount: number;
  transcriptPath?: string;
  discussion: DiscussionDetailDto;
};
