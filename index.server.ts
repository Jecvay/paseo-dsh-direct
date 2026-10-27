import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DSH_SETTINGS } from "./shared/settings.js";
import { launchDshBridge } from "./server/bridge-client.js";
import { currentDshConfigured } from "./server/dsh-config.js";
import { defaultDshCommand } from "./server/dsh-spawn.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider } from "./server/provider.js";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { createSubagentSettingsAccess } from "./server/subagent-settings.js";
import { readSubagentSettings, saveSubagentSettings } from "./shared/subagent-settings.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(DSH_SETTINGS);
  // Read per call, not once: a changed setting applies to new sessions and new catalog discovery.
  const configured = () => currentDshConfigured(process.env, settings);
  let providerLaunch: ProviderLaunch | undefined;
  const subagents = createSubagentSettingsAccess({
    target: async () => ({ configured: await configured(), launch: providerLaunch }),
    open: ({ configured: { executable, profile }, launch }) => launchDshBridge({
      bridgeSource: DSH_BRIDGE_SOURCE, executable, profile, providerLaunch: launch,
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
  server.registerProvider(
    createDshProvider({
      configured,
      observeLaunch: (launch) => { providerLaunch = launch; },
      command: defaultDshCommand(process.env),
      createBridge: async (launch) => {
        const { executable, profile } = await configured();
        return launchDshBridge({ ...launch, bridgeSource: DSH_BRIDGE_SOURCE, executable, profile });
      },
    }),
  );
  return () => subagents.dispose();
}
