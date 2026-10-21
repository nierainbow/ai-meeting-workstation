import type React from "react";
import type { DiscussionDetailDto, ParticipantDto, WorkspaceDataScope } from "../../../../shared/types";
import type { FormState } from "../appTypes";
import { formatFileSize, parseKnownSpeakers } from "../taskMode";
import { humanSpeakerLabel } from "../format";
import { discussionMarkdownExportUrl, discussionPackageExportUrl } from "../api";
import type { TimelineItem } from "../discussionTimeline";
import { ConversationEntry } from "../ConversationEntry";
import { VoiceprintConfirmPanel } from "../VoiceprintConfirmPanel";

export function FileTranscribeView(props: {
  discussion: DiscussionDetailDto | null;
  isFileResult: boolean;
  isTaskBusy: boolean;
  isAudioFileUploading: boolean;
  isInvitingCodex: boolean;
  isSettingsOpen: boolean;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  selectedAudioFile: File | null;
  setSelectedAudioFile: (file: File | null) => void;
  fileTranscriptionName: string;
  setFileTranscriptionName: (value: string) => void;
  primaryFunasrInputRef: React.RefObject<HTMLInputElement | null>;
  conversationItems: TimelineItem[];
  finalUtteranceCount: number;
  speakerLabels: string[];
  errorMessage: string | null;
  localStatus: string | null;
  workspaceScope: WorkspaceDataScope;
  onReturnHome: () => void;
  onChooseAudioFile: (file: File) => void;
  onClearAudioFile: () => void;
  onStartFileTranscription: () => Promise<void>;
  onInviteCodex: () => Promise<void>;
  onBindSpeaker: (label: string, participant: ParticipantDto) => Promise<void>;
  onResetFileResult: () => void;
}) {
  const {
    discussion,
    isFileResult,
    isTaskBusy,
    isAudioFileUploading,
    isInvitingCodex,
    isSettingsOpen,
    form,
    setForm,
    selectedAudioFile,
    fileTranscriptionName,
    setFileTranscriptionName,
    primaryFunasrInputRef,
    conversationItems,
    finalUtteranceCount,
    speakerLabels,
    errorMessage,
    localStatus,
    workspaceScope,
    onReturnHome,
    onChooseAudioFile,
    onClearAudioFile,
    onStartFileTranscription,
    onInviteCodex,
    onBindSpeaker,
    onResetFileResult
  } = props;
  return (
    <section className="file-workspace" aria-label={isFileResult ? "录音转写结果" : "上传录音转写"}>
      <header className="file-workspace-header">
        <div>
          <button
            type="button"
            className="quiet-button"
            style={{ display: "block", marginBottom: 18, borderColor: "#7785db", color: "#293a92", background: "#f0f3ff", fontWeight: 800 }}
            disabled={isTaskBusy}
            onClick={onReturnHome}
          >
            ← 返回首页
          </button>
          <span>{isFileResult ? "TRANSCRIPT RESULT" : "FILE TRANSCRIPTION"}</span>
          <h1>{isFileResult ? "转写结果" : "上传录音转写"}</h1>
          <p>{isFileResult ? "逐字稿已进入时间线，可校正说话人并导出。" : "先选择文件，再确认转写方式；选择文件不会立即上传。"}</p>
        </div>
      </header>

      {!isFileResult ? (
        <div className="file-preflight-grid">
          <section className="file-picker-card">
            <input
              ref={primaryFunasrInputRef}
              id="file-transcription-input"
              type="file"
              accept="audio/*,video/*"
              hidden
              disabled={isAudioFileUploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onChooseAudioFile(file);
                event.currentTarget.value = "";
              }}
              onDragEnter={(event) => event.preventDefault()}
            />
            {selectedAudioFile ? (
              <div className="selected-file-card">
                <span className="file-token" aria-hidden="true">AUDIO</span>
                <div>
                  <strong>{selectedAudioFile.name}</strong>
                  <small>{formatFileSize(selectedAudioFile.size)} · 等待开始</small>
                </div>
                <button type="button" disabled={isAudioFileUploading} onClick={onClearAudioFile}>移除</button>
              </div>
            ) : (
              <button
                type="button"
                className="file-drop-target"
                disabled={isAudioFileUploading}
                onClick={() => primaryFunasrInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files?.[0];
                  if (file) onChooseAudioFile(file);
                }}
              >
                <strong>选择或拖放录音文件</strong>
                <span>支持 M4A、MP3、WAV 等常见格式</span>
              </button>
            )}
            {selectedAudioFile ? (
              <button type="button" className="replace-file" disabled={isAudioFileUploading} onClick={() => primaryFunasrInputRef.current?.click()}>重新选择文件</button>
            ) : null}
          </section>

          <section className="file-options-card">
            <fieldset disabled={isAudioFileUploading}>
              <legend>选择转写方式</legend>
              <label className={form.asrProvider === "volcengine-file" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="file-provider" value="volcengine-file" checked={form.asrProvider === "volcengine-file"} onChange={() => setForm((current) => ({ ...current, asrProvider: "volcengine-file" }))} />
                <span><strong>火山录音文件识别 2.0 <em>推荐</em></strong><small>录音会上传到火山引擎；本工作台当前限制 200MB。</small></span>
              </label>
              <label className={form.asrProvider === "funasr" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="file-provider" value="funasr" checked={form.asrProvider === "funasr"} onChange={() => setForm((current) => ({ ...current, asrProvider: "funasr" }))} />
                <span><strong>本地 FunASR <em>隐私优先</em></strong><small>只在本机处理；准确度可能低于火山。</small></span>
              </label>
              <label className={form.asrProvider === "type4me" ? "provider-choice selected" : "provider-choice"}>
                <input type="radio" name="file-provider" value="type4me" checked={form.asrProvider === "type4me"} onChange={() => setForm((current) => ({ ...current, asrProvider: "type4me" }))} />
                <span><strong>Type4Me 本地引擎 <em>Qwen3-ASR</em></strong><small>复用本机 Type4Me 的模型与热词，Apple Silicon 加速，全程离线。</small></span>
              </label>
            </fieldset>
            <label className="file-meta-field">转写名称（可选）<input value={fileTranscriptionName} placeholder="未填写时使用文件名" disabled={isAudioFileUploading} onChange={(event) => setFileTranscriptionName(event.target.value)} /></label>
            <label className="file-meta-field">会议说明（可选）<textarea value={form.background} disabled={isAudioFileUploading} placeholder="例如：客户访谈、项目复盘" onChange={(event) => setForm({ ...form, background: event.target.value })} /></label>
            <label className="file-meta-field">已知说话人姓名（可选）<input value={form.participants.map((item) => item.displayName).join("，")} disabled={isAudioFileUploading} placeholder="用逗号分隔，例如：项目经理，客户经理" onChange={(event) => setForm((current) => ({ ...current, participants: parseKnownSpeakers(event.target.value) }))} /></label>
          </section>
        </div>
      ) : null}

      {discussion ? (
        <section className="file-result-summary" aria-label="转写摘要">
          <div><span>文件</span><strong>{selectedAudioFile?.name || discussion.title}</strong></div>
          <div><span>转写方式</span><strong>{discussion.asrProvider === "volcengine-file" ? "火山录音文件识别 2.0" : discussion.asrProvider === "type4me" ? "Type4Me 本地 Qwen3-ASR" : "本地 FunASR"}</strong></div>
          <div><span>转写片段</span><strong>{finalUtteranceCount} 条</strong></div>
        </section>
      ) : null}

      {isFileResult && discussion ? (
        <section className="file-result-layout">
          <section className="conversation-panel file-result-transcript">
            <header className="panel-heading"><div><span>FULL TRANSCRIPT</span><h2>完整逐字稿</h2></div><div className="transcript-health">已保存到本机</div></header>
            <div className="conversation-feed file-result-feed">{conversationItems.map((item) => <ConversationEntry discussion={discussion} item={item} key={item.id} />)}</div>
          </section>
          <aside className="file-result-actions">
            <h2>结果操作</h2>
            <a href={discussionMarkdownExportUrl(discussion.id, workspaceScope)}>导出 Markdown</a>
            <a href={discussionPackageExportUrl(discussion.id, workspaceScope)}>导出讨论包</a>
            <button type="button" disabled={isInvitingCodex} onClick={onInviteCodex}>{isInvitingCodex ? "AI 正在整理" : "让 AI 整理会议纪要"}</button>
            <button type="button" disabled={isTaskBusy} onClick={onResetFileResult}>重新上传录音</button>
          </aside>
        </section>
      ) : null}

      {speakerLabels.length > 0 && discussion ? (
        <section className="voice-binding-strip" aria-label="说话人校正"><strong>说话人校正</strong>{speakerLabels.map((label) => <div className="voice-binding" key={label}><span>{humanSpeakerLabel(label)}</span>{discussion.participants.map((participant) => <button type="button" key={participant.id} onClick={() => onBindSpeaker(label, participant)}>标为 {participant.displayName}</button>)}</div>)}</section>
      ) : null}

      {discussion ? <VoiceprintConfirmPanel discussionId={discussion.id} /> : null}

      {!isFileResult ? (
        <section className="file-primary-action" aria-live="polite">
          <button type="button" disabled={!selectedAudioFile || isAudioFileUploading} aria-busy={isAudioFileUploading} onClick={() => void onStartFileTranscription()}>{isAudioFileUploading ? "正在上传并识别，请勿重复操作" : discussion ? "重试转写" : "开始转写"}</button>
          <span>{localStatus || (selectedAudioFile ? "等待开始" : "请先选择录音文件")}</span>
        </section>
      ) : null}
      {errorMessage && !isSettingsOpen ? <div className="file-error" role="alert"><strong>转写失败</strong><span>{errorMessage}</span></div> : null}
    </section>
  );
}
