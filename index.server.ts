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
// A pending host request must not keep an orphaned worker alive after its host is gone.
const HOST_EXIT_DEADLINE_MS = 10_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(DSH_SETTINGS);
  // Read per call, not once: a changed setting applies to new sessions and new catalog discovery.
  const configured = () => currentDshConfigured(process.env, settings);
  const startup = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    inFlight.add(task);
    void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
    return task;
  };
  const openBridge = (options: LaunchBridgeOptions) =>
    track(launchDshBridge({ ...options, signal: startup.signal }));
  const connections = new Set<ProviderConnection>();
  let providerLaunch: ProviderLaunch | undefined;
  const subagents = createSubagentSettingsAccess({
    target: async () => ({ configured: await configured(), launch: providerLaunch }),
    open: ({ configured: { executable, profile, startupTimeoutMs }, launch }) => openBridge({
      bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, startupTimeoutMs, providerLaunch: launch,
    }),
  });
  // Provider discovery supplies the same resolved command and environment used for sessions.
  // Keep the host API shape local so the plugin compiles without installing host packages.
  type ProviderDiscovery = {
    providers: {
      refresh(input: { providers: string[] }): Promise<unknown>
      listModels(provider: string): Promise<{ error?: string | null }>
    }
  }
  const refreshLaunch = async (paseo: ProviderDiscovery) => {
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
      const task = provider.connect(request).then(async (connection) => {
        // Shutdown snapshots `connections` synchronously, so a connection that
        // resolves afterwards must close itself rather than stay open.
        if (startup.signal.aborted) {
          await connection.close();
          startup.signal.throwIfAborted();
        }
        const tracked: ProviderConnection = {
          version: connection.version,
          capabilities: connection.capabilities,
          send: (input) => connection.send(input),
          onEvent: (listener) => connection.onEvent(listener),
          close: () => connection.close().finally(() => { connections.delete(tracked); }),
        };
        connections.add(tracked);
        return tracked;
      });
      return track(task);
    },
  });
  let hostExitHandled = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = () => (shutdownTask ??= (async () => {
    startup.abort();
    await Promise.allSettled([
      subagents.dispose(),
      ...inFlight,
      ...Array.from(connections, (connection) => connection.close()),
    ]);
    for (const event of HOST_EXIT_EVENTS) process.off(event, onHostExit);
  })());
  const onHostExit = () => {
    if (hostExitHandled) return;
    hostExitHandled = true;
    // A late plugin reply on the closed host channel reports this code as a
    // process "error"; absorb it so cleanup can finish. Anything else stays fatal.
    process.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code !== "ERR_IPC_CHANNEL_CLOSED") throw error;
    });
    // The stderr pipe has no reader once the host is gone; a broken pipe from a
    // diagnostic write must not kill the worker in the middle of cleanup.
    process.stderr.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code !== "EPIPE") throw error;
    });
    // Failsafe: exiting still closes every bridge's stdin, and DSH releases its
    // write lease on EOF, so a stuck request cannot leave the worker behind.
    const deadline = setTimeout(() => process.exit(0), HOST_EXIT_DEADLINE_MS);
    deadline.unref();
    void shutdown().finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  for (const event of HOST_EXIT_EVENTS) process.on(event, onHostExit);
  return shutdown;
}
