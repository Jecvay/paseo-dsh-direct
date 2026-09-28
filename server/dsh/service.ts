import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type {
  BridgeCatalog,
  BridgeInitializeResult,
  BridgeMethods,
  BridgeNotifications,
  DshSessionEvent,
  InteractionRequest,
  ModelSelection,
  QuestionAnswer,
  QuestionItem,
  SessionOpenParams,
  SessionOpenResult,
  SessionSummary,
  PromptPart,
  SlashCommand,
} from "../../shared/bridge-protocol.js";
import { slashLine } from "../../shared/bridge-protocol.js";
import type {
  ApprovalOutcome,
  HostAgent,
  HostContext,
  HostHandle,
  HostHelpers,
  ModelSelectionRef,
} from "./host.js";

type Notify = <K extends keyof BridgeNotifications>(
  method: K,
  params: BridgeNotifications[K],
) => void;
interface PendingInteraction {
  request: InteractionRequest;
  finish(value?: ApprovalOutcome | { answers: QuestionAnswer[] }): void;
}
interface RecordEntry {
  handle: HostHandle;
  model?: ModelSelection;
  preset?: string;
  selection: ModelSelectionRef;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a nonempty string`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function selection(input: unknown): ModelSelection | undefined {
  const value = record(input);
  if (
    typeof value.provider !== "string" ||
    !value.provider ||
    typeof value.model !== "string" ||
    !value.model
  )
    return;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === "string"
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  };
}
/** Restore the durable pending selection, falling back to the last request route. */
export function savedModel(
  events: DshSessionEvent[],
): ModelSelection | undefined {
  let pending: ModelSelection | undefined;
  let used: ModelSelection | undefined;
  for (const event of events) {
    if (event.type === "model/selection")
      pending = selection(event.data) ?? pending;
    if (event.type !== "request/header") continue;
    const header = record(event.data.header);
    const raw = selection(header.config);
    if (raw) {
      used =
        record(header.adapterDefaults).reasoningEffort === true
          ? { provider: raw.provider, model: raw.model }
          : raw;
      if (pending && JSON.stringify(raw) === JSON.stringify(pending))
        pending = undefined;
    }
  }
  return pending ?? used;
}

export class BridgeService {
  private readonly owned = new Map<string, RecordEntry>();
  private readonly opening = new Map<string, Promise<SessionOpenResult>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly tracked = new Set<string>();
  private readonly parent = new Map<string, string>();
  private readonly commandAborts = new Map<string, AbortController>();
  private readonly preapproved = new Map<string, ReadonlySet<string>>();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly subscriptions: Array<() => void> = [];
  private stopping = false;
  private stopTask?: Promise<{}>;

  constructor(
    private readonly ctx: HostContext,
    private readonly notify: Notify,
    private readonly profile = "paseo",
    private readonly helpers?: HostHelpers,
  ) {
    this.subscriptions.push(
      ctx.on("session/created", (session) => {
        if (session.header.parentSession)
          this.parent.set(
            String(session.id),
            String(session.header.parentSession),
          );
      }),
    );
    this.subscriptions.push(
      ctx.on("session/event", (session, event) => {
        if (this.tracked.has(String(session.id)))
          notify("session.event", { sessionId: String(session.id), event });
      }),
    );
    this.subscriptions.push(
      ctx.on("agent/assistant-stream", ({ agent, frame }) => {
        if (this.tracked.has(String(agent.id)))
          notify("session.stream", { sessionId: String(agent.id), frame });
      }),
    );
    this.subscriptions.push(
      ctx.on("agent/status", ({ agent, status }) => {
        if (this.tracked.has(String(agent.id)))
          notify("session.status", { sessionId: String(agent.id), status });
      }),
    );
    this.subscriptions.push(
      ctx.on("approval/request", (request, next) => {
        const sessionId = this.rootFor(request.agent);
        if (!sessionId) return next();
        if (this.preapproved.get(sessionId)?.has(request.toolName))
          return Promise.resolve("allowed-once" as const);
        return this.ask(
          {
            sessionId,
            requestId: randomUUID(),
            kind: "approval",
            toolName: request.toolName,
            callId: request.callId,
            reason: request.reason,
          },
          request.signal,
        ).then((value) => {
          if (typeof value !== "string")
            throw new Error("Unexpected approval response");
          return value;
        });
      }),
    );
    this.subscriptions.push(
      ctx.on("user-questions/request", (request, next) => {
        const sessionId = this.rootFor(request.agent);
        if (!sessionId) return next();
        return this.ask(
          {
            sessionId,
            requestId: randomUUID(),
            kind: "questions",
            questions: request.questions,
          },
          request.signal,
        ).then((value) => {
          if (typeof value === "string")
            throw new Error("Unexpected question response");
          return value;
        });
      }),
    );
  }

  private rootFor(agent: HostAgent | undefined): string | undefined {
    let id = agent?.id && String(agent.id);
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      if (this.tracked.has(id)) return id;
      seen.add(id);
      id =
        this.parent.get(id) ??
        (id === agent?.id ? agent.session.header.parentSession : undefined);
    }
    return undefined;
  }

  private ask(
    request: InteractionRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome | { answers: QuestionAnswer[] }> {
    if (
      signal?.aborted ||
      this.stopping ||
      this.closing.has(request.sessionId)
    ) {
      return request.kind === "approval"
        ? Promise.resolve("cancelled")
        : Promise.reject(new Error("Question cancelled"));
    }
    return new Promise((resolve, reject) => {
      const abort = () => finish();
      const finish = (
        value?: ApprovalOutcome | { answers: QuestionAnswer[] },
      ) => {
        if (!this.interactions.delete(request.requestId)) return;
        signal?.removeEventListener("abort", abort);
        this.notify("interaction.closed", {
          requestId: request.requestId,
          sessionId: request.sessionId,
        });
        if (value !== undefined) resolve(value);
        else if (request.kind === "approval") resolve("cancelled");
        else reject(new Error("Question cancelled"));
      };
      this.interactions.set(request.requestId, { request, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.notify("interaction.request", request);
    });
  }

  async catalog(): Promise<BridgeCatalog> {
    const llm = this.ctx.get("llm");
    const presets = this.ctx.get("agentPresets");
    const permission = this.ctx.get("permissionPresets");
    const models: BridgeCatalog["models"] = [];
    const defaultModel = selection(
      this.ctx.get("agentDefaultModel")?.currentSelection(),
    );
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          let reasoningEfforts: BridgeCatalog["models"][number]["reasoningEfforts"];
          try {
            reasoningEfforts = (
              await llm.resolveModelInfo?.(provider.id, model.id)
            )?.reasoning?.efforts;
          } catch {
            /* Optional capability discovery may be unavailable for this route. */
          }
          models.push({
            id: `${provider.id}/${model.id}`,
            provider: provider.id,
            model: model.id,
            name: model.name ?? model.id,
            providerName: provider.name ?? provider.id,
            reasoningEfforts,
          });
        }
      } catch {
        /* One unconfigured provider must not hide the other configured routes. */
      }
    }
    if (
      defaultModel &&
      !models.some(
        (model) =>
          model.provider === defaultModel.provider &&
          model.model === defaultModel.model,
      )
    ) {
      models.push({
        id: `${defaultModel.provider}/${defaultModel.model}`,
        ...defaultModel,
        name: defaultModel.model,
        providerName: defaultModel.provider,
      });
    }
    return {
      models,
      presets: (await presets.list())
        .filter((preset) => !preset.broken)
        .map((preset) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
        })),
      defaultModel,
      defaultPreset: presets.defaultId,
      ...(permission && this.ctx.get("commands")
        ? {
            permissionPresets: permission.names.map((id) => {
              const option = permission.optionOf(id);
              return {
                id,
                name: option.name,
                ...(option.description
                  ? { description: option.description }
                  : {}),
              };
            }),
            defaultPermissionPreset: permission.defaultPreset,
          }
        : {}),
    };
  }

  async handle<K extends keyof BridgeMethods>(
    method: K,
    input: unknown = {},
  ): Promise<BridgeMethods[K]["result"]> {
    if (this.stopping && method !== "bridge.shutdown")
      throw new Error("Bridge is shutting down");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Method params must be an object");
    const params = record(input);
    let result: unknown;
    switch (method) {
      case "bridge.initialize":
        result = {
          protocolVersion: 1,
          profile: this.profile,
          capabilities: {
            stream: true,
            approvals: Boolean(this.ctx.get("approval")),
            questions: Boolean(this.ctx.get("userQuestions")),
            history: true,
            cancel: true,
          },
          catalog: await this.catalog(),
        } satisfies BridgeInitializeResult;
        break;
      case "session.list": {
        const query = this.ctx.get("sessionQuery");
        const records = await query.listSessions();
        const sessions: SessionSummary[] = records.map((record) => ({
          ...record.header,
        }));
        // The official bulk title read owns live/cold source and validation.
        if (typeof query.readTitleSnapshots === "function") {
          const titles = await query.readTitleSnapshots(
            sessions.map((session) => session.id),
          );
          for (let i = 0; i < sessions.length; i++) {
            const result = titles[i];
            const title =
              result?.status === "fulfilled"
                ? result.value.title?.title
                : undefined;
            if (typeof title === "string") sessions[i]!.title = title;
          }
        }
        result = { sessions };
        break;
      }
      case "session.read":
        result = await this.ctx
          .get("sessionQuery")
          .readSession(nonempty(params.sessionId, "sessionId"));
        break;
      case "session.open":
        result = await this.open(validateOpen(params));
        break;
      case "session.prompt":
      case "session.steer": {
        const agent = this.agent(params.sessionId);
        const content = await this.admitContent(agent, validateContent(params.content));
        const id = randomUUID();
        const message = Object.freeze({
          id,
          role: "user",
          source: Object.freeze({ kind: "user" }),
          content: Object.freeze(content),
        });
        if (method === "session.steer") agent.steer(message);
        else agent.followup(message);
        result = { messageId: id };
        break;
      }
      case "session.configure": {
        const agent = this.agent(params.sessionId);
        const entry = this.owned.get(String(agent.id))!;
        if (agent.status !== "idle")
          throw new Error("Configuration requires an idle session");
        const model =
          params.model === undefined ? undefined : validateModel(params.model);
        const preset =
          params.preset === undefined
            ? undefined
            : nonempty(params.preset, "preset");
        const permissionPreset =
          params.permissionPreset === undefined
            ? undefined
            : nonempty(params.permissionPreset, "permissionPreset");
        if (model && !this.helpers)
          throw new Error(
            "Model switching is unavailable in this Harness runtime",
          );
        if (preset)
          entry.preset = await this.ctx
            .get("agentPresets")
            .select(agent, preset);
        if (model) {
          agent.session.append("model/selection", model);
          entry.selection.current = model;
          entry.model = model;
        }
        if (permissionPreset)
          await this.setPermissionPreset(agent, permissionPreset);
        result = {
          model: entry.model,
          preset: entry.preset,
          permissionPreset: this.ctx
            .get("permissionPresets")
            ?.current(agent.session),
        };
        break;
      }
      case "session.commands":
        result = { commands: await this.slashCommands(this.agent(params.sessionId)) };
        break;
      case "session.command":
        result = await this.runCommand(
          this.agent(params.sessionId),
          nonempty(params.name, "name"),
          typeof params.arguments === "string" ? params.arguments : "",
        );
        break;
      case "session.rename": {
        const agent = this.agent(params.sessionId);
        const titles = this.ctx.get("sessionTitle");
        if (!titles)
          throw new Error("Session titles are unavailable in this profile");
        titles.rename(agent.session, nonempty(params.title, "title"));
        result = {};
        break;
      }
      case "session.cancel":
        this.commandAborts.get(nonempty(params.sessionId, "sessionId"))?.abort();
        this.agent(params.sessionId).cancel(
          { kind: "user" },
          { keepInbox: false },
        );
        result = {};
        break;
      case "session.close":
        await this.close(nonempty(params.sessionId, "sessionId"));
        result = {};
        break;
      case "interaction.respond":
        this.respond(params);
        result = {};
        break;
      case "bridge.shutdown":
        result = await this.shutdown();
        break;
      default:
        throw new Error(`Unsupported bridge method: ${String(method)}`);
    }
    return result as BridgeMethods[K]["result"];
  }

  /** Store images and files as durable DSH attachments, in prompt order. */
  private async admitContent(
    agent: HostAgent,
    parts: PromptPart[],
  ): Promise<object[]> {
    if (parts.some((part) => part.type === "image")) {
      const model = this.owned.get(String(agent.id))?.model;
      const info = model
        ? await this.ctx.get("llm").resolveModelInfo?.(model.provider, model.model)
        : undefined;
      if (info?.inputModalities && !info.inputModalities.includes("image"))
        throw new Error(`Model "${model!.model}" does not support image input`);
    }
    const attachments = () => {
      const service = this.ctx.get("attachments");
      if (!service) throw new Error("Attachments are unavailable in this profile");
      return service;
    };
    // Stores are independent; Promise.all keeps prompt order.
    return Promise.all(
      parts.map(async (part) => {
        if (part.type === "text") return Object.freeze({ type: "text", text: part.text });
        if (part.type === "image") {
          const attachment = await attachments().saveImage({
            data: Buffer.from(part.data, "base64"),
            mediaType: part.mediaType,
            ...(part.name ? { name: part.name } : {}),
          });
          return Object.freeze({ type: "image", attachment });
        }
        const attachment = await attachments().saveFile({
          data: await readFile(part.path),
          name: part.name ?? basename(part.path),
        });
        return Object.freeze({ type: "file", attachment });
      }),
    );
  }

  /** Registered commands first; a skill never shadows a command of the same name. */
  private async slashCommands(agent: HostAgent): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = (this.ctx.get("commands")?.list(agent) ?? []).map(
      (command) => ({
        name: command.name,
        description: command.description,
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
        kind: "command" as const,
      }),
    );
    const taken = new Set(commands.map((command) => command.name));
    const registry =
      this.ctx.get("agentPresets").serviceFor?.(agent, "skills") ??
      this.ctx.get("skills");
    let skills: SlashCommand[] = [];
    try {
      skills = (
        (await registry?.list({
          cwd: agent.session.header.cwd,
          scope: agent,
        })) ?? []
      )
        .filter(
          (skill) =>
            skill.invocation?.userInvocable === true &&
            typeof skill.name === "string" &&
            !taken.has(skill.name),
        )
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          kind: "skill" as const,
        }));
    } catch {
      // A failed skill read degrades to commands only.
    }
    return [...commands, ...skills].sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
  }

  private async runCommand(
    agent: HostAgent,
    name: string,
    args: string,
  ): Promise<BridgeMethods["session.command"]["result"]> {
    const commands = this.ctx.get("commands");
    if (!commands) throw new Error("Commands are unavailable in this profile");
    const sessionId = String(agent.id);
    if (this.commandAborts.has(sessionId))
      throw new Error("A DSH command is already running");
    const abort = new AbortController();
    this.commandAborts.set(sessionId, abort);
    try {
      const execution = await commands.execute(
        agent,
        slashLine(name, args),
        [],
        abort.signal,
      );
      if (!execution) throw new Error(`Unknown DSH command: /${name}`);
      // Handlers such as /goal and /plan wake the agent; let that settle first.
      await new Promise((resolve) => setImmediate(resolve));
      return {
        kind: execution.result.kind === "success" ? "success" : "error",
        ...(execution.result.text ? { text: execution.result.text } : {}),
        running: agent.status === "running",
      };
    } finally {
      this.commandAborts.delete(sessionId);
    }
  }

  private agent(id: unknown): HostAgent {
    const sessionId = nonempty(id, "sessionId");
    const agent = this.owned.get(sessionId)?.handle.agent;
    if (
      !agent ||
      this.closing.has(sessionId) ||
      this.ctx.get("agents").get(sessionId) !== agent
    )
      throw new Error("Session is not open in this bridge");
    return agent;
  }

  private open(params: SessionOpenParams): Promise<SessionOpenResult> {
    const id =
      params.sessionId === undefined
        ? randomUUID()
        : nonempty(params.sessionId, "sessionId");
    if (params.resume && params.sessionId === undefined)
      return Promise.reject(new Error("Resume requires sessionId"));
    if (this.owned.has(id) || this.opening.has(id) || this.closing.has(id))
      return Promise.reject(
        new Error("Session already open or changing ownership"),
      );
    if (!isAbsolute(nonempty(params.cwd, "cwd")))
      return Promise.reject(new Error("cwd must be absolute"));
    if (params.model !== undefined && selection(params.model) === undefined)
      return Promise.reject(new Error("Invalid model selection"));
    this.tracked.add(id);
    if (params.preapprovedTools?.length)
      this.preapproved.set(id, new Set(params.preapprovedTools));
    const task = this.performOpen(id, params);
    this.opening.set(id, task);
    void task.then(
      () => this.opening.delete(id),
      () => {
        this.opening.delete(id);
        this.tracked.delete(id);
        this.preapproved.delete(id);
      },
    );
    return task;
  }

  private async performOpen(
    id: string,
    params: SessionOpenParams,
  ): Promise<SessionOpenResult> {
    const query = this.ctx.get("sessionQuery");
    const presets = this.ctx.get("agentPresets");
    let savedPreset: string | undefined;
    let historical: DshSessionEvent[] = [];
    if (params.resume) {
      // Reading neither acquires a writer nor drives a model request.
      const observation = await query.observeSession(id, {
        projectionMode: "all",
      });
      try {
        savedPreset = observation.projections?.values?.agentPreset ?? undefined;
      } finally {
        observation[Symbol.dispose]();
      }
      historical = (await query.readSession(id)).events;
      if (params.preset && params.preset !== savedPreset)
        throw new Error("A resumed session must retain its recorded preset");
    }
    const preset = await presets.resolve(savedPreset ?? params.preset);
    const model =
      selection(params.model) ??
      savedModel(historical) ??
      selection(this.ctx.get("agentDefaultModel")?.currentSelection());
    if (!model) throw new Error("Profile has no configured default model");
    const modelRef: ModelSelectionRef = {
      current: model,
      assembled: undefined,
    };
    const setup = async (agentCtx: HostContext) => {
      this.helpers?.installModelSelection(agentCtx, modelRef);
      await presets.mount(agentCtx, preset.id);
      if (params.systemPrompt) {
        const systemPrompt = agentCtx.get("systemPrompt");
        if (!systemPrompt)
          throw new Error("System prompt sections are unavailable in this profile");
        // Agent-scoped, after first-party guidance and before the persona suffix (10200).
        systemPrompt.section({ name: "paseo:system-prompt", order: 10100, text: params.systemPrompt });
      }
    };
    // The official factory owns cross-process SessionWriteLease flock arbitration.
    const handle: HostHandle = params.resume
      ? await this.ctx
          .get("agents")
          .resume({ resumeSessionId: id, agentOptions: model, setup })
      : await this.ctx.get("agents").create({
          sessionId: id,
          meta: { cwd: params.cwd, agentPreset: preset.id },
          agentOptions: model,
          setup,
        });
    try {
      if (this.stopping) throw new Error("Bridge is shutting down");
      if (params.model) handle.agent.session.append("model/selection", model);
      if (params.permissionPreset)
        await this.setPermissionPreset(handle.agent, params.permissionPreset);
      this.owned.set(id, {
        handle,
        model,
        preset: preset.id,
        selection: modelRef,
      });
      return {
        sessionId: id,
        cwd: handle.agent.session.header.cwd ?? params.cwd,
        model,
        preset: preset.id,
        permissionPreset: this.ctx
          .get("permissionPresets")
          ?.current(handle.agent.session),
        events: handle.agent.session.snapshotEvents(),
      };
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  private async setPermissionPreset(
    agent: HostAgent,
    preset: string,
  ): Promise<void> {
    const permission = this.ctx.get("permissionPresets");
    const commands = this.ctx.get("commands");
    if (!permission || !commands)
      throw new Error("Permission presets are unavailable in this profile");
    if (!permission.names.includes(preset))
      throw new Error("Unknown permission preset");

    // Use the official live /permission command, as DSH's own surfaces do. It writes session-owned
    // permission/sandbox/approval events and queues the policy-change notice;
    // the settings namespace and future-session default remain untouched.
    const execution = await commands.execute(
      agent,
      `/permission ${preset}`,
      [],
      new AbortController().signal,
    );
    if (!execution || execution.result.kind !== "success") {
      throw new Error(
        execution?.result.text ?? "Permission preset command is unavailable",
      );
    }
    if (permission.current(agent.session) !== preset)
      throw new Error("Permission preset was not applied");
  }

  private respond(params: Record<string, unknown>): void {
    const pending = this.interactions.get(
      nonempty(params.requestId, "requestId"),
    );
    if (!pending) throw new Error("Interaction is no longer pending");
    if (pending.request.kind === "approval") {
      if (params.outcome !== "allowed-once" && params.outcome !== "rejected")
        throw new Error("Invalid approval outcome");
      pending.finish(params.outcome);
      return;
    }
    if (params.outcome === "rejected") {
      pending.finish();
      return;
    }
    const questions = pending.request.questions ?? [];
    validateAnswers(questions, params.answers);
    pending.finish({ answers: params.answers });
  }

  private close(id: string): Promise<void> {
    const previous = this.closing.get(id);
    if (previous) return previous;
    const task = (async () => {
      await this.opening.get(id)?.catch(() => undefined);
      this.commandAborts.get(id)?.abort();
      for (const pending of this.interactions.values())
        if (pending.request.sessionId === id) pending.finish();
      const record = this.owned.get(id);
      if (record) await record.handle.dispose();
      this.owned.delete(id);
      this.tracked.delete(id);
      this.preapproved.delete(id);
    })();
    this.closing.set(id, task);
    void task.finally(() => this.closing.delete(id)).catch(() => undefined);
    return task;
  }

  shutdown(): Promise<{}> {
    this.stopping = true;
    return (this.stopTask ??= (async () => {
      for (const pending of this.interactions.values()) pending.finish();
      await Promise.allSettled(this.opening.values());
      const results = await Promise.allSettled(
        [...this.owned.keys()].map((id) => this.close(id)),
      );
      for (const dispose of this.subscriptions.splice(0)) dispose();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("One or more DSH sessions failed to close");
      return {};
    })());
  }
}

export function validateAnswers(
  questions: QuestionItem[],
  answers: unknown,
): asserts answers is QuestionAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw new Error("Every question requires one answer");
  const seen = new Set<string>();
  for (const candidate of answers) {
    const answer = record(candidate);
    const question = questions.find((item) => item.id === answer.id);
    if (
      !question ||
      typeof answer.id !== "string" ||
      seen.has(answer.id) ||
      !Array.isArray(answer.selected) ||
      answer.selected.some(
        (label: unknown) =>
          typeof label !== "string" ||
          !question.options?.some((option) => option.label === label),
      ) ||
      new Set(answer.selected).size !== answer.selected.length ||
      (!question.multiSelect && answer.selected.length > 1) ||
      (answer.custom !== undefined && typeof answer.custom !== "string") ||
      (!answer.selected.length &&
        !(typeof answer.custom === "string" && answer.custom.trim()))
    )
      throw new Error("Invalid question answer");
    seen.add(answer.id);
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function validateContent(value: unknown): PromptPart[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("content must be a nonempty array");
  const parts = value.map((raw): PromptPart => {
    const part = record(raw);
    if (part.type === "text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (part.type === "image") {
      if (typeof part.mediaType !== "string" || !IMAGE_TYPES.has(part.mediaType))
        throw new Error(`Unsupported image type: ${String(part.mediaType)}`);
      return {
        type: "image",
        mediaType: part.mediaType,
        data: nonempty(part.data, "image data"),
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      };
    }
    if (part.type === "file") {
      const path = nonempty(part.path, "file path");
      if (!isAbsolute(path)) throw new Error("file path must be absolute");
      return {
        type: "file",
        path,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
      };
    }
    throw new Error("Invalid prompt content");
  });
  if (!parts.some((part) => part.type !== "text" || part.text.trim()))
    throw new Error("Prompt content is empty");
  return parts;
}

function validateOpen(params: Record<string, unknown>): SessionOpenParams {
  const result: SessionOpenParams = { cwd: nonempty(params.cwd, "cwd") };
  if (params.sessionId !== undefined)
    result.sessionId = nonempty(params.sessionId, "sessionId");
  if (params.preset !== undefined)
    result.preset = nonempty(params.preset, "preset");
  if (params.permissionPreset !== undefined)
    result.permissionPreset = nonempty(
      params.permissionPreset,
      "permissionPreset",
    );
  if (params.resume !== undefined) {
    if (typeof params.resume !== "boolean")
      throw new Error("resume must be boolean");
    result.resume = params.resume;
  }
  if (params.model !== undefined) {
    result.model = validateModel(params.model);
  }
  if (params.systemPrompt !== undefined)
    result.systemPrompt = nonempty(params.systemPrompt, "systemPrompt");
  if (params.preapprovedTools !== undefined) {
    if (
      !Array.isArray(params.preapprovedTools) ||
      params.preapprovedTools.some((tool) => typeof tool !== "string" || !tool)
    )
      throw new Error("preapprovedTools must be an array of tool names");
    result.preapprovedTools = params.preapprovedTools as string[];
  }
  return result;
}
function validateModel(value: unknown): ModelSelection {
  const model = selection(value);
  const effort = record(value).reasoningEffort;
  if (
    !model ||
    (effort !== undefined && (typeof effort !== "string" || !effort))
  )
    throw new Error("Invalid model selection");
  return model;
}
