import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDshLaunch, type DshLaunchHost } from "./dsh-launch.js";

const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const BIN_JS = `${NPM}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
const PATH_ENV = { Path: `C:\\Windows;${NPM}` };

/** A Windows host whose filesystem holds exactly `files` (case-insensitive). */
function windows(files: string[]): DshLaunchHost {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return { platform: "win32", exists: (file) => present.has(file.toLowerCase()) };
}

describe("resolveDshLaunch", () => {
  it("passes the executable through unchanged off Windows", () => {
    const host: DshLaunchHost = { platform: "linux", exists: () => true };
    assert.deepEqual(resolveDshLaunch("dsh", ["--version"], { PATH: "/usr/bin" }, host), {
      command: "dsh",
      args: ["--version"],
    });
  });

  it("resolves the npm dsh.cmd wrapper found on PATH to node and bin.js", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(resolveDshLaunch("dsh", ["--profile", "paseo"], PATH_ENV, host), {
      command: "node",
      args: [BIN_JS, "--profile", "paseo"],
    });
  });

  it("reads PATH case-insensitively, as Windows does", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.equal(resolveDshLaunch("dsh", [], { PATH: NPM }, host).command, "node");
  });

  it("prefers a node.exe installed beside the wrapper", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS, `${NPM}\\node.exe`]);
    assert.equal(resolveDshLaunch("dsh", [], PATH_ENV, host).command, `${NPM}\\node.exe`);
  });

  it("accepts an explicit path to the .cmd wrapper without consulting PATH", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.deepEqual(resolveDshLaunch(`${NPM}\\dsh.cmd`, ["--version"], {}, host), {
      command: "node",
      args: [BIN_JS, "--version"],
    });
  });

  it("accepts an explicit extensionless path to the wrapper", () => {
    const host = windows([`${NPM}\\dsh.cmd`, BIN_JS]);
    assert.equal(resolveDshLaunch(`${NPM}\\dsh`, [], {}, host).args[0], BIN_JS);
  });

  it("runs a .js entry point through node", () => {
    assert.deepEqual(resolveDshLaunch("D:\\dsh\\lib\\bin.js", ["--version"], PATH_ENV, windows([])), {
      command: "node",
      args: ["D:\\dsh\\lib\\bin.js", "--version"],
    });
  });

  it("passes a real executable through unchanged", () => {
    const host = windows(["D:\\tools\\dsh.exe"]);
    assert.deepEqual(resolveDshLaunch("D:\\tools\\dsh.exe", ["--version"], PATH_ENV, host), {
      command: "D:\\tools\\dsh.exe",
      args: ["--version"],
    });
  });

  it("passes through when the wrapper is not the npm dsh layout", () => {
    const host = windows([`${NPM}\\dsh.cmd`]);
    assert.deepEqual(resolveDshLaunch("dsh", ["--version"], PATH_ENV, host), { command: "dsh", args: ["--version"] });
  });

  it("passes through when no wrapper is on PATH", () => {
    assert.deepEqual(resolveDshLaunch("dsh", [], PATH_ENV, windows([])), { command: "dsh", args: [] });
  });
});
