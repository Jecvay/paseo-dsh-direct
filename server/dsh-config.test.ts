import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDshLaunch } from "./bridge-client.js";
import { currentDshConfigured, mergeDshConfigured, readDshSettings, type DshSettingsSource } from "./dsh-config.js";

const launch = { command: "/paseo/dsh", args: ["--flag"] };

/** The executable `status()` and `createBridge` end up with for these inputs. */
const effectiveExecutable = (
  env: Record<string, string>,
  settings: { executable?: string } | undefined,
  paseoLaunch?: typeof launch,
) => resolveDshLaunch(mergeDshConfigured(env, settings).executable, paseoLaunch);

describe("dsh executable precedence", () => {
  it("prefers PASEO_DSH_EXECUTABLE over the setting, Paseo's launch and the default", () => {
    assert.deepEqual(effectiveExecutable({ PASEO_DSH_EXECUTABLE: "/env/dsh" }, { executable: "/set/dsh" }, launch), {
      command: "/env/dsh",
      args: [],
    });
  });

  it("prefers the setting over Paseo's launch", () => {
    assert.deepEqual(effectiveExecutable({}, { executable: " /set/dsh " }, launch), { command: "/set/dsh", args: [] });
  });

  it("prefers Paseo's launch (with its arguments) over the default", () => {
    assert.deepEqual(effectiveExecutable({}, undefined, launch), { command: "/paseo/dsh", args: ["--flag"] });
  });

  it("falls back to dsh on PATH", () => {
    assert.deepEqual(effectiveExecutable({}, undefined), { command: "dsh", args: [] });
  });

  it("treats blank values as unset at every step", () => {
    assert.deepEqual(effectiveExecutable({ PASEO_DSH_EXECUTABLE: "  " }, { executable: "" }, launch), {
      command: "/paseo/dsh",
      args: ["--flag"],
    });
    assert.deepEqual(effectiveExecutable({ PASEO_DSH_EXECUTABLE: " " }, { executable: "/set/dsh" }), {
      command: "/set/dsh",
      args: [],
    });
  });
});

describe("dsh profile precedence", () => {
  it("prefers PASEO_DSH_PROFILE, then the setting, then unset (the default profile)", () => {
    assert.equal(mergeDshConfigured({ PASEO_DSH_PROFILE: "env" }, { profile: "set" }).profile, "env");
    assert.equal(mergeDshConfigured({ PASEO_DSH_PROFILE: " " }, { profile: " set " }).profile, "set");
    assert.equal(mergeDshConfigured({}, { profile: "" }).profile, undefined);
    assert.equal(mergeDshConfigured({}, undefined).profile, undefined);
  });
});

describe("reading the settings", () => {
  const source = (state: Awaited<ReturnType<DshSettingsSource["read"]>>): DshSettingsSource => ({ read: async () => state });

  it("returns the values of ready settings", async () => {
    const lines: string[] = [];
    assert.deepEqual(await readDshSettings(source({ status: "ready", values: { profile: "p" } }), (l) => lines.push(l)), { profile: "p" });
    assert.deepEqual(lines, []);
  });

  it("treats invalid settings as unset and writes one warning line", async () => {
    const lines: string[] = [];
    assert.equal(await readDshSettings(source({ status: "invalid", error: "bad" }), (l) => lines.push(l)), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /invalid.*bad/);
  });

  it("treats a failing read as unset", async () => {
    const lines: string[] = [];
    const failing: DshSettingsSource = { read: async () => Promise.reject(new Error("rpc down")) };
    assert.equal(await readDshSettings(failing, (l) => lines.push(l)), undefined);
    assert.equal(lines.length, 1);
  });

  it("re-reads on every call so a changed setting applies to the next launch", async () => {
    let values = { profile: "one" };
    const live: DshSettingsSource = { read: async () => ({ status: "ready", values }) };
    assert.equal((await currentDshConfigured({}, live)).profile, "one");
    values = { profile: "two" };
    assert.equal((await currentDshConfigured({}, live)).profile, "two");
  });
});
