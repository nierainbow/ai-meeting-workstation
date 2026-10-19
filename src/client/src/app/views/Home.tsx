import type { DiscussionSummaryDto } from "../../../../shared/types";
import { isFileAsrProvider } from "../taskMode";

export function RecentTasks(props: {
  items: DiscussionSummaryDto[];
  onOpen: (discussionId: string) => Promise<void>;
}) {
  return (
    <section className="recent-tasks" aria-label="最近任务">
      <div className="recent-tasks-heading"><span>RECENT WORK</span><h2>最近任务</h2></div>
      {props.items.length > 0 ? (
        <div className="recent-task-list">
          {props.items.slice(0, 5).map((item) => (
            <button type="button" key={item.id} onClick={() => void props.onOpen(item.id)}>
              <span className={isFileAsrProvider(item.asrProvider) ? "task-kind file" : "task-kind live"}>{isFileAsrProvider(item.asrProvider) ? "文件转写" : "实时会议"}</span>
              <strong>{item.topic}</strong>
              <small>{item.finalUtteranceCount} 条片段 · {item.status === "ended" ? "已结束" : "进行中"}</small>
            </button>
          ))}
        </div>
      ) : <p>暂无历史任务。完成一次转写或会议后，会从这里直接恢复。</p>}
    </section>
  );
}
