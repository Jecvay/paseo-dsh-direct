import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderLaunch, ProviderRegistration } from "@getpaseo/plugin/server/provider";
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

async function fixture(initial: DshSettingsValues, options: { gateLaunch?: boolean } = {}) {
  const launches: Array<{ options: LaunchBridgeOptions; snapshot: LaunchBridgeOptions; bridge: DshBridge; closed: number }> = [];
  const warnings: string[] = [];
  const reads: string[] = [];
  let releaseLaunch = () => {};
  const launchGate = options.gateLaunch
    ? new Promise<void>((resolve) => { releaseLaunch = resolve; })
    : undefined;
  let markLaunched = () => {};
  const launched = new Promise<void>((resolve) => { markLaunched = resolve; });
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
    markLaunched();
    if (launchGate) await launchGate;
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
  const exits: number[] = [];
  let resolveExit = () => {};
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const stderr = Object.assign(new EventEmitter(), {
    write: (line: string) => warnings.push(line),
  });
  const hostProcess = Object.assign(new EventEmitter(), {
    env: {},
    platform: "linux",
    stderr,
    exit(code: number) {
      exits.push(code);
      resolveExit();
    },
  });
  const module = { exports: {} as { default: (server: PluginServerContext) => () => Promise<void> } };
  // Give the bundle an isolated process facade: no user env overrides or stderr output.
  const evaluate = new Function("require", "module", "exports", "process", "launchDshBridgeMock", await bundledEntry);
  evaluate(require, module, module.exports, hostProcess, launchDshBridgeMock);
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
    launches, warnings, reads, discovery, settings, hostProcess, exits, exited, launched,
    releaseLaunch: () => releaseLaunch(),
    async connect() {
      return provider!.connect({ versions: [1], capabilities: [], launch: providerLaunch });
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

const HOST_EXIT_EVENTS = ["disconnect", "SIGTERM", "SIGINT"] as const;

for (const event of HOST_EXIT_EVENTS) {
  test(`host ${event} closes active connections and requests worker exit`, { timeout: 5_000 }, async () => {
    const f = await fixture({});
    await f.connect();
    assert.equal(f.launches[0].closed, 0);
    for (const name of HOST_EXIT_EVENTS) assert.equal(f.hostProcess.listenerCount(name), 1);

    f.hostProcess.emit(event);
    f.hostProcess.emit(event);
    if (event === "disconnect") {
      assert.doesNotThrow(() => f.hostProcess.emit(
        "error",
        Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }),
      ));
      assert.doesNotThrow(() => f.hostProcess.stderr.emit(
        "error",
        Object.assign(new Error("Broken pipe"), { code: "EPIPE" }),
      ));
      assert.throws(
        () => f.hostProcess.stderr.emit("error", Object.assign(new Error("Disk full"), { code: "ENOSPC" })),
        /Disk full/,
      );
    }
    await f.exited;

    assert.equal(f.launches[0].options.signal?.aborted, true);
    assert.equal(f.launches[0].closed, 1);
    assert.deepEqual(f.exits, [0]);
    for (const name of HOST_EXIT_EVENTS) assert.equal(f.hostProcess.listenerCount(name), 0);
  });
}

test("normal unload closes active connections without exiting the worker", { timeout: 5_000 }, async () => {
  const f = await fixture({});
  await f.connect();
  await f.dispose();
  assert.equal(f.launches[0].closed, 1);
  assert.deepEqual(f.exits, []);
  for (const name of HOST_EXIT_EVENTS) assert.equal(f.hostProcess.listenerCount(name), 0);
});

test("the host-exit deadline stops a worker whose cleanup stalls", { timeout: 5_000 }, async (t) => {
  const f = await fixture({}, { gateLaunch: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const connecting = f.connect();
  await f.launched;
  f.hostProcess.emit("disconnect");
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.exits, [0], "the deadline must exit without waiting for the stalled bridge");
  f.releaseLaunch();
  await assert.rejects(connecting, (error: Error) => error.name === "AbortError");
});

test("a connection that resolves during shutdown is closed before the worker exits", { timeout: 5_000 }, async () => {
  const f = await fixture({}, { gateLaunch: true });
  const connecting = f.connect();
  await f.launched;
  f.hostProcess.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.exits, [], "the worker must wait for the connecting bridge");
  f.releaseLaunch();
  await assert.rejects(connecting, (error: Error) => error.name === "AbortError");
  await f.exited;
  assert.equal(f.launches[0].closed, 1);
  assert.deepEqual(f.exits, [0]);
});
