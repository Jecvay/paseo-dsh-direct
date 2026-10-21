import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DSH_SETTINGS } from "./shared/settings.js";
import { launchDshBridge } from "./server/bridge-client.js";
import { currentDshConfigured } from "./server/dsh-config.js";
import { defaultDshCommand } from "./server/dsh-spawn.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(DSH_SETTINGS);
  // Read per call, not once: a changed setting applies to new sessions and new catalog discovery.
  const configured = () => currentDshConfigured(process.env, settings);
  server.registerProvider(
    createDshProvider({
      configured,
      command: defaultDshCommand(process.env),
      createBridge: async (launch) => {
        const { executable, profile } = await configured();
        return launchDshBridge({ ...launch, bridgeSource: DSH_BRIDGE_SOURCE, executable, profile });
      },
    }),
  );
  return () => {};
}
