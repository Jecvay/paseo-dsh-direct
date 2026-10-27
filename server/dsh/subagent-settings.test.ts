import assert from "node:assert/strict";
import test from "node:test";
import type { HostContext, HostServices, HostSettings } from "./host.js";
import { SubagentSettings } from "./subagent-settings.js";

const NS = "subagent-model-selection-settings";
const route = { provider: "available", model: "org/model" };
const enabled = { enabled: true, allowedModels: [route] };
const disabled = { enabled: false, allowedModels: [] };
function conflict(): Error {
  return Object.assign(new Error("settings changed"), { code: "SETTINGS_CONFLICT" });
}
function fixture(initial: Record<string, unknown> = {}) {
  let raw = structuredClone(initial);
  let revision = 0;
  let base: unknown = disabled;
  let user: unknown = raw;
  let documentPath = "/test/profile/cordis.patch.yml";
  let beforeModels: (() => void) | undefined;
  let beforeMutate: (() => void) | undefined;
  let failure: Error | undefined;
  let models = [{ id: route.model }];
  const writes: Array<{ ns: string; ops: unknown; revision: number }> = [];
  const settings: HostSettings = {
    get documentPath() { return documentPath; },
    describe(options) {
      assert.deepEqual(options, { redactSecrets: true });
      return [{ ns: NS, revision, value: { ...disabled, ...raw }, base, user }];
    },
    async mutate(ns, ops, expectedRevision) {
      writes.push({ ns, ops: structuredClone(ops), revision: expectedRevision });
      beforeMutate?.();
      if (failure) throw failure;
      if (revision !== expectedRevision) throw conflict();
      assert.equal(ns, NS);
      assert.deepEqual(ops.map(op => [op.op, op.path]), [
        ["set", ["enabled"]], ["set", ["allowedModels"]],
      ]);
      for (const op of ops) raw[op.path[0]!] = structuredClone(op.value);
      user = structuredClone(raw);
      revision++;
    },
  };
  const services: Pick<HostServices, "settings" | "configEditor" | "llm"> = {
    settings,
    configEditor: { configuration: () => [{ entry: { options: { id: NS, config: raw } } }] },
    llm: {
      listProviders: () => [{ id: "broken" }, { id: route.provider, name: "Available" }],
      listModels: async provider => {
        beforeModels?.();
        if (provider === "broken") throw new Error("offline");
        return models;
      },
    },
  };
  const ctx = { get: (name: keyof typeof services) => services[name] } as HostContext;
  return {
    subject: new SubagentSettings(ctx, "paseo"), ctx, services, writes,
    get raw() { return raw; },
    setRaw(value: Record<string, unknown>) { raw = value; user = value; revision++; },
    setRevision(value: number) { revision = value; },
    setBase(value: unknown) { base = value; },
    setUser(value: unknown) { user = value; },
    setDocumentPath(value: string) { documentPath = value; },
    setModels(value: typeof models) { models = value; },
    beforeModels(callback: () => void) { beforeModels = callback; },
    beforeMutate(callback: () => void) { beforeMutate = callback; },
    fail(error: Error) { failure = error; },
  };
}

test("initialization selects successful routes atomically, reports failed providers and stays fixed", async () => {
  const f = fixture({ other: "preserved" });
  f.setRevision(7);
  await f.subject.initialize();
  assert.deepEqual(f.raw, { other: "preserved", ...enabled });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.revision, 7);
  const view = await f.subject.read();
  assert.equal(view.initialized, true);
  assert.deepEqual(view.selection, enabled);
  assert.deepEqual(view.failedProviders, ["broken"]);
  assert.deepEqual(view.models, [{ ...route, name: route.model, providerName: "Available" }]);
  f.setModels([{ id: route.model }, { id: "new-model" }]);
  await f.subject.initialize();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.raw.allowedModels, [route]);
});

for (const config of [{ enabled: false }, { allowedModels: [] }, enabled, disabled]) {
  test(`initialization preserves explicit config ${JSON.stringify(config)}`, async () => {
    const f = fixture(config);
    await f.subject.initialize();
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.raw, config);
    assert.equal((await f.subject.read()).initialized, true);
  });
}

test("no successful models leaves raw settings uninitialized and permits later discovery", async () => {
  const f = fixture();
  f.setModels([]);
  await f.subject.initialize();
  assert.equal(f.writes.length, 0);
  assert.equal((await f.subject.read()).initialized, false);
  f.setModels([{ id: route.model }]);
  await f.subject.initialize();
  assert.deepEqual(f.raw, enabled);
});

