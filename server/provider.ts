import { randomUUID } from "node:crypto";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPermissionRequest,
  type ProviderPermissionResponse,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type {
  BridgeCatalog,
  InteractionRequest,
  ModelSelection,
  QuestionAnswer,
  QuestionItem,
  SessionOpenResult,
  PromptPart,
  SlashCommand,
} from "../shared/bridge-protocol.js";
import { slashLine } from "../shared/bridge-protocol.js";
import type { BridgeMcpServer, DshBridge, SessionLaunch } from "./bridge-client.js";
import { detectDshVersion } from "./dsh-version.js";
import { PLUGIN_VERSION } from "./plugin-version.js";
import { displayText, toPromptParts } from "./prompt-content.js";
import { TimelineProjector } from "./timeline.js";
import { classifyTurnEnd, type TurnTerminal } from "./turn-end.js";
import { objectValue } from "./values.js";
import { matchVersionLine, versionWarningMessage } from "./version-line.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission",
  "permission.tool_policy",
] as const;
const PERMISSION_PRESET_SETTING = "permissionPreset";
const PLAN_MODE_SETTING = "planMode";

interface DshProviderOptions {
  createBridge(launch?: SessionLaunch): Promise<DshBridge>;
  /** Detects the local dsh version for the startup compatibility check; defaults to spawning `<exe> --version`. */
  detectDshVersion?: (executable: string) => Promise<string>;
}

/** A prompt or command RPC in flight; it owns any turn DSH starts before the RPC returns. */
interface Dispatch {
  kind: "prompt" | "command";
  clientMessageId: string;
  sawRunning: boolean;
  /** A terminal DSH reported before the RPC returned. */
  deferred: TurnTerminal | null;
}

interface SessionState {
  paseoId: string;
  nativeId: string;
  config: ProviderSessionConfig;
  open: SessionOpenResult;
  bridge: DshBridge;
  releaseBridgeListeners: Array<() => void>;
  projector: TimelineProjector;
  activeTurnId: string | null;
  cancelRequested: boolean;
  dispatch: Dispatch | null;
  commands: SlashCommand[];
  /** DSH plan mode, from the latest `plan/mode` event. */
  planMode: boolean;
  pendingInteractions: Map<string, InteractionRequest>;
  lane: Promise<void>;
  closed: boolean;
}

export function createDshProvider(options: DshProviderOptions): ProviderRegistration {
  return {
    id: "dsh-pi",
    label: "DeepSeek Harness",
    description: "Direct connection to the local DeepSeek Harness (dsh)",
    icon: "dsh.svg",
    getCatalogCacheKey: async (options) =>
      options.scope === "workspace" ? `dsh-pi:${options.cwd}` : "dsh-pi:global",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      const bridge = await options.createBridge();
      const supported = CAPABILITIES.filter(
        (capability) =>
          capability !== "permission" ||
          bridge.initialized.capabilities.approvals ||
          bridge.initialized.capabilities.questions,
      );
      return createConnection(
        bridge,
        options.createBridge,
        negotiateProviderCapabilities(request.capabilities, supported),
        options.detectDshVersion ?? detectDshVersion,
      );
    },
  };
}

function createConnection(
  discoveryBridge: DshBridge,
  createBridge: DshProviderOptions["createBridge"],
  capabilities: readonly string[],
  detectVersion: (executable: string) => Promise<string>,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, SessionState>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      validateAdmission(input, sessions, capabilities);
      queueMicrotask(() => {
        void dispatch(input, { discoveryBridge, createBridge, sessions, emit, capabilities, detectVersion }).catch(
          (error) => failInput(input, error, emit),
        );
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const bridges = [discoveryBridge];
      for (const session of sessions.values()) {
        session.closed = true;
        session.releaseBridgeListeners.forEach((release) => release());
        bridges.push(session.bridge);
      }
      sessions.clear();
      listeners.clear();
      await Promise.all(bridges.map((bridge) => bridge.close()));
    },
  };
}

