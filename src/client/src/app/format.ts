import type { DiscussionDetailDto, UtteranceDto } from "../../../shared/types";
import type { AsrStatus } from "../../../shared/events";
import { isUsableAiTurnStatus } from "../../../shared/aiTurns";
import { aiTurnDisplayText } from "./errorPresentation";
import { speakerLetter } from "./speaker";
import type { TimelineItem } from "./discussionTimeline";
import type { AsrDiagnostics, SessionPhase } from "./appTypes";

export function sessionPhase(input: {
  copyStatus: string | null;
  discussion: DiscussionDetailDto | null;
  finalUtteranceCount: number;
  isInvitingCodex: boolean;
  isRecording: boolean;
}): SessionPhase {
  if (!input.discussion) return "ready";
  if (input.discussion.status === "ended") return input.copyStatus === "已复制" ? "handoff-copied" : "handoff-ready";
  if (input.isInvitingCodex) return "agent-thinking";
  if (input.discussion.aiTurns.some((turn) => isUsableAiTurnStatus(turn.status))) return "agent-joined";
  if (input.finalUtteranceCount > 0) return "capturing";
  return input.isRecording ? "listening" : "ready";
}

export function phaseLabel(phase: SessionPhase): string {
  const labels: Record<SessionPhase, string> = {
    ready: "准备会议",
    listening: "实时转写中",
    capturing: "会议进行中",
    "agent-thinking": "AI 思考中",
    "agent-joined": "AI 已参与",
    "handoff-ready": "会议已结束",
    "handoff-copied": "上下文已复制"
  };
  return labels[phase];
}

export function statusText(status: AsrStatus): string {
  if (status === "connected" || status === "receiving") return "转写中";
  if (status === "connecting") return "连接中";
  if (status === "failed") return "转写暂不可用";
  if (status === "closed") return "已停止";
  return "待命";
}

export function diagnosticItems(diagnostics: AsrDiagnostics): Array<{ label: string; done: boolean }> {
  return [
    { label: "麦克风已授权", done: diagnostics.micAuthorized },
    { label: "音频发送中", done: diagnostics.audioSending },
    { label: "ASR 已连接", done: diagnostics.asrConnected },
    { label: "已收到 ASR 返回", done: diagnostics.asrReceiving },
    { label: "ASR 异常", done: Boolean(diagnostics.errorMessage) }
  ];
}

export function countFinalUtterancesSinceLastAiTurn(discussion: DiscussionDetailDto): number {
  const finalUtterances = discussion.utterances.filter((utterance) => utterance.isFinal);
  const processedAiTurns = discussion.aiTurns.filter((turn) => isUsableAiTurnStatus(turn.status));
  const lastAiTurn = processedAiTurns.at(-1);
  if (!lastAiTurn) return finalUtterances.length;
  if (lastAiTurn.triggerEndUtteranceId) {
    const boundaryIndex = finalUtterances.findIndex((utterance) => utterance.id === lastAiTurn.triggerEndUtteranceId);
    return boundaryIndex >= 0 ? finalUtterances.slice(boundaryIndex + 1).length : finalUtterances.length;
  }
  if (lastAiTurn.completedAt) {
    const completedAt = lastAiTurn.completedAt;
    return finalUtterances.filter((utterance) => utterance.createdAt > completedAt).length;
  }
  return finalUtterances.length;
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

export function speakerName(discussion: DiscussionDetailDto | null, utterance: UtteranceDto): string {
  const participant = discussion?.participants.find((item) => item.id === utterance.participantId);
  return participant?.displayName ?? humanSpeakerLabel(utterance.speakerLabel);
}

export function speakerBadge(discussion: DiscussionDetailDto | null, utterance: UtteranceDto): string {
  const participant = discussion?.participants.find((item) => item.id === utterance.participantId);
  if (!participant) return speakerLetter(utterance.speakerLabel);
  const genericParticipantMatch = participant.displayName.trim().match(/(?:参与人|说话人)\s*([A-Z])$/i);
  return genericParticipantMatch?.[1]?.toUpperCase() ?? participant.displayName.trim().slice(0, 1);
}

export function humanSpeakerLabel(speakerLabel: string): string {
  return `说话人 ${speakerLetter(speakerLabel)}`;
}

export function timelineLabel(discussion: DiscussionDetailDto | null, item: TimelineItem): string {
  if (item.type === "utterance") return speakerName(discussion, item.utterance);
  if (item.type === "aiTurn") return "Agent";
  return "Agent";
}

export function timelineText(item: TimelineItem): string {
  if (item.type === "utterance") return item.utterance.text;
  if (item.type === "aiTurn") return aiTurnDisplayText(item.aiTurn);
  return "Agent 正在思考...";
}

export function fragmentPreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 88) return normalized;
  return `${normalized.slice(0, 86)}...`;
}

export function formatTimestamp(ms?: number): string {
  if (!ms) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function float32ToPcm16(input: Float32Array, sourceSampleRate: number, targetSampleRate: number): ArrayBuffer {
  const outputLength = Math.max(1, Math.floor((input.length * targetSampleRate) / sourceSampleRate));
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor((index * sourceSampleRate) / targetSampleRate));
    const sample = Math.max(-1, Math.min(1, input[sourceIndex]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return output;
}
