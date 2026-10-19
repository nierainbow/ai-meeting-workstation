import type {
  AsrProviderType,
  BrainProviderType
} from "../../../shared/types";
import {
  createDefaultParticipants,
  type ParticipantFormItem
} from "./participantForm";
import { defaultCustomerProfile } from "./customerProfile";

export type FormState = {
  background: string;
  customerId: string;
  customerName: string;
  customerProfile: string;
  participants: ParticipantFormItem[];
  projectPath: string;
  asrProvider: AsrProviderType;
  brainProvider: BrainProviderType;
  brainModel: string;
};

export type AsrDiagnostics = {
  micAuthorized: boolean;
  audioSending: boolean;
  asrConnected: boolean;
  asrReceiving: boolean;
  errorMessage?: string;
  retryable: boolean;
};

export type SessionPhase = "ready" | "listening" | "capturing" | "agent-thinking" | "agent-joined" | "handoff-ready" | "handoff-copied";

export const initialFormState: FormState = {
  background: "",
  customerId: "",
  customerName: "",
  customerProfile: defaultCustomerProfile(""),
  participants: createDefaultParticipants(),
  projectPath: ".",
  asrProvider: "volcengine",
  brainProvider: "deepseek",
  brainModel: "deepseek-v4-pro"
};

export const initialAsrDiagnostics: AsrDiagnostics = {
  micAuthorized: false,
  audioSending: false,
  asrConnected: false,
  asrReceiving: false,
  retryable: false
};
