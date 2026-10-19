import type { DiscussionDetailDto } from "../../../shared/types";
import { aiTurnSystemNotice } from "./errorPresentation";
import { formatClock, formatTimestamp, speakerBadge, speakerName } from "./format";
import { speakerTone } from "./speaker";
import type { TimelineItem } from "./discussionTimeline";

export function ConversationEntry(props: {
  discussion: DiscussionDetailDto | null;
  item: TimelineItem;
}) {
  const { discussion, item } = props;
  if (item.type === "utterance") {
    const name = speakerName(discussion, item.utterance);
    const badge = speakerBadge(discussion, item.utterance);
    const tone = speakerTone(item.utterance.speakerLabel);
    return (
      <article className={`conversation-entry human speaker-tone-${tone} ${item.utterance.isFinal ? "final" : "interim"}`}>
        <span className="speaker-avatar" aria-hidden="true">{badge}</span>
        <div className="message-card">
          <header>
            <strong>{name}</strong>
            <time>{formatTimestamp(item.utterance.startMs)}</time>
          </header>
          <p>{item.utterance.text}</p>
          {!item.utterance.isFinal ? <small>正在识别…</small> : null}
        </div>
      </article>
    );
  }

  if (item.type === "aiTurn") {
    const systemNotice = aiTurnSystemNotice(item.aiTurn.status);
    return (
      <article className="conversation-entry ai">
        <span className="speaker-avatar ai-avatar" aria-hidden="true">AI</span>
        <div className="message-card">
          <header>
            <strong>AI 会议参谋</strong>
            <time>{formatClock(item.aiTurn.completedAt ?? item.aiTurn.createdAt)}</time>
          </header>
          <p>{item.aiTurn.response ?? "本轮分析已完成。"}</p>
          {systemNotice ? <aside className="ai-response-system-note" role="note">{systemNotice}</aside> : null}
        </div>
      </article>
    );
  }

  return (
    <article className="conversation-entry ai thinking">
      <span className="speaker-avatar ai-avatar" aria-hidden="true">AI</span>
      <div className="message-card">
        <header>
          <strong>AI 会议参谋</strong>
          <time>分析中</time>
        </header>
        <p>正在把最近片段组织成可推进的上下文。</p>
      </div>
    </article>
  );
}