test("duplicate catalog rows are selected once, preserving exact slash-containing routes", async () => {
  const f = fixture();
  f.setModels([{ id: route.model }, { id: route.model }]);
  await f.subject.initialize();
  assert.deepEqual(f.raw, enabled);
});

test("initializer keeps a competing explicit configuration written during discovery", async () => {
  const f = fixture();
  let once = false;
  f.beforeModels(() => {
    if (!once) { once = true; f.setRaw(disabled); }
  });
  await f.subject.initialize();
  assert.deepEqual(f.raw, disabled);
  assert.equal(f.writes[0]!.revision, 0);
});

test("initializer rejects conflicts that still leave settings unconfigured", async () => {
  const f = fixture();
  f.beforeMutate(() => f.setRaw({ other: 2 }));
  await assert.rejects(f.subject.initialize(), /settings changed/);
  assert.deepEqual(f.raw, { other: 2 });
});

test("non-conflict initialization failures are not hidden by a concurrent configuration", async () => {
  const f = fixture();
  f.beforeMutate(() => f.setRaw(disabled));
  f.fail(new Error("disk full"));
  await assert.rejects(f.subject.initialize(), /disk full/);
});

test("read tokens are stable across process revisions and object key order", async () => {
  const first = fixture({ ...enabled, other: { b: 2, a: 1 } });
  const second = fixture({ other: { a: 1, b: 2 }, allowedModels: [route], enabled: true });
  second.setRevision(42);
  const a = await first.subject.read();
  const b = await second.subject.read();
  assert.equal(a.revision, b.revision);
  const saved = await second.subject.save({ profile: a.profile, revision: a.revision, selection: disabled });
  assert.deepEqual(saved.selection, disabled);
  assert.equal(second.writes[0]!.revision, 42);
  assert.equal(second.raw.other && typeof second.raw.other, "object");
});

for (const change of ["raw", "base", "user", "document", "profile"] as const) {
  test(`save token detects ${change} changes even with equal numeric revisions`, async () => {
    const f = fixture(enabled);
    const old = await f.subject.read();
    if (change === "raw") f.setRaw({ ...enabled, other: true });
    if (change === "base") f.setBase(enabled);
    if (change === "user") f.setUser({ ...enabled, other: true });
    if (change === "document") f.setDocumentPath("/other/profile/cordis.patch.yml");
    f.setRevision(0);
    const target = change === "profile" ? new SubagentSettings(f.ctx, "other") : f.subject;
    await assert.rejects(target.save({ profile: old.profile, revision: old.revision, selection: disabled }), /changed/);
    assert.equal(f.writes.length, 0);
  });
}

test("save uses the native revision to reject changes after token verification", async () => {
  const f = fixture(enabled);
  const old = await f.subject.read();
  f.beforeMutate(() => f.setRaw({ enabled: false, allowedModels: [route] }));
  await assert.rejects(f.subject.save({ profile: old.profile, revision: old.revision, selection: disabled }), /changed/);
  assert.deepEqual(f.raw.allowedModels, [route]);
});

test("save preserves selected routes absent from the currently available catalog", async () => {
  const f = fixture(disabled);
  const old = await f.subject.read();
  const selection = { enabled: false, allowedModels: [{ provider: "offline", model: "a/b" }] };
  const saved = await f.subject.save({ profile: old.profile, revision: old.revision, selection });
  assert.deepEqual(saved.selection, selection);
});

test("runtime validation rejects malformed, empty enabled, and duplicate route writes", async () => {
  const f = fixture(enabled);
  const old = await f.subject.read();
  for (const selection of [null, { enabled: "true", allowedModels: [] },
    { enabled: true, allowedModels: [] }, { enabled: false, allowedModels: [route, route] },
    { enabled: false, allowedModels: [{ provider: "", model: "x" }] }]) {
    await assert.rejects(f.subject.save({ profile: old.profile, revision: old.revision, selection }));
  }
  assert.equal(f.writes.length, 0);
});

for (const missing of ["settings", "configEditor", "namespace"] as const) {
  test(`missing ${missing} returns unsupported and performs no writes`, async () => {
    const f = fixture();
    if (missing === "namespace") f.services.configEditor = { configuration: () => [] };
    else f.services[missing] = undefined;
    await f.subject.initialize();
    const view = await f.subject.read();
    assert.equal(view.supported, false);
    assert.equal(view.profile, "paseo");
    assert.equal(f.writes.length, 0);
    assert.equal((await f.subject.save({ profile: "paseo", revision: "old", selection: disabled })).supported, false);
  });
}

test("settings read failures remain visible", async () => {
  const f = fixture();
  f.services.settings!.describe = () => { throw new Error("invalid profile document"); };
  await assert.rejects(f.subject.read(), /invalid profile document/);
});
