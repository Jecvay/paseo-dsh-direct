import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createFixture, hookPlugin } from "./paseo-014-fixture.js";

// Opt in explicitly. Dependencies must already be installed; this test never installs packages.
// PASEO_014_E2E=1 PASEO_014_NODE_MODULES=/absolute/node_modules npx --no-install tsx --test scripts/paseo-014.e2e.test.ts
const enabled = process.env.PASEO_014_E2E === "1";
const execute = promisify(execFile);
const HOUR = 60 * 60 * 1000;
const repo = path.resolve(import.meta.dirname, "..");

async function eventually<T>(description: string, check: () => Promise<T> | T, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

// Dynamic imports keep the ordinary test suite independent of the heavyweight daemon package.
test("Paseo 0.14 isolated DSH runtime lifecycle", { skip: !enabled ? "set PASEO_014_E2E=1 and PASEO_014_NODE_MODULES to run" : process.platform !== "linux" ? "Linux /proc process cleanup required" : false, timeout: 180_000 }, async t => {
  const modules = process.env.PASEO_014_NODE_MODULES;
  assert.ok(modules && path.isAbsolute(modules), "PASEO_014_NODE_MODULES must name preinstalled dependencies");
  const load = (file: string) => import(pathToFileURL(path.join(modules, file)).href);
  for (const name of ["server", "client", "plugin"]) {
    const pkg = JSON.parse(await readFile(path.join(modules, `@getpaseo/${name}/package.json`), "utf8"));
    assert.equal(pkg.version, "0.14.0", `requires @getpaseo/${name} 0.14.0`);
  }
  const executable = process.env.PASEO_DSH_EXECUTABLE || "dsh";
  const { stdout: version } = await execute(executable, ["--version"]);
  t.diagnostic(`DSH ${version.trim()}; preinstalled Paseo 0.14.0`);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-014-e2e-")));
  const oldEnv = { ...process.env };
  let daemon: any;
  let client: any;
  let driver: any;
  let cleanup: any;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const home = path.join(root, "home");
    const dshHome = path.join(root, "dsh");
    const paseoHome = path.join(root, "paseo");
    const cwd = path.join(root, "workspace");
    const profile = path.join(dshHome, "profiles/paseo");
    await Promise.all([home, paseoHome, cwd, profile].map(dir => mkdir(dir, { recursive: true })));
    // Remove inherited real credentials and DSH session context before starting any process.
    for (const key of Object.keys(process.env)) {
      if (/API_KEY|TOKEN|SECRET|DSH_|PASEO_/.test(key)) delete process.env[key];
    }
    // Daemon skill maintenance calls os.homedir(); isolate that API without changing HOME.
    t.mock.method(os, "homedir", () => home);
    Object.assign(process.env, { DSH_HOME: dshHome, PASEO_HOME: paseoHome, PASEO_DSH_EXECUTABLE: executable, DSH_PERMISSION_MODE: "danger-full-access", PASEO_014_FIXTURE_KEY: "synthetic-loopback-only" });
    fixture = await createFixture();
    await writeFile(path.join(profile, "package.json"), JSON.stringify({ private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }));
    await writeFile(path.join(profile, "cordis.yml"), "[]\n");
    await writeFile(path.join(profile, "cordis.patch.yml"), `- id: llm-pi-ai\n  config:\n    providers:\n      fixture:\n        api: openai-completions\n        apiKeyEnv: PASEO_014_FIXTURE_KEY\n        baseURL: ${fixture.url}/v1\n        models:\n          - id: fixture\n            name: Fixture\n            contextWindow: 131072\n            maxTokens: 4096\n            input: [text]\n            reasoningEfforts: false\n- id: agent-default-model\n  config: { provider: fixture, model: fixture }\n- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n`);
    const hookDir = path.join(root, "hook");
    const auditFile = path.join(root, "hooks.jsonl");
    await mkdir(hookDir);
    await writeFile(path.join(hookDir, "paseo-plugin.json"), JSON.stringify({ id: "fixture-hooks", requirements: { paseo: ">=0.14.0" } }));
    await writeFile(path.join(hookDir, "index.server.ts"), hookPlugin(fixture.url, auditFile));
    await execute(process.execPath, ["scripts/build.mjs"], { cwd: repo });
    const [{ createPaseoDaemon }, { createPaseoClient }, { DaemonClient }, { default: pino }, { createIdleRuntimeCleanup }] = await Promise.all([
      load("@getpaseo/server/dist/server/server/exports.js"), load("@getpaseo/client/dist/index.js"), load("@getpaseo/client/dist/daemon-client.js"), load("pino/pino.js"), load("@getpaseo/server/dist/server/server/agent/idle-runtime-cleanup/index.js"),
    ]);
    const logger = pino({ level: "silent" });
    daemon = await createPaseoDaemon({
      listen: "127.0.0.1:0", paseoHome, daemonVersion: "0.14.0", corsAllowedOrigins: [], staticDir: root,
      agentStoragePath: path.join(paseoHome, "agents"), agentClients: {}, relayEnabled: false,
      browserToolsEnabled: false, mcpEnabled: true, mcpInjectIntoAgents: true, mcpDebug: false,
      idleRuntimeCleanup: false, pluginsEnabled: true,
      plugins: { "paseo-dsh-direct": { source: "directory", path: repo }, "fixture-hooks": { source: "directory", path: hookDir } },
      metadataGeneration: { providers: [] }, skillSelection: { mode: "custom", skills: [] },
    }, logger);
    await daemon.start();
    const listen = daemon.getListenTarget();
    assert.equal(listen?.type, "tcp");
    const url = `ws://127.0.0.1:${listen.port}/ws`;
    client = createPaseoClient({ url, reconnect: { enabled: false }, logger });
    driver = new DaemonClient({ url, clientId: "paseo-014-test-driver", reconnect: { enabled: false }, logger });
    await Promise.all([client.connect(), driver.connect()]);
    const plugins = await driver.listPlugins();
    assert.equal(plugins.find((p: any) => p.id === "paseo-dsh-direct")?.status, "running", JSON.stringify(plugins));
    assert.equal(plugins.find((p: any) => p.id === "fixture-hooks")?.status, "running", JSON.stringify(plugins));
    t.diagnostic("both plugin subprocesses compiled and running");
    await client.providers.refresh({ providers: ["dsh-pi"] });
    const models = await client.providers.listModels("dsh-pi");
    assert.ok(!models.error, models.error);
    const model = models.models.find((m: any) => m.id.includes("fixture"));
    assert.ok(model, JSON.stringify(models));
    const agent = await client.agents.create({ cwd, title: "isolated fixture", config: { provider: `dsh-pi/${model.id}`, modeId: "standard" } });
    const run = async (text: string) => {
      const result = await agent.run(text, { timeoutMs: 30_000 });
      assert.equal(result.status, "idle", JSON.stringify(result));
      return result;
    };
    await run("fixture-first");
    const candidate = () => daemon.agentManager.getRuntimeCleanupCandidates().find((c: any) => c.agentId === agent.id);
    await eventually("real idle runtime can stop", async () => await candidate()?.canStopRuntime?.());
    const nativeId = candidate().sessionId;
    assert.ok(nativeId);
    const tools = fixture.requests.at(-1).tools.map((tool: any) => tool.function.name);
    // Paseo 0.14 agent.session_open hook MCP servers and per-agent tools reach
    // the Direct provider through the existing session.open config path.
    assert.ok(tools.includes("mcp__fixture_external__echo"), `session_open MCP missing: ${tools.join(", ")}`);
    assert.ok(tools.includes("mcp__paseo__fixture_agent_echo"), `per-agent tool missing: ${tools.join(", ")}`);
    t.diagnostic(`model-visible tools: ${tools.join(", ")}`);
    t.diagnostic(`idle safety probe passed; native session identity captured`);
    let now = Date.now();
    cleanup = createIdleRuntimeCleanup({ enabled: true, runtimes: () => daemon.agentManager.getRuntimeCleanupCandidates(), logger, now: () => now, schedule: () => () => {} });
    // A real DSH background bash job remains active after the main turn returns idle.
    let launchJob = true;
    fixture.script(() => launchJob
      ? (launchJob = false, { tool: tools.find((name: string) => /(?:^|__)bash$/.test(name)), args: { description: "Wait for isolated fixture release marker", command: "while [ ! -f job-release ]; do sleep 0.1; done; echo background-finished", run_in_background: true } })
      : { text: "background-started" });
    await run("fixture-background-job");
    assert.equal(await candidate().canStopRuntime(), false, "idle main agent with a running DSH job cannot stop");
    now += HOUR + 1;
    const vetoed = await cleanup.sweep();
    assert.deepEqual(vetoed.failures, []);
    assert.deepEqual(vetoed.collected, []);
    assert.equal(candidate().sessionId, nativeId);
    await writeFile(path.join(cwd, "job-release"), "release\n");
    // Collect the actual DSH job output through its model-visible tool.
    let collectJob = true;
    fixture.script(body => {
      if (!collectJob) return { text: "background-collected" };
      collectJob = false;
      const history = JSON.stringify(body.messages);
      const jobId = history.match(/bash-[a-f0-9]+/)?.[0];
      assert.ok(jobId, "background job id must be returned by real DSH");
      return { tool: tools.find((name: string) => /(?:^|__)job_output$/.test(name)), args: { job_id: jobId, wait: true } };
    });
    await run("fixture-collect-job");
    await eventually("completed background job allows stop", () => candidate().canStopRuntime());
    const grace = await cleanup.sweep();
    assert.deepEqual(grace.collected, [], "veto release starts a fresh idle hour");
    now += HOUR + 1;
    const collected = await cleanup.sweep();
    assert.deepEqual(collected.failures, []);
    assert.equal(collected.collected[0]?.sessionId, nativeId);
    await run("fixture-after-collection");
    assert.equal(candidate().sessionId, nativeId);
    const reloaded = await agent.reload();
    assert.ok(reloaded);
    assert.equal(candidate().sessionId, nativeId);
    await run("fixture-after-reload");
    const hooks = (await readFile(auditFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(hooks.some(hook => hook.reason === "create"));
    assert.ok(hooks.some(hook => hook.reason === "resume"));
    assert.ok(hooks.some(hook => hook.reason === "refresh"));
    t.diagnostic("one-hour sweep collected runtime; prompt and reload retained native session identity");
    assert.ok(fixture.requests.length >= 3);
  } finally {
    const closes = await Promise.allSettled([
      Promise.resolve().then(() => cleanup?.close()),
      Promise.resolve().then(() => client?.close()),
      Promise.resolve().then(() => driver?.close()),
    ]);
    closes.push(...await Promise.allSettled([
      Promise.resolve().then(() => daemon?.stop()),
      Promise.resolve().then(() => fixture?.close()),
    ]));
    // Terminate any descendant left by a failed assertion before deleting its isolated home.
    const isolatedHome = path.join(root, "dsh");
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const env = await readFile(`/proc/${entry}/environ`).catch(() => Buffer.alloc(0));
      if (env.toString().split("\0").includes(`DSH_HOME=${isolatedHome}`)) {
        try { process.kill(Number(entry), "SIGKILL"); } catch {}
      }
    }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    assert.equal(await realpath(root), root);
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith("paseo-014-e2e-"));
    await rm(root, { recursive: true, force: true });
    const failures = closes.filter(result => result.status === "rejected");
    assert.equal(failures.length, 0, "isolated resources must close successfully");
  }
});
