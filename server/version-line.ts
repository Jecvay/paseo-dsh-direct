/** Compatibility classification between this plugin's version and a detected dsh version. */
export type VersionLineMatch = "match" | "mismatch" | "unknown";

/**
 * The major.minor line a version string belongs to (e.g. "0.1"), ignoring
 * patch and any prerelease suffix (`-rc.N`, `-alpha.N`). Returns undefined
 * when no leading `major.minor` can be read from the string.
 */
export function versionLine(version: string): string | undefined {
  const match = /^\s*v?(\d+)\.(\d+)(?:\.\d+)?/i.exec(version);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Whether `pluginVersion` and `dshVersion` belong to the same major.minor
 * line: the plugin's `0.1.x` line tracks dsh `0.1.*`. A dsh prerelease
 * suffix does not affect its line. Either string failing to parse a
 * `major.minor` (blank, garbled output) yields "unknown", not "mismatch" —
 * this plugin only warns, it never blocks on an unconfirmed version.
 */
export function matchVersionLine(pluginVersion: string, dshVersion: string): VersionLineMatch {
  const pluginLine = versionLine(pluginVersion);
  const dshLine = versionLine(dshVersion);
  if (!pluginLine || !dshLine) return "unknown";
  return pluginLine === dshLine ? "match" : "mismatch";
}

/**
 * One-line warning for a "mismatch" or "unknown" classification: states the
 * plugin's supported dsh line, the detected dsh version, and what to do.
 * Never called for "match".
 */
export function versionWarningMessage(
  status: Exclude<VersionLineMatch, "match">,
  pluginVersion: string,
  dshVersion: string,
): string {
  const pluginLine = versionLine(pluginVersion) ?? pluginVersion;
  if (status === "unknown") {
    return (
      `Could not confirm the local dsh version (this plugin supports dsh ${pluginLine}.*). ` +
      `The session started anyway; check that dsh is installed and "dsh --version" reports a version.`
    );
  }
  const dshLine = versionLine(dshVersion) ?? dshVersion;
  return (
    `This plugin supports dsh ${pluginLine}.*; detected dsh ${dshVersion}. ` +
    `Install a plugin tag for the dsh ${dshLine}.x line, or switch the dsh executable to a ${pluginLine}.x build.`
  );
}
