import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SETTINGS_SCREEN_ICON } from "./shared/settings.js";
import DshSettingsScreen from "./client/settings-screen.js";
import {
  GoalCardView,
  PermissionPresetCardView,
  PlanModeCardView,
} from "./client/timeline-cards.js";
import {
  CARD_KINDS,
  CARD_VERSION,
  goalCardSchema,
  permissionPresetCardSchema,
  planModeCardSchema,
} from "./shared/timeline-cards.js";

/** Provider presentation comes from the server registration; the client adds the dsh settings screen and timeline cards. */
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSettingsScreen({
      id: "dsh",
      title: "DeepSeek Harness",
      icon: SETTINGS_SCREEN_ICON,
      Component: DshSettingsScreen,
    }),
    client.addTimelineRenderer({
      kind: CARD_KINDS.planMode,
      version: CARD_VERSION,
      schema: planModeCardSchema,
      Component: PlanModeCardView,
    }),
    client.addTimelineRenderer({
      kind: CARD_KINDS.permissionPreset,
      version: CARD_VERSION,
      schema: permissionPresetCardSchema,
      Component: PermissionPresetCardView,
    }),
    client.addTimelineRenderer({
      kind: CARD_KINDS.goal,
      version: CARD_VERSION,
      schema: goalCardSchema,
      Component: GoalCardView,
    }),
  ];
  return async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  };
}
