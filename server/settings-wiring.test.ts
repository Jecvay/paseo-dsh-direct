import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderConnection, ProviderLaunch, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { SettingsDefinition } from "@getpaseo/plugin";
import type { DshBridge, LaunchBridgeOptions } from "./bridge-client.js";
import type { DshSettingsValues } from "../shared/settings.js";
import type { SubagentSettingsView } from "../shared/subagent-settings.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const bridgeSource = "settings-wiring-test bridge source";

// Bundle the actual contribution and its provider/config/settings implementations.
// Only the entry's process launcher and generated bridge asset are replaced.
const bundledEntry = build({
  entryPoints: [path.join(root, "index.server.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  plugins: [{
    name: "settings-wiring-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/server\/(bridge-client|generated-bridge)\.js$/ }, (args) => {
        if (args.importer !== path.join(root, "index.server.ts")) return;
        return { path: args.path, namespace: "settings-wiring" };
      });
      builder.onLoad({ filter: /.*/, namespace: "settings-wiring" }, ({ path: modulePath }) => ({
        contents: modulePath.endsWith("bridge-client.js")
          ? "export const launchDshBridge = launchDshBridgeMock;"
          : `export const DSH_BRIDGE_SOURCE = ${JSON.stringify(bridgeSource)};`,
      }));
    },
  }],
}).then((result) => result.outputFiles[0].text);

const providerLaunch: ProviderLaunch = {
  command: "/test/daemon/dsh",
  args: ["--test-launch"],
  env: { DSH_HOME: "/test/dsh-home" },
};

async function fixture(initial: DshSettingsValues) {
  const launches: Array<{ options: LaunchBridgeOptions; snapshot: LaunchBridgeOptions; bridge: DshBridge; closed: number }> = [];
  const warnings: string[] = [];
  const reads: string[] = [];
  const connections: ProviderConnection[] = [];
  let definition: SettingsDefinition | undefined;
  let values = structuredClone(initial);
  let revision = "host-0";
  let writes = 0;
  let provider: ProviderRegistration | undefined;
  type Handler = (_input: Record<string, never>, context: { paseo: typeof paseo }) => Promise<SubagentSettingsView>;
  const handlers = new Map<string, Handler>();
  const discovery: string[] = [];
  const paseo = { providers: {
    async refresh(input: { providers: string[] }) {
      assert.deepEqual(input, { providers: ["dsh-pi"] });
      discovery.push("refresh");
      // The daemon refreshes provider discovery before the settings handler opens its bridge.
      await provider!.getCatalogCacheKey!({ scope: "global", launch: providerLaunch });
    },
    async listModels(id: string) {
      assert.equal(id, "dsh-pi");
      discovery.push("listModels");
      return { models: [] };
    },
  } };
  const settings = {
    async read() {
      reads.push(revision);
      return { status: "ready" as const, values: definition!.schema.parse(structuredClone(values)), revision };
    },
    async save(next: DshSettingsValues, expectedRevision: string) {
      if (expectedRevision !== revision) return false;
      values = definition!.schema.parse(structuredClone(next)) as DshSettingsValues;
      revision = `host-${++writes}`;
      return true;
    },
  };
  const launchDshBridgeMock = async (options: LaunchBridgeOptions): Promise<DshBridge> => {
    const record = { options, snapshot: { ...structuredClone({ ...options, signal: undefined }), signal: options.signal }, bridge: undefined as unknown as DshBridge, closed: 0 };
    const profile = options.profile ?? "paseo";
    const view: SubagentSettingsView = {
      supported: true, profile, revision: "native-revision", initialized: true,
      selection: { enabled: false, allowedModels: [] }, models: [], failedProviders: [],
    };
    record.bridge = {
      executable: options.executable ?? providerLaunch.command,
      initialized: {
        protocolVersion: 1, profile,
        capabilities: { stream: true, approvals: true, questions: true, history: true, cancel: true },
        catalog: { models: [], presets: [] },
      },
      async request(method, params) {
        assert.equal(method, "subagent.settings.read");
        assert.deepEqual(params, {});
        return view as never;
      },
      on: () => () => {},
      onFailure: () => () => {},
      async close() { record.closed++; },
    };
    launches.push(record);
    return record.bridge;
  };
  const module = { exports: {} as { default: (server: PluginServerContext) => () => Promise<void> } };
  // Give the bundle an isolated process facade: no user env overrides or stderr output.
  const evaluate = new Function("require", "module", "exports", "process", "launchDshBridgeMock", await bundledEntry);
  evaluate(require, module, module.exports, {
    env: {}, platform: "linux", stderr: { write: (line: string) => warnings.push(line) },
  }, launchDshBridgeMock);
  const dispose = module.exports.default({
    registerSettings(registered: SettingsDefinition) {
      assert.equal(registered.id, "dsh");
      assert.equal(registered.scope, "host");
      assert.equal(registered.version, 1);
      definition = registered;
      return settings;
    },
    registerProvider(registered: ProviderRegistration) { provider = registered; },
    handle(contract: { name: string }, handler: Handler) { handlers.set(contract.name, handler); },
  } as unknown as PluginServerContext);
  assert.ok(provider);
  return {
    launches, warnings, reads, discovery, settings,
    async connect() {
      const connection = await provider!.connect({ versions: [1], capabilities: [], launch: providerLaunch });
      connections.push(connection);
      return connection;
    },
    async readSubagents() {
      const handler = handlers.get("subagent-settings.read");
      assert.ok(handler, "the real entry must register readSubagentSettings");
      return handler({}, { paseo });
    },
    async save(next: DshSettingsValues) {
      const current = await settings.read();
      assert.equal(await settings.save(next, current.revision), true);
    },
    async dispose() {
      await Promise.all(connections.map((connection) => connection.close()));
      await dispose();
    },
  };
}

