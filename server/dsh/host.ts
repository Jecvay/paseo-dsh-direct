import type {
  DshSessionEvent,
  DshStreamFrame,
  ModelSelection,
  QuestionAnswer,
  QuestionItem,
  SessionSnapshot,
  SessionSummary,
} from "../../shared/bridge-protocol.js";

/** Structural boundary owned by the installed Harness, never a second DSH runtime. */
export interface HostContext {
  get<K extends keyof HostServices>(name: K): HostServices[K];
  on<K extends keyof HostEvents>(event: K, listener: HostEvents[K]): () => void;
  effect(callback: () => () => void | Promise<void>, label?: string): unknown;
}
export interface HostSession {
  id: string;
  header: SessionSummary;
  snapshotEvents(): DshSessionEvent[];
  requestHeader():
    | {
        config?: ModelSelection;
        adapterDefaults?: { reasoningEffort?: boolean };
      }
    | undefined;
  append(type: string, data: unknown): unknown;
}
export interface HostAgent {
  id: string;
  ctx: HostContext;
  session: HostSession;
  options: ModelSelection;
  status: "idle" | "running";
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(
    reason: { kind: "user" | "disposed" },
    options?: { keepInbox: boolean },
  ): void;
  whenIdle(): Promise<void>;
}
export interface HostHandle {
  agent: HostAgent;
  dispose(): Promise<void>;
}
export interface HostSkills {
  list(options: { cwd?: string; scope?: object }): Promise<
    Array<{
      name: string;
      description: string;
      invocation?: { userInvocable?: boolean };
    }>
  >;
}
interface Preset {
  id: string;
  name?: string;
  description?: string;
  broken?: unknown;
}
interface AgentOptions {
  sessionId?: string;
  resumeSessionId?: string;
  meta?: { cwd: string; agentPreset: string };
  agentOptions: ModelSelection;
  setup(ctx: HostContext, agent: HostAgent): Promise<void>;
}
export interface HostServices {
  agents: {
    get(id: string): HostAgent | undefined;
    create(options: AgentOptions): Promise<HostHandle>;
    resume(options: AgentOptions): Promise<HostHandle>;
  };
  sessionQuery: {
    listSessions(): Promise<Array<{ header: SessionSummary }>>;
    readSession(id: string): Promise<SessionSnapshot>;
    readTitleSnapshots?(
      ids: string[],
    ): Promise<
      Array<
        | { status: "fulfilled"; value: { title?: { title: string } } }
        | { status: "rejected" }
      >
    >;
    observeSession(
      id: string,
      options: { projectionMode: "all" },
    ): Promise<{
      projections?: { values?: { agentPreset?: string | null } };
      [Symbol.dispose](): void;
    }>;
  };
  agentPresets: {
    list(): Promise<Preset[]>;
    resolve(id?: string): Promise<Preset>;
    mount(ctx: HostContext, id: string): Promise<unknown>;
    select(agent: HostAgent, id: string): Promise<string>;
    serviceFor?(agent: HostAgent, name: "skills"): HostSkills | undefined;
    defaultId: string;
  };
  skills: HostSkills | undefined;
  systemPrompt?: {
    section(definition: { name: string; order: number; text: string }): unknown;
  };
  attachments?: {
    saveImage(input: {
      data: Uint8Array;
      mediaType: string;
      name?: string;
    }): Promise<unknown>;
    saveFile(input: { data: Uint8Array; name?: string }): Promise<unknown>;
  };
  llm: {
    listProviders(): Array<{ id: string; name?: string }>;
    listModels(provider: string): Promise<Array<{ id: string; name?: string }>>;
    resolveModelInfo?(
      provider: string,
      model: string,
    ): Promise<{
      inputModalities?: readonly string[];
      reasoning?: {
        efforts?: Array<{ id: string; name: string; description?: string }>;
      };
    }>;
  };
  agentDefaultModel: { currentSelection(): ModelSelection } | undefined;
  /**
   * Projection registry read cut. The `tokenUsage` and `contextPressure` units
   * carry the figures Paseo renders as session usage; absent when the profile
   * mounts no projection registry.
   */
  sessionProjections?: {
    snapshot(
      session: HostSession,
      keys?: readonly string[],
    ): { values: Partial<Record<string, unknown>> };
    /** Change feed: fires once per client-visible unit whose raw view changed. */
    onChanged(
      listener: (
        session: HostSession,
        key: string,
        value: unknown,
        seq: number,
      ) => void,
    ): () => void;
  };
  sessionTitle:
    { rename(session: HostSession, title: string): void } | undefined;
  approval: object | undefined;
  permissionPresets?: {
    readonly names: readonly string[];
    readonly defaultPreset: string;
    optionOf(name: string): {
      value: string;
      name: string;
      description?: string;
    };
    current(session: HostSession): string;
  };
  commands?: {
    list(agent: HostAgent): readonly {
      name: string;
      description: string;
      input?: { hint: string };
    }[];
    execute(
      agent: HostAgent,
      line: string,
      attachments: readonly never[],
      signal: AbortSignal,
    ): Promise<
      | {
          result: { kind: string; text?: string };
        }
      | undefined
    >;
  };
  userQuestions: object | undefined;
  appReady: { onReady(listener: () => void): () => void } | undefined;
  appExit: ((code: number) => void) | undefined;
}
export interface ModelSelectionRef {
  current: ModelSelection | undefined;
  assembled: ModelSelection | undefined;
}
export interface HostHelpers {
  installModelSelection(
    ctx: HostContext,
    selection: ModelSelectionRef,
  ): () => void;
}
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";
export interface HostEvents {
  "session/created": (session: HostSession) => void;
  "session/event": (session: HostSession, event: DshSessionEvent) => void;
  "agent/assistant-stream": (payload: {
    agent: HostAgent;
    frame: DshStreamFrame;
  }) => void;
  "agent/status": (payload: {
    agent: HostAgent;
    status: "idle" | "running";
  }) => void;
  "approval/request": (
    request: {
      agent: HostAgent;
      signal?: AbortSignal;
      toolName: string;
      callId?: string;
      reason?: string;
    },
    next: () => Promise<ApprovalOutcome>,
  ) => Promise<ApprovalOutcome>;
  "user-questions/request": (
    request: {
      agent?: HostAgent;
      signal?: AbortSignal;
      questions: QuestionItem[];
    },
    next: () => Promise<{ answers: QuestionAnswer[] }>,
  ) => Promise<{ answers: QuestionAnswer[] }>;
}
