import { z } from "zod";

/** Plugin id from paseo-plugin.json; Paseo matches timeline plugin items by it, not by the provider id. */
export const PLUGIN_ID = "paseo-dsh-direct";

/** Schema version shared by every card kind below. */
export const CARD_VERSION = 1;

/** Plan mode switched on or off. */
export const planModeCardSchema = z.object({ active: z.boolean() });

/** Permission preset changed to `preset`. */
export const permissionPresetCardSchema = z.object({ preset: z.string() });

/** Goal operations from `goal/change`, plus `continue` for an automatic goal round. */
export const goalCardSchema = z.object({
  operation: z.enum([
    "create",
    "edit",
    "pause",
    "resume",
    "complete",
    "block",
    "clear",
    "continue",
  ]),
  objective: z.string().optional(),
  round: z.number().optional(),
  maxRounds: z.number().optional(),
  reason: z.string().optional(),
});

export type PlanModeCard = z.infer<typeof planModeCardSchema>;
export type PermissionPresetCard = z.infer<typeof permissionPresetCardSchema>;
export type GoalCard = z.infer<typeof goalCardSchema>;

/** Card kinds keyed by the `kind` field of the Paseo plugin timeline item. */
export const CARD_KINDS = {
  planMode: "plan-mode",
  permissionPreset: "permission-preset",
  goal: "goal",
} as const;