function listenToSessionBridge(
  session: SessionState,
  emit: (event: ProviderEvent) => void,
): Array<() => void> {
  const isCurrentSession = (nativeId: string) =>
    !session.closed && nativeId === session.nativeId;

  return [
    session.bridge.on("session.event", ({ sessionId, event }) => {
      if (!isCurrentSession(sessionId)) return;
      // The prompt path emits its own bubble with the clientMessageId.
      if (event.type === "user/message" && session.dispatch?.kind === "prompt") return;
      if (event.type === "turn/start") {
        // A turn nobody dispatched from Paseo: a /goal continuation or a queued
        // follow-up that DSH drains without going idle.
        if (!session.activeTurnId && !session.dispatch) {
          startTurn(session, `dsh-auto-${randomUUID()}`, emit);
        }
        return;
      }
      if (event.type === "turn/end") {
        const terminal = classifyTurnEnd(event.data);
        // Failures reach Paseo through session.turn; other abnormal ends become notices.
        if (terminal.state !== "failed") {
          for (const projected of session.projector.projectEvent(event)) emit(projected);
        }
        // DSH can finish before the prompt or command RPC returns.
        if (!session.activeTurnId && session.dispatch) session.dispatch.deferred = terminal;
        else finishTurn(session, terminal, emit);
        return;
      }
      if (event.type === "plan/mode" && typeof event.data.active === "boolean") {
        if (session.planMode !== event.data.active) {
          session.planMode = event.data.active;
          emitConfig(session, emit);
        }
      }
      if (event.type === "permission/preset" && typeof event.data.preset === "string") {
        // Covers /permission and any other DSH-side preset change.
        if (session.open.permissionPreset !== event.data.preset) {
          session.open = { ...session.open, permissionPreset: event.data.preset };
          emitConfig(session, emit);
        }
      }
      const clientMessageId =
        event.type === "command/run" && session.dispatch?.kind === "command"
          ? session.dispatch.clientMessageId
          : undefined;
      for (const projected of session.projector.projectEvent(event, { clientMessageId })) {
        emit(projected);
      }
    }),
    session.bridge.on("session.stream", ({ sessionId, frame }) => {
      if (!isCurrentSession(sessionId)) return;
      for (const projected of session.projector.projectStream(frame)) emit(projected);
    }),
    session.bridge.on("session.status", ({ sessionId, status }) => {
      if (!isCurrentSession(sessionId)) return;
      if (status === "running") {
        if (session.dispatch) session.dispatch.sawRunning = true;
        return;
      }
      const terminal: TurnTerminal = { state: session.cancelRequested ? "canceled" : "completed" };
      if (session.activeTurnId) finishTurn(session, terminal, emit);
      else if (session.dispatch?.sawRunning && !session.dispatch.deferred) {
        session.dispatch.deferred = terminal;
      }
    }),
    session.bridge.on("interaction.request", (interaction) => {
      if (!isCurrentSession(interaction.sessionId)) return;
      session.pendingInteractions.set(interaction.requestId, interaction);
      emit({
        type: "session.permission",
        sessionId: session.paseoId,
        request: permissionRequest(interaction),
      });
    }),
    session.bridge.on("interaction.closed", ({ requestId, sessionId }) => {
      if (!isCurrentSession(sessionId) || !session.pendingInteractions.delete(requestId)) return;
      emit({
        type: "session.permission_resolved",
        sessionId: session.paseoId,
        permissionId: requestId,
      });
    }),
    session.bridge.onFailure((error) => failSession(session, error, emit)),
  ];
}

function failSession(
  session: SessionState,
  error: Error,
  emit: (event: ProviderEvent) => void,
): void {
  if (session.closed) return;
  session.closed = true;
  session.releaseBridgeListeners.forEach((release) => release());
  for (const permissionId of session.pendingInteractions.keys()) {
    emit({ type: "session.permission_resolved", sessionId: session.paseoId, permissionId });
  }
  session.pendingInteractions.clear();
  for (const projected of session.projector.failRunningTools(error.message)) emit(projected);
  if (session.activeTurnId) {
    emit({
      type: "session.turn",
      sessionId: session.paseoId,
      turnId: session.activeTurnId,
      state: "failed",
      error: { message: error.message },
    });
    session.activeTurnId = null;
  }
  emit({
    type: "session.runtime_failed",
    sessionId: session.paseoId,
    error: { message: error.message },
  });
  void session.bridge.close().catch(() => undefined);
}

interface DispatchState {
  discoveryBridge: DshBridge;
  createBridge: DshProviderOptions["createBridge"];
  sessions: Map<string, SessionState>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
  detectVersion: (executable: string) => Promise<string>;
}

