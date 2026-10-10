import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { BridgeInitializeResult } from "../shared/bridge-protocol.js";
import {
  assertBridgeHandshake,
  assertSurfaceRowsPresent,
  createBridgePatch,
  DEFAULT_PROFILE,
  DISABLED_SURFACE_ROWS,
  dumpedRowIds,
  ensureDshProfile,
  missingSurfaceRows,
  resolveDshExecutable,
  resolveDshHome,
  resolveDshLaunch,
} from "./bridge-client.js";

describe("resolveDshHome", () => {
  it("follows DSH_HOME, ignores a blank value, and expands a tilde", () => {
    assert.equal(resolveDshHome({}), path.join(homedir(), ".dsh"));
    assert.equal(resolveDshHome({ DSH_HOME: "   " }), path.join(homedir(), ".dsh"));
    assert.equal(resolveDshHome({ DSH_HOME: "/srv/dsh/" }), "/srv/dsh");
    assert.equal(resolveDshHome({ DSH_HOME: "~/alt" }), path.join(homedir(), "alt"));
  });
});

describe("createBridgePatch", () => {
  it("disables the web surface rows before inserting the bridge", () => {
    const patch = createBridgePatch({ profile: "paseo", bridgePath: "/tmp/b/dsh-bridge.mjs" });
    assert.deepEqual(
      patch.slice(0, DISABLED_SURFACE_ROWS.length),
      DISABLED_SURFACE_ROWS.map((id) => ({ id, disabled: true })),
    );
    assert.ok(DISABLED_SURFACE_ROWS.includes("web-startup"));
    // Otherwise the browser forwarder takes approvals and questions first and never answers.
    assert.ok(DISABLED_SURFACE_ROWS.includes("api-remotes"));
    assert.deepEqual(patch.at(-1), {
      insert: [{ id: "paseo-dsh-bridge", name: "/tmp/b/dsh-bridge.mjs", config: { profile: "paseo" } }],
    });
    assert.ok(!JSON.stringify(patch).includes("preset-"));
  });

  it("adds ephemeral storage and MCP servers", () => {
    const patch = createBridgePatch({
      profile: "paseo",
      bridgePath: "/b.mjs",
      sessionsRoot: "/tmp/s",
      mcpServers: [{ serverName: "x", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" }],
    });
    assert.deepEqual(patch[DISABLED_SURFACE_ROWS.length], {
      id: "session-persistence-jsonl",
      config: { root: "/tmp/s" },
    });
    const insert = (patch.at(-1) as { insert: Array<{ id: string }> }).insert;
    assert.deepEqual(insert.map((row) => row.id), ["paseo-mcp-x", "paseo-dsh-bridge"]);
  });
});

describe("ensureDshProfile", () => {
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-dsh-profile-test-"));
    const home = path.join(root, "home");
    const log = path.join(root, "calls.log");
    const executable = path.join(root, "fake-dsh");
    // Records its arguments and creates the profile directory like `dsh --from-default-profile`.
    await writeFile(
      executable,
      `#!/bin/sh\necho "$@" >> "${log}"\nmkdir -p "$DSH_HOME/profiles/$2"\necho tree\n`,
    );
    await chmod(executable, 0o755);
    return { root, home, log, executable, env: { ...process.env, DSH_HOME: home } };
  }

  it("creates the default profile once from the web template", async () => {
    const f = await fixture();
    try {
      await ensureDshProfile({ executable: f.executable, profile: DEFAULT_PROFILE, env: f.env });
      await ensureDshProfile({ executable: f.executable, profile: DEFAULT_PROFILE, env: f.env });
      assert.ok((await stat(path.join(f.home, "profiles", DEFAULT_PROFILE))).isDirectory());
      assert.equal(
        await readFile(f.log, "utf8"),
        `--profile ${DEFAULT_PROFILE} --from-default-profile web --dump-config\n`,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("reports a missing explicit profile instead of creating it", async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        ensureDshProfile({ executable: f.executable, profile: "custom", env: f.env }),
        /DSH profile "custom" does not exist.*--from-default-profile web/,
      );
      await assert.rejects(stat(f.log));
      await mkdir(path.join(f.home, "profiles", "custom"), { recursive: true });
      await ensureDshProfile({ executable: f.executable, profile: "custom", env: f.env });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("resolveDshLaunch", () => {
  const launch = { command: "/opt/bin/dsh", args: ["run", "dsh"] };

  it("prefers PASEO_DSH_EXECUTABLE, then Paseo's launch, then dsh from PATH", () => {
    assert.deepEqual(resolveDshLaunch(" /custom/dsh ", launch), { command: "/custom/dsh", args: [] });
    assert.deepEqual(resolveDshLaunch(undefined, launch), launch);
    assert.deepEqual(resolveDshLaunch("   ", launch), launch);
    assert.deepEqual(resolveDshLaunch(undefined), { command: "dsh", args: [] });
    assert.equal(resolveDshExecutable("", launch), "/opt/bin/dsh");
    assert.equal(resolveDshExecutable(undefined), "dsh");
  });
});

describe("profile row guard", () => {
  const yaml = DISABLED_SURFACE_ROWS.map((id) => `- id: ${id}\n  name: x`).join("\n");

  it("finds row ids in YAML and JSON dumps", () => {
    assert.deepEqual([...dumpedRowIds(yaml)].sort(), [...DISABLED_SURFACE_ROWS].sort());
    const json = JSON.stringify(DISABLED_SURFACE_ROWS.map((id) => ({ id })));
    assert.deepEqual(missingSurfaceRows(json), []);
    assert.deepEqual(missingSurfaceRows(yaml.replace("id: webserver", "id: http-server")), ["webserver"]);
  });

  const launch = { command: "dsh", args: [] };
  const run = (dump: string | Error) =>
    assertSurfaceRowsPresent({
      launch,
      profile: "paseo",
      env: {},
      dshVersionOf: async () => "0.2.7",
      dump: async () => {
        if (dump instanceof Error) throw dump;
        return dump;
      },
    });

  it("passes when every disabled row exists", async () => {
    await run(yaml);
  });

  it("names the missing row and the dsh version", async () => {
    await assert.rejects(run(yaml.replace("id: api-remotes", "id: remotes")), /DSH 0\.2\.7.*"api-remotes"/);
  });

  it("has no evidence to act on when the dump fails or is empty", async () => {
    await run(new Error("exit 1"));
    await run("  \n");
  });
});

describe("assertBridgeHandshake", () => {
  const base: BridgeInitializeResult = {
    protocolVersion: 1,
    profile: "paseo",
    capabilities: { stream: true, approvals: true, questions: true, history: true, cancel: true },
    catalog: { models: [], presets: [] },
  };

  it("accepts a handshake with nothing missing", () => {
    assertBridgeHandshake(base, "0.2.7");
    assertBridgeHandshake({ ...base, missing: [] }, "0.2.7");
  });

  it("lists what is missing with the dsh version", () => {
    assert.throws(
      () => assertBridgeHandshake({ ...base, missing: ["agents.resume", "llm"] }, "0.3.0"),
      /DSH 0\.3\.0.*agents\.resume, llm/,
    );
  });
});
