import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DSH_SETTINGS } from "./shared/settings.js";
import { launchDshBridge, type LaunchBridgeOptions } from "./server/bridge-client.js";
import { currentDshConfigured } from "./server/dsh-config.js";
import { defaultDshCommand } from "./server/dsh-spawn.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider } from "./server/provider.js";
import type { ProviderConnection, ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { createSubagentSettingsAccess } from "./server/subagent-settings.js";
import { readSubagentSettings, saveSubagentSettings } from "./shared/subagent-settings.js";

const HOST_EXIT_EVENTS = ["disconnect", "SIGTERM", "SIGINT"] as const;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(DSH_SETTINGS);
  // Read per call, not once: a changed setting applies to new sessions and new catalog discovery.
  const configured = () => currentDshConfigured(process.env, settings);
  const startup = new AbortController();
  const startups = new Set<Promise<unknown>>();
  const connections = new Set<ProviderConnection>();
  const connects = new Set<Promise<ProviderConnection>>();
  const openBridge = (options: LaunchBridgeOptions) => {
    const task = launchDshBridge({ ...options, signal: startup.signal });
    startups.add(task);
    void task.then(() => startups.delete(task), () => startups.delete(task));
    return task;
  };
  let providerLaunch: ProviderLaunch | undefined;
  const subagents = createSubagentSettingsAccess({
    target: async () => ({ configured: await configured(), launch: providerLaunch }),
    open: ({ configured: { executable, profile, startupTimeoutMs }, launch }) => openBridge({
      bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs, providerLaunch: launch,
    }),
  });
  // Provider discovery supplies the same resolved command and environment used for sessions.
  const refreshLaunch = async (paseo: import("@getpaseo/client").PaseoApi) => {
    await paseo.providers.refresh({ providers: ["dsh-pi"] });
    const result = await paseo.providers.listModels("dsh-pi");
    if (result.error) throw new Error(result.error);
  };
  server.handle(readSubagentSettings, async (_input, { paseo }) => {
    await refreshLaunch(paseo);
    return subagents.read();
  });
  server.handle(saveSubagentSettings, async (input, { paseo }) => {
    await refreshLaunch(paseo);
    return subagents.save(input);
  });
  const provider = createDshProvider({
    configured,
    observeLaunch: (launch) => { providerLaunch = launch; },
    command: defaultDshCommand(process.env),
    createBridge: async (launch) => {
      startup.signal.throwIfAborted();
      const { executable, profile, startupTimeoutMs } = await configured();
      return openBridge({ ...launch, bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs });
    },
  });
  server.registerProvider({
    ...provider,
    async connect(request) {
      startup.signal.throwIfAborted();
      const task = provider.connect(request).then(async (connection) => {
        if (startup.signal.aborted) {
          await connection.close();
          startup.signal.throwIfAborted();
        }
        const tracked: ProviderConnection = {
          ...connection,
          close: () => connection.close().finally(() => { connections.delete(tracked); }),
        };
        connections.add(tracked);
        return tracked;
      });
      connects.add(task);
      try {
        return await task;
      } finally {
        connects.delete(task);
      }
    },
  });
  let hostExited = false;
  let shutdownTask: Promise<void> | undefined;
  const ignoreClosedIpc = (error: NodeJS.ErrnoException) => {
    if (error?.code !== "ERR_IPC_CHANNEL_CLOSED" && process.listenerCount("error") <= 1) throw error;
  };
  const onHostExit = () => {
    if (hostExited) return;
    hostExited = true;
    process.on("error", ignoreClosedIpc);
    void shutdown().finally(() => { process.exit(0); });
  };
  const shutdown = () => (shutdownTask ??= (async () => {
    startup.abort();
    await Promise.allSettled([
      subagents.dispose(),
      ...startups,
      ...connects,
      ...Array.from(connections, (connection) => connection.close()),
    ]);
    for (const event of HOST_EXIT_EVENTS) process.off(event, onHostExit);
  })());
  for (const event of HOST_EXIT_EVENTS) process.on(event, onHostExit);
  return shutdown;
}
