import { SettingsRow } from "@getpaseo/plugin/client/ui";
import {
  type GoalCard,
  type PermissionPresetCard,
  type PlanModeCard,
} from "../shared/timeline-cards.js";

interface CardProps<Data> {
  item: { data: Data };
}

/** Text of a goal card; exported for reuse by the row component. */
export function goalCardText(data: GoalCard): string {
  const objective = data.objective ? `: ${data.objective}` : "";
  switch (data.operation) {
    case "create":
      return `Goal set${objective}`;
    case "edit":
      return `Goal edited${objective}`;
    case "pause":
      return "Goal paused";
    case "resume":
      return "Goal resumed";
    case "complete":
      return "Goal completed";
    case "block":
      return data.reason ? `Goal blocked: ${data.reason}` : "Goal blocked";
    case "clear":
      return "Goal cleared";
    case "continue": {
      const round = data.round === undefined ? "" : ` (round ${data.round}${data.maxRounds === undefined ? "" : `/${data.maxRounds}`})`;
      return `Goal continued${round}`;
    }
  }
}

/** One-row card for a plan mode switch. */
export function PlanModeCardView({ item }: CardProps<PlanModeCard>) {
  return <SettingsRow label={item.data.active ? "Plan mode on" : "Plan mode off"} />;
}

/** One-row card for a permission preset change. */
export function PermissionPresetCardView({ item }: CardProps<PermissionPresetCard>) {
  return <SettingsRow label={`Permission preset: ${item.data.preset}`} />;
}

/** One-row card for a goal change or an automatic goal round. */
export function GoalCardView({ item }: CardProps<GoalCard>) {
  return <SettingsRow label={goalCardText(item.data)} />;
}
