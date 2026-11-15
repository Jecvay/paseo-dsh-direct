import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createFixture } from "./paseo-014-fixture.js";

// Run `npm run build` separately before opting in. No installation or build runs here.
// PASEO_PLAN_REVIEW_E2E=1 PASEO_PLAN_REVIEW_SERVER=/absolute/@getpaseo/server \
// PASEO_DSH_EXECUTABLE=/absolute/dsh npx --no-install tsx --test scripts/plan-review.e2e.test.ts
// The server's own dependency graph supplies the matching client and logger.
const enabled = process.env.PASEO_PLAN_REVIEW_E2E === "1";
const execute = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const approvedPlan = "# Approved fixture plan\n\n1. Inspect the isolated workspace.\n2. Verify **approval** and `plan/mode`.\n";
const firstPlan = "# First fixture proposal\n\n- Review the initial approach.\n- Keep planning before implementation.\n";
const revisedPlan = "# Revised fixture proposal\n\n1. Add explicit validation.\n2. Wait for a new approval.\n";

async function eventually<T>(description: string, check: () => Promise<T> | T, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}

function assertReview(request: any, plan: string) {
  assert.equal(request.kind, "plan");
  assert.equal(request.metadata?.planText, plan);
  assert.equal(request.input?.plan, plan);
  assert.deepEqual(request.detail, { type: "plan", text: plan });
  assert.deepEqual(request.actions?.map((action: any) => [action.id, action.label, action.behavior]), [
    ["approve-plan", "Approve", "allow"], ["keep-planning", "Keep planning", "deny"],
  ]);
}

