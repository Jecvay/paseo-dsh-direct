import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchDshBridge, type DshBridge } from "./bridge-client.js";
import { DSH_BRIDGE_SOURCE } from "./generated-bridge.js";

// Uses the installed DSH with a temporary home. No model request or real profile write.
test("native DSH persists initialization, rejects stale edits and preserves session policies", {
  skip: process.env.DSH_SETTINGS_E2E !== "1",
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-subagent-settings-e2e-"));
  const profile = path.join(home, "profiles", "paseo");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-paseo", private: true, dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  }));
  await writeFile(path.join(profile, "cordis.yml"), "[]\n");
  await writeFile(path.join(profile, "cordis.patch.yml"), "[]\n");
  const bridges: DshBridge[] = [];
  const open = async () => {
    const bridge = await launchDshBridge({
      bridgeSource: DSH_BRIDGE_SOURCE,
      profile: "paseo",
      env: { DSH_HOME: home, DEEPSEEK_API_KEY: "test-key-no-requests" },
      startupTimeoutMs: 30_000,
    });
    bridges.push(bridge);
    return bridge;
  };
  try {
    const first = await open();
    const initial = await first.request("subagent.settings.read", {});
    assert.equal(initial.supported, true);
    assert.equal(initial.initialized, true);
    assert.equal(initial.selection.enabled, true);
    assert.ok(initial.models.length > 0);
    assert.equal(initial.selection.allowedModels.length, initial.models.length);
    const session = await first.request("session.open", { cwd: home });
    const history = await first.request("session.read", { sessionId: session.sessionId });
    assert.ok(history.events.some(event => event.type === "subagent/model-selection-policy"));
    await first.request("session.close", { sessionId: session.sessionId });
    await first.close();

    const second = await open();
    const reloaded = await second.request("subagent.settings.read", {});
    assert.equal(reloaded.revision, initial.revision, "revision survives bridge restart");
    const disabled = await second.request("subagent.settings.save", {
      profile: "paseo", revision: initial.revision,
      selection: { enabled: false, allowedModels: [] },
    });
    assert.equal(disabled.selection.enabled, false);
    await assert.rejects(second.request("subagent.settings.save", {
      profile: "paseo", revision: initial.revision, selection: initial.selection,
    }), /changed|revision/i);
    await second.close();

    const third = await open();
    const final = await third.request("subagent.settings.read", {});
    assert.deepEqual(final.selection, { enabled: false, allowedModels: [] });
    const resumed = await third.request("session.open", { sessionId: session.sessionId, resume: true, cwd: home });
    assert.ok(resumed.events.some(event => event.type === "subagent/model-selection-policy"));
    await third.request("session.close", { sessionId: session.sessionId });
    const fresh = await third.request("session.open", { cwd: home });
    const freshHistory = await third.request("session.read", { sessionId: fresh.sessionId });
    assert.equal(freshHistory.events.some(event => event.type === "subagent/model-selection-policy"), false);
    await third.request("session.close", { sessionId: fresh.sessionId });
  } finally {
    await Promise.allSettled(bridges.map(bridge => bridge.close()));
  }
});
