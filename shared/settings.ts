import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The values of the plugin settings screen; blank means unset. Shared so the client and server agree. */
export interface DshSettingsValues {
  executable?: string;
  profile?: string;
  /** Whole seconds as typed; blank keeps the launcher default. */
  startupTimeoutSeconds?: string;
}

/** Seconds a bridge may take to become ready when the settings screen is blank. */
export const DEFAULT_STARTUP_TIMEOUT_SECONDS = 15;
/** Upper bound of the settings-screen value; a longer wait is a hung dsh, not a slow one. */
export const MAX_STARTUP_TIMEOUT_SECONDS = 600;

/**
 * Host-scoped plugin settings for the dsh launch. Every field is optional; an
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
    /**
     * How long a bridge may take to become ready, in whole seconds. Blank
     * keeps the built-in default. Held as text because the settings screen
     * edits every field as a string; the server parses it into milliseconds.
     */
    startupTimeoutSeconds: z.string().optional(),
  }),
});

/**
 * Icon of the dsh settings screen. Paseo resolves plugin icons by the exact export name of
 * `lucide-react-native` (PascalCase) and rejects the whole client contribution otherwise.
 */
export const SETTINGS_SCREEN_ICON = "Settings";
