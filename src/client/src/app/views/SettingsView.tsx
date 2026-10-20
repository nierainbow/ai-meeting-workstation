import type React from "react";
import type {
  CustomerDetailDto,
  CustomerSummaryDto,
  DiscussionDetailDto,
  DiscussionSummaryDto,
  MemoryDraftDto,
  ParticipantDto,
  PublicAppSettingsDto,
  WorkspaceDataScope
} from "../../../../shared/types";
import type { AsrDiagnostics, FormState } from "../appTypes";
import type { AsrStatus } from "../../../../shared/events";
import type { TaskMode } from "../taskMode";
import type { AsrProviderType, BrainProviderType } from "../../../../shared/types";
import { isUsableAiTurn } from "../../../../shared/aiTurns";
import { CODING_PLAN_MODELS, cloudNotice, defaultModelForBrain } from "../brainOptions";
import { diagnosticItems, fragmentPreview, humanSpeakerLabel, statusText, timelineLabel, timelineText } from "../format";
import { addParticipant, removeParticipant, updateParticipant } from "../participantForm";
import type { TimelineItem } from "../discussionTimeline";
import { discussionMarkdownExportUrl, discussionPackageExportUrl } from "../api";
import type { UpdateState } from "../useAppUpdate";

export function SettingsView(props: {
  activeRecentDiscussion?: DiscussionSummaryDto;
  appSettings: PublicAppSettingsDto | null;
  asrDiagnostics: AsrDiagnostics;
  asrStatus: AsrStatus;
  copyStatus: string | null;
  customers: CustomerSummaryDto[];
  discussion: DiscussionDetailDto | null;
  errorMessage: string | null;
  finalUtteranceCount: number;
  form: FormState;
  taskMode: TaskMode;
  isDiagnosticsOpen: boolean;
  isAudioStarting: boolean;
  isAudioFileUploading: boolean;
  isFallbackLoading: boolean;
  isOpen: boolean;
  isRecording: boolean;
  localStatus: string | null;
  memoryDraft: MemoryDraftDto | null;
  memoryDraftText: string;
  recentDiscussions: DiscussionSummaryDto[];
  resumeCommand: string;
  selectedCustomer: CustomerDetailDto | null;
  speakerLabels: string[];
  visibleTimeline: TimelineItem[];
  workspaceScope: WorkspaceDataScope;
  onBindSpeaker: (speakerLabel: string, participant: ParticipantDto) => Promise<void>;
  onClose: () => void;
  onCopyCommand: (command: string) => Promise<void>;
  onDeleteAudio: () => Promise<void>;
  onDeleteDiscussion: () => Promise<void>;
  onDraftMemory: () => Promise<void>;
  onConfirmMemory: (content: string) => Promise<void>;
  onSetMemoryDraftText: (value: string) => void;
  onMarkAiFeedback: (aiTurnId: string, rating: "useful" | "bad") => Promise<void>;
  onOpenDiscussion: (discussionId: string) => Promise<void>;
  onOpenModelSetup: () => Promise<void>;
  onReconnectAsr: () => Promise<void>;
  onSaveCustomer: () => Promise<void>;
  onSaveSettings: (update: Partial<PublicAppSettingsDto> & {
    deepseekApiKey?: string;
    openaiApiKey?: string;
    volcengineApiKey?: string;
    volcengineBrainApiKey?: string;
    volcengineBrainBaseUrl?: string;
    volcengineBrainModel?: string;
  }) => Promise<void>;
  onSelectCustomer: (customerId: string) => Promise<void>;
  onSetDiagnosticsOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  onSetForm: (form: FormState | ((current: FormState) => FormState)) => void;
  onToggleAudio: () => Promise<void>;
  onUploadAudio: (file: File) => Promise<void>;
  /** 自动更新状态；浏览器 dev 模式为 undefined，此时整段不渲染。 */
  update?: UpdateState;
}) {
  const {
    activeRecentDiscussion,
    appSettings,
    asrDiagnostics,
    asrStatus,
    copyStatus,
    customers,
    discussion,
    errorMessage,
    finalUtteranceCount,
    form,
    taskMode,
    isDiagnosticsOpen,
    isAudioStarting,
    isAudioFileUploading,
    isFallbackLoading,
    isOpen,
    isRecording,
    localStatus,
    memoryDraft,
    memoryDraftText,
    recentDiscussions,
    resumeCommand,
    selectedCustomer,
    speakerLabels,
    visibleTimeline,
    workspaceScope
  } = props;

  return (
    <div className={isOpen ? "settings-layer open" : "settings-layer"} aria-hidden={!isOpen}>
      <button type="button" className="settings-backdrop" onClick={props.onClose} tabIndex={isOpen ? 0 : -1} aria-label="关闭隐藏设置" />
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="设置">
        <header className="drawer-header">
          <div>
            <span>{taskMode === "file" ? "文件转写设置" : "实时会议设置"}</span>
            <h2>{taskMode === "file" ? "转写方式与隐私边界" : "客户、实时转写与 AI"}</h2>
          </div>
          <button type="button" onClick={props.onClose}>
            关闭
          </button>
        </header>

        {errorMessage ? <p className="drawer-alert">{errorMessage}</p> : null}
        {localStatus ? <p className="drawer-alert neutral">{localStatus}</p> : null}
        {workspaceScope === "demo" ? (
          <p className="drawer-alert demo">演示模式的数据与正常会议完全分开；重置只会清理演示空间。</p>
        ) : null}

        {appSettings?.secrets?.plaintextOnDisk ? (
          <div className="drawer-alert warn" role="alert">
            <strong>密钥还以明文存在本机</strong>
            <span>请重新保存一次上面的 API Key，工作台会把它写进系统钥匙串（macOS Keychain / Windows DPAPI），磁盘只留引用。</span>
            <ul>
              {appSettings.secrets.rotateReminder.map((reminder) => (
                <li key={reminder}>{reminder}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {appSettings?.secrets && !appSettings.secrets.plaintextOnDisk && !appSettings.secrets.available ? (
          <p className="drawer-alert warn">当前系统钥匙串不可用，本次运行的密钥只保存在进程内存中，重启后需要重新填写。</p>
        ) : null}

        {taskMode !== "file" ? <section className="drawer-section">
          <h3>客户档案</h3>
          {!discussion ? (
            <>
              <label>
                选择客户
                <select value={form.customerId} onChange={(event) => void props.onSelectCustomer(event.target.value)}>
                  <option value="">未选择</option>
                {customers.map((customer) => (
                  <option value={customer.id} key={customer.id}>
                    {customer.displayName} · {customer.memoryCount} 条记忆
                  </option>
                ))}
              </select>
            </label>
            <label>
              客户 ID
              <input
                value={form.customerId}
                placeholder="alpha-consult"
                onChange={(event) =>
                  props.onSetForm({
                    ...form,
                    customerId: event.target.value,
                    customerName: form.customerName || event.target.value
                  })
                }
              />
            </label>
            <label>
              客户名称
              <input
                value={form.customerName}
                placeholder="客户公司名"
                onChange={(event) => props.onSetForm({ ...form, customerName: event.target.value })}
              />
            </label>
            <label>
              公司档案
              <textarea
                value={form.customerProfile}
                onChange={(event) => props.onSetForm({ ...form, customerProfile: event.target.value })}
              />
            </label>
            <button type="button" className="quiet-button" onClick={() => void props.onSaveCustomer()}>
              保存客户档案
            </button>
          </>
        ) : (
          <div className="customer-readout">
            <strong>{selectedCustomer?.displayName || discussion.customerId || "未选择客户"}</strong>
            <span>{selectedCustomer ? `${selectedCustomer.memoryCount} 条滚动记忆` : "本次会议没有客户记忆上下文"}</span>
          </div>
        )}
      </section> : null}

      <section className="drawer-section">
        <h3>{taskMode === "file" ? "文件转写方式" : "转写与大脑"}</h3>
        <label>
          ASR 转写
          <select
            value={form.asrProvider}
            disabled={Boolean(discussion)}
            onChange={(event) => {
              const asrProvider = event.target.value as AsrProviderType;
              props.onSetForm({ ...form, asrProvider });
              void props.onSaveSettings({ asrProvider });
            }}
          >
            {taskMode === "file" ? (
              <>
                <option value="volcengine-file">火山录音文件识别 2.0（推荐）</option>
                <option value="funasr">本地 FunASR（隐私优先）</option>
                <option value="type4me">Type4Me 本地引擎（Qwen3-ASR）</option>
              </>
            ) : (
              <>
                <option value="volcengine">火山豆包流式 ASR 2.0</option>
                <option value="type4me-live">Type4Me 本地引擎（Qwen3-ASR）</option>
                <option value="mock">Mock 演示</option>
              </>
            )}
          </select>
        </label>
        {taskMode === "file" ? (
          <p className="cloud-notice">{form.asrProvider === "volcengine-file" ? "录音会上传到火山引擎。本工作台当前限制 200MB；完整原始 M4A 与 MP3 分段均已实测。" : form.asrProvider === "type4me" ? "录音只交给本机 Type4Me 引擎（Qwen3-ASR）处理，不联网、不发送到火山。" : "录音只在本机交给 FunASR 处理，不发送到火山。"}</p>
        ) : null}
        {taskMode !== "file" ? <>
        <label>
          AI 大脑
          <select
            value={form.brainProvider}
            disabled={Boolean(discussion)}
            onChange={(event) => {
              const brainProvider = event.target.value as BrainProviderType;
              const brainModel = defaultModelForBrain(brainProvider, appSettings);
              props.onSetForm({ ...form, brainProvider, brainModel });
              void props.onSaveSettings({ brainProvider, brainModel });
            }}
          >
            <option value="deepseek">DeepSeek（客户默认）</option>
            <option value="volcengine">火山方舟 Ark（客户默认）</option>
            <option value="claude-cli">Claude CLI（自用/客户自带订阅）</option>
            <option value="codex-cli">Codex CLI（自用/客户自带订阅）</option>
            <option value="openai">OpenAI GPT（预留）</option>
            <option value="local-qwen">本地 Qwen（预留）</option>
            <option value="mock">Mock</option>
          </select>
        </label>
        <label>
          模型
          <input
            value={form.brainProvider === "volcengine" ? (appSettings?.volcengineBrainModel || "ark-code-latest") : form.brainModel}
            disabled={Boolean(discussion) || form.brainProvider === "volcengine"}
            title={form.brainProvider === "volcengine" ? "火山方舟 Coding Plan 模型由服务器端统一配置，不可在客户端随意填写。" : undefined}
            onChange={(event) => props.onSetForm({ ...form, brainModel: event.target.value })}
            onBlur={() => void props.onSaveSettings({ brainModel: form.brainModel })}
          />
        </label>
        <label>
          DeepSeek API Key
          <input
            type="password"
            placeholder={appSettings?.keys.deepseek ? "已保存，留空不改" : "填客户自己的 key"}
            onBlur={(event) => {
              if (event.target.value.trim()) void props.onSaveSettings({ deepseekApiKey: event.target.value.trim() });
              event.currentTarget.value = "";
            }}
          />
        </label>
        <label>
          火山 ASR API Key
          <input
            type="password"
            placeholder={appSettings?.keys.volcengine ? "已保存，留空不改" : "填火山自己的 key"}
            onBlur={(event) => {
              if (event.target.value.trim()) void props.onSaveSettings({ volcengineApiKey: event.target.value.trim() });
              event.currentTarget.value = "";
            }}
          />
        </label>
        <label>
          火山流式 Resource-Id
          <input
            value={appSettings?.volcengineResourceId ?? "volc.seedasr.sauc.duration"}
            onChange={(event) => void props.onSaveSettings({ volcengineResourceId: event.target.value })}
          />
        </label>
        <label>
          火山方舟 Ark API Key
          <input
            type="password"
            placeholder={appSettings?.keys.volcengineBrain ? "已保存，留空不改" : "填火山方舟的 key"}
            onBlur={(event) => {
              if (event.target.value.trim()) void props.onSaveSettings({ volcengineBrainApiKey: event.target.value.trim() });
              event.currentTarget.value = "";
            }}
          />
        </label>
        <label>
          火山方舟 Coding Plan 模型
          <select
            value={(() => {
              const current = appSettings?.volcengineBrainModel || "ark-code-latest";
              return CODING_PLAN_MODELS.some((model) => model.id === current) ? current : "ark-code-latest";
            })()}
            onChange={(event) => void props.onSaveSettings({ volcengineBrainModel: event.target.value })}
          >
            {CODING_PLAN_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          火山方舟 Base URL
          <input
            value={appSettings?.volcengineBrainBaseUrl ?? "https://ark.cn-beijing.volces.com/api/coding/v3"}
            onChange={(event) => void props.onSaveSettings({ volcengineBrainBaseUrl: event.target.value })}
          />
        </label>
        <p className="cloud-notice">{cloudNotice(form.brainProvider, form.asrProvider)}</p>
        </> : (
          <details className="advanced-settings">
            <summary>高级设置</summary>
            <label>
              火山 API Key
              <input type="password" placeholder={appSettings?.keys.volcengine ? "凭证已配置，留空不改" : "凭证未配置"} onBlur={(event) => { if (event.target.value.trim()) void props.onSaveSettings({ volcengineApiKey: event.target.value.trim() }); event.currentTarget.value = ""; }} />
            </label>
            <label>本地项目目录<input value={form.projectPath} onChange={(event) => props.onSetForm({ ...form, projectPath: event.target.value })} /></label>
          </details>
        )}
        {!discussion ? (
          <label>
            本地项目目录
            <input
              value={form.projectPath}
              onChange={(event) => props.onSetForm({ ...form, projectPath: event.target.value })}
            />
          </label>
        ) : (
          <code className="path-readout">{discussion.projectPath}</code>
        )}
      </section>

      {taskMode !== "file" ? <section className="drawer-section">
        <h3>参与者</h3>
        {!discussion ? (
          <div className="participant-editor">
            {form.participants.map((participant, index) => (
              <div className="participant-line" key={participant.id}>
                <label>
                  {`参与人 ${index + 1}`}
                  <input
                    value={participant.displayName}
                    onChange={(event) =>
                      props.onSetForm((current) => ({
                        ...current,
                        participants: updateParticipant(current.participants, participant.id, { displayName: event.target.value })
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={form.participants.length <= 2}
                  onClick={() => props.onSetForm((current) => ({ ...current, participants: removeParticipant(current.participants, participant.id) }))}
                >
                  删除
                </button>
              </div>
            ))}
            <button type="button" className="quiet-button" onClick={() => props.onSetForm((current) => ({ ...current, participants: addParticipant(current.participants) }))}>
              新增参与人
            </button>
          </div>
        ) : (
          <div className="voice-marker-list">
            {discussion.participants.map((participant) => (
              <span key={participant.id}>{participant.displayName}</span>
            ))}
          </div>
        )}
        {discussion && speakerLabels.length > 0 ? (
          <div className="speaker-map">
            <strong>识别到新声音</strong>
            {speakerLabels.map((label) => (
              <div key={label}>
                <span>{humanSpeakerLabel(label)}</span>
                {discussion.participants.map((participant) => (
                  <button type="button" key={participant.id} onClick={() => void props.onBindSpeaker(label, participant)}>
                    标为 {participant.displayName}
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </section> : null}

      {taskMode !== "file" && discussion?.mode === "real" ? (
        <section className="drawer-section">
          <h3>会议转写</h3>
          {discussion.asrProvider === "volcengine" || discussion.asrProvider === "type4me-live" ? (
            <>
              <button
                type="button"
                className={isRecording || isAudioStarting ? "quiet-button live" : "quiet-button"}
                onClick={() => void props.onToggleAudio()}
                disabled={isAudioStarting || isFallbackLoading}
                aria-busy={isAudioStarting}
                aria-pressed={isRecording}
              >
                {isAudioStarting ? "正在请求麦克风…" : isRecording ? "停止实时转写" : "启动实时转写"}
              </button>
              <p>状态：{isAudioStarting ? "等待浏览器麦克风授权" : statusText(asrStatus)}</p>
            </>
          ) : (
            <p>
              {discussion.asrProvider === "volcengine-file"
                ? "当前选择火山录音文件识别 2.0，上传后录音会发送到火山引擎云端。本工作台当前限制 200MB；MP3 分段和完整原始 M4A 直传均已实测。实际双人录音被模型分成 4 组说话人，身份需要人工确认。"
                : discussion.asrProvider === "type4me"
                  ? "当前选择 Type4Me 本地引擎（Qwen3-ASR），录音只在本机识别，自动复用 Type4Me 的热词。"
                  : "当前选择本地 FunASR，使用上传录音文件识别。"}
            </p>
          )}
          <label>
            {isAudioFileUploading ? "正在上传并等待识别，请勿重复操作" : "上传录音文件"}
            <input
              type="file"
              accept="audio/*,video/*"
              disabled={isFallbackLoading || isAudioFileUploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void props.onUploadAudio(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </section>
      ) : null}

      <section className="drawer-section">
        <h3>本地模型</h3>
        <p>下载或继续安装本地语音模型；跳过后也可以在这里重新打开安装向导。</p>
        <button type="button" className="quiet-button" onClick={() => void props.onOpenModelSetup()}>
          打开模型安装向导
        </button>
      </section>

      {props.update ? (
        <section className="drawer-section update-section">
          <h3>自动更新</h3>
          <p>{props.update.status.text}</p>
          <div className="update-section-actions">
            <button
              type="button"
              className="quiet-button"
              disabled={!props.update.status.canCheck}
              onClick={() => props.update?.checkNow()}
            >
              {props.update.checking ? "检查中…" : "检查更新"}
            </button>
            {props.update.status.canInstall ? (
              <button
                type="button"
                className="quiet-button"
                disabled={!props.update.status.canInstall}
                onClick={() => props.update?.install()}
              >
                立即更新
              </button>
            ) : null}
          </div>
          <p className="cloud-notice">更新前会自动把 .local-data/ 备份到同级 backups/ 目录；更新包需通过签名校验才会安装。</p>
        </section>
      ) : null}

      {discussion ? (
        <section className="drawer-section">
          <h3>状态与诊断</h3>
          <button type="button" className="quiet-button" onClick={() => props.onSetDiagnosticsOpen((current) => !current)}>
            {isDiagnosticsOpen || asrStatus === "failed" ? "收起诊断" : "查看诊断"}
          </button>
          {isDiagnosticsOpen || asrStatus === "failed" ? (
            <div className="diagnostics-list">
              {diagnosticItems(asrDiagnostics).map((item) => (
                <span className={item.done ? "done" : ""} key={item.label}>
                  {item.label}
                </span>
              ))}
              {asrDiagnostics.errorMessage ? <p>{asrDiagnostics.errorMessage}</p> : null}
              {asrDiagnostics.retryable ? (
                <button type="button" className="quiet-button" onClick={() => void props.onReconnectAsr()}>
                  重新连接转写
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {taskMode !== "file" ? <section className="drawer-section">
        <h3>实时转写</h3>
        {visibleTimeline.length > 0 ? (
          <div className="transcript-drawer-list">
            {visibleTimeline.map((item) => (
              <p key={item.id}>
                <strong>{timelineLabel(discussion, item)}</strong>
                <span>{timelineText(item)}</span>
              </p>
            ))}
          </div>
        ) : (
          <p>{discussion ? "还没有新的讨论片段。" : "开始说之后，这里会出现完整片段列表。"}</p>
        )}
      </section> : null}

      {discussion && discussion.aiTurns.length > 0 ? (
        <section className="drawer-section">
          <h3>AI 发言反馈</h3>
          {discussion.aiTurns
            .filter(isUsableAiTurn)
            .slice(-4)
            .map((turn) => (
              <div className="feedback-line" key={turn.id}>
                <p>{fragmentPreview(turn.response || "")}</p>
                {turn.status === "truncated" ? <small>本次回复未完整生成</small> : null}
                <button
                  type="button"
                  className={turn.feedbackRating === "useful" ? "selected" : ""}
                  onClick={() => void props.onMarkAiFeedback(turn.id, "useful")}
                >
                  有用/有增量
                </button>
                <button
                  type="button"
                  className={turn.feedbackRating === "bad" ? "selected" : ""}
                  onClick={() => void props.onMarkAiFeedback(turn.id, "bad")}
                >
                  蠢话/没用
                </button>
              </div>
            ))}
        </section>
      ) : null}

      {discussion ? (
        <section className="drawer-section">
          <h3>会后记忆</h3>
          <p>{discussion.customerId ? "草稿必须人工确认后才会进入该客户滚动记忆。" : "先在会前选择客户，才能沉淀客户记忆。"}</p>
          <button type="button" className="quiet-button" disabled={!discussion.customerId || isFallbackLoading} onClick={() => void props.onDraftMemory()}>
            起草记忆
          </button>
          {memoryDraft ? (
            <label>
              记忆草稿
              <textarea
                value={memoryDraftText}
                onChange={(event) => props.onSetMemoryDraftText(event.target.value)}
              />
            </label>
          ) : null}
          {memoryDraft ? (
            <button
              type="button"
              className="quiet-button"
              onClick={() => void props.onConfirmMemory(memoryDraftText)}
            >
              确认入库
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="drawer-section">
        <h3>最近讨论</h3>
        {activeRecentDiscussion ? (
          <button type="button" className="recent-line active" onClick={() => void props.onOpenDiscussion(activeRecentDiscussion.id)}>
            <strong>恢复进行中的讨论</strong>
            <span>{activeRecentDiscussion.topic}</span>
          </button>
        ) : null}
        {recentDiscussions
          .filter((item) => item.id !== activeRecentDiscussion?.id)
          .slice(0, 4)
          .map((item) => (
            <button type="button" className="recent-line" key={item.id} onClick={() => void props.onOpenDiscussion(item.id)}>
              <strong>{item.status === "ended" ? "已结束" : "进行中"}</strong>
              <span>
                {item.topic} · {item.finalUtteranceCount} 片段 · {item.aiTurnCount} 次 Agent
              </span>
            </button>
          ))}
        {recentDiscussions.length === 0 ? <p>暂无历史讨论。</p> : null}
      </section>

      {discussion ? (
        <section className="drawer-section danger-zone">
          <h3>备用操作</h3>
          <p>
            最终转写 {finalUtteranceCount} 条，音频资产 {discussion.audioAssets.length} 个。
          </p>
          {resumeCommand ? (
            <button type="button" className="quiet-button" onClick={() => void props.onCopyCommand(resumeCommand)}>
              {copyStatus === "已复制" ? "已复制续接命令" : "复制续接命令"}
            </button>
          ) : null}
          <a href={discussionMarkdownExportUrl(discussion.id, workspaceScope)}>导出 Markdown</a>
          <a href={discussionPackageExportUrl(discussion.id, workspaceScope)}>导出讨论包</a>
          {discussion.audioAssets.length > 0 ? (
            <button type="button" onClick={() => void props.onDeleteAudio()}>
              删除音频
            </button>
          ) : null}
          <button type="button" className="danger-button" onClick={() => void props.onDeleteDiscussion()}>
            删除讨论
          </button>
        </section>
      ) : null}
    </aside>
  </div>
);
}
