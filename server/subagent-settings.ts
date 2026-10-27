import { createHash } from "node:crypto";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { SubagentSettingsSave, SubagentSettingsView } from "../shared/subagent-settings.js";
import type { DshConfigured } from "./dsh-config.js";
import { DEFAULT_PROFILE, resolveDshHome, resolveDshLaunch, type DshBridge } from "./bridge-client.js";

interface SettingsTarget {
  configured: DshConfigured;
  launch?: ProviderLaunch;
}

/** Bind a draft to its effective installation and profile without exposing launch credentials. */
export function subagentSettingsTargetKey({ configured, launch }: SettingsTarget): string {
  const command = resolveDshLaunch(configured.executable, launch);
  return createHash("sha256").update(JSON.stringify([
    command,
    configured.profile ?? DEFAULT_PROFILE,
    resolveDshHome(launch?.env ?? process.env),
  ])).digest("hex");
}

/** Each settings operation owns a short-lived bridge; no agent or background worker is retained. */
export function createSubagentSettingsAccess(options: {
  target(): Promise<SettingsTarget>;
  open(target: SettingsTarget): Promise<DshBridge>;
}) {
  let disposed = false;
  const pending = new Set<Promise<unknown>>();
  const run = (input?: SubagentSettingsSave): Promise<SubagentSettingsView> => {
    if (disposed) return Promise.reject(new Error("Plugin is shutting down"));
    const task = (async () => {
      const target = await options.target();
      const key = subagentSettingsTargetKey(target);
      let revision: string | undefined;
      if (input) {
        const prefix = `${key}:`;
        if (!input.revision.startsWith(prefix) || input.profile !== (target.configured.profile ?? DEFAULT_PROFILE)) {
          throw new Error("DSH launch settings changed. Reload before saving.");
        }
        revision = input.revision.slice(prefix.length);
      }
      if (disposed) throw new Error("Plugin is shutting down");
      const bridge = await options.open(target);
      try {
        if (disposed) throw new Error("Plugin is shutting down");
        const view = input
          ? await bridge.request("subagent.settings.save", { ...input, revision: revision! })
          : await bridge.request("subagent.settings.read", {});
        return { ...view, revision: `${key}:${view.revision}` };
      } finally {
        await bridge.close();
      }
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  return {
    read: () => run(),
    save: (input: SubagentSettingsSave) => run(input),
    async dispose() {
      disposed = true;
      await Promise.allSettled(pending);
    },
  };
}