async function dispatch(input: ProviderInput, state: DispatchState): Promise<void> {
  switch (input.type) {
    case "catalog":
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: catalog(state.discoveryBridge.initialized.catalog),
      });
      return;
    case "sessions":
      await listSessions(input, state);
      return;
    case "session.open":
      await openSession(input, state);
      return;
    case "session.prompt":
      await enqueue(requireSession(state.sessions, input.sessionId), () => promptSession(input, state));
      return;
    case "session.interrupt":
      await interruptSession(input, state);
      return;
    case "session.permission":
      await respondToPermission(input, state);
      return;
    case "session.configure":
      await enqueue(requireSession(state.sessions, input.sessionId), () => configureSession(input, state));
      return;
    case "session.close":
      await closeSession(input, state);
      return;
    case "session.archive":
    case "session.unarchive":
    case "session.revert":
      state.emit({
        type: "request.failed",
        requestId: input.requestId,
        error: { message: `${input.type} is not supported` },
      });
  }
}

async function listSessions(
  input: Extract<ProviderInput, { type: "sessions" }>,
  state: DispatchState,
): Promise<void> {
  const result = await state.discoveryBridge.request("session.list", {});
  const query = input.query?.trim().toLowerCase();
  const rows = result.sessions
    .filter((session): session is typeof session & { cwd: string } => Boolean(session.cwd))
    .filter((session) => !input.cwd || session.cwd === input.cwd)
    .filter(
      (session) =>
        !query || session.title?.toLowerCase().includes(query) || session.id.toLowerCase().includes(query),
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const sessions = (input.limit === undefined ? rows : rows.slice(0, input.limit))
    .map((session) => ({
      persistence: persistence(session.id),
      cwd: session.cwd ?? "",
      title: session.title,
      description: session.agentPreset ? `preset: ${session.agentPreset}` : undefined,
      updatedAt: timestamp(session.createdAt),
    }));
  state.emit({ type: "sessions", requestId: input.requestId, sessions });
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: DispatchState,
): Promise<void> {
  validateSessionConfig(input.config);
  const nativeId = persistenceId(input.persistence);
  const bridge = await state.createBridge({
    env: input.config.env,
    ephemeral: !input.config.persist,
    mcpServers: bridgeMcpServers(input.config.mcpServers),
  });
  let session: SessionState | undefined;
  try {
    // Resume from DSH's durable model and preset. Paseo fills catalog defaults into
    // open config, so forwarding them would accidentally overwrite native history.
    const selection = nativeId
      ? undefined
      : selectModel(bridge.initialized.catalog, input.config.model, input.config.thinkingOption);
    const permissionPreset = nativeId
      ? undefined
      : selectedPermissionPreset(input.config.settings, bridge.initialized.catalog);
    const opened = await bridge.request("session.open", {
      ...(nativeId ? { sessionId: nativeId, resume: true } : {}),
      cwd: input.config.cwd,
      ...(selection ? { model: selection } : {}),
      ...(!nativeId && input.config.mode ? { preset: input.config.mode } : {}),
      ...(permissionPreset ? { permissionPreset } : {}),
      ...(input.config.systemPrompt?.trim() ? { systemPrompt: input.config.systemPrompt } : {}),
      ...(input.config.toolPolicy
        ? { preapprovedTools: preapprovedTools(input.config) }
        : {}),
    });
    const title = nativeId ? undefined : input.config.title?.trim();
    const [commands] = await Promise.all([
      fetchCommands(bridge, opened.sessionId),
      title ? bridge.request("session.rename", { sessionId: opened.sessionId, title }) : undefined,
    ]);
    session = {
      paseoId: input.sessionId,
      nativeId: opened.sessionId,
      config: input.config,
      open: opened,
      bridge,
      releaseBridgeListeners: [],
      projector: new TimelineProjector(input.sessionId),
      activeTurnId: null,
      cancelRequested: false,
      dispatch: null,
      commands,
      planMode: latestPlanMode(opened.events),
      pendingInteractions: new Map(),
      lane: Promise.resolve(),
      closed: false,
    };
    state.sessions.set(input.sessionId, session);
    session.releaseBridgeListeners = listenToSessionBridge(session, state.emit);
    if (!nativeId && input.config.settings[PLAN_MODE_SETTING] === true) {
      await setPlanMode(session, true);
    }
  } catch (error) {
    if (session) state.sessions.delete(input.sessionId);
    await bridge.close();
    throw error;
  }
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    // A non-persistent session lives in the bridge's temporary store.
    ...(input.config.persist ? { persistence: persistence(session.nativeId) } : {}),
    cwd: session.open.cwd,
  });
  emitConfig(session, state.emit);
  emitCommands(session, state.emit);
  if (input.history === "replay") {
    for (const event of session.open.events) {
      for (const projected of session.projector.projectEvent(event)) state.emit(projected);
    }
  }
  await warnOnDshVersionMismatch(session, state);
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

