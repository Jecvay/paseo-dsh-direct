import { existsSync } from "node:fs";
import path from "node:path";

/** A command line `child_process.spawn` can start without a shell. */
export interface DshSpawn {
  command: string;
  args: string[];
  /** The environment to spawn with: the launch environment, plus what the resolved command needs. */
  env: Readonly<Record<string, string | undefined>>;
}

/** The host facts the resolution depends on, injected so the Windows branch is testable anywhere. */
export interface DshSpawnHost {
  platform: NodeJS.Platform;
  exists(file: string): boolean;
}

const defaultHost: DshSpawnHost = { platform: process.platform, exists: existsSync };

/**
 * The spawn for a dsh command chosen by `resolveDshLaunch`, with `args` being
 * the launch's leading arguments followed by dsh's own.
 *
 * On Windows `dsh` is only ever a `.cmd` / `.ps1` wrapper. Node does not apply
 * PATHEXT without a shell and refuses to spawn `.cmd` files directly; a shell
 * would join arguments unescaped and leave the real dsh process behind when it
 * is killed, and the `.ps1` wrapper waits for piped stdin to close before
 * starting. So a recognised wrapper is resolved to the command it runs:
 *
 * - npm: `node <wrapper dir>\node_modules\@deepseek-ai\dsh\lib\bin.js`,
 *   preferring a `node.exe` beside the wrapper as the wrapper itself does.
 * - DSH Desktop (`<install>\resources\runtime\cli\bin\dsh.cmd`, or
 *   `<install>\DeepSeek Harness.exe` named directly): the desktop executable
 *   run as Node on `dsh-desktop-host`'s CLI inside `app.asar`.
 *
 * A bare `dsh` that is not on `PATH` falls back to DSH Desktop's default
 * per-user install. Other platforms, real executables and unrecognised layouts
 * pass through unchanged.
 */
export function resolveDshSpawn(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  host: DshSpawnHost = defaultHost,
): DshSpawn {
  const passthrough = { command, args: [...args], env };
  if (host.platform !== "win32") return passthrough;
  if (path.win32.basename(command).toLowerCase() === DESKTOP_EXE.toLowerCase()) {
    return desktopSpawn(path.win32.dirname(command), args, env, host) ?? passthrough;
  }
  const found = findWrapper(command, env, host);
  if (found === "executable") return passthrough;
  if (found === undefined) {
    const install = command.toLowerCase() === "dsh" ? desktopInstall(env) : undefined;
    return (install !== undefined && desktopSpawn(install, args, env, host)) || passthrough;
  }
  const directory = path.win32.dirname(found);
  const binJs = path.win32.join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (host.exists(binJs)) {
    const bundledNode = path.win32.join(directory, "node.exe");
    return { command: host.exists(bundledNode) ? bundledNode : "node", args: [binJs, ...args], env };
  }
  // <install>\resources\runtime\cli\bin\dsh.cmd
  return desktopSpawn(path.win32.resolve(directory, "..", "..", "..", ".."), args, env, host) ?? passthrough;
}

/**
 * The command the provider registers with Paseo. Paseo resolves it on `PATH`
 * before the plugin sees it, so on Windows, when `PATH` has no `dsh` but DSH
 * Desktop is installed in its default location, the desktop executable is
 * registered instead; `resolveDshSpawn` then runs it as dsh. Otherwise `dsh`.
 */
export function defaultDshCommand(
  env: Readonly<Record<string, string | undefined>>,
  host: DshSpawnHost = defaultHost,
): string {
  if (host.platform !== "win32" || findWrapper("dsh", env, host) !== undefined) return "dsh";
  const install = desktopInstall(env);
  if (install === undefined || !desktopSpawn(install, [], env, host)) return "dsh";
  return path.win32.join(install, DESKTOP_EXE);
}

const DESKTOP_EXE = "DeepSeek Harness.exe";

/** DSH Desktop's default per-user install directory. */
function desktopInstall(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const local = windowsEnv(env, "LOCALAPPDATA");
  return local ? path.win32.join(local, "Programs", "DeepSeek Harness") : undefined;
}

/** DSH Desktop's own CLI, as its `dsh.cmd` runs it, when `install` holds a desktop install. */
function desktopSpawn(
  install: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  host: DshSpawnHost,
): DshSpawn | undefined {
  const exe = path.win32.join(install, DESKTOP_EXE);
  const asar = path.win32.join(install, "resources", "app.asar");
  if (!host.exists(exe) || !host.exists(asar)) return undefined;
  const cli = path.win32.join(asar, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  return { command: exe, args: ["--expose-internals", cli, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

const WRAPPER = /\.(cmd|ps1)$/i;
/** Extensions Node finds itself when spawning a bare name; a match means a real executable wins. */
const EXECUTABLE = [".com", ".exe"];

/** The wrapper `command` names, `"executable"` when Node would find a real executable first, else undefined. */
function findWrapper(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  host: DshSpawnHost,
): string | "executable" | undefined {
  const extension = path.win32.extname(command);
  if (extension !== "" && !WRAPPER.test(extension)) return "executable";
  if (/[\\/]/.test(command)) return wrapperAt(command, extension, host);
  for (const directory of (windowsEnv(env, "PATH") ?? "").split(";")) {
    if (!directory.trim()) continue;
    const base = path.win32.join(directory.trim().replace(/^"|"$/g, ""), command);
    if (extension === "" && EXECUTABLE.some((suffix) => host.exists(base + suffix))) return "executable";
    const wrapper = wrapperAt(base, extension, host);
    if (wrapper !== undefined) return wrapper;
  }
  return undefined;
}

function wrapperAt(base: string, extension: string, host: DshSpawnHost): string | undefined {
  if (extension !== "") return host.exists(base) ? base : undefined;
  return [`${base}.cmd`, `${base}.ps1`].find((candidate) => host.exists(candidate));
}

/** Windows environment names are case-insensitive (`Path` as well as `PATH`). */
function windowsEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === key && value) return value;
  }
  return undefined;
}
