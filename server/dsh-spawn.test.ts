import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultDshCommand, resolveDshSpawn, type DshSpawnHost } from "./dsh-spawn.js";

const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const BIN_JS = `${NPM}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
const PATH_ENV = { PATH: `C:\\Windows\\system32;${NPM}` };

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const DESKTOP = `${LOCAL}\\Programs\\DeepSeek Harness`;
const DESKTOP_EXE = `${DESKTOP}\\DeepSeek Harness.exe`;
const DESKTOP_ASAR = `${DESKTOP}\\resources\\app.asar`;
const DESKTOP_CLI = `${DESKTOP_ASAR}\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js`;
const DESKTOP_BIN = `${DESKTOP}\\resources\\runtime\\cli\\bin`;
const DESKTOP_FILES = [DESKTOP_EXE, DESKTOP_ASAR, `${DESKTOP_BIN}\\dsh.cmd`];

/** A Windows host whose filesystem holds exactly `files`, compared case-insensitively. */
function windows(files: string[]): DshSpawnHost {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return { platform: "win32", exists: (file) => present.has(file.toLowerCase()) };
}

/** The command line alone. */
function line(...parameters: Parameters<typeof resolveDshSpawn>) {
  const { command, args } = resolveDshSpawn(...parameters);
  return { command, args };
}

describe("resolveDshSpawn", () => {
  it("passes through unchanged off Windows, even when an npm layout is present", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const host: DshSpawnHost = { platform, exists: () => true };
      assert.deepEqual(resolveDshSpawn("dsh", ["--version"], PATH_ENV, host), {
        command: "dsh",
        args: ["--version"],
        env: PATH_ENV,
      });
    }
  });

  it("resolves an extensionless dsh found on PATH as dsh.cmd to node and bin.js", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(resolveDshSpawn("dsh", ["--profile", "paseo"], PATH_ENV, host), {
      command: "node",
      args: [BIN_JS, "--profile", "paseo"],
      env: PATH_ENV,
    });
  });

  it("resolves an extensionless dsh found on PATH as dsh.ps1 only", () => {
    const host = windows([`${NPM}\\dsh.ps1`, BIN_JS]);
    assert.deepEqual(line("dsh", ["--version"], PATH_ENV, host), { command: "node", args: [BIN_JS, "--version"] });
  });

  it("resolves an explicit dsh.cmd path without consulting PATH", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(line(`${NPM}\\dsh.cmd`, ["--version"], {}, host), { command: "node", args: [BIN_JS, "--version"] });
  });

  it("resolves an explicit dsh.ps1 path", () => {
    const host = windows([`${NPM}\\dsh.ps1`, BIN_JS]);
    assert.deepEqual(line(`${NPM}\\dsh.ps1`, [], {}, host), { command: "node", args: [BIN_JS] });
  });

  it("resolves a bare dsh.cmd name on PATH", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.equal(resolveDshSpawn("dsh.cmd", [], PATH_ENV, host).args[0], BIN_JS);
  });

  it("prefers a node.exe beside the wrapper, as the wrapper does", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS, `${NPM}\\node.exe`]);
    assert.deepEqual(line("dsh", ["--version"], PATH_ENV, host), { command: `${NPM}\\node.exe`, args: [BIN_JS, "--version"] });
  });

  it("keeps the launch's leading arguments after bin.js", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(resolveDshSpawn("dsh", ["--lead", "--version"], PATH_ENV, host).args, [BIN_JS, "--lead", "--version"]);
  });

  it("passes an explicit .exe through unchanged", () => {
    const host = windows(["D:\\tools\\dsh.exe", `${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(resolveDshSpawn("D:\\tools\\dsh.exe", ["--version"], PATH_ENV, host), {
      command: "D:\\tools\\dsh.exe",
      args: ["--version"],
      env: PATH_ENV,
    });
  });

  it("leaves a bare name to Node when a dsh.exe comes first on PATH", () => {
    const host = windows(["D:\\tools\\dsh.exe", `${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(line("dsh", [], { PATH: `D:\\tools;${NPM}` }, host), { command: "dsh", args: [] });
  });

  it("passes through when the wrapper directory has no bin.js", () => {
    const host = windows([`${NPM}\\dsh.cmd`]);
    assert.deepEqual(line("dsh", ["--version"], PATH_ENV, host), { command: "dsh", args: ["--version"] });
    assert.deepEqual(line(`${NPM}\\dsh.cmd`, [], {}, host), { command: `${NPM}\\dsh.cmd`, args: [] });
  });

  it("passes through when no wrapper is on PATH and DSH Desktop is not installed", () => {
    assert.deepEqual(line("dsh", [], { ...PATH_ENV, LOCALAPPDATA: LOCAL }, windows([])), { command: "dsh", args: [] });
  });

  it("reads the PATH variable case-insensitively", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.equal(resolveDshSpawn("dsh", [], { Path: NPM }, host).command, "node");
    assert.equal(resolveDshSpawn("dsh", [], { path: `"${NPM}"` }, host).command, "node");
  });
});

describe("resolveDshSpawn with DSH Desktop", () => {
  const desktop = (args: string[]) => ({ command: DESKTOP_EXE, args: ["--expose-internals", DESKTOP_CLI, ...args] });

  it("runs Desktop's dsh.cmd from PATH as the desktop executable in Node mode", () => {
    const env = { Path: DESKTOP_BIN };
    const spawn = resolveDshSpawn("dsh", ["--version"], env, windows(DESKTOP_FILES));
    assert.deepEqual({ command: spawn.command, args: spawn.args }, desktop(["--version"]));
    assert.deepEqual(spawn.env, { ...env, ELECTRON_RUN_AS_NODE: "1" });
  });

  it("accepts an explicit path to Desktop's dsh.cmd or to DeepSeek Harness.exe", () => {
    const host = windows(DESKTOP_FILES);
    assert.deepEqual(line(`${DESKTOP_BIN}\\dsh.cmd`, ["--version"], {}, host), desktop(["--version"]));
    assert.deepEqual(line(DESKTOP_EXE, ["--version"], {}, host), desktop(["--version"]));
  });

  it("falls back to Desktop's default install when PATH has no dsh", () => {
    const env = { ...PATH_ENV, LocalAppData: LOCAL };
    assert.deepEqual(line("dsh", ["--version"], env, windows([DESKTOP_EXE, DESKTOP_ASAR])), desktop(["--version"]));
  });

  it("prefers an npm dsh on PATH over an installed Desktop", () => {
    const env = { ...PATH_ENV, LOCALAPPDATA: LOCAL };
    assert.equal(line("dsh", [], env, windows([`${NPM}\\dsh.cmd`, BIN_JS, ...DESKTOP_FILES])).command, "node");
  });

  it("does not fall back to Desktop for a configured command that is not found", () => {
    const env = { ...PATH_ENV, LOCALAPPDATA: LOCAL };
    assert.deepEqual(line("D:\\missing\\dsh", [], env, windows(DESKTOP_FILES)), { command: "D:\\missing\\dsh", args: [] });
  });

  it("passes DeepSeek Harness.exe through when its app.asar is missing", () => {
    assert.deepEqual(line(DESKTOP_EXE, [], {}, windows([DESKTOP_EXE])), { command: DESKTOP_EXE, args: [] });
  });
});

describe("defaultDshCommand", () => {
  const env = { ...PATH_ENV, LOCALAPPDATA: LOCAL };

  it("registers dsh off Windows and whenever PATH has a dsh", () => {
    assert.equal(defaultDshCommand(env, { platform: "linux", exists: () => true }), "dsh");
    assert.equal(defaultDshCommand(env, windows([`${NPM}\\dsh.cmd`, BIN_JS, ...DESKTOP_FILES])), "dsh");
    assert.equal(defaultDshCommand(env, windows(["C:\\Windows\\system32\\dsh.exe", ...DESKTOP_FILES])), "dsh");
  });

  it("registers DSH Desktop's executable when PATH has no dsh and Desktop is installed", () => {
    assert.equal(defaultDshCommand(env, windows([DESKTOP_EXE, DESKTOP_ASAR])), DESKTOP_EXE);
  });

  it("registers dsh when neither is present, so Paseo reports dsh missing", () => {
    assert.equal(defaultDshCommand(env, windows([])), "dsh");
    assert.equal(defaultDshCommand(PATH_ENV, windows([DESKTOP_EXE, DESKTOP_ASAR])), "dsh");
  });
});