/**
 * Compares the detected local dsh version against the plugin's own line
 * (`PLUGIN_VERSION`'s major.minor) and, on a mismatch or an unconfirmed
 * result, posts a timeline warning and logs the same message to stderr.
 * Never blocks the session: DSH's own handshake is what can fail startup.
 */
async function warnOnDshVersionMismatch(session: SessionState, state: DispatchState): Promise<void> {
  const dshVersion = await state.detectVersion(session.bridge.executable).catch(() => "");
  const status = matchVersionLine(PLUGIN_VERSION, dshVersion);
  if (status === "match") return;
  const message = versionWarningMessage(status, PLUGIN_VERSION, dshVersion);
  console.error(`[paseo-dsh-direct] ${message}`);
  state.emit({
    type: "timeline.item",
    sessionId: session.paseoId,
    item: { type: "notification", id: `dsh-version:${session.paseoId}`, level: "warning", message },
  });
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  if (input.prompt.delivery === "steer") {
    if (!session.activeTurnId) {
      emitPromptFailure(input, "There is no active DSH turn to steer", state.emit);
      return;
    }
    if (input.prompt.input.type !== "message") {
      emitPromptFailure(input, "DSH cannot steer with a command", state.emit);
      return;
    }
    await session.bridge.request("session.steer", {
      sessionId: session.nativeId,
      content: toPromptParts(input.prompt.input.content),
    });
    emitPromptResult(input, { type: "steer", turnId: session.activeTurnId }, state.emit);
    return;
  }
  if (session.activeTurnId || session.dispatch) {
    emitPromptFailure(input, "A DSH turn is already running", state.emit);
    return;
  }
  const prompt = input.prompt.input;
  let content: PromptPart[];
  if (prompt.type === "command") {
    const kind = session.commands.find((candidate) => candidate.name === prompt.name)?.kind;
    if (kind !== "skill") return runCommand(session, input, prompt, state.emit);
    // DSH loads a skill body when a user message starts with `/<skill>`.
    content = [{ type: "text", text: slashLine(prompt.name, prompt.arguments) }];
  } else {
    content = toPromptParts(prompt.content);
  }
  const dispatch = beginDispatch(session, "prompt", input.prompt.clientMessageId);
  try {
    const result = await session.bridge.request("session.prompt", { sessionId: session.nativeId, content });
    state.emit({
      type: "timeline.item",
      sessionId: session.paseoId,
      item: {
        type: "user_message",
        id: result.messageId,
        messageId: result.messageId,
        clientMessageId: input.prompt.clientMessageId,
        text: displayText(content),
      },
    });
    acceptTurn(session, input, dispatch, result.messageId, state.emit);
  } catch (error) {
    emitPromptFailure(input, errorMessage(error), state.emit);
  } finally {
    session.dispatch = null;
  }
}

async function runCommand(
  session: SessionState,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  command: { name: string; arguments: string },
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  const dispatch = beginDispatch(session, "command", input.prompt.clientMessageId);
  try {
    // DSH records command/run and command/done; the projector renders both.
    const result = await session.bridge.request("session.command", {
      sessionId: session.nativeId,
      name: command.name,
      arguments: command.arguments,
    });
    if (result.running || dispatch.sawRunning) {
      // The command woke the agent (/goal, /plan): report it as this prompt's turn;
      // finishing the turn refreshes the command list.
      acceptTurn(session, input, dispatch, `dsh-command-${input.prompt.clientMessageId}`, emit);
      return;
    }
    emitPromptResult(input, { type: "completed" }, emit);
  } catch (error) {
    emitPromptFailure(input, errorMessage(error), emit);
    return;
  } finally {
    session.dispatch = null;
  }
  await refreshCommands(session, emit);
}