function assertLaunch(options: LaunchBridgeOptions, expected: DshSettingsValues, timeout: number | undefined) {
  assert.equal(options.bridgeSource, bridgeSource);
  assert.equal(options.executable, expected.executable);
  assert.equal(options.profile, expected.profile);
  assert.equal(options.startupTimeoutMs, timeout);
  assert.deepEqual(options.providerLaunch, providerLaunch);
}

test("the contribution hot-reads host settings for provider connect and subagent settings without changing existing bridges", async (t) => {
  const legacy = { executable: "/test/legacy/dsh", profile: "legacy" };
  const f = await fixture(legacy);
  t.after(() => f.dispose());

  const cases: Array<{ values: DshSettingsValues; timeout?: number }> = [
    { values: legacy },
    { values: { executable: "/test/min/dsh", profile: "minimum", startupTimeoutSeconds: "1" }, timeout: 1_000 },
    { values: { executable: "/test/max/dsh", profile: "maximum", startupTimeoutSeconds: "600" }, timeout: 600_000 },
    { values: { executable: "/test/blank/dsh", profile: "blank", startupTimeoutSeconds: " \t " } },
  ];
  const originalSettings = await f.settings.read();
  for (const [index, { values, timeout }] of cases.entries()) {
    if (index > 0) {
      await f.save(values);
      assert.equal(await f.settings.save({ profile: "stale", startupTimeoutSeconds: "600" }, originalSettings.revision), false);
      assert.equal(f.launches.length, index * 2, "saving settings must not relaunch active bridges");
    }
    await f.connect();
    const read = await f.readSubagents();
    assert.equal(read.profile, values.profile);
    assertLaunch(f.launches[index * 2].options, values, timeout);
    assertLaunch(f.launches[index * 2 + 1].options, values, timeout);
    assert.equal(f.launches[index * 2].closed, 0);
    assert.equal(f.launches[index * 2 + 1].closed, 1, "settings reads must release their temporary bridge");
    for (const launch of f.launches) assert.deepEqual(launch.options, launch.snapshot);
  }
  assert.deepEqual(f.discovery, cases.flatMap(() => ["refresh", "listModels"]));
  assert.deepEqual([...new Set(f.reads)], ["host-0", "host-1", "host-2", "host-3"]);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.launches[0].closed, 0, "the first provider bridge remains alive with its original options");
});

test("invalid timeout text only drops the timeout on both actual entry launch paths", async (t) => {
  const f = await fixture({});
  t.after(() => f.dispose());
  for (const text of ["soon", "1.5", "0", "601"]) {
    const values = { executable: "/test/configured/dsh", profile: "configured", startupTimeoutSeconds: text };
    await f.save(values);
    const start = f.launches.length;
    await f.connect();
    await f.readSubagents();
    assertLaunch(f.launches[start].options, values, undefined);
    assertLaunch(f.launches[start + 1].options, values, undefined);
  }
  assert.ok(f.warnings.length > 0);
  assert.ok(f.warnings.every((line) => line.includes("ignoring the startup timeout setting")));
});
