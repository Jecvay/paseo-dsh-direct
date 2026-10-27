import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const subagentRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type SubagentRoute = z.infer<typeof subagentRouteSchema>;

export const subagentSelectionSchema = z.object({
  enabled: z.boolean(),
  allowedModels: z.array(subagentRouteSchema),
}).superRefine((value, ctx) => {
  if (value.enabled && value.allowedModels.length === 0) {
    ctx.addIssue({ code: "custom", message: "Select at least one model before enabling model selection." });
  }
  const keys = value.allowedModels.map(subagentRouteKey);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: "custom", message: "A model may only be selected once." });
  }
});
export type SubagentSelection = z.infer<typeof subagentSelectionSchema>;

export const subagentSettingsViewSchema = z.object({
  supported: z.boolean(),
  profile: z.string(),
  reason: z.string().optional(),
  revision: z.string(),
  initialized: z.boolean(),
  selection: subagentSelectionSchema,
  models: z.array(subagentRouteSchema.extend({
    name: z.string(),
    providerName: z.string(),
  })),
  failedProviders: z.array(z.string()),
});
export type SubagentSettingsView = z.infer<typeof subagentSettingsViewSchema>;

export const subagentSettingsSaveSchema = z.object({
  profile: z.string(),
  revision: z.string().min(1),
  selection: subagentSelectionSchema,
});
export type SubagentSettingsSave = z.infer<typeof subagentSettingsSaveSchema>;

export const readSubagentSettings = defineRpc({
  name: "subagent-settings.read",
  input: z.object({}),
  output: subagentSettingsViewSchema,
});
export const saveSubagentSettings = defineRpc({
  name: "subagent-settings.save",
  input: subagentSettingsSaveSchema,
  output: subagentSettingsViewSchema,
});

/** Preserve exact provider/model pairs, including model ids containing slashes. */
export function subagentRouteKey(route: SubagentRoute): string {
  return JSON.stringify([route.provider, route.model]);
}