function beginDispatch(session: SessionState, kind: Dispatch["kind"], clientMessageId: string): Dispatch {
  session.dispatch = { kind, clientMessageId, sawRunning: false, deferred: null };
  return session.dispatch;
}

/** Report the dispatch as a Paseo turn, settling a terminal DSH sent before the RPC returned. */
function acceptTurn(
  session: SessionState,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  dispatch: Dispatch,
  turnId: string,
  emit: (event: ProviderEvent) => void,
): void {
  emitPromptResult(input, { type: "turn", turnId }, emit);
  startTurn(session, turnId, emit);
  if (dispatch.deferred) finishTurn(session, dispatch.deferred, emit);
}

async function fetchCommands(bridge: DshBridge, sessionId: string): Promise<SlashCommand[]> {
  try {
    const { commands } = await bridge.request("session.commands", { sessionId });
    return Array.isArray(commands) ? commands : [];
  } catch {
    return [];
  }
}

async function refreshCommands(
  session: SessionState,
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  const commands = await fetchCommands(session.bridge, session.nativeId);
  if (session.closed || JSON.stringify(commands) === JSON.stringify(session.commands)) return;
  const hadPlan = hasPlanCommand(session);
  session.commands = commands;
  if (hadPlan !== hasPlanCommand(session)) emitConfig(session, emit);
  emitCommands(session, emit);
}

function emitCommands(session: SessionState, emit: (event: ProviderEvent) => void): void {
  emit({
    type: "session.commands",
    sessionId: session.paseoId,
    commands: session.commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })),
  });
}

async function interruptSession(
  input: Extract<ProviderInput, { type: "session.interrupt" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  session.cancelRequested = true;
  await session.bridge.request("session.cancel", { sessionId: session.nativeId });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  if (session.activeTurnId || session.dispatch) {
    state.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: "Wait for the active DSH turn before changing configuration" },
    });
    return;
  }
  validateSettings(input.changes.settings ?? {});
  const source = session.bridge.initialized.catalog;
  const currentModel = modelId(source, session.open.model) ?? session.config.model;
  const currentMode = session.open.preset ?? session.config.mode;
  const currentThinking = session.open.model?.reasoningEffort ?? session.config.thinkingOption;
  const next: ProviderSessionConfig = {
    ...session.config,
    model: nullableChange(input.changes.model, currentModel),
    mode: nullableChange(input.changes.mode, currentMode),
    thinkingOption: nullableChange(input.changes.thinkingOption, currentThinking),
    settings: input.changes.settings
      ? { ...session.config.settings, ...input.changes.settings }
      : session.config.settings,
  };
  const modelChanged =
    input.changes.model !== undefined || input.changes.thinkingOption !== undefined;
  const selection = modelChanged
    ? selectModel(source, next.model, next.thinkingOption)
    : undefined;
  const preset = input.changes.mode === null
    ? source.defaultPreset
    : input.changes.mode;
  const permissionPreset = selectedPermissionPreset(
    input.changes.settings ?? {},
    source,
  );
  const planMode = input.changes.settings?.[PLAN_MODE_SETTING];
  if (typeof planMode === "boolean" && planMode !== session.planMode) {
    await setPlanMode(session, planMode);
  }
  const configured = await session.bridge.request("session.configure", {
    sessionId: session.nativeId,
    ...(selection ? { model: selection } : {}),
    ...(preset ? { preset } : {}),
    ...(permissionPreset ? { permissionPreset } : {}),
  });
  session.config = next;
  session.open = {
    ...session.open,
    model: configured.model,
    preset: configured.preset,
    permissionPreset: configured.permissionPreset,
  };
  emitConfig(session, state.emit);
  state.emit({ type: "request.completed", requestId: input.requestId });
}

async function respondToPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  const interaction = session.pendingInteractions.get(input.permissionId);
  if (!interaction) throw new Error(`Unknown DSH interaction: ${input.permissionId}`);
  const params = interaction.kind === "questions" && input.response.behavior === "allow"
    ? { requestId: input.permissionId, answers: questionAnswers(interaction.questions ?? [], input.response) }
    : {
        requestId: input.permissionId,
        outcome: input.response.behavior === "allow" ? "allowed-once" as const : "rejected" as const,
      };
  await session.bridge.request("interaction.respond", params);
  if (session.pendingInteractions.delete(input.permissionId)) {
    state.emit({
      type: "session.permission_resolved",
      sessionId: session.paseoId,
      permissionId: input.permissionId,
    });
  }
}

