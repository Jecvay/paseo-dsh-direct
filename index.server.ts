import type { PluginServerContext } from "@getpaseo/plugin/server";
import { launchDshBridge } from "./server/bridge-client.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    createDshProvider({
      createBridge: (launch) =>
        launchDshBridge({
          ...launch,
          bridgeSource: DSH_BRIDGE_SOURCE,
          executable: process.env.PASEO_DSH_EXECUTABLE,
          profile: process.env.PASEO_DSH_PROFILE,
        }),
    }),
  );
  return () => {};
}
