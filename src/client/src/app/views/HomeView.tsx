import { RecentTasks } from "./Home";

export function HomeView(props: {
  recentDiscussions: Parameters<typeof RecentTasks>[0]["items"];
  onOpenDiscussion: (discussionId: string) => Promise<void>;
  isTaskBusy: boolean;
  onSelectTask: (mode: "file" | "live") => void;
}) {
  const { recentDiscussions, onOpenDiscussion, isTaskBusy, onSelectTask } = props;
  return (
    <section className="task-home" aria-label="选择工作任务">
      <header className="task-home-intro">
        <span>AI MEETING WORKSTATION</span>
        <h1>今天要处理哪一种会议？</h1>
        <p>已有录音直接转写；正在开会则进入实时助手。两条流程各自保持清晰。</p>
      </header>
      <div className="task-entry-grid">
        <article className="task-entry-card file-primary">
          <span className="task-index">01 · FILE TRANSCRIPT</span>
          <h2>上传录音转写</h2>
          <p>已有 M4A、MP3、WAV 等录音，上传后生成完整逐字稿。</p>
          <button type="button" disabled={isTaskBusy} onClick={() => onSelectTask("file")}>选择录音文件</button>
          <small>默认推荐火山录音文件识别 2.0；也可以选择本地 FunASR。</small>
        </article>
        <article className="task-entry-card live-secondary">
          <span className="task-index">02 · LIVE MEETING</span>
          <h2>实时会议助手</h2>
          <p>现场录音、实时转写，并可在讨论中邀请 AI 参与。</p>
          <button type="button" disabled={isTaskBusy} onClick={() => onSelectTask("live")}>开始实时会议</button>
          <small>保留会议背景、参与者、麦克风和 AI 参谋。</small>
        </article>
      </div>
      <RecentTasks items={recentDiscussions} onOpen={onOpenDiscussion} />
    </section>
  );
}