async function closeSession(
  input: Extract<ProviderInput, { type: "session.close" }>,
  state: DispatchState,
): Promise<void> {
  const session = requireSession(state.sessions, input.sessionId);
  for (const permissionId of session.pendingInteractions.keys()) {
    state.emit({ type: "session.permission_resolved", sessionId: session.paseoId, permissionId });
  }
  session.pendingInteractions.clear();
  session.closed = true;
  session.releaseBridgeListeners.forEach((release) => release());
  try {
    await session.bridge.request("session.close", { sessionId: session.nativeId });
  } finally {
    try {
      await session.bridge.close();
    } finally {
      state.sessions.delete(input.sessionId);
      if (session.activeTurnId) finishTurn(session, { state: "canceled" }, state.emit);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
    }
  }
  state.emit({ type: "request.completed", requestId: input.requestId });
}

function validateAdmission(
  input: ProviderInput,
  sessions: Map<string, SessionState>,
  capabilities: readonly string[],
): void {
  requireProviderCapabilities(capabilities, input);
  if (input.type === "session.open") {
    if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
    return;
  }
  if ("sessionId" in input && !sessions.has(input.sessionId)) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
}

function validateSessionConfig(config: ProviderSessionConfig): void {
  validateSettings(config.settings);
  const unsupported: string[] = [];
  if (config.providerOptions && Object.keys(config.providerOptions).length > 0) {
    unsupported.push("providerOptions");
  }
  if (unsupported.length > 0) {
    throw new Error(`DSH does not support session config: ${unsupported.join(", ")}`);
  }
}

function emitConfig(session: SessionState, emit: (event: ProviderEvent) => void): void {
  emit({
    type: "session.config",
    sessionId: session.paseoId,
    config: configState(session, session.bridge.initialized.catalog),
  });
}

function hasPlanCommand(session: SessionState): boolean {
  return session.commands.some((command) => command.name === "plan" && command.kind === "command");
}

function latestPlanMode(events: readonly { type: string; data: Record<string, unknown> }[]): boolean {
  const last = events.findLast((event) => event.type === "plan/mode");
  return last?.data.active === true;
}

/** Toggle plan mode through DSH's own `/plan` command, which records `plan/mode`. */
async function setPlanMode(session: SessionState, active: boolean): Promise<void> {
  const result = await session.bridge.request("session.command", {
    sessionId: session.nativeId,
    name: "plan",
    arguments: active ? "" : "off",
  });
  if (result.kind === "error") throw new Error(result.text ?? "DSH /plan failed");
  // Entry can be queued until the next step; reflect the requested state now.
  session.planMode = active;
}

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;

/** Map Paseo MCP servers to dsh-mcp-client entries. */
function bridgeMcpServers(servers: ProviderSessionConfig["mcpServers"]): BridgeMcpServer[] {
  return Object.entries(servers).map(([name, server]): BridgeMcpServer => {
    if (!MCP_SERVER_NAME.test(name)) {
      throw new Error(`DSH MCP server names must match ${String(MCP_SERVER_NAME)}: ${name}`);
    }
    if (server.type === "sse") {
      throw new Error(`DSH supports stdio and streamable HTTP MCP servers, not SSE: ${name}`);
    }
    return server.type === "stdio"
      ? {
          serverName: name,
          transport: "stdio",
          command: server.command,
          ...(server.args ? { args: server.args } : {}),
          ...(server.env ? { env: server.env } : {}),
        }
      : {
          serverName: name,
          transport: "streamable-http",
          url: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
        };
  });
}

/** DSH names MCP tools `mcp__<server>__<tool>`. */
function preapprovedTools(config: ProviderSessionConfig): string[] {
  return (config.toolPolicy?.preapproved ?? []).map((grant) => {
    if (!Object.hasOwn(config.mcpServers, grant.server)) {
      throw new Error(`Tool policy names MCP server '${grant.server}' that is not configured`);
    }
    return `mcp__${grant.server}__${grant.tool}`;
  });
}

const catalogs = new WeakMap<BridgeCatalog, ProviderCatalog>();

/** Paseo view of a bridge catalog; a bridge's catalog never changes, so it is built once. */
function catalog(source: BridgeCatalog): ProviderCatalog {
  let mapped = catalogs.get(source);
  if (!mapped) catalogs.set(source, (mapped = buildCatalog(source)));
  return mapped;
}

