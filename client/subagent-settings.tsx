import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  readSubagentSettings,
  saveSubagentSettings,
  subagentRouteKey,
  type SubagentRoute,
  type SubagentSelection,
  type SubagentSettingsView,
  type SubagentSettingsSave,
} from "../shared/subagent-settings.js";

type Draft = {
  view: SubagentSettingsView;
  selection: SubagentSelection;
  launchRevision: string;
};
type ModelRow = SubagentRoute & { name: string; providerName: string; available: boolean };

function sameSelection(left: SubagentSelection, right: SubagentSelection): boolean {
  const keys = new Set(left.allowedModels.map(subagentRouteKey));
  return left.enabled === right.enabled && keys.size === right.allowedModels.length &&
    right.allowedModels.every((model) => keys.has(subagentRouteKey(model)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keeps edits tied to the exact profile and revision returned by the daemon. */
export default function SubagentSettings({ launchRevision, launchSaving }: {
  launchRevision: string;
  launchSaving: boolean;
}) {
  const readSettings = useRpc(readSubagentSettings);
  const saveSettings = useRpc(saveSubagentSettings);
  const queryClient = useQueryClient();
  const queryKey = ["dsh-subagent-settings", launchRevision];
  const query = useQuery({
    queryKey,
    queryFn: () => readSettings({}),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const dirty = draft !== null && !sameSelection(draft.selection, draft.view.selection);
  // A background read or a saved launch-setting change must never replace pending edits.
  const activeDraft = dirty ? draft : null;
  const view = activeDraft?.view ?? query.data;
  const selection = activeDraft?.selection ?? view?.selection;
  const launchChanged = activeDraft !== null && activeDraft.launchRevision !== launchRevision;
  const save = useMutation({
    mutationFn: ({ input }: { input: SubagentSettingsSave; launchRevision: string }) => saveSettings(input),
    onSuccess: (saved, submitted) => {
      queryClient.setQueryData(["dsh-subagent-settings", submitted.launchRevision], saved);
      setDraft(null);
    },
  });
  const saveError = save.error ? errorMessage(save.error) : undefined;
  const conflict = saveError !== undefined && /changed|conflict|revision|stale/i.test(saveError);
  const busy = save.isPending || query.isFetching || launchSaving;

  const refresh = () => {
    if (dirty || busy) return;
    save.reset();
    void query.refetch();
  };
  const discardAndRefresh = () => {
    if (busy) return;
    setDraft(null);
    save.reset();
    void query.refetch();
  };
  const edit = (next: SubagentSelection) => {
    if (!view || busy) return;
    // Keep a conflict visible until the user explicitly discards and refreshes.
    if (!conflict) save.reset();
    setDraft({
      view,
      selection: next,
      launchRevision: activeDraft?.launchRevision ?? launchRevision,
    });
  };

  if (!view || !selection) {
    return (
      <SettingsSection title="Subagent models">
        <SettingsRow
          label={query.isError ? "Could not load subagent models" : "Loading subagent models"}
          error={query.isError ? errorMessage(query.error) : undefined}
          hint="Models and saved choices come from the active dsh profile."
        />
        {query.isError && <SettingsAction label="Load models again" actionLabel="Retry" onPress={refresh} disabled={busy} />}
      </SettingsSection>
    );
  }

  const selectedKeys = new Set(selection.allowedModels.map(subagentRouteKey));
  const models = new Map<string, ModelRow>(view.models.map((model) => [
    subagentRouteKey(model), { ...model, available: true },
  ]));
  // Keep missing saved rows visible even after unchecking, until Save or Discard.
  for (const route of [...view.selection.allowedModels, ...selection.allowedModels]) {
    const key = subagentRouteKey(route);
    if (!models.has(key)) {
      models.set(key, { ...route, name: route.model, providerName: route.provider, available: false });
    }
  }
  const term = search.trim().toLocaleLowerCase();
  const groups = new Map<string, { name: string; rows: ModelRow[] }>();
  for (const model of models.values()) {
    if (term && ![model.name, model.model, model.provider, model.providerName]
      .some((value) => value.toLocaleLowerCase().includes(term))) continue;
    const group = groups.get(model.provider) ?? { name: model.providerName, rows: [] };
    group.rows.push(model);
    groups.set(model.provider, group);
  }
  const missingCount = selection.allowedModels.filter((route) => !models.get(subagentRouteKey(route))?.available).length;
  const emptyEnabled = selection.enabled && selection.allowedModels.length === 0;
  const toggle = (model: SubagentRoute, checked: boolean) => {
    const key = subagentRouteKey(model);
    const remaining = selection.allowedModels.filter((route) => subagentRouteKey(route) !== key);
    edit({ ...selection, allowedModels: checked ? [...remaining, { provider: model.provider, model: model.model }] : remaining });
  };
  const selectAvailable = () => {
    const routes = new Map(selection.allowedModels.map((route) => [subagentRouteKey(route), route]));
    for (const model of view.models) {
      routes.set(subagentRouteKey(model), { provider: model.provider, model: model.model });
    }
    edit({ ...selection, allowedModels: [...routes.values()] });
  };

  return (
    <>
      <SettingsSection title="Subagent models">
        <SettingsRow
          label={`Profile: ${view.profile}`}
          hint="Saved changes apply only to new sessions. The first initialization selects all available models; models added later stay unselected until you choose them."
        />
        {query.isError && (
          <SettingsRow label="Could not refresh models" error={errorMessage(query.error)} hint="The last loaded list is still shown. Retry after discarding any pending edits." />
        )}
        {launchChanged && (
          <SettingsRow label="dsh launch settings changed" error="Your model edits still belong to the previously loaded profile. Discard changes and refresh before saving." />
        )}
        {!view.supported && (
          <SettingsRow
            label="Subagent model selection is unavailable"
            hint={view.reason ?? "The current dsh profile does not support subagent model selection. Choose a supported profile and refresh."}
          />
        )}
        {view.failedProviders.length > 0 && (
          <SettingsRow
            label="Some providers could not load models"
            hint={`${view.failedProviders.join(", ")}. Their saved selections are preserved. Refresh to retry loading them.`}
          />
        )}
        {!view.initialized && (
          <SettingsRow label="Model selection has not been initialized" hint="No initial selection has been saved. If the catalog is empty, check your providers and refresh once models are available." />
        )}
        <SettingsSwitch
          label="Enable subagent model selection"
          hint="Allow new sessions to choose subagent models from the selected list. Turning this off keeps your model choices."
          value={selection.enabled}
          onValueChange={(enabled) => edit({ ...selection, enabled })}
          disabled={busy || !view.supported}
        />
        <SettingsRow
          label={`${selection.allowedModels.length} selected · ${view.models.length} available`}
          hint={missingCount > 0 ? `${missingCount} selected model(s) are not in the current catalog. You can keep or remove them below.` : "New models are never added to your saved selection automatically."}
          error={emptyEnabled ? "Select at least one model, or turn off model selection before saving." : undefined}
        />
        <SettingsInput label="Search models" placeholder="Name, model ID, or provider" initialValue={search} onChangeText={setSearch} />
        <SettingsAction
          label="Select all available models"
          hint="Includes all providers, even models hidden by search. Keeps saved models that are currently unavailable."
          actionLabel="Select all"
          onPress={selectAvailable}
          disabled={busy || !view.supported || view.models.length === 0 || view.models.every((model) => selectedKeys.has(subagentRouteKey(model)))}
        />
        <SettingsAction label="Clear model selection" hint="Clears every selection, including models hidden by search." actionLabel="Clear" onPress={() => edit({ ...selection, allowedModels: [] })} disabled={busy || !view.supported || selectedKeys.size === 0} />
        <SettingsAction
          label={query.isFetching ? "Refreshing models" : "Refresh models"}
          hint={dirty ? "Save or discard your changes before refreshing." : "Reload the catalog and saved selection for the active profile."}
          actionLabel={query.isError ? "Retry" : "Refresh"}
          onPress={refresh}
          disabled={busy || dirty}
        />
      </SettingsSection>
      {[...groups].sort(([left], [right]) => left.localeCompare(right)).map(([provider, group]) => (
        <SettingsSection key={provider} title={`${group.name} (${group.rows.filter((model) => selectedKeys.has(subagentRouteKey(model))).length}/${group.rows.length}${term ? " matching" : ""})`}>
          {group.rows.sort((left, right) => left.name.localeCompare(right.name) || left.model.localeCompare(right.model)).map((model) => (
            <SettingsSwitch
              key={subagentRouteKey(model)}
              label={model.name}
              hint={`${model.provider} / ${model.model}${model.available ? "" : " · Not in the current catalog; uncheck to remove from saved selection."}`}
              value={selectedKeys.has(subagentRouteKey(model))}
              onValueChange={(checked) => toggle(model, checked)}
              disabled={busy || !view.supported}
            />
          ))}
        </SettingsSection>
      ))}
      {groups.size === 0 && (
        <SettingsSection title="Models">
          <SettingsRow label={term ? "No models match your search" : "No models are available"} hint={term ? "Try another name, model ID, or provider." : "Check your provider configuration, then refresh the catalog."} />
        </SettingsSection>
      )}
      <SettingsSection title="Save subagent settings">
        <SettingsAction
          label={save.isSuccess ? "Subagent settings saved" : "Apply model selection"}
          hint={conflict ? "Settings changed elsewhere. Your edits are still here; discard changes and refresh to load the latest version." : "Changes apply only to new sessions. Existing sessions keep their current model selection."}
          error={saveError}
          actionLabel={save.isPending ? "Saving" : "Save"}
          onPress={() => {
            if (!dirty || busy || emptyEnabled || conflict || launchChanged || !view.supported || query.isError) return;
            save.mutate({ input: { profile: view.profile, revision: view.revision, selection }, launchRevision });
          }}
          disabled={!dirty || busy || emptyEnabled || conflict || launchChanged || !view.supported || query.isError}
        />
        <SettingsAction label="Discard changes and reload saved selection" actionLabel="Discard and refresh" onPress={discardAndRefresh} disabled={busy || (!dirty && !save.isError)} />
      </SettingsSection>
    </>
  );
}
