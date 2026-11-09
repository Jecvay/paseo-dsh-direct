import { spawnDsh } from "./dsh-spawn.js";

const DEFAULT_TIMEOUT_MS = 3_000;

/** One probe per executable path per process; repeated session opens reuse it instead of spawning again. */
const cache = new Map<string, Promise<string>>();

export interface DetectDshVersionOptions {
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Arguments placed before `--version`, from Paseo's resolved command. */
  args?: readonly string[];
  /** Cancels an uncached probe used during bridge startup. */
  signal?: AbortSignal;
}

/**
 * Runs `<executable> --version` and returns the version it printed. Returns
 * `""` when the process exits non-zero, times out, or prints nothing a
 * version can be parsed from — callers treat `""` as "unconfirmed" via
 * `matchVersionLine`, never as a reason to block startup. Cached by
 * executable path for the life of the process.
 */
export function detectDshVersion(executable: string, options: DetectDshVersionOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.signal) return runVersionProbe(executable, options);
  const key = JSON.stringify([executable, ...(options.args ?? [])]);
  const cached = cache.get(key);
  if (cached) return cached;
  const probe = runVersionProbe(executable, options);
  cache.set(key, probe);
  return probe;
}

function runVersionProbe(executable: string, options: DetectDshVersionOptions): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawnDsh> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    let stopping = false;
    let stopReason: Error | undefined;
    const settleAbort = () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      reject(stopReason ?? new Error("The operation was aborted"));
    };
    const abort = () => {
      if (settled) return;
      stopReason = options.signal?.reason instanceof Error ? options.signal.reason : new Error("The operation was aborted");
      if (stopping) return;
      stopping = true;
      if (timeout) clearTimeout(timeout);
      if (!child) {
        settleAbort();
        return;
      }
      child.once("close", settleAbort);
      child.kill("SIGKILL");
    };

    try {
      options.signal?.throwIfAborted();
      child = spawnDsh(executable, [...(options.args ?? []), "--version"], {
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Synchronous spawn failure (e.g. the executable does not exist).
      if (options.signal?.aborted) abort();
      else finish("");
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }

    timeout = setTimeout(() => {
      if (stopping || settled) return;
      stopping = true;
      child.once("close", () => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        resolve("");
      });
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", () => {
      if (stopping) return;
      if (options.signal?.aborted) abort();
      else finish("");
    });
    child.once("exit", (code) => {
      if (options.signal?.aborted) abort();
      else if (!stopping) finish(code === 0 ? extractVersion(stdout) : "");
    });
  });
}

/** The first semver-looking token in the output; dsh prints only the version, but tolerate extra text. */
function extractVersion(output: string): string {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(output);
  return match ? match[0] : "";
}