function buildCatalog(source: BridgeCatalog): ProviderCatalog {
  const nameCounts = new Map<string, number>();
  for (const model of source.models) nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  return {
    models: source.models.map((model) => ({
      id: model.id,
      // The provider goes in the description; the label names it only to tell same-named models apart.
      label: nameCounts.get(model.name)! > 1 ? `${model.name} (${model.providerName})` : model.name,
      description: model.providerName,
      metadata: { provider: model.provider, model: model.model },
      thinkingOptions: model.reasoningEfforts?.map((effort) => ({
        id: effort.id,
        label: effort.name,
        description: effort.description,
        isDefault: effort.id === source.defaultModel?.reasoningEffort,
      })),
      defaultThinkingOptionId:
        model.provider === source.defaultModel?.provider && model.model === source.defaultModel.model
          ? source.defaultModel.reasoningEffort
          : undefined,
    })),
    modes: source.presets.map((preset) => ({
      id: preset.id,
      label: preset.name ?? preset.id,
      description: preset.description,
    })),
    defaultModel: source.models.find(
      (model) =>
        source.defaultModel &&
        model.provider === source.defaultModel.provider &&
        model.model === source.defaultModel.model,
    )?.id,
    defaultMode: source.defaultPreset,
  };
}

function configState(session: SessionState, source: BridgeCatalog): ProviderConfigState {
  const available = catalog(source);
  const thinking = session.open.model?.reasoningEffort ?? session.config.thinkingOption;
  const selectedModelId = modelId(source, session.open.model) ?? session.config.model;
  return {
    model: selectedModelId,
    mode: session.open.preset ?? session.config.mode,
    thinkingOption: thinking,
    models: available.models,
    modes: available.modes,
    thinkingOptions:
      source.models
        .find((model) => model.id === selectedModelId)
        ?.reasoningEfforts?.map((effort) => ({
          id: effort.id,
          label: effort.name,
          description: effort.description,
          isDefault: effort.id === thinking,
        })) ?? [],
    settings: [
      ...(source.permissionPresets?.length
        ? [
            {
              type: "select" as const,
              id: PERMISSION_PRESET_SETTING,
              label: "Permissions",
              description: "DSH permission and sandbox preset for this session",
              value: session.open.permissionPreset ?? source.defaultPermissionPreset ?? null,
              options: source.permissionPresets.map((preset) => ({
                label: preset.name,
                value: preset.id,
              })),
            },
          ]
        : []),
      ...(hasPlanCommand(session)
        ? [
            {
              type: "toggle" as const,
              id: PLAN_MODE_SETTING,
              label: "Plan mode",
              description: "DSH plan mode: explore and propose a plan before editing",
              value: session.planMode,
            },
          ]
        : []),
    ],
  };
}

function modelId(source: BridgeCatalog, selection?: ModelSelection): string | undefined {
  return source.models.find(
    (model) =>
      selection &&
      model.provider === selection.provider &&
      model.model === selection.model,
  )?.id;
}

function validateSettings(settings: Readonly<Record<string, unknown>>): void {
  const unsupported = Object.keys(settings).filter(
    (key) => key !== PERMISSION_PRESET_SETTING && key !== PLAN_MODE_SETTING,
  );
  if (unsupported.length > 0) {
    throw new Error(`DSH does not support session settings: ${unsupported.join(", ")}`);
  }
  const value = settings[PERMISSION_PRESET_SETTING];
  if (value !== undefined && typeof value !== "string") {
    throw new Error("DSH permissionPreset must be a string");
  }
  const plan = settings[PLAN_MODE_SETTING];
  if (plan !== undefined && typeof plan !== "boolean") {
    throw new Error("DSH planMode must be a boolean");
  }
}

function selectedPermissionPreset(
  settings: Readonly<Record<string, unknown>>,
  source: BridgeCatalog,
): string | undefined {
  const value = settings[PERMISSION_PRESET_SETTING];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("DSH permissionPreset must be a string");
  if (!source.permissionPresets?.some((preset) => preset.id === value)) {
    throw new Error(`Unknown DSH permission preset: ${value}`);
  }
  return value;
}

