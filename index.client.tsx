import type { PluginClientContext } from "@getpaseo/plugin/client";
import DshSettingsScreen from "./client/settings-screen.js";

/** Provider presentation comes from the server registration; the client adds the dsh settings screen. */
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "dsh",
    title: "DeepSeek Harness",
    icon: "terminal",
    Component: DshSettingsScreen,
  });
}