test("real Paseo 0.15.4 and DSH plan review: approve, revise, interrupt, replay", {
  skip: !enabled ? "set PASEO_PLAN_REVIEW_E2E=1 and PASEO_PLAN_REVIEW_SERVER to run"
    : process.platform !== "linux" ? "Linux /proc cleanup required" : false,
  timeout: 180_000,
}, async t => {
  const serverDir = process.env.PASEO_PLAN_REVIEW_SERVER;
  assert.ok(serverDir && path.isAbsolute(serverDir), "PASEO_PLAN_REVIEW_SERVER must name a preinstalled @getpaseo/server package directory");
  const pkg = JSON.parse(await readFile(path.join(serverDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@getpaseo/server");
  assert.equal(pkg.version, "0.15.4");
  const resolve = createRequire(path.join(serverDir, "package.json"));
  const load = (specifier: string) => import(pathToFileURL(resolve.resolve(specifier)).href);
  const executable = process.env.PASEO_DSH_EXECUTABLE || "dsh";
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-plan-review-e2e-")));
  const oldEnv = { ...process.env };
  let daemon: any;
  let client: any;
  let driver: any;
  let subscription: any;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const home = path.join(root, "home");
    const dshHome = path.join(root, "dsh");
    const paseoHome = path.join(root, "paseo");
    const cwd = path.join(root, "workspace");
    const profile = path.join(dshHome, "profiles/paseo");
    await Promise.all([home, paseoHome, cwd, profile].map(dir => mkdir(dir, { recursive: true })));
    // Isolate file-based credentials as well as environment credentials, before imports/startup.
    for (const key of Object.keys(process.env)) {
      if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DSH_|PASEO_|^XDG_|^AWS_|^AZURE_|^GOOGLE_|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^SSH_AUTH_SOCK$|^GPG_AGENT_INFO$|PROXY/i.test(key)) delete process.env[key];
    }
    t.mock.method(os, "homedir", () => home);
    Object.assign(process.env, {
      HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local/share"), DSH_HOME: dshHome, PASEO_HOME: paseoHome,
      PASEO_DSH_EXECUTABLE: executable, DSH_PERMISSION_MODE: "danger-full-access",
      PASEO_014_FIXTURE_KEY: "synthetic-loopback-only",
    });
    const { stdout: version } = await execute(executable, ["--version"], { cwd });
    assert.ok(["0.2.2-rc.1", "0.2.2-rc.3"].includes(version.trim()), "requires DSH 0.2.2-rc.1 or 0.2.2-rc.3");
    t.diagnostic(`DSH ${version.trim()}; Paseo ${pkg.version}; isolated HOME and loopback model`);
    fixture = await createFixture();
    await writeFile(path.join(profile, "package.json"), JSON.stringify({ private: true, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }));
    await writeFile(path.join(profile, "cordis.yml"), "[]\n");
    await writeFile(path.join(profile, "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      fixture:
        api: openai-completions
        apiKeyEnv: PASEO_014_FIXTURE_KEY
        baseURL: ${fixture.url}/v1
        models:
          - id: fixture
            name: Fixture
            contextWindow: 131072
            maxTokens: 4096
            input: [text]
            reasoningEfforts: false
- id: agent-default-model
  config: { provider: fixture, model: fixture }
- id: session-title-llm
  disabled: true
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
`);
    // Resolve public package exports from this installation, including its actual client dependency.
    const [{ createPaseoDaemon }, { createPaseoClient }, { DaemonClient }, { default: pino }] = await Promise.all([
      load("@getpaseo/server"), load("@getpaseo/client"), load("@getpaseo/client/internal/daemon-client"), load("pino"),
    ]);
    const logger = pino({ level: "silent" });
    daemon = await createPaseoDaemon({
      listen: "127.0.0.1:0", paseoHome, daemonVersion: pkg.version, corsAllowedOrigins: [], staticDir: root,
      agentStoragePath: path.join(paseoHome, "agents"), agentClients: {}, relayEnabled: false,
      browserToolsEnabled: false, mcpEnabled: false, mcpInjectIntoAgents: false, mcpDebug: false,
      idleRuntimeCleanup: false, pluginsEnabled: true,
      plugins: { "paseo-dsh-direct": { source: "directory", path: repo } },
      metadataGeneration: { providers: [] }, skillSelection: { mode: "custom", skills: [] },
    }, logger);
    await daemon.start();
    const listen = daemon.getListenTarget();
    assert.equal(listen?.type, "tcp");
    const url = `ws://127.0.0.1:${listen.port}/ws`;
    client = createPaseoClient({ url, reconnect: { enabled: false }, logger });
    driver = new DaemonClient({ url, clientId: "plan-review-e2e", reconnect: { enabled: false }, logger });
    await Promise.all([client.connect(), driver.connect()]);
    const plugins = await driver.listPlugins();
    assert.equal(plugins.find((plugin: any) => plugin.id === "paseo-dsh-direct")?.status, "running", JSON.stringify(plugins));
    await client.providers.refresh({ providers: ["dsh-pi"] });
    const models = await client.providers.listModels("dsh-pi");
    assert.ok(!models.error, models.error);
    const model = models.models.find((entry: any) => entry.id.includes("fixture"));
    assert.ok(model, "isolated model catalog must expose fixture");
    const agent = await client.agents.create({ cwd, title: "isolated plan review", config: { provider: `dsh-pi/${model.id}`, modeId: "standard" } });
    const liveItems: any[] = [];
    subscription = agent.timeline.subscribe((event: any) => {
      if (event.event.type === "timeline") liveItems.push(event.event.item);
    });
    await subscription.ready;
    const planActive = async () => {
      await agent.refresh();
      const feature = agent.features?.find((entry: any) => entry.id === "planMode");
      assert.ok(feature, "real host must expose DSH plan mode");
      return feature.value;
    };
    const review = async (plan: string, previousId?: string) => eventually("host plan permission", async () => {
      await agent.refresh();
      const request = agent.pendingPermissions?.find((entry: any) => entry.id !== previousId);
      if (!request) return;
      assertReview(request, plan);
      assert.ok(liveItems.some(item => item.type === "tool_call" && item.detail?.type === "plan" && item.detail.text === plan), "live host tool card must contain Markdown before approval");
      return request;
    });
    const callPlan = (body: any, plan: string) => {
      const tool = body.tools.find((entry: any) => entry.function.name === "exit_plan_mode");
      assert.ok(tool, "real DSH must disclose exit_plan_mode after entering plan mode");
      return { tool: tool.function.name, args: { plan } };
    };

    await driver.setAgentFeature(agent.id, "planMode", true);
    assert.equal(await planActive(), true);
    let approveStep = 0;
    fixture.script(body => {
      if (approveStep++ === 0) return callPlan(body, approvedPlan);
      assert.match(JSON.stringify(body.messages), /Plan approved/);
      return { text: "fixture-approval-complete" };
    });
    await agent.send("fixture: present a plan for approval");
    const approve = await review(approvedPlan);
    await agent.respondToPermission({ requestId: approve.id, response: { behavior: "allow", selectedActionId: "approve-plan" } });
    await eventually("approved turn finishes", async () => (await agent.refresh(), agent.status === "idle" && !agent.pendingPermissions?.length));
    assert.equal(approveStep, 2, "approval must resume the actual DSH model loop");
    assert.equal(await planActive(), false, "approval must commit DSH's exit from plan mode");
    t.diagnostic("approve-plan/allow: host received full plan; DSH resumed and exited plan mode");

    await driver.setAgentFeature(agent.id, "planMode", true);
    let revisionStep = 0;
    let unexpectedContinuation = "";
    fixture.script(body => {
      if (revisionStep++ === 0) return callPlan(body, firstPlan);
      if (revisionStep > 2) {
        unexpectedContinuation = JSON.stringify(body.messages.filter((message: any) => message.role === "tool").at(-1));
        return { text: "fixture-unexpected-continuation" };
      }
      const history = JSON.stringify(body.messages);
      assert.match(history, /The user chose to keep planning; revise the plan and present it again/);
      assert.ok(!history.includes("Denied by user"), "UI's default denial message must not become model feedback");
      return callPlan(body, revisedPlan);
    });
    await agent.send("fixture: propose then revise when asked to keep planning");
    const keep = await review(firstPlan);
    // Same payload as the native UI deny action; it has no feedback input control.
    await agent.respondToPermission({ requestId: keep.id, response: { behavior: "deny", selectedActionId: "keep-planning", message: "Denied by user" } });
    const revised = await review(revisedPlan, keep.id);
    assert.notEqual(revised.id, keep.id);
    assert.equal(await planActive(), true, "keep planning must preserve active plan mode");
    t.diagnostic("keep-planning/deny + default message: DSH revised and requested a new review, mode active");
    const beforeInterrupt = fixture.requests.length;
    await agent.respondToPermission({ requestId: revised.id, response: { behavior: "deny", selectedActionId: "keep-planning", message: "Denied by user", interrupt: true } });
    await eventually("interrupted review finishes", async () => (await agent.refresh(), agent.status === "idle" && !agent.pendingPermissions?.length));
    assert.equal(fixture.requests.length, beforeInterrupt, `interrupt must conclude the turn without another model request; unexpected tool result: ${unexpectedContinuation}`);
    assert.equal(await planActive(), true, "interrupt must not approve the revised plan");
    t.diagnostic("interrupt:true: review canceled, no approval or model continuation, mode active");

    // Reopen the real DSH session so history is reconstructed through provider replay.
    assert.ok(await agent.reload());
    assert.equal(await planActive(), true, "native persisted plan mode survives reload");
    const replay = await agent.timeline.refetch({ limit: 200 });
    const items = replay.entries.map((entry: any) => entry.item);
    for (const plan of [approvedPlan, firstPlan, revisedPlan]) {
      assert.ok(items.some((item: any) => item.type === "tool_call" && item.detail?.type === "plan" && item.detail.text === plan), "replayed tool cards must retain the complete plan Markdown");
    }
    t.diagnostic("native session reload and host history replay retained all three Markdown plans");
  } finally {
    const closes = await Promise.allSettled([
      Promise.resolve().then(() => subscription?.()),
      Promise.resolve().then(() => client?.close()),
      Promise.resolve().then(() => driver?.close()),
    ]);
    closes.push(...await Promise.allSettled([
      Promise.resolve().then(() => daemon?.stop()),
      Promise.resolve().then(() => fixture?.close()),
    ]));
    // Also reap DSH/plugin descendants if a failed assertion interrupted normal shutdown.
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const env = await readFile(`/proc/${entry}/environ`).catch(() => Buffer.alloc(0));
      if (env.toString().split("\0").includes(`DSH_HOME=${path.join(root, "dsh")}`)) {
        try { process.kill(Number(entry), "SIGKILL"); } catch {}
      }
    }
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    assert.equal(await realpath(root), root);
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith("paseo-plan-review-e2e-"));
    await rm(root, { recursive: true, force: true });
    assert.equal(closes.filter(result => result.status === "rejected").length, 0, "isolated resources must close successfully");
  }
});
