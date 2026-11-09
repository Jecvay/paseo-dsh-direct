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
  launchDshBridge,
  missingSurfaceRows,
  parseBridgeLine,
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

  it("aborts profile creation and waits until its child has exited", async () => {
    const f = await fixture();
    const record = path.join(f.root, "profile-child.json");
    await writeFile(f.executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const controller = new AbortController();
    try {
      const creating = ensureDshProfile({ executable: f.executable, profile: DEFAULT_PROFILE, env: f.env, signal: controller.signal });
      while (true) {
        try { await stat(record); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      controller.abort();
      await assert.rejects(creating, { name: "AbortError" });
      const pid = Number((await readFile(record, "utf8")).trim());
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

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

  it("does not swallow cancellation when the profile dump fails", async () => {
    const controller = new AbortController();
    await assert.rejects(assertSurfaceRowsPresent({
      launch,
      profile: "paseo",
      env: {},
      signal: controller.signal,
      dshVersionOf: async () => "",
      dump: async () => {
        controller.abort();
        throw new Error("terminated");
      },
    }), { name: "AbortError" });
  });
});

describe("parseBridgeLine", () => {
  it("returns protocol messages", () => {
    const ready = { jsonrpc: "2.0", method: "bridge.ready", params: { protocolVersion: 1 } };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    assert.deepEqual(parseBridgeLine(JSON.stringify(ready)), ready);
    assert.deepEqual(parseBridgeLine(JSON.stringify(response)), response);
  });

  it("skips dsh's own stdout log lines", () => {
    // The deepseek-account model catalog logs to stdout in dsh 0.2.1; the
    // bridge must not treat that line as a protocol failure.
    assert.equal(
      parseBridgeLine(
        "[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)",
      ),
      undefined,
    );
    assert.equal(parseBridgeLine('{"truncated":'), undefined);
  });

  it("skips JSON that is not a protocol object", () => {
    for (const line of ["null", "42", '"log"', "[]", "true"]) assert.equal(parseBridgeLine(line), undefined);
  });
});

describe("bridge ready deadline", () => {
  async function fixture(mode: "delayed" | "never" | "exit") {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-ready-test-"));
    const home = path.join(root, "home");
    const record = path.join(root, "child.json");
    await mkdir(path.join(home, "profiles", "fixture"), { recursive: true });
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(1);
      if (args.includes('--dump-config')) {
        console.log(${JSON.stringify(DISABLED_SURFACE_ROWS.map(id => `- id: ${id}`).join("\n"))});
        process.exit(0);
      }
      const patch = args[args.indexOf('--patch') + 1];
      fs.writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify({ pid: process.pid, directory: path.dirname(patch) }));
      if (process.env.FIXTURE_MODE === 'exit') process.exit(7);
      const send = value => console.log(JSON.stringify(value));
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'bridge.initialize') {
          // Initialization may take longer than the already completed ready wait.
          setTimeout(() => send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, catalog: { models: [], presets: [] }, capabilities: {} } }), 1_700);
        } else if (request.method === 'bridge.shutdown') {
          process.exit(0);
        }
      });
      if (process.env.FIXTURE_MODE !== 'never') setTimeout(() => send({ jsonrpc: '2.0', method: 'bridge.ready', params: {} }), 400);
    `;
    const bridges: Awaited<ReturnType<typeof launchDshBridge>>[] = [];
    const open = async (startupTimeoutMs: number) => {
      const bridge = await launchDshBridge({
        bridgeSource: "",
        profile: "fixture",
        startupTimeoutMs,
        providerLaunch: {
          command: process.execPath,
          args: ["-e", script, "--"],
          env: { ...process.env, DSH_HOME: home, FIXTURE_RECORD: record, FIXTURE_MODE: mode } as Record<string, string>,
        },
      });
      bridges.push(bridge);
      return bridge;
    };
    const dispose = async () => Promise.allSettled(bridges.map((bridge) => bridge.close()));
    const assertCleaned = async () => {
      const child = JSON.parse(await readFile(record, "utf8")) as { pid: number; directory: string };
      assert.throws(() => process.kill(child.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      await assert.rejects(stat(child.directory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    };
    return { root, open, bridges, dispose, assertCleaned };
  }

  it("allows delayed ready with a wider deadline and keeps initialization independent", async () => {
    const f = await fixture("delayed");
    try {
      await assert.rejects(f.open(200), /did not become ready within 200ms/);
      await f.assertCleaned();
      const bridge = await f.open(2_000);
      try { assert.equal(bridge.initialized.protocolVersion, 1); }
      finally { await bridge.close(); }
      await f.assertCleaned();
    } finally { await f.dispose(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("aborts a long never-ready startup and removes its child and temporary directory", async () => {
    const f = await fixture("never");
    const controller = new AbortController();
    try {
      const opening = launchDshBridge({
        bridgeSource: "",
        profile: "fixture",
        startupTimeoutMs: 600_000,
        signal: controller.signal,
        providerLaunch: {
          command: process.execPath,
          args: ["-e", `const fs=require('node:fs');const path=require('node:path');const p=process.argv.slice(1);if(p.includes('--dump-config')){console.log(${JSON.stringify(DISABLED_SURFACE_ROWS.map(id => `- id: ${id}`).join("\\n"))});process.exit(0)}const patch=p[p.indexOf('--patch')+1];fs.writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({pid:process.pid,directory:path.dirname(patch)}));setInterval(()=>{},1000);`, "--"],
          env: { ...process.env, DSH_HOME: path.join(f.root, "home"), FIXTURE_RECORD: path.join(f.root, "child.json") } as Record<string, string>,
        },
      });
      while (true) {
        try { await stat(path.join(f.root, "child.json")); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      const child = JSON.parse(await readFile(path.join(f.root, "child.json"), "utf8")) as { pid: number; directory: string };
      const abortedAt = Date.now();
      controller.abort();
      await assert.rejects(opening, { name: "AbortError" });
      assert.ok(Date.now() - abortedAt < 1_000, "abort should not wait for the startup deadline");
      assert.throws(() => process.kill(child.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      await assert.rejects(stat(child.directory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    } finally { await f.dispose(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("reports an early exit instead of waiting for the ready deadline", async () => {
    const f = await fixture("exit");
    try {
      await assert.rejects(f.open(5_000), /exited with code 7/);
      await f.assertCleaned();
    } finally { await f.dispose(); await rm(f.root, { recursive: true, force: true }); }
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
