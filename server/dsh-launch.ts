import { existsSync } from "node:fs";
import path from "node:path";

/** A command line ready for `child_process.spawn` without a shell. */
export interface DshLaunch {
  command: string;
  args: string[];
}

/** The host facts the resolution depends on, injectable for tests. */
export interface DshLaunchHost {
  platform: NodeJS.Platform;
  exists(file: string): boolean;
}

const defaultHost: DshLaunchHost = { platform: process.platform, exists: existsSync };

/**
 * Turn the configured `dsh` executable and its arguments into a command that
 * `spawn` can start without a shell.
 *
 * On Windows, npm installs `dsh` as `dsh.cmd` / `dsh.ps1` wrappers and no
 * `dsh.exe`. Node does not apply PATHEXT when spawning without a shell, and
 * refuses to spawn `.cmd` files directly. A shell would concatenate arguments
 * unescaped and leave the real dsh process running when the shell is killed.
 * So an npm wrapper is resolved to the command it runs:
 * `node <wrapper dir>/node_modules/@deepseek-ai/dsh/lib/bin.js ...args`,
 * preferring a `node.exe` beside the wrapper, as the wrapper itself does.
 *
 * Other platforms, real executables, and paths whose wrapper layout is not
 * recognised are passed through unchanged.
 */
export function resolveDshLaunch(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  host: DshLaunchHost = defaultHost,
): DshLaunch {
  const passthrough = { command: executable, args: [...args] };
  if (host.platform !== "win32") return passthrough;
  if (/\.m?js$/i.test(executable)) return { command: "node", args: [executable, ...args] };
  const wrapper = findNpmWrapper(executable, env, host);
  if (wrapper === undefined) return passthrough;
  const directory = path.win32.dirname(wrapper);
  const binJs = path.win32.join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!host.exists(binJs)) return passthrough;
  const bundledNode = path.win32.join(directory, "node.exe");
  return { command: host.exists(bundledNode) ? bundledNode : "node", args: [binJs, ...args] };
}

/** The `.cmd` / `.ps1` wrapper `executable` names, if it names one. */
function findNpmWrapper(
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
  host: DshLaunchHost,
): string | undefined {
  if (/\.(cmd|ps1)$/i.test(executable)) return host.exists(executable) ? executable : undefined;
  if (path.win32.extname(executable) !== "") return undefined;
  if (executable.includes("/") || executable.includes("\\")) {
    const candidate = `${executable}.cmd`;
    return host.exists(candidate) ? candidate : undefined;
  }
  for (const directory of windowsPath(env).split(";")) {
    if (!directory) continue;
    const candidate = path.win32.join(directory, `${executable}.cmd`);
    if (host.exists(candidate)) return candidate;
  }
  return undefined;
}

/** Windows environment names are case-insensitive (`Path` vs `PATH`). */
function windowsPath(env: Readonly<Record<string, string | undefined>>): string {
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === "PATH" && value) return value;
  }
  return "";
}
