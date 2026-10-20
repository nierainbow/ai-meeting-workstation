import { useEffect, useMemo, useRef, useState } from "react";
import { isUsableAiTurn } from "../../../shared/aiTurns";
import type { AsrStatus, ProductEvent } from "../../../shared/events";
import type {
  CustomerDetailDto,
  CustomerSummaryDto,
  DemoBootstrapDto,
  DiscussionDetailDto,
  DiscussionSummaryDto,
  MemoryDraftDto,
  ModelSetupStatusDto,
  ModelTierId,
  ParticipantDto,
  PublicAppSettingsDto,
  WorkspaceDataScope
} from "../../../shared/types";
import {
  bindSpeaker,
  bootstrapDemoMode,
  confirmMemory,
  createDiscussion,
  deleteDiscussion,
  deleteDiscussionAudio,
  draftMemory,
  endDiscussion,
  getAppConfig,
  getCustomer,
  getDiscussion,
  listDiscussions,
  listCustomers,
  loadDemoFallbackAudio,
  cancelModelDownload,
  getModelSetupStatus,
  markAiTurnFeedback,
  resetDemoMode,
  skipModelSetup,
  startModelDownload,
  saveCustomer,
  saveSettings,
  triggerAiTurn,
  uploadAudioFile
} from "./api";
import { codexResumeCommand } from "./codexCommand";
import { buildVisibleDiscussionTimeline, mergeAiTurn, mergeUtterance, unboundSpeakerLabels } from "./discussionTimeline";
import { SingleFlight } from "./singleFlight";
import { VoiceInvitationDetector } from "./voiceInvitation";
import { isFileAsrProvider, taskModeForDiscussion, transcriptionNameFromFile, type TaskMode } from "./taskMode";
import { initialAsrDiagnostics, initialFormState, type AsrDiagnostics, type FormState } from "./appTypes";
import { countFinalUtterancesSinceLastAiTurn, copyText, float32ToPcm16, sessionPhase } from "./format";
import { defaultModelForBrain } from "./brainOptions";
import { defaultCustomerProfile } from "./customerProfile";
import { HomeView } from "./views/HomeView";
import { FileTranscribeView } from "./views/FileTranscribeView";
import { LiveMeetingView } from "./views/LiveMeetingView";
import { SettingsView } from "./views/SettingsView";
import { ModelSetupWizard } from "./views/ModelSetupWizard";
import { DemoView } from "./views/DemoView";
import { UpdateBanner } from "./UpdateBanner";
import { useAppUpdate } from "./useAppUpdate";
import { isDesktopShell } from "./updater";

export { speakerLetter } from "./speaker";

