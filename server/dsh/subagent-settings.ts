import { createHash } from "node:crypto";
import type {
  SubagentRoute,
  SubagentSelection,
  SubagentSettingsSave,
  SubagentSettingsView,
} from "../../shared/subagent-settings.js";
import type { HostContext, HostServices, HostSettings, HostSettingsDescriptor } from "./host.js";

const NAMESPACE = "subagent-model-selection-settings";
type Catalog = Pick<SubagentSettingsView, "models" | "failedProviders">;
interface Snapshot {
  settings: HostSettings;
  descriptor: HostSettingsDescriptor;
  initialized: boolean;
  selection: SubagentSelection;
  revision: string;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid subagent settings object");
  return value as Record<string, unknown>;
}
function routeKey(route: SubagentRoute): string {
  return JSON.stringify([route.provider, route.model]);
}
function validateSelection(input: unknown): SubagentSelection {
  const value = record(input);
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.allowedModels))
    throw new Error("Subagent settings require enabled and allowedModels");
  const allowedModels = value.allowedModels.map((input): SubagentRoute => {
    const route = record(input);
    if (typeof route.provider !== "string" || !route.provider.trim() ||
        typeof route.model !== "string" || !route.model.trim())
      throw new Error("Subagent model routes require nonempty provider and model ids");
    return { provider: route.provider, model: route.model };
  });
  if (new Set(allowedModels.map(routeKey)).size !== allowedModels.length)
    throw new Error("A subagent model may only be selected once");
  if (value.enabled && allowedModels.length === 0)
    throw new Error("Select at least one model before enabling model selection");
  return { enabled: value.enabled, allowedModels };
}

// Object insertion order and process-local revisions must not invalidate tokens
// carried between the short-lived read and save bridges. Array order is meaningful.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
  return value;
}

/** Accesses only native DSH services; the shared module is a type-only boundary. */
export class SubagentSettings {
  constructor(private readonly ctx: HostContext, private readonly profile: string) {}

  private snapshot(): Snapshot | undefined {
    let settings: HostSettings | undefined;
    let editor: HostServices["configEditor"];
    try {
      settings = this.ctx.get("settings");
      editor = this.ctx.get("configEditor");
    } catch {
      // Older profiles can omit these optional services entirely.
      return undefined;
    }
    if (!settings || typeof settings.describe !== "function" ||
        typeof settings.mutate !== "function" || settings.writable === false ||
        !editor || !("configuration" in editor) || typeof editor.configuration !== "function")
      return undefined;
    const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === NAMESPACE);
    const entry = editor.configuration().find(row => row.entry.options.id === NAMESPACE)?.entry;
    if (!descriptor || !entry) return undefined;
    if (!Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0)
      throw new Error("Invalid DSH settings revision");
    const raw = entry.options.config ?? {};
    const config = record(raw);
    const initialized = Object.hasOwn(config, "enabled") || Object.hasOwn(config, "allowedModels");
    const selection = validateSelection(descriptor.value);
    const revision = createHash("sha256").update(JSON.stringify(canonical({
      profile: this.profile,
      documentPath: settings.documentPath,
      raw,
      value: descriptor.value,
      base: descriptor.base,
      user: descriptor.user,
    }))).digest("hex");
    return { settings, descriptor, initialized, selection, revision };
  }

  private unsupported(): SubagentSettingsView {
    return {
      supported: false, profile: this.profile,
      reason: "This DSH profile does not provide writable subagent model settings.",
      revision: "", initialized: false,
      selection: { enabled: false, allowedModels: [] }, models: [], failedProviders: [],
    };
  }

  private async catalog(): Promise<Catalog> {
    const llm = this.ctx.get("llm");
    const models: Catalog["models"] = [];
    const failedProviders: string[] = [];
    const seen = new Set<string>();
    for (const provider of llm.listProviders()) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          const route = { provider: provider.id, model: model.id };
          const key = routeKey(route);
          if (seen.has(key)) continue;
          seen.add(key);
          models.push({ ...route, name: model.name ?? model.id, providerName: provider.name ?? provider.id });
        }
      } catch {
        failedProviders.push(provider.id);
      }
    }
    return { models, failedProviders };
  }

  private view(snapshot: Snapshot, catalog: Catalog): SubagentSettingsView {
    return {
      supported: true, profile: this.profile,
      revision: snapshot.revision, initialized: snapshot.initialized,
      selection: snapshot.selection, ...catalog,
    };
  }

  private async mutate(snapshot: Snapshot, selection: SubagentSelection): Promise<void> {
    await snapshot.settings.mutate(NAMESPACE, [
      { op: "set", path: ["enabled"], value: selection.enabled },
      { op: "set", path: ["allowedModels"], value: selection.allowedModels },
    ], snapshot.descriptor.revision);
  }

  /** Capture the revision before discovery so another writer always wins. */
  async initialize(): Promise<void> {
    const snapshot = this.snapshot();
    if (!snapshot || snapshot.initialized) return;
    const catalog = await this.catalog();
    if (catalog.models.length === 0) return;
    try {
      await this.mutate(snapshot, {
        enabled: true,
        allowedModels: catalog.models.map(({ provider, model }) => ({ provider, model })),
      });
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error &&
          error.code === "SETTINGS_CONFLICT" && this.snapshot()?.initialized) return;
      throw error;
    }
  }

  async read(): Promise<SubagentSettingsView> {
    if (!this.snapshot()) return this.unsupported();
    const catalog = await this.catalog();
    const current = this.snapshot();
    if (!current) return this.unsupported();
    return this.view(current, catalog);
  }

  async save(input: unknown): Promise<SubagentSettingsView> {
    const value = record(input);
    if (value.profile !== this.profile) throw new Error("DSH profile changed; reload settings before saving");
    if (typeof value.revision !== "string" || !value.revision)
      throw new Error("Subagent settings revision is required");
    const selection = validateSelection(value.selection);
    const request: SubagentSettingsSave = { profile: this.profile, revision: value.revision, selection };
    const snapshot = this.snapshot();
    if (!snapshot) return this.unsupported();
    if (request.revision !== snapshot.revision)
      throw new Error("Subagent settings changed; reload settings before saving");
    await this.mutate(snapshot, request.selection);
    return this.read();
  }
}
