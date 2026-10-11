import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** A command line `child_process.spawn` can start without a shell. */
export interface DshSpawn {
  command: string;
  args: string[];
  /** The environment to spawn with: the launch environment, plus what the resolved command needs. */
  env: Env;
}

/** The host facts the resolution depends on, injected so the Windows branch is testable anywhere. */
export interface DshSpawnHost {
  platform: NodeJS.Platform;
  exists(file: string): boolean;
}

const defaultHost: DshSpawnHost = { platform: process.platform, exists: existsSync };
const DESKTOP_EXE = "DeepSeek Harness.exe";
const WRAPPER_EXTENSIONS = [".cmd", ".ps1"];
/** Extensions Node finds itself when spawning a bare name; a match means a real executable wins. */
const EXECUTABLE_EXTENSIONS = [".com", ".exe"];

/**
 * Spawns dsh without a shell: `spawn` with `command` / `args` / `env` replaced
 * by `resolveDshSpawn(command, args, options.env)` and `windowsHide` set. Every
 * dsh process the plugin starts goes through here.
 */
export const spawnDsh = ((command: string, args: readonly string[], options: SpawnOptions) => {
  const target = resolveDshSpawn(command, args, options.env ?? process.env);
  return spawn(target.command, target.args, { ...options, env: target.env, windowsHide: true });
}) as typeof spawn;

/**
 * The spawn for a dsh command chosen by `resolveDshLaunch`, with `args` being
 * the launch's leading arguments followed by dsh's own. Other platforms, real
 * executables and unrecognised layouts pass through unchanged; on Windows an
 * npm or DSH Desktop `dsh.cmd` / `dsh.ps1` wrapper becomes the command it runs,
 * and a bare `dsh` not on `PATH` falls back to DSH Desktop's default install.
 * Layouts and reasons: `docs/server-architecture.md` (dsh 的选择).
 */
export function resolveDshSpawn(
  command: string,
  args: readonly string[],
  env: Env,
  host: DshSpawnHost = defaultHost,
): DshSpawn {
  const passthrough = { command, args: [...args], env };
  if (host.platform !== "win32") return passthrough;
  if (path.win32.basename(command).toLowerCase() === DESKTOP_EXE.toLowerCase()) {
    return desktopSpawn(path.win32.dirname(command), args, env, host) ?? passthrough;
  }
  const found = findCommand(command, env, host);
  if (found.kind === "executable") return passthrough;
  if (found.kind === "missing") {
    return (command.toLowerCase() === "dsh" ? desktopFallback(args, env, host) : undefined) ?? passthrough;
  }
  const directory = path.win32.dirname(found.path);
  return (
    npmSpawn(directory, args, env, host) ??
    // <install>\resources\runtime\cli\bin\dsh.cmd
    desktopSpawn(path.win32.resolve(directory, "..", "..", "..", ".."), args, env, host) ??
    passthrough
  );
}

/**
 * The command the provider registers with Paseo. Paseo resolves it on `PATH`
 * before the plugin sees it, so on Windows, when `PATH` has no `dsh` but DSH
 * Desktop is installed in its default location, the desktop executable is
 * registered instead; `resolveDshSpawn` then runs it as dsh. Otherwise `dsh`.
 */
export function defaultDshCommand(env: Env, host: DshSpawnHost = defaultHost): string {
  if (host.platform !== "win32" || findCommand("dsh", env, host).kind !== "missing") return "dsh";
  return desktopFallback([], env, host)?.command ?? "dsh";
}

/** npm's layout: `node <wrapper dir>\node_modules\@deepseek-ai\dsh\lib\bin.js`, preferring a `node.exe` beside the wrapper. */
function npmSpawn(directory: string, args: readonly string[], env: Env, host: DshSpawnHost): DshSpawn | undefined {
  const binJs = path.win32.join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!host.exists(binJs)) return undefined;
  const bundledNode = path.win32.join(directory, "node.exe");
  return { command: host.exists(bundledNode) ? bundledNode : "node", args: [binJs, ...args], env };
}

/** DSH Desktop's default per-user install, `%LOCALAPPDATA%\Programs\DeepSeek Harness`, when present. */
function desktopFallback(args: readonly string[], env: Env, host: DshSpawnHost): DshSpawn | undefined {
  const local = windowsEnv(env, "LOCALAPPDATA");
  return local ? desktopSpawn(path.win32.join(local, "Programs", "DeepSeek Harness"), args, env, host) : undefined;
}

/** DSH Desktop's own CLI, as its `dsh.cmd` runs it, when `install` holds a desktop install. */
function desktopSpawn(install: string, args: readonly string[], env: Env, host: DshSpawnHost): DshSpawn | undefined {
  const exe = path.win32.join(install, DESKTOP_EXE);
  const asar = path.win32.join(install, "resources", "app.asar");
  if (!host.exists(exe) || !host.exists(asar)) return undefined;
  const cli = path.win32.join(asar, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  return { command: exe, args: ["--expose-internals", cli, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

type Found = { kind: "executable" } | { kind: "wrapper"; path: string } | { kind: "missing" };

/** What `command` names: a wrapper script, a real executable Node finds first, or nothing. */
function findCommand(command: string, env: Env, host: DshSpawnHost): Found {
  const extension = path.win32.extname(command).toLowerCase();
  if (extension !== "" && !WRAPPER_EXTENSIONS.includes(extension)) return { kind: "executable" };
  const candidates = (base: string) => (extension ? [base] : WRAPPER_EXTENSIONS.map((suffix) => base + suffix));
  const wrapperAt = (base: string): Found => {
    const wrapper = candidates(base).find((candidate) => host.exists(candidate));
    return wrapper === undefined ? { kind: "missing" } : { kind: "wrapper", path: wrapper };
  };
  if (/[\\/]/.test(command)) return wrapperAt(command);
  for (const directory of (windowsEnv(env, "PATH") ?? "").split(";")) {
    if (!directory.trim()) continue;
    const base = path.win32.join(directory.trim().replace(/^"|"$/g, ""), command);
    if (extension === "" && EXECUTABLE_EXTENSIONS.some((suffix) => host.exists(base + suffix))) {
      return { kind: "executable" };
    }
    const found = wrapperAt(base);
    if (found.kind === "wrapper") return found;
  }
  return { kind: "missing" };
}

/** Windows environment names are case-insensitive (`Path` as well as `PATH`). */
function windowsEnv(env: Env, key: string): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === key && value) return value;
  }
  return undefined;
}
