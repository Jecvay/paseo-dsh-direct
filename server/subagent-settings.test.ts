import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentSettingsAccess, subagentSettingsTargetKey } from "./subagent-settings.js";
import type { DshBridge } from "./bridge-client.js";
import type { SubagentSettingsView } from "../shared/subagent-settings.js";
import { subagentSelectionSchema } from "../shared/subagent-settings.js";

const view: SubagentSettingsView = {
  supported: true, profile: "paseo", revision: "content-hash", initialized: true,
  selection: { enabled: true, allowedModels: [{ provider: "test", model: "group/small" }] },
  models: [{ provider: "test", model: "group/small", name: "Small", providerName: "Test" }],
  failedProviders: [],
};
function fixture() {
  let closed = 0;
  let opened = 0;
  let profile = "paseo";
  let fail = false;
  const requests: Array<{ method: string; params: unknown }> = [];
  const access = createSubagentSettingsAccess({
    target: async () => ({ configured: { profile } }),
    open: async () => {
      opened++;
      return {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params });
          if (fail) throw new Error("settings unavailable");
          return view;
        },
        close: async () => { closed++; },
      } as DshBridge;
    },
  });
  return { access, requests, get opened() { return opened; }, get closed() { return closed; },
    setProfile(value: string) { profile = value; }, fail() { fail = true; } };
}

test("settings operations close their bridges and carry only the native revision back to DSH", async () => {
  const f = fixture();
  const read = await f.access.read();
  assert.notEqual(read.revision, view.revision);
  await f.access.save({ profile: read.profile, revision: read.revision, selection: read.selection });
  assert.deepEqual(f.requests[1], { method: "subagent.settings.save", params: {
    profile: "paseo", revision: "content-hash", selection: view.selection,
  } });
  assert.equal(f.closed, 2);
  await f.access.dispose();
  await assert.rejects(f.access.read(), /shutting down/);
});

test("a draft cannot save into a different profile", async () => {
  const f = fixture();
  const read = await f.access.read();
  f.setProfile("other");
  await assert.rejects(f.access.save({ profile: read.profile, revision: read.revision, selection: read.selection }), /launch settings changed/);
  assert.equal(f.opened, 1);
});

test("a failed RPC still releases its bridge", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.access.read(), /settings unavailable/);
  assert.equal(f.closed, 1);
});

test("draft identity includes the executable, launch arguments and DSH home", () => {
  const base = { configured: {}, launch: { command: "dsh", args: [], env: { DSH_HOME: "/one" } } };
  const original = subagentSettingsTargetKey(base);
  assert.notEqual(original, subagentSettingsTargetKey({ ...base, configured: { executable: "/other/dsh" } }));
  assert.notEqual(original, subagentSettingsTargetKey({ ...base, launch: { ...base.launch, args: ["--option"] } }));
  assert.notEqual(original, subagentSettingsTargetKey({ ...base, launch: { ...base.launch, env: { DSH_HOME: "/two" } } }));
});

test("selection validation rejects enabled empty lists and duplicate exact routes", () => {
  assert.equal(subagentSelectionSchema.safeParse({ enabled: true, allowedModels: [] }).success, false);
  assert.equal(subagentSelectionSchema.safeParse({ enabled: false, allowedModels: [] }).success, true);
  assert.equal(subagentSelectionSchema.safeParse({ enabled: true, allowedModels: [...view.selection.allowedModels, ...view.selection.allowedModels] }).success, false);
});
