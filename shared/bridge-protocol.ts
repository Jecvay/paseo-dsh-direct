/** The package-owned JSONL boundary. No DSH or Node runtime imports. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export type JsonObject = Record<string, unknown>;
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: JsonObject;
  surfaceOp?: "append" | { op: "replace"; startSeq: number; endSeq: number };
  sourceEventSeqs?: number[];
}
export type DshStreamFrame =
  | {
      type: "start";
      attemptId: string;
      revision: number;
      turn: number;
      step: number;
    }
  | {
      type: "chunk";
      attemptId: string;
      revision: number;
      index: number;
      time: number;
      chunk: JsonObject;
    }
  | {
      type: "end";
      attemptId: string;
      revision: number;
      index: number;
      outcome:
        | { kind: "abandoned" }
        | {
            kind: "committed";
            eventType: "assistant/message" | "assistant/attempt";
            seq: number;
          };
    };
export interface SessionSummary {
  id: string;
  createdAt: number;
  cwd?: string;
  title?: string;
  parentSession?: string;
  agentPreset?: string;
}
export interface SessionSnapshot {
  session: SessionSummary;
  events: DshSessionEvent[];
  inheritedEventCount: number;
}
export interface BridgeCatalog {
  models: Array<{
    id: string;
    provider: string;
    model: string;
    name: string;
    providerName: string;
    reasoningEfforts?: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  }>;
  presets: Array<{ id: string; name?: string; description?: string }>;
  defaultModel?: ModelSelection;
  defaultPreset?: string;
  permissionPresets?: Array<{ id: string; name: string; description?: string }>;
  defaultPermissionPreset?: string;
}
export interface BridgeInitializeResult {
  protocolVersion: 1;
  profile: string;
  capabilities: {
    stream: true;
    approvals: boolean;
    questions: boolean;
    history: true;
    cancel: true;
  };
  catalog: BridgeCatalog;
  /**
   * DSH services or methods the bridge requires that this DSH does not provide,
   * as `service` or `service.method`. Absent or empty when nothing is missing;
   * the plugin refuses to connect otherwise.
   */
  missing?: string[];
}
export interface SessionOpenParams {
  sessionId?: string;
  resume?: boolean;
  cwd: string;
  model?: ModelSelection;
  preset?: string;
  permissionPreset?: string;
  /** Appended to the DSH system prompt for this agent only. */
  systemPrompt?: string;
  /** Tool names approved without asking, e.g. `mcp__paseo__create_agent`. */
  preapprovedTools?: string[];
}
export interface SessionOpenResult {
  sessionId: string;
  cwd: string;
  model?: ModelSelection;
  preset?: string;
  permissionPreset?: string;
  events: DshSessionEvent[];
}
export interface QuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string };
}
export interface QuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}
export interface InteractionRequest {
  sessionId: string;
  requestId: string;
  kind: "approval" | "questions";
  callId?: string;
  toolName?: string;
  reason?: string;
  questions?: QuestionItem[];
}
/** Prompt content; the bridge stores images and files in DSH's attachment store. */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string }
  | { type: "file"; path: string; name?: string };
/** The line DSH parses as a slash command or a skill invocation. */
export function slashLine(name: string, args: string): string {
  return args ? `/${name} ${args}` : `/${name}`;
}
/** One slash entry: a DSH registered command or a user-invocable skill. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "command" | "skill";
}
export interface CommandResult {
  kind: "success" | "error";
  text?: string;
  /** Whether the command left the agent running a model turn. */
  running: boolean;
}
export interface BridgeMethods {
  "bridge.initialize": { params: {}; result: BridgeInitializeResult };
  "session.list": { params: {}; result: { sessions: SessionSummary[] } };
  "session.read": { params: { sessionId: string }; result: SessionSnapshot };
  "session.open": { params: SessionOpenParams; result: SessionOpenResult };
  "session.prompt": {
    params: { sessionId: string; content: PromptPart[] };
    result: { messageId: string };
  };
  "session.steer": {
    params: { sessionId: string; content: PromptPart[] };
    result: { messageId: string };
  };
  "session.configure": {
    params: {
      sessionId: string;
      model?: ModelSelection;
      preset?: string;
      permissionPreset?: string;
    };
    result: {
      model?: ModelSelection;
      preset?: string;
      permissionPreset?: string;
    };
  };
  "session.commands": {
    params: { sessionId: string };
    result: { commands: SlashCommand[] };
  };
  "session.command": {
    params: { sessionId: string; name: string; arguments: string };
    result: CommandResult;
  };
  "session.rename": {
    params: { sessionId: string; title: string };
    result: {};
  };
  "session.cancel": { params: { sessionId: string }; result: {} };
  "session.close": { params: { sessionId: string }; result: {} };
  "interaction.respond": {
    params: {
      requestId: string;
      outcome?: "allowed-once" | "rejected";
      answers?: QuestionAnswer[];
    };
    result: {};
  };
  "bridge.shutdown": { params: {}; result: {} };
}
export interface BridgeNotifications {
  "bridge.ready": { protocolVersion: 1 };
  "session.event": { sessionId: string; event: DshSessionEvent };
  "session.stream": { sessionId: string; frame: DshStreamFrame };
  "session.status": { sessionId: string; status: "idle" | "running" };
  "interaction.request": InteractionRequest;
  "interaction.closed": { requestId: string; sessionId: string };
}
export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: keyof BridgeMethods;
  params?: JsonObject;
}
export type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string };
    };
export type RpcNotification = {
  [K in keyof BridgeNotifications]: {
    jsonrpc: "2.0";
    method: K;
    params: BridgeNotifications[K];
  };
}[keyof BridgeNotifications];
