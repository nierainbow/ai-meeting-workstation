import type React from "react";
import type { DemoBootstrapDto, DiscussionDetailDto, ParticipantDto } from "../../../../shared/types";
import type { AsrStatus } from "../../../../shared/events";
import type { FormState, SessionPhase } from "../appTypes";
import { cloudNotice } from "../brainOptions";
import { humanSpeakerLabel, phaseLabel } from "../format";
import { mainErrorText } from "../errorPresentation";
import { aiTurnSystemNotice } from "../errorPresentation";
import type { TimelineItem } from "../discussionTimeline";
import { ConversationEntry } from "../ConversationEntry";

export function LiveMeetingView(props: {
  discussion: DiscussionDetailDto | null;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  phase: SessionPhase;
  asrStatus: AsrStatus;
  isRecording: boolean;
  isStarting: boolean;
  isAudioStarting: boolean;
  isInvitingCodex: boolean;
  isFallbackLoading: boolean;
  isAudioFileUploading: boolean;
  isSettingsOpen: boolean;
  isEnded: boolean;
  isDemoMode: boolean;
  fallbackLoaded: boolean;
  demoBootstrap: DemoBootstrapDto | null;
  isFollowingLatest: boolean;
  isGuidanceOpen: boolean;
  setIsGuidanceOpen: (value: boolean) => void;
  aiGuidance: string;
  setAiGuidance: (value: string) => void;
  conversationItems: TimelineItem[];
  finalUtteranceCount: number;
  finalUtteranceCountForNextAi: number;
  speakerLabels: string[];
  latestUsableAiTurn: DiscussionDetailDto["aiTurns"][number] | null;
  resumeCommand: string | null;
  isCommandExpanded: boolean;
  copyStatus: string | null;
  errorMessage: string | null;
  primaryFunasrInputRef: React.RefObject<HTMLInputElement | null>;
  conversationFeedRef: React.RefObject<HTMLDivElement | null>;
  onScrollConversation: () => void;
  onScrollConversationToLatest: () => void;
  onStart: () => void;
  onToggleAudioCapture: () => void;
  onUploadAudio: (file: File) => Promise<void>;
  onInviteCodex: () => void;
  onEndDiscussion: () => void;
  onNewDiscussion: () => void;
  onCopyCodexCommand: (command: string | null) => void;
  onBindSpeaker: (label: string, participant: ParticipantDto) => Promise<void>;
  onLoadFallbackAudio: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenKnowledge: () => void;
}) {
  const {
    discussion,
    form,
    setForm,
    phase,
    asrStatus,
    isRecording,
    isStarting,
    isAudioStarting,
    isInvitingCodex,
    isFallbackLoading,
    isAudioFileUploading,
    isSettingsOpen,
    isEnded,
    isDemoMode,
    fallbackLoaded,
    demoBootstrap,
    isFollowingLatest,
    isGuidanceOpen,
    setIsGuidanceOpen,
    aiGuidance,
    setAiGuidance,
    conversationItems,
    finalUtteranceCount,
    finalUtteranceCountForNextAi,
    speakerLabels,
    latestUsableAiTurn,
    resumeCommand,
    isCommandExpanded,
    copyStatus,
    errorMessage,
    primaryFunasrInputRef,
    conversationFeedRef,
    onScrollConversation,
    onScrollConversationToLatest,
    onStart,
    onToggleAudioCapture,
    onUploadAudio,
    onInviteCodex,
    onEndDiscussion,
    onNewDiscussion,
    onCopyCodexCommand,
    onBindSpeaker,
    onLoadFallbackAudio,
    onOpenSettings,
    onOpenKnowledge
  } = props;
  return (
  <section className="workspace-canvas" aria-label="实时会议助手">
    <div className="topic-stage">
      <div className="meeting-status">
        <span className={isRecording ? "status-orb live" : "status-orb"} aria-hidden="true" />
        <span>{phaseLabel(phase)}</span>
        {discussion ? <small>{finalUtteranceCount} 条有效片段</small> : null}
      </div>
      {!discussion ? (
        <label className="topic-editor">
          <span>让每一次会议<br />都成为企业资产</span>
          <textarea
            value={form.background}
            placeholder="写下会议主题、目标和背景。AI 会结合客户档案与历史记忆参与讨论。"
            onChange={(event) => setForm({ ...form, background: event.target.value })}
          />
        </label>
      ) : (
        <button type="button" className="topic-node-large" onClick={onOpenSettings}>
          <span>AI 参与企业会议</span>
          <strong>实时理解讨论，协同判断，沉淀企业知识</strong>
          <small>从会议实录到行动建议，让每一次沟通都成为下一次决策的上下文。</small>
        </button>
      )}
      <small>{cloudNotice(form.brainProvider, form.asrProvider)}</small>
    </div>

    <section className="meeting-command-center" aria-label="会议轨迹">
      <section className="conversation-panel">
        <header className="panel-heading">
          <div>
            <span>Live transcript</span>
            <h2>会议实录</h2>
          </div>
          <div className="transcript-health">
            <span className={asrStatus === "receiving" || asrStatus === "connected" ? "health-dot online" : "health-dot"} />
            {isRecording
              ? "实时记录中"
              : finalUtteranceCount > 0
                ? "已保存到本机"
                : discussion?.asrProvider === "funasr" || discussion?.asrProvider === "volcengine-file" || discussion?.asrProvider === "type4me"
                  ? "等待上传录音"
                  : "等待会议开始"}
          </div>
        </header>

        <div className="conversation-feed-shell">
          <div
            className="conversation-feed"
            ref={conversationFeedRef}
            onScroll={onScrollConversation}
            aria-live="polite"
          >
            {conversationItems.length > 0 ? (
              conversationItems.map((item) => (
                <ConversationEntry discussion={discussion} item={item} key={item.id} />
              ))
            ) : (
              <div className="conversation-empty">
                <span className="empty-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                <strong>{discussion ? "会议已经准备好" : "先建立本次会议"}</strong>
                <p>
                  {discussion
                    ? discussion.asrProvider === "funasr" || discussion.asrProvider === "volcengine-file" || discussion.asrProvider === "type4me"
                      ? "点击下方“选择录音文件转写”，这里会按顺序呈现识别结果和 AI 的发言。"
                      : "点击下方“开始实时转写”，这里会按顺序呈现每个人和 AI 的发言。"
                    : "写下主题后开始会议，实时转写与 AI 建议会出现在这里。"}
                </p>
              </div>
            )}
          </div>
          {!isFollowingLatest && conversationItems.length > 0 ? (
            <button type="button" className="conversation-jump-latest" onClick={onScrollConversationToLatest}>
              回到最新发言 <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
      </section>

      <aside className="insight-panel">
        <header className="insight-heading">
          <span className="ai-mark" aria-hidden="true">AI</span>
          <div>
            <span>Meeting Copilot</span>
            <h2>AI 会议参谋</h2>
          </div>
          <em>{isInvitingCodex ? "分析中" : latestUsableAiTurn ? "已更新" : "待命"}</em>
        </header>

        <div className={latestUsableAiTurn ? "insight-content has-answer" : "insight-content"}>
          {isInvitingCodex ? (
            <>
              <strong>正在分析新增讨论</strong>
              <p>AI 正在寻找盲点、风险和下一步行动，不会重复发送已经分析过的对话。</p>
            </>
          ) : latestUsableAiTurn?.response ? (
            <>
              <strong>本轮建议</strong>
              <p>{latestUsableAiTurn.response}</p>
              {aiTurnSystemNotice(latestUsableAiTurn.status) ? (
                <aside className="ai-response-system-note" role="note">
                  {aiTurnSystemNotice(latestUsableAiTurn.status)}
                </aside>
              ) : null}
            </>
          ) : (
            <>
              <strong>让 AI 在关键时刻介入</strong>
              <p>{finalUtteranceCountForNextAi > 0 ? `已有 ${finalUtteranceCountForNextAi} 条新片段可分析。` : "会议产生有效对话后，AI 会结合背景和历史记忆给出建议。"}</p>
            </>
          )}
        </div>

        <div className={isGuidanceOpen || aiGuidance.trim() ? "ai-guidance open" : "ai-guidance"}>
          <button
            type="button"
            className="ai-guidance-toggle"
            aria-expanded={isGuidanceOpen}
            onClick={() => setIsGuidanceOpen(!isGuidanceOpen)}
          >
            <span aria-hidden="true">{aiGuidance.trim() ? "✓" : "+"}</span>
            {aiGuidance.trim() ? "已添加本轮引导" : "添加本轮引导（可选）"}
          </button>
          {isGuidanceOpen ? (
            <label className="ai-guidance-editor">
              <span>希望 AI 这一次重点回答什么？</span>
              <textarea
                value={aiGuidance}
                maxLength={300}
                rows={3}
                placeholder="例如：只分析合同风险；判断客户真实意图；不要总结，只给下一步。"
                onChange={(event) => setAiGuidance(event.target.value)}
              />
              <small>
                <span>仅影响下一次发言，成功后自动清空</span>
                <span>{aiGuidance.length}/300</span>
              </small>
            </label>
          ) : null}
        </div>

        <button type="button" className="insight-action" disabled={!discussion || isInvitingCodex || isFallbackLoading} onClick={onInviteCodex}>
          {isInvitingCodex ? "AI 正在思考…" : "让 AI 分析最新讨论"}
        </button>
        {discussion?.asrProvider === "volcengine" || discussion?.asrProvider === "type4me-live" ? (
          <p className="voice-invitation-hint">实时转写时也可以说：“AI，你怎么看这个方案？”</p>
        ) : null}

        <section className="knowledge-preview">
          <div>
            <span>Knowledge loop</span>
            <strong>会议结束后自动沉淀</strong>
          </div>
          <p>关键决策、战略方向、客户信号和行动项，将成为企业下一次决策的背景。</p>
          <div className="knowledge-tags">
            <span>战略部署</span>
            <span>关键决策</span>
            <span>客户洞察</span>
            <span>行动项</span>
          </div>
          <button type="button" onClick={onOpenKnowledge}>
            查看企业知识库 Demo <span aria-hidden="true">↗</span>
          </button>
        </section>
      </aside>
    </section>

    {speakerLabels.length > 0 && discussion ? (
      <section className="voice-binding-strip" aria-label="识别到新说话人">
        <strong>识别到新说话人</strong>
        {speakerLabels.map((label) => (
          <div className="voice-binding" key={label}>
            <span>{humanSpeakerLabel(label)}</span>
            {discussion.participants.map((participant: ParticipantDto) => (
              <button type="button" key={participant.id} onClick={() => onBindSpeaker(label, participant)}>
                标为 {participant.displayName}
              </button>
            ))}
          </div>
        ))}
      </section>
    ) : null}

    {isEnded && resumeCommand && isCommandExpanded ? (
      <section className="handoff-command" aria-label="Codex 续接命令">
        <code>{resumeCommand}</code>
        <p>{copyStatus === "已复制" ? "已复制，回到 Codex 后粘贴即可继续。" : "这条命令会把刚才的讨论上下文交回 Codex。"}</p>
      </section>
    ) : null}

    <section className="primary-action-cluster" aria-label="当前主动作">
      {!discussion ? (
        <button type="button" className="listen-button" onClick={onStart} disabled={isStarting}>
          <span className="mic-glyph" aria-hidden="true" />
          {isStarting ? "准备中" : "开始实时会议"}
        </button>
      ) : isEnded ? (
        <>
          <button type="button" className="listen-button handoff" onClick={() => void onCopyCodexCommand(resumeCommand)} disabled={!resumeCommand}>
            <span className="handoff-glyph" aria-hidden="true" />
            {copyStatus === "已复制" ? "已复制" : "复制会议上下文"}
          </button>
          <button type="button" className="ghost-action" onClick={onNewDiscussion}>
            新会议
          </button>
        </>
      ) : (
        <>
          {discussion.asrProvider === "funasr" || discussion.asrProvider === "volcengine-file" || discussion.asrProvider === "type4me" ? (
            <>
              <input
                ref={primaryFunasrInputRef}
                type="file"
                accept="audio/*,video/*"
                hidden
                disabled={isFallbackLoading || isAudioFileUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onUploadAudio(file);
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                className="listen-button"
                onClick={() => primaryFunasrInputRef.current?.click()}
                disabled={isFallbackLoading || isAudioFileUploading}
                aria-busy={isAudioFileUploading}
              >
                {isAudioFileUploading ? "正在上传并识别，请勿重复操作" : "选择录音文件转写"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={isRecording || isAudioStarting ? "listen-button live" : "listen-button"}
              onClick={onToggleAudioCapture}
              disabled={isAudioStarting || isFallbackLoading}
              aria-busy={isAudioStarting}
              aria-pressed={isRecording}
            >
              <span className="mic-glyph" aria-hidden="true" />
              {isAudioStarting ? "正在请求麦克风…" : isRecording ? "停止实时转写" : "开始实时转写"}
            </button>
          )}
          {isDemoMode ? (
            <button
              type="button"
              className="fallback-action"
              disabled={isFallbackLoading || fallbackLoaded || !demoBootstrap?.fallbackAudio.available}
              onClick={() => void onLoadFallbackAudio()}
            >
              {isFallbackLoading ? "正在处理兜底录音" : fallbackLoaded ? "兜底录音已载入" : "使用兜底录音"}
            </button>
          ) : null}
          <button type="button" className="agent-action" disabled={isInvitingCodex || isFallbackLoading} onClick={onInviteCodex}>
            {isInvitingCodex ? "AI 正在思考" : "由 AI 发言"}
          </button>
          <button type="button" className="handoff-action" disabled={isFallbackLoading} onClick={onEndDiscussion}>
            结束会议
          </button>
        </>
      )}
      {errorMessage && !isSettingsOpen ? (
        <button type="button" className="soft-warning" onClick={onOpenSettings}>
          <strong>{mainErrorText(errorMessage)}</strong>
          <span>{errorMessage}</span>
        </button>
      ) : null}
    </section>
  </section>
  );
}
