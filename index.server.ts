import type { PluginServerContext } from "@getpaseo/plugin/server";
import { launchDshBridge, resolveDshExecutable } from "./server/bridge-client.js";
import { DSH_BRIDGE_SOURCE } from "./server/generated-bridge.js";
import { createDshProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const executable = resolveDshExecutable(process.env.PASEO_DSH_EXECUTABLE);
  server.registerProvider(
    createDshProvider({
      executable,
      createBridge: (launch) =>
        launchDshBridge({
          ...launch,
          bridgeSource: DSH_BRIDGE_SOURCE,
          executable,
          profile: process.env.PASEO_DSH_PROFILE,
        }),
    }),
  );
  return () => {};
}
