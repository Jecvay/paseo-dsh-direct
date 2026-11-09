import type { DshSettingsValues } from "../shared/settings.js";
import { MAX_STARTUP_TIMEOUT_SECONDS } from "../shared/startup-timeout.js";

/** The dsh launch choices that outrank Paseo's own `launch` and the built-in defaults. */
export interface DshConfigured {
  /** A non-blank dsh executable, or undefined when neither the environment nor the settings name one. */
  executable?: string;
  /** A non-blank profile name, or undefined to use the default profile. */
  profile?: string;
  /**
   * Milliseconds to wait for bridge.ready, parsed from whole seconds in the
   * settings screen. Undefined means the launcher default.
   */
  startupTimeoutMs?: number;
}

const nonBlank = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** The parsed settings-screen timeout, or the reason the text is not usable. */
export interface StartupTimeout {
  milliseconds?: number;
  problem?: string;
}

/**
 * Parses the settings-screen startup timeout. Blank is unset; otherwise the
 * text must be whole seconds within 1..MAX. A rejected value is reported by
 * the caller and ignored, so a typo never blocks launching dsh.
 */
export function parseStartupTimeoutSeconds(value: string | undefined): StartupTimeout {
  const text = nonBlank(value);
  if (text === undefined) return {};
  if (!/^[0-9]+$/.test(text)) return { problem: "startup timeout must be a whole number of seconds" };
  const seconds = Number(text);
  if (seconds < 1 || seconds > MAX_STARTUP_TIMEOUT_SECONDS) {
    return { problem: `startup timeout must be within 1..${MAX_STARTUP_TIMEOUT_SECONDS} seconds` };
  }
  return { milliseconds: seconds * 1000 };
}

/**
 * Merges the environment and the settings screen: a non-blank
 * `PASEO_DSH_EXECUTABLE` / `PASEO_DSH_PROFILE` wins over the setting of the
 * same name. The result is then resolved against Paseo's `launch` and the
 * default profile by `resolveDshLaunch` and `launchDshBridge`. The startup
 * timeout has no environment variable; it is a bridge-running detail, not an
 * installation identity.
 */
export function mergeDshConfigured(
  env: Readonly<Record<string, string | undefined>>,
  settings: DshSettingsValues | undefined,
): DshConfigured {
  const executable = nonBlank(env.PASEO_DSH_EXECUTABLE) ?? nonBlank(settings?.executable);
  const profile = nonBlank(env.PASEO_DSH_PROFILE) ?? nonBlank(settings?.profile);
  const startupTimeout = parseStartupTimeoutSeconds(settings?.startupTimeoutSeconds);
  return {
    ...(executable ? { executable } : {}),
    ...(profile ? { profile } : {}),
    ...(startupTimeout.milliseconds === undefined ? {} : { startupTimeoutMs: startupTimeout.milliseconds }),
  };
}

/** The slice of `PluginSettings.read()` this module needs. */
export interface DshSettingsSource {
  read(): Promise<
    | { status: "ready"; values: DshSettingsValues }
    | { status: "invalid"; error: string }
    | { status: "error"; error: string }
  >;
}

/**
 * Reads the current settings. Invalid or unreadable settings count as unset,
 * with one line on stderr, so a bad setting never blocks launching dsh. A
 * rejected startup timeout keeps the rest of the values and gets its own line.
 */
export async function readDshSettings(
  source: DshSettingsSource,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<DshSettingsValues | undefined> {
  const state = await source.read().catch((error: unknown) => ({
    status: "error" as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (state.status === "ready") {
    const startupTimeout = parseStartupTimeoutSeconds(state.values.startupTimeoutSeconds);
    if (startupTimeout.problem) {
      warn(`[paseo-dsh-direct] ignoring the startup timeout setting: ${startupTimeout.problem}`);
    }
    return state.values;
  }
  warn(`[paseo-dsh-direct] ignoring the dsh plugin settings (${state.status}): ${state.error}`);
  return undefined;
}

/** The configuration the provider uses right now: environment first, then the current settings. */
export async function currentDshConfigured(
  env: Readonly<Record<string, string | undefined>>,
  source: DshSettingsSource,
  warn?: (line: string) => void,
): Promise<DshConfigured> {
  return mergeDshConfigured(env, await readDshSettings(source, warn));
}