export function App() {
  const [form, setForm] = useState<FormState>(initialFormState);
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceDataScope>("normal");
  const [demoBootstrap, setDemoBootstrap] = useState<DemoBootstrapDto | null>(null);
  const [isDemoModeLoading, setIsDemoModeLoading] = useState(false);
  const [isFallbackLoading, setIsFallbackLoading] = useState(false);
  const [fallbackLoaded, setFallbackLoaded] = useState(false);
  const [discussion, setDiscussion] = useState<DiscussionDetailDto | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrStatus>("idle");
  const [isStarting, setIsStarting] = useState(false);
  const [isInvitingCodex, setIsInvitingCodex] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAudioStarting, setIsAudioStarting] = useState(false);
  const [isAudioFileUploading, setIsAudioFileUploading] = useState(false);
  const [taskMode, setTaskMode] = useState<TaskMode>("home");
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const [fileTranscriptionName, setFileTranscriptionName] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [asrDiagnostics, setAsrDiagnostics] = useState<AsrDiagnostics>(initialAsrDiagnostics);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isKnowledgeOpen, setIsKnowledgeOpen] = useState(false);
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [isGuidanceOpen, setIsGuidanceOpen] = useState(false);
  const [aiGuidance, setAiGuidance] = useState("");
  const [recentDiscussions, setRecentDiscussions] = useState<DiscussionSummaryDto[]>([]);
  const [appSettings, setAppSettings] = useState<PublicAppSettingsDto | null>(null);
  const [customers, setCustomers] = useState<CustomerSummaryDto[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetailDto | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraftDto | null>(null);
  const [memoryDraftText, setMemoryDraftText] = useState("");
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelSetupStatusDto | null>(null);
  const [isModelWizardOpen, setIsModelWizardOpen] = useState(false);
  const [selectedModelTier, setSelectedModelTier] = useState<ModelTierId | null>(null);
  const [isModelActionBusy, setIsModelActionBusy] = useState(false);
  const updateState = useAppUpdate();
  // 浏览器 dev 模式（无桌面壳）下不展示「自动更新」这一段；桌面壳内才有意义。
  const desktopUpdate = isDesktopShell() ? updateState : undefined;
  const hasSentAudioRef = useRef(false);
  const primaryFunasrInputRef = useRef<HTMLInputElement | null>(null);
  const audioUploadFlightRef = useRef(new SingleFlight());
  const audioSessionRef = useRef<{
    context: AudioContext;
    processor: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    stream: MediaStream;
    socket: WebSocket;
  } | null>(null);
  const conversationFeedRef = useRef<HTMLDivElement | null>(null);
  const aiTurnFlightRef = useRef(false);
  const voiceInvitationRef = useRef<VoiceInvitationDetector | null>(null);
  const liveMeetingRef = useRef({
    discussionId: discussion?.id,
    isRecording,
    isActive: discussion?.status === "active",
    isLiveAsr: discussion?.asrProvider === "volcengine" || discussion?.asrProvider === "type4me-live"
  });
  const inviteByVoiceRef = useRef<(guidance: string) => void>(() => undefined);
  liveMeetingRef.current = {
    discussionId: discussion?.id,
    isRecording,
    isActive: discussion?.status === "active",
    isLiveAsr: discussion?.asrProvider === "volcengine" || discussion?.asrProvider === "type4me-live"
  };
  inviteByVoiceRef.current = (guidance) => { void inviteAi(guidance, "voice"); };
  if (!voiceInvitationRef.current) {
    voiceInvitationRef.current = new VoiceInvitationDetector(
      (guidance) => inviteByVoiceRef.current(guidance),
      () => {
        const meeting = liveMeetingRef.current;
        return meeting.isRecording && meeting.isActive && meeting.isLiveAsr;
      }
    );
  }

  useEffect(() => {
    void getAppConfig()
      .then((config) => {
        setAppSettings(config.settings);
        setForm((current) => ({
          ...current,
          projectPath: config.defaultProjectPath,
          asrProvider: config.settings.asrProvider,
          brainProvider: config.settings.brainProvider,
          brainModel: defaultModelForBrain(config.settings.brainProvider, config.settings)
        }));
      })
      .catch(() => {
        setErrorMessage("读取本地配置失败，请确认后端服务正在运行。");
      });
  }, []);

  // 首启模型向导：进应用时查一次本地模型状态，缺模型且没跳过过才弹向导。
  useEffect(() => {
    let disposed = false;
    void refreshModelStatus().then((status) => {
      if (disposed || !status) return;
      if (status.needsSetup) {
        setIsModelWizardOpen(true);
        setSelectedModelTier((current) => current ?? status.tier);
      }
    });
    return () => {
      disposed = true;
    };
    // 只在首次挂载时检查一次，之后由下面的轮询 effect 负责刷新。
  }, []);

  // 下载中定时轮询进度；下载结束后再拉一次拿到终态。
  useEffect(() => {
    if (!isModelWizardOpen && !(modelStatus?.running ?? false)) return;
    if (!modelStatus?.running) return;
    const timer = window.setInterval(() => {
      void refreshModelStatus();
    }, 800);
    return () => {
      window.clearInterval(timer);
    };
  }, [isModelWizardOpen, modelStatus?.running]);

  useEffect(() => {
    void loadRecentDiscussions("normal");
    void loadCustomers("normal");
  }, []);

  useEffect(() => {
    if (!discussion || isFileAsrProvider(discussion.asrProvider)) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?discussionId=${discussion.id}`);

    socket.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as ProductEvent;
      if (event.type === "asr.status") {
        setAsrStatus(event.status);
        if (event.status === "connected") {
          setAsrDiagnostics((current) => ({ ...current, asrConnected: true }));
        }
        if (event.status === "receiving") {
          setAsrDiagnostics((current) => ({ ...current, asrConnected: true, asrReceiving: true }));
        }
      }
      if (event.type === "asr.error") {
        setAsrStatus("failed");
        setErrorMessage(event.message);
        setIsDiagnosticsOpen(true);
        setAsrDiagnostics((current) => ({
          ...current,
          errorMessage: event.message,
          retryable: event.retryable
        }));
      }
      if (event.type === "transcript.partial" || event.type === "transcript.final") {
        setAsrDiagnostics((current) => ({ ...current, asrReceiving: true }));
        setDiscussion((current) => mergeUtterance(current, event.utterance));
        if (event.utterance.source === "volcengine" && liveMeetingRef.current.discussionId === discussion.id) {
          if (event.type === "transcript.partial") voiceInvitationRef.current?.onPartial();
          else voiceInvitationRef.current?.onFinal(event.utterance);
        }
      }
      if (event.type === "audio.asset.saved") {
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "speaker.binding.updated") {
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "codex.turn.completed" || event.type === "codex.turn.truncated") {
        setDiscussion((current) => mergeAiTurn(current, event.aiTurn));
      }
      if (event.type === "codex.turn.failed") {
        setErrorMessage(event.message);
        void refreshDiscussion(discussion.id);
      }
      if (event.type === "discussion.updated") {
        void refreshDiscussion(discussion.id);
      }
    };

    socket.onerror = () => {
      setErrorMessage("WebSocket 连接失败，请确认后端服务正在运行。");
    };

    return () => {
      socket.close();
      voiceInvitationRef.current?.reset();
    };
  }, [discussion?.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsSettingsOpen((current) => !current);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && discussion && discussion.status === "active") {
        event.preventDefault();
        void handleInviteCodex();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const isEnded = discussion?.status === "ended";
  const isDemoMode = workspaceScope === "demo";
  const visibleTimeline = useMemo(() => (discussion ? buildVisibleDiscussionTimeline(discussion, { isInvitingCodex }) : []), [discussion, isInvitingCodex]);
  const speakerLabels = useMemo(() => (discussion ? unboundSpeakerLabels(discussion) : []), [discussion]);
  const finalUtteranceCount = discussion?.utterances.filter((utterance) => utterance.isFinal).length ?? 0;
  const activeRecentDiscussion = recentDiscussions.find((item) => item.status === "active");
  const finalUtteranceCountForNextAi = useMemo(() => (discussion ? countFinalUtterancesSinceLastAiTurn(discussion) : 0), [discussion]);
  const resumeCommand = discussion?.codexThreadId
    ? codexResumeCommand({ codexThreadId: discussion.codexThreadId, projectPath: discussion.projectPath })
    : "";
  const phase = sessionPhase({
    discussion,
    isRecording,
    isInvitingCodex,
    finalUtteranceCount,
    copyStatus
  });
  const conversationItems = visibleTimeline;
  const conversationFollowKey = conversationItems
    .map((item) => {
      if (item.type === "utterance") return `${item.id}:${item.utterance.text}:${item.utterance.isFinal}`;
      if (item.type === "aiTurn") return `${item.id}:${item.aiTurn.response ?? ""}`;
      return item.id;
    })
    .join("|");
  const latestUsableAiTurn = discussion?.aiTurns.filter(isUsableAiTurn).slice(-1)[0] ?? null;
  const settingsHasAlert = Boolean(errorMessage || speakerLabels.length > 0 || asrStatus === "failed");
  const isFileMode = taskMode === "file";
  const isFileResult = Boolean(isFileMode && discussion && finalUtteranceCount > 0);
  const isTaskBusy = isAudioFileUploading || isFallbackLoading || isStarting || isAudioStarting || isRecording;

  useEffect(() => {
    setIsFollowingLatest(true);
  }, [discussion?.id]);

  useEffect(() => {
    if (!isFollowingLatest) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const feed = conversationFeedRef.current;
      if (!feed) return;
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: isRecording ? "smooth" : "auto"
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [conversationFollowKey, isFollowingLatest, isRecording]);

  async function refreshDiscussion(discussionId: string) {
    const nextDiscussion = await getDiscussion(discussionId, workspaceScope);
    setDiscussion(nextDiscussion);
  }

  async function refreshModelStatus(): Promise<ModelSetupStatusDto | null> {
    try {
      const next = await getModelSetupStatus();
      setModelStatus(next);
      return next;
    } catch {
      // 模型状态读取失败不该打断主流程，向导下次启动再问。
      return null;
    }
  }

  async function handleStartModelDownload() {
    const tier = selectedModelTier ?? modelStatus?.tier ?? "cloud";
    setIsModelActionBusy(true);
    try {
      const next = await startModelDownload(tier);
      setModelStatus(next);
      setSelectedModelTier(next.tier);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "模型下载启动失败。");
      await refreshModelStatus();
    } finally {
      setIsModelActionBusy(false);
    }
  }

  async function handleCancelModelDownload() {
    setIsModelActionBusy(true);
    try {
      await cancelModelDownload();
      // 取消只保留临时分片，正式目录不留半成品；刷新后 needsSetup 仍为 true。
      await refreshModelStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "取消模型下载失败。");
    } finally {
      setIsModelActionBusy(false);
    }
  }

  async function handleSkipModelSetup() {
    setIsModelActionBusy(true);
    try {
      const next = await skipModelSetup();
      setModelStatus(next);
      setIsModelWizardOpen(false);
      setLocalStatus("已跳过本地模型下载，可继续使用云端转写。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "跳过模型下载失败。");
    } finally {
      setIsModelActionBusy(false);
    }
  }

  function handleCloseModelWizard() {
    // 下载中点关闭只是收起向导，下载继续在后台跑，下次打开还能看到进度。
    setIsModelWizardOpen(false);
  }

  async function handleOpenModelSettings() {
    await refreshModelStatus();
    setIsModelWizardOpen(true);
  }
  async function loadRecentDiscussions(scope: WorkspaceDataScope = workspaceScope) {
    try {
      const discussions = await listDiscussions(scope);
      setRecentDiscussions(discussions);
    } catch {
      setRecentDiscussions([]);
    }
  }

  async function loadCustomers(scope: WorkspaceDataScope = workspaceScope) {
    try {
      const nextCustomers = await listCustomers(scope);
      setCustomers(nextCustomers);
    } catch {
      setCustomers([]);
    }
  }

  async function handleSelectCustomer(customerId: string) {
    if (!customerId) {
      setSelectedCustomer(null);
      setForm((current) => ({
        ...current,
        customerId: "",
        customerName: "",
        customerProfile: defaultCustomerProfile("")
      }));
      return;
    }
    const customer = await getCustomer(customerId, workspaceScope);
    setSelectedCustomer(customer);
    setForm((current) => ({
      ...current,
      customerId: customer.id,
      customerName: customer.displayName,
      customerProfile: customer.profile
    }));
  }

  async function handleSaveCustomer() {
    const id = form.customerId.trim();
    if (!id) {
      setErrorMessage("请先填写客户 ID。");
      return;
    }
    const customer = await saveCustomer({
      id,
      displayName: form.customerName.trim() || id,
      profile: form.customerProfile.trim() || defaultCustomerProfile(id),
      recentCount: appSettings?.recentMemoryCount ?? 5
    }, workspaceScope);
    setSelectedCustomer(customer);
    setLocalStatus("客户档案已保存，本地存储，不会自动上云。");
    await loadCustomers(workspaceScope);
  }

  async function handleSaveSettings(update: Partial<PublicAppSettingsDto> & {
    deepseekApiKey?: string;
    openaiApiKey?: string;
    volcengineApiKey?: string;
    volcengineBrainApiKey?: string;
    volcengineBrainBaseUrl?: string;
    volcengineBrainModel?: string;
  }) {
    const next = await saveSettings(update);
    setAppSettings(next);
    setForm((current) => ({
      ...current,
      asrProvider: next.asrProvider,
      brainProvider: next.brainProvider,
      brainModel: defaultModelForBrain(next.brainProvider, next)
    }));
    setLocalStatus("设置已保存到本机。");
  }

  function applyDemoBootstrap(bootstrap: DemoBootstrapDto) {
    setDemoBootstrap(bootstrap);
    setSelectedCustomer(bootstrap.customer);
    setForm((current) => ({
      ...current,
      background: bootstrap.meeting.background,
      customerId: bootstrap.customer.id,
      customerName: bootstrap.customer.displayName,
      customerProfile: bootstrap.customer.profile,
      participants: bootstrap.meeting.participants.map((participant, index) => ({
        id: `demo-participant-${index + 1}`,
        displayName: participant.displayName
      }))
    }));
    setFallbackLoaded(false);
    setMemoryDraft(null);
    setMemoryDraftText("");
  }

  async function handleEnterDemoMode() {
    setIsDemoModeLoading(true);
    setErrorMessage(null);
    try {
      await stopAudioCapture();
      const bootstrap = await bootstrapDemoMode();
      setWorkspaceScope("demo");
      setDiscussion(null);
      applyDemoBootstrap(bootstrap);
      setCustomers(await listCustomers("demo"));
      setRecentDiscussions(await listDiscussions("demo"));
      setIsSettingsOpen(false);
      setLocalStatus("演示模式已载入：公司档案、参会人和会议背景均为虚构数据。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "演示模式载入失败。");
    } finally {
      setIsDemoModeLoading(false);
    }
  }

  async function handleExitDemoMode() {
    if (isFallbackLoading) return;
    await stopAudioCapture();
    setWorkspaceScope("normal");
    setDiscussion(null);
    setDemoBootstrap(null);
    setSelectedCustomer(null);
    setFallbackLoaded(false);
    setMemoryDraft(null);
    setMemoryDraftText("");
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setErrorMessage(null);
    setLocalStatus(null);
    setForm((current) => ({
      ...initialFormState,
      projectPath: current.projectPath,
      asrProvider: appSettings?.asrProvider ?? current.asrProvider,
      brainProvider: appSettings?.brainProvider ?? current.brainProvider,
      brainModel: defaultModelForBrain(appSettings?.brainProvider ?? current.brainProvider, appSettings)
    }));
    setCustomers(await listCustomers("normal"));
    setRecentDiscussions(await listDiscussions("normal"));
  }

  async function handleResetDemoMode() {
    if (!isDemoMode || isFallbackLoading) return;
    setIsDemoModeLoading(true);
    setErrorMessage(null);
    try {
      await stopAudioCapture();
      const bootstrap = await resetDemoMode();
      setDiscussion(null);
      applyDemoBootstrap(bootstrap);
      setCustomers(await listCustomers("demo"));
      setRecentDiscussions([]);
      setAsrStatus("idle");
      setAsrDiagnostics(initialAsrDiagnostics);
      setIsSettingsOpen(false);
      setLocalStatus("演示空间已重置，只保留澄远科技的干净初始档案。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "演示空间重置失败。");
    } finally {
      setIsDemoModeLoading(false);
    }
  }

  async function handleOpenDiscussion(discussionId: string) {
    await stopAudioCapture();
    const nextDiscussion = await getDiscussion(discussionId, workspaceScope);
    setTaskMode(taskModeForDiscussion(nextDiscussion));
    setDiscussion(nextDiscussion);
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setIsDiagnosticsOpen(false);
    setIsSettingsOpen(false);
    setCopyStatus(null);
    setAiGuidance("");
    setIsGuidanceOpen(false);
    setFallbackLoaded(false);
  }

  async function handleReturnHome() {
    await stopAudioCapture();
    setDiscussion(null);
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setIsDiagnosticsOpen(false);
    setCopyStatus(null);
    setErrorMessage(null);
    setAiGuidance("");
    setIsGuidanceOpen(false);
    setFallbackLoaded(false);
    setTaskMode("home");
    setSelectedAudioFile(null);
    setFileTranscriptionName("");
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleNewDiscussion() {
    await handleReturnHome();
    setForm((current) => ({
      ...current,
      background: isDemoMode ? demoBootstrap?.meeting.background ?? current.background : ""
    }));
  }

  function handleSelectTask(nextMode: Exclude<TaskMode, "home">) {
    if (isTaskBusy) return;
    setTaskMode(nextMode);
    setDiscussion(null);
    setErrorMessage(null);
    setLocalStatus(null);
    if (nextMode === "file") {
      setForm((current) => ({ ...current, asrProvider: isFileAsrProvider(current.asrProvider) ? current.asrProvider : "volcengine-file" }));
    } else {
      setSelectedAudioFile(null);
      setFileTranscriptionName("");
      setForm((current) => ({ ...current, asrProvider: current.asrProvider === "volcengine" || current.asrProvider === "mock" || current.asrProvider === "type4me-live" ? current.asrProvider : "volcengine" }));
    }
  }

  function handleChooseAudioFile(file: File) {
    if (isAudioFileUploading) return;
    setSelectedAudioFile(file);
    setFileTranscriptionName((current) => current || transcriptionNameFromFile(file.name));
    setErrorMessage(null);
    setLocalStatus("文件已选择，尚未上传。确认方式后点击“开始转写”。");
  }

  function handleClearAudioFile() {
    if (isAudioFileUploading) return;
    setSelectedAudioFile(null);
    setFileTranscriptionName("");
    setErrorMessage(null);
    setLocalStatus(null);
  }

  async function handleStart() {
    setIsStarting(true);
    setErrorMessage(null);
    try {
      const nextDiscussion = await createDiscussion({
        background: form.background,
        customerId: form.customerId.trim() || undefined,
        projectPath: form.projectPath,
        participants: form.participants.map((participant) => ({
          displayName: participant.displayName
        })),
        asrProvider: form.asrProvider,
        brainProvider: form.brainProvider,
        brainModel: form.brainModel,
        mode: form.asrProvider === "mock" ? "mock" : "real"
      }, workspaceScope);
      setDiscussion(nextDiscussion);
      setAsrDiagnostics(initialAsrDiagnostics);
      setIsDiagnosticsOpen(false);
      setIsSettingsOpen(false);
      void loadRecentDiscussions(workspaceScope);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "创建讨论失败");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleStartFileTranscription() {
    if (!selectedAudioFile || audioUploadFlightRef.current.isActive) return;
    const file = selectedAudioFile;
    const provider = isFileAsrProvider(form.asrProvider) ? form.asrProvider : "volcengine-file";
    await audioUploadFlightRef.current.run(async () => {
      setIsAudioFileUploading(true);
      setErrorMessage(null);
      setLocalStatus("正在上传并识别，请勿重复操作");
      try {
        const activeDiscussion = discussion && isFileAsrProvider(discussion.asrProvider)
          ? discussion
          : await createDiscussion({
              background: [fileTranscriptionName.trim() || transcriptionNameFromFile(file.name), form.background.trim()].filter(Boolean).join("\n\n"),
              projectPath: form.projectPath,
              participants: form.participants.map((participant) => ({ displayName: participant.displayName })),
              asrProvider: provider,
              brainProvider: form.brainProvider,
              brainModel: form.brainModel,
              mode: "real"
            }, workspaceScope);
        setDiscussion(activeDiscussion);
        const result = await uploadAudioFile({ discussionId: activeDiscussion.id, file }, workspaceScope);
        setDiscussion(result.discussion);
        setLocalStatus(`转写完成：已写入 ${result.utteranceCount} 条转写片段。`);
        void loadRecentDiscussions(workspaceScope);
      } catch (error) {
        setLocalStatus("转写失败，可保留当前文件直接重试。");
        setErrorMessage(error instanceof Error ? error.message : "录音文件识别失败。");
      } finally {
        setIsAudioFileUploading(false);
      }
    });
  }

  async function handleBindSpeaker(speakerLabel: string, participant: ParticipantDto) {
    if (!discussion) return;
    await bindSpeaker({
      discussionId: discussion.id,
      speakerLabel,
      participantId: participant.id
    }, workspaceScope);
    await refreshDiscussion(discussion.id);
  }

  async function handleInviteCodex() {
    voiceInvitationRef.current?.cancelPending();
    await inviteAi(aiGuidance, "manual");
  }

  async function inviteAi(guidance: string | undefined, source: "manual" | "voice") {
    if (!discussion) return;
    if (source === "voice" && (!isRecording || discussion.status !== "active" || discussion.asrProvider !== "volcengine")) return;
    if (aiTurnFlightRef.current) return;
    aiTurnFlightRef.current = true;
    const activeDiscussionId = discussion.id;
    setIsInvitingCodex(true);
    setErrorMessage(null);
    try {
      const aiTurn = await triggerAiTurn(activeDiscussionId, guidance, workspaceScope);
      setDiscussion((current) => current?.id === activeDiscussionId ? mergeAiTurn(current, aiTurn) : current);
      if (source === "manual") {
        setAiGuidance("");
        setIsGuidanceOpen(false);
      }
    } catch (error) {
      if (liveMeetingRef.current.discussionId === activeDiscussionId) {
        setErrorMessage(error instanceof Error ? error.message : "邀请 AI 失败");
      }
    } finally {
      aiTurnFlightRef.current = false;
      setIsInvitingCodex(false);
    }
  }

  async function handleUploadAudio(file: File) {
    if (!discussion || audioUploadFlightRef.current.isActive) return;
    const activeDiscussion = discussion;
    const activeScope = workspaceScope;
    const isVolcengineFile = activeDiscussion.asrProvider === "volcengine-file";
    const isType4me = activeDiscussion.asrProvider === "type4me";
    const providerLabel = isVolcengineFile ? "火山录音文件识别" : isType4me ? "Type4Me 引擎" : "FunASR";
    await audioUploadFlightRef.current.run(async () => {
      setIsAudioFileUploading(true);
      setErrorMessage(null);
      setLocalStatus(
        isVolcengineFile
          ? "正在上传并等待火山识别，请勿重复操作。"
          : `正在用本地 ${providerLabel} 识别上传录音，请勿重复操作。`
      );
      try {
        const result = await uploadAudioFile({ discussionId: activeDiscussion.id, file }, activeScope);
        setDiscussion(result.discussion);
        setLocalStatus(`${providerLabel}已写入 ${result.utteranceCount} 条转写片段。`);
      } catch (error) {
        setLocalStatus(null);
        setErrorMessage(error instanceof Error ? error.message : "录音文件识别失败。");
      } finally {
        setIsAudioFileUploading(false);
      }
    });
  }

  async function handleLoadFallbackAudio() {
    if (!discussion || !isDemoMode) return;
    setIsFallbackLoading(true);
    setErrorMessage(null);
    setLocalStatus("正在用本地 FunASR 处理预置兜底录音...");
    try {
      await stopAudioCapture();
      const result = await loadDemoFallbackAudio(discussion.id);
      setDiscussion(result.discussion);
      setFallbackLoaded(true);
      setAsrStatus("idle");
      setLocalStatus(
        result.alreadyLoaded
          ? "这条演示会议已经载入过兜底录音，没有重复写入。"
          : `兜底录音已完成真实本地转写，写入 ${result.utteranceCount} 条片段。`
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "兜底录音处理失败。");
      setLocalStatus(null);
    } finally {
      setIsFallbackLoading(false);
    }
  }

  async function handleDraftMemory() {
    if (!discussion) return;
    setLocalStatus("正在让当前大脑起草本次会议记忆...");
    const draft = await draftMemory(discussion.id, workspaceScope);
    setMemoryDraft(draft);
    setMemoryDraftText(draft.content);
    setLocalStatus("记忆草稿已生成，确认或修改后才会入库。");
  }

  async function handleConfirmMemory(content: string) {
    if (!discussion) return;
    const result = await confirmMemory({ discussionId: discussion.id, content }, workspaceScope);
    setSelectedCustomer(result.customer);
    setMemoryDraft(null);
    setMemoryDraftText("");
    setLocalStatus("滚动记忆已确认入库。");
    await loadCustomers(workspaceScope);
  }

  async function handleMarkAiFeedback(aiTurnId: string, rating: "useful" | "bad") {
    if (!discussion) return;
    const aiTurn = await markAiTurnFeedback({ discussionId: discussion.id, aiTurnId, rating }, workspaceScope);
    setDiscussion((current) =>
      current
        ? {
            ...current,
            aiTurns: current.aiTurns.map((item) => (item.id === aiTurn.id ? aiTurn : item))
          }
        : current
    );
  }

  async function handleEndDiscussion() {
    if (!discussion) return;
    await stopAudioCapture();
    const ended = await endDiscussion(discussion.id, workspaceScope);
    setDiscussion(ended);
    setAsrStatus("idle");
    setIsCommandExpanded(true);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleDeleteDiscussion() {
    if (!discussion) return;
    if (!window.confirm("确认删除这条讨论及其本地音频文件吗？此操作不可撤销。")) return;
    await stopAudioCapture();
    await deleteDiscussion(discussion.id, workspaceScope);
    setDiscussion(null);
    setErrorMessage(null);
    setIsSettingsOpen(false);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleDeleteAudio() {
    if (!discussion) return;
    if (!window.confirm("确认删除本次讨论的本地音频文件吗？转写和 AI 发言会保留。")) return;
    const updated = await deleteDiscussionAudio(discussion.id, workspaceScope);
    setDiscussion(updated);
    void loadRecentDiscussions(workspaceScope);
  }

  async function handleCopyCodexCommand(command: string | null) {
    if (command && (await copyText(command))) {
      setCopyStatus("已复制");
      setIsCommandExpanded(true);
      return;
    }
    setCopyStatus("复制失败");
  }

  async function handleReconnectAsr() {
    if (!discussion || discussion.status !== "active" || discussion.mode !== "real") return;
    await stopAudioCapture();
    setAsrStatus("idle");
    setAsrDiagnostics(initialAsrDiagnostics);
    setErrorMessage(null);
    await startAudioCapture();
    setIsDiagnosticsOpen(true);
  }

  async function toggleAudioCapture() {
    if (isRecording) {
      await stopAudioCapture();
      return;
    }
    await startAudioCapture();
  }

  async function startAudioCapture() {
    if (!discussion) return;
    setIsFollowingLatest(true);
    setErrorMessage(null);
    setIsAudioStarting(true);
    hasSentAudioRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAsrDiagnostics((current) => ({ ...current, micAuthorized: true, errorMessage: undefined, retryable: false }));
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const audioSocketPath = isDemoMode ? "/demo-audio" : "/audio";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}${audioSocketPath}?discussionId=${discussion.id}&sampleRate=16000`
      );
      socket.binaryType = "arraybuffer";

      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(float32ToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate, 16000));
        if (!hasSentAudioRef.current) {
          hasSentAudioRef.current = true;
          setAsrDiagnostics((current) => ({ ...current, audioSending: true }));
        }
      };

      source.connect(processor);
      processor.connect(context.destination);
      audioSessionRef.current = { context, processor, source, stream, socket };
      setIsRecording(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法启动麦克风。";
      setErrorMessage(message);
      setIsSettingsOpen(true);
      setIsDiagnosticsOpen(true);
      setAsrDiagnostics((current) => ({ ...current, errorMessage: message, retryable: true }));
    } finally {
      setIsAudioStarting(false);
    }
  }

  async function stopAudioCapture() {
    voiceInvitationRef.current?.reset();
    const session = audioSessionRef.current;
    if (!session) return;
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    session.socket.close();
    await session.context.close();
    audioSessionRef.current = null;
    setIsRecording(false);
  }

  function handleConversationScroll() {
    const feed = conversationFeedRef.current;
    if (!feed) return;
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    setIsFollowingLatest(distanceFromBottom < 72);
  }

  function scrollConversationToLatest() {
    setIsFollowingLatest(true);
    window.requestAnimationFrame(() => {
      conversationFeedRef.current?.scrollTo({
        top: conversationFeedRef.current.scrollHeight,
        behavior: "smooth"
      });
    });
  }

  return (
    <main
      className={`one-line-workspace phase-${phase}${isDemoMode ? " demo-mode" : ""}${
        updateState.hasBanner ? " workspace-has-update" : ""
      }`}
    >
      <header className="workspace-chrome">
        <button type="button" className="brand-signal" disabled={isFallbackLoading} onClick={handleNewDiscussion} aria-label="回到新会议">
          <span className="brand-orbit" aria-hidden="true">
            <span />
            <span />
          </span>
          <span className="brand-copy">
            <strong>AI Meeting Workstation</strong>
            <small>企业会议决策台</small>
          </span>
        </button>
        <div className="workspace-header-actions">
          {isDemoMode ? (
            <>
              <span className="demo-mode-badge">演示模式 · 数据隔离</span>
              <button type="button" className="demo-reset-trigger" disabled={isDemoModeLoading || isFallbackLoading} onClick={() => void handleResetDemoMode()}>
                {isDemoModeLoading ? "重置中" : "重置演示数据"}
              </button>
              <button type="button" className="demo-exit-trigger" disabled={isDemoModeLoading || isFallbackLoading} onClick={() => void handleExitDemoMode()}>
                退出演示
              </button>
            </>
          ) : (
            <button type="button" className="demo-mode-entry" disabled={isDemoModeLoading} onClick={() => void handleEnterDemoMode()}>
              {isDemoModeLoading ? "正在载入" : "进入演示模式"}
            </button>
          )}
          <button type="button" className="knowledge-trigger" onClick={() => setIsKnowledgeOpen(true)}>
            企业知识库 <span>Demo</span>
          </button>
          <button
            type="button"
            className={settingsHasAlert ? "settings-trigger has-alert" : "settings-trigger"}
            onClick={() => setIsSettingsOpen(true)}
            aria-label="打开设置"
          >
            设置 <kbd>⌘ K</kbd>
          </button>
        </div>
      </header>

      <UpdateBanner state={updateState} />

      {isDemoMode ? (
        <section className="demo-boundary-banner" role="status">
          <strong>当前为演示模式</strong>
          <span>澄远科技及参会人均为虚构数据；会议、录音和记忆只写入独立演示空间。</span>
        </section>
      ) : null}

      {taskMode === "home" ? (
        <HomeView
          recentDiscussions={recentDiscussions}
          onOpenDiscussion={handleOpenDiscussion}
          isTaskBusy={isTaskBusy}
          onSelectTask={handleSelectTask}
        />
      ) : isFileMode ? (
        <FileTranscribeView
          discussion={discussion}
          isFileResult={isFileResult}
          isTaskBusy={isTaskBusy}
          isAudioFileUploading={isAudioFileUploading}
          isInvitingCodex={isInvitingCodex}
          isSettingsOpen={isSettingsOpen}
          form={form}
          setForm={setForm}
          selectedAudioFile={selectedAudioFile}
          setSelectedAudioFile={setSelectedAudioFile}
          fileTranscriptionName={fileTranscriptionName}
          setFileTranscriptionName={setFileTranscriptionName}
          primaryFunasrInputRef={primaryFunasrInputRef}
          conversationItems={conversationItems}
          finalUtteranceCount={finalUtteranceCount}
          speakerLabels={speakerLabels}
          errorMessage={errorMessage}
          localStatus={localStatus}
          workspaceScope={workspaceScope}
          onReturnHome={handleReturnHome}
          onChooseAudioFile={handleChooseAudioFile}
          onClearAudioFile={handleClearAudioFile}
          onStartFileTranscription={handleStartFileTranscription}
          onInviteCodex={handleInviteCodex}
          onBindSpeaker={handleBindSpeaker}
          onResetFileResult={() => {
            setDiscussion(null);
            setSelectedAudioFile(null);
            setFileTranscriptionName("");
            setErrorMessage(null);
            setLocalStatus(null);
          }}
        />
      ) : (
        <LiveMeetingView
          discussion={discussion}
          form={form}
          setForm={setForm}
          phase={phase}
          asrStatus={asrStatus}
          isRecording={isRecording}
          isStarting={isStarting}
          isAudioStarting={isAudioStarting}
          isInvitingCodex={isInvitingCodex}
          isFallbackLoading={isFallbackLoading}
          isAudioFileUploading={isAudioFileUploading}
          isSettingsOpen={isSettingsOpen}
          isEnded={Boolean(isEnded)}
          isDemoMode={isDemoMode}
          fallbackLoaded={fallbackLoaded}
          demoBootstrap={demoBootstrap}
          isFollowingLatest={isFollowingLatest}
          isGuidanceOpen={isGuidanceOpen}
          setIsGuidanceOpen={setIsGuidanceOpen}
          aiGuidance={aiGuidance}
          setAiGuidance={setAiGuidance}
          conversationItems={conversationItems}
          finalUtteranceCount={finalUtteranceCount}
          finalUtteranceCountForNextAi={finalUtteranceCountForNextAi}
          speakerLabels={speakerLabels}
          latestUsableAiTurn={latestUsableAiTurn}
          resumeCommand={resumeCommand || null}
          isCommandExpanded={isCommandExpanded}
          copyStatus={copyStatus}
          errorMessage={errorMessage}
          primaryFunasrInputRef={primaryFunasrInputRef}
          conversationFeedRef={conversationFeedRef}
          onScrollConversation={handleConversationScroll}
          onScrollConversationToLatest={scrollConversationToLatest}
          onStart={handleStart}
          onToggleAudioCapture={toggleAudioCapture}
          onUploadAudio={handleUploadAudio}
          onInviteCodex={handleInviteCodex}
          onEndDiscussion={handleEndDiscussion}
          onNewDiscussion={handleNewDiscussion}
          onCopyCodexCommand={handleCopyCodexCommand}
          onBindSpeaker={handleBindSpeaker}
          onLoadFallbackAudio={handleLoadFallbackAudio}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenKnowledge={() => setIsKnowledgeOpen(true)}
        />
      )}

      <DemoView
        discussion={discussion}
        isOpen={isKnowledgeOpen}
        latestAiResponse={latestUsableAiTurn?.response ?? ""}
        onClose={() => setIsKnowledgeOpen(false)}
      />

      {modelStatus ? (
        <ModelSetupWizard
          status={modelStatus}
          isOpen={isModelWizardOpen}
          isBusy={isModelActionBusy}
          onSelectTier={setSelectedModelTier}
          onStart={() => void handleStartModelDownload()}
          onCancel={() => void handleCancelModelDownload()}
          onSkip={() => void handleSkipModelSetup()}
          onClose={handleCloseModelWizard}
        />
      ) : null}
      <SettingsView
        activeRecentDiscussion={activeRecentDiscussion}
        appSettings={appSettings}
        asrDiagnostics={asrDiagnostics}
        asrStatus={asrStatus}
        copyStatus={copyStatus}
        customers={customers}
        discussion={discussion}
        errorMessage={errorMessage}
        finalUtteranceCount={finalUtteranceCount}
        form={form}
        taskMode={taskMode}
        isDiagnosticsOpen={isDiagnosticsOpen}
        isAudioStarting={isAudioStarting}
        isAudioFileUploading={isAudioFileUploading}
        isFallbackLoading={isFallbackLoading}
        isOpen={isSettingsOpen}
        isRecording={isRecording}
        localStatus={localStatus}
        memoryDraft={memoryDraft}
        memoryDraftText={memoryDraftText}
        recentDiscussions={recentDiscussions}
        resumeCommand={resumeCommand}
        selectedCustomer={selectedCustomer}
        speakerLabels={speakerLabels}
        visibleTimeline={visibleTimeline}
        workspaceScope={workspaceScope}
        onBindSpeaker={handleBindSpeaker}
        onClose={() => setIsSettingsOpen(false)}
        onCopyCommand={handleCopyCodexCommand}
        onDeleteAudio={handleDeleteAudio}
        onDeleteDiscussion={handleDeleteDiscussion}
        onDraftMemory={handleDraftMemory}
        onConfirmMemory={handleConfirmMemory}
        onSetMemoryDraftText={setMemoryDraftText}
        onMarkAiFeedback={handleMarkAiFeedback}
        onOpenDiscussion={handleOpenDiscussion}
        onOpenModelSetup={handleOpenModelSettings}
        onReconnectAsr={handleReconnectAsr}
        onSaveCustomer={handleSaveCustomer}
        onSaveSettings={handleSaveSettings}
        onSelectCustomer={handleSelectCustomer}
        onSetDiagnosticsOpen={setIsDiagnosticsOpen}
        onSetForm={setForm}
        onToggleAudio={toggleAudioCapture}
        onUploadAudio={handleUploadAudio}
        update={desktopUpdate}
      />
    </main>
  );
}

