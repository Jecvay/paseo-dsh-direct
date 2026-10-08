import { spawn } from "node:child_process";
import { resolveDshLaunch } from "./dsh-launch.js";

const DEFAULT_TIMEOUT_MS = 3_000;

/** One probe per executable path per process; repeated session opens reuse it instead of spawning again. */
const cache = new Map<string, Promise<string>>();

export interface DetectDshVersionOptions {
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs `<executable> --version` and returns the version it printed. Returns
 * `""` when the process exits non-zero, times out, or prints nothing a
 * version can be parsed from — callers treat `""` as "unconfirmed" via
 * `matchVersionLine`, never as a reason to block startup. Cached by
 * executable path for the life of the process.
 */
export function detectDshVersion(executable: string, options: DetectDshVersionOptions = {}): Promise<string> {
  const cached = cache.get(executable);
  if (cached) return cached;
  const probe = runVersionProbe(executable, options);
  cache.set(executable, probe);
  return probe;
}

function runVersionProbe(executable: string, options: DetectDshVersionOptions): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    };

    let child;
    try {
      const env = options.env ?? process.env;
      const launch = resolveDshLaunch(executable, ["--version"], env);
      child = spawn(launch.command, launch.args, {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      // Synchronous spawn failure (e.g. the executable does not exist).
      finish("");
      return;
    }

    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish("");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => finish(""));
    child.once("exit", (code) => finish(code === 0 ? extractVersion(stdout) : ""));
  });
}

/** The first semver-looking token in the output; dsh prints only the version, but tolerate extra text. */
function extractVersion(output: string): string {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(output);
  return match ? match[0] : "";
}
