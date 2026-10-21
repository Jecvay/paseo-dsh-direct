/** The dsh launch choices that outrank Paseo's own `launch` and the built-in defaults. */
export interface DshConfigured {
  /** A non-blank dsh executable, or undefined when neither the environment nor the settings name one. */
  executable?: string;
  /** A non-blank profile name, or undefined to use the default profile. */
  profile?: string;
}

/** The two values of the plugin settings screen; blank means unset. */
export interface DshSettingsValues {
  executable?: string;
  profile?: string;
}

const nonBlank = (value: string | undefined): string | undefined => value?.trim() || undefined;

/**
 * Merges the environment and the settings screen: a non-blank
 * `PASEO_DSH_EXECUTABLE` / `PASEO_DSH_PROFILE` wins over the setting of the
 * same name. The result is then resolved against Paseo's `launch` and the
 * default profile by `resolveDshLaunch` and `launchDshBridge`.
 */
export function mergeDshConfigured(
  env: Readonly<Record<string, string | undefined>>,
  settings: DshSettingsValues | undefined,
): DshConfigured {
  const executable = nonBlank(env.PASEO_DSH_EXECUTABLE) ?? nonBlank(settings?.executable);
  const profile = nonBlank(env.PASEO_DSH_PROFILE) ?? nonBlank(settings?.profile);
  return { ...(executable ? { executable } : {}), ...(profile ? { profile } : {}) };
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
 * with one line on stderr, so a bad setting never blocks launching dsh.
 */
export async function readDshSettings(
  source: DshSettingsSource,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<DshSettingsValues | undefined> {
  const state = await source.read().catch((error: unknown) => ({
    status: "error" as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (state.status === "ready") return state.values;
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
