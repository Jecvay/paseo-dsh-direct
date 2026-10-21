import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped plugin settings for the dsh launch. Both fields are optional; an
 * empty or whitespace-only value means unset. The server reads them when a
 * bridge is launched, and the client settings screen edits them.
 */
export const DSH_SETTINGS = defineSettings({
  id: "dsh",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Path or command of the dsh executable. */
    executable: z.string().optional(),
    /** Name of the dsh profile the plugin launches. */
    profile: z.string().optional(),
  }),
});

/**
 * Icon of the dsh settings screen. Paseo resolves plugin icons by the exact export name of
 * `lucide-react-native` (PascalCase) and rejects the whole client contribution otherwise.
 */
export const SETTINGS_SCREEN_ICON = "Settings";