function selectModel(
  source: BridgeCatalog,
  modelId?: string,
  reasoningEffort?: string,
): ModelSelection | undefined {
  const model = source.models.find((candidate) => candidate.id === modelId);
  const base = model
    ? { provider: model.provider, model: model.model }
    : source.defaultModel;
  return base ? { ...base, ...(reasoningEffort ? { reasoningEffort } : {}) } : undefined;
}

function permissionRequest(interaction: InteractionRequest): ProviderPermissionRequest {
  if (interaction.kind === "questions") {
    return {
      id: interaction.requestId,
      name: "question",
      kind: "question" as const,
      title: "DeepSeek Harness question",
      input: {
        questions: (interaction.questions ?? []).map((question) => ({
          question: question.question,
          header: question.header ?? question.id,
          options: question.options ?? [],
          multiSelect: question.multiSelect ?? false,
          allowOther: true,
        })),
      },
    };
  }
  return {
    id: interaction.requestId,
    name: interaction.toolName ?? "tool",
    kind: "tool" as const,
    title: interaction.toolName ? `Allow ${interaction.toolName}?` : "Allow tool?",
    description: interaction.reason,
    input: { callId: interaction.callId ?? "" },
    actions: [
      { id: "allow-once", label: "Allow once", behavior: "allow" as const, variant: "primary" as const },
      { id: "reject", label: "Reject", behavior: "deny" as const, variant: "secondary" as const },
    ],
  };
}

function questionAnswers(
  questions: QuestionItem[],
  response: Extract<ProviderPermissionResponse, { behavior: "allow" }>,
): QuestionAnswer[] {
  const answers = objectValue(response.updatedInput?.answers);
  return questions.map((question) => {
    const key = question.header ?? question.id;
    const raw = answers?.[key];
    const selected = typeof raw === "string" ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
    const known = new Set((question.options ?? []).map((option) => option.label));
    const custom = selected.find((value) => !known.has(value));
    return {
      id: question.id,
      selected: selected.filter((value) => known.has(value)),
      ...(custom ? { custom } : {}),
    };
  });
}

function startTurn(
  session: SessionState,
  turnId: string,
  emit: (event: ProviderEvent) => void,
): void {
  session.activeTurnId = turnId;
  session.cancelRequested = false;
  emit({ type: "session.turn", sessionId: session.paseoId, turnId, state: "started" });
}

function finishTurn(
  session: SessionState,
  terminal: TurnTerminal,
  emit: (event: ProviderEvent) => void,
): void {
  const turnId = session.activeTurnId;
  if (!turnId) return;
  emit({
    type: "session.turn",
    sessionId: session.paseoId,
    turnId,
    state: terminal.state,
    ...(terminal.state === "failed"
      ? { error: terminal.error ?? { message: "DSH turn failed" } }
      : {}),
  });
  session.activeTurnId = null;
  session.cancelRequested = false;
  void refreshCommands(session, emit);
}

function persistence(sessionId: string) {
  return { version: 1, data: { dshSessionId: sessionId } } as const;
}

function persistenceId(
  value: Extract<ProviderInput, { type: "session.open" }>["persistence"],
): string | undefined {
  if (!value) return undefined;
  if (value.version !== 1) throw new Error(`Unsupported DSH persistence version ${value.version}`);
  const data = objectValue(value.data);
  const id = data?.dshSessionId;
  if (typeof id !== "string" || !id) throw new Error("Invalid DSH persistence handle");
  return id;
}

function enqueue(session: SessionState, operation: () => Promise<void>): Promise<void> {
  session.lane = session.lane.then(operation, operation);
  return session.lane;
}

function requireSession(sessions: Map<string, SessionState>, sessionId: string): SessionState {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function failInput(input: ProviderInput, error: unknown, emit: (event: ProviderEvent) => void): void {
  if (input.type === "session.prompt") {
    emitPromptFailure(input, errorMessage(error), emit);
  } else if ("requestId" in input) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: errorMessage(error) },
    });
  }
}

function emitPromptResult(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  result: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"],
  emit: (event: ProviderEvent) => void,
): void {
  emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result,
  });
}

function emitPromptFailure(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  message: string,
  emit: (event: ProviderEvent) => void,
): void {
  emitPromptResult(input, { type: "failed", error: { message } }, emit);
}

function nullableChange(value: string | null | undefined, current: string | undefined): string | undefined {
  return value === null ? undefined : value ?? current;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value: number): string {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
}
