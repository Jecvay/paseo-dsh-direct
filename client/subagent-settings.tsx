import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsInput, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import SettingsSection from "./settings-section.js";
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
export default function SubagentSettings({ theme, launchRevision, launchSaving }: {
  theme: PluginSurfaceProps["theme"];
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
  const [editorOpen, setEditorOpen] = useState(false);
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
      <SettingsSection theme={theme} title="Subagents">
        <SettingsRow
          label={query.isError ? "Could not load subagent models" : "Loading subagent models"}
          error={query.isError ? errorMessage(query.error) : undefined}
        />
        {query.isError && <SettingsAction label="Load models" actionLabel="Retry" onPress={refresh} disabled={busy} />}
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

  // Older clients expose the same UI module without Modal; keep their inline editor.
  const hasModal = typeof Modal !== "undefined" && Modal.Content != null;
  const feedback = (
    <>
      {conflict && (
        <SettingsRow label="Settings changed elsewhere" hint="Discard your edits and reload the saved settings" />
      )}
      {query.isError && (
        <SettingsRow label="Could not refresh models" error={errorMessage(query.error)} hint={dirty ? "Your edits are kept; discard and refresh to retry" : "The previous list is shown; refresh to retry"} />
      )}
      {launchChanged && (
        <SettingsRow label="Connection settings changed" error="These edits belong to the previous connection. Discard and refresh before saving." />
      )}
      {!view.supported && (
        <SettingsRow
          label="Model selection unavailable"
          hint={view.reason ?? "Choose a profile that supports model selection, then refresh."}
        />
      )}
      {view.failedProviders.length > 0 && (
        <SettingsRow
          label="Some providers could not load models"
          hint={`${view.failedProviders.join(", ")} · Saved choices kept; refresh to retry`}
        />
      )}
      {view.supported && !view.initialized && (
        <SettingsRow label="No saved selection" hint="Choose models and save, or check your providers if the list is empty" />
      )}
      {missingCount > 0 && (
        <SettingsRow label={`${missingCount} selected ${missingCount === 1 ? "model is" : "models are"} missing from this catalog`} hint="Saved choices are kept unless you remove them" />
      )}
    </>
  );
  const editor = (
    <>
      <SettingsSection theme={theme} title="Selection">
        <SettingsRow
          label={`${selection.allowedModels.length} selected · ${view.models.length} available · Profile: ${view.profile}`}
          hint="Closing keeps your unsaved changes"
          error={emptyEnabled ? "Select at least one model, or turn off Use selected models." : undefined}
        />
        {feedback}
      </SettingsSection>
      <SettingsSection theme={theme} title="Model selection">
        <SettingsSwitch
          label="Use selected models"
          hint="Turn off to use the profile’s default behavior"
          value={selection.enabled}
          onValueChange={(enabled) => edit({ ...selection, enabled })}
          disabled={busy || !view.supported}
        />
        <SettingsInput label="Search" placeholder="Name, ID or provider" initialValue={search} onChangeText={setSearch} />
      </SettingsSection>
      {[...groups].sort(([left], [right]) => left.localeCompare(right)).map(([provider, group]) => (
        <SettingsSection theme={theme} key={provider} title={`${group.name} (${group.rows.filter((model) => selectedKeys.has(subagentRouteKey(model))).length}/${group.rows.length}${term ? " matching" : ""})`}>
          {group.rows.sort((left, right) => left.name.localeCompare(right.name) || left.model.localeCompare(right.model)).map((model) => (
            <SettingsSwitch
              key={subagentRouteKey(model)}
              label={model.name}
              hint={model.name === model.model ? (model.available ? undefined : "Not in this catalog") : `${model.model}${model.available ? "" : " · Not in this catalog"}`}
              value={selectedKeys.has(subagentRouteKey(model))}
              onValueChange={(checked) => toggle(model, checked)}
              disabled={busy || !view.supported}
            />
          ))}
        </SettingsSection>
      ))}
      {view.supported && groups.size === 0 && (
        <SettingsSection theme={theme} title="Models">
          <SettingsRow label={term ? "No matching models" : "No models available"} hint={term ? "Try a different name, ID or provider" : "Check your providers, then refresh"} />
        </SettingsSection>
      )}
      <SettingsSection theme={theme} title="All models">
        <SettingsAction
          label="Available models"
          hint="Includes models hidden by your search"
          actionLabel="Select all"
          onPress={selectAvailable}
          disabled={busy || !view.supported || view.models.length === 0 || view.models.every((model) => selectedKeys.has(subagentRouteKey(model)))}
        />
        <SettingsAction label="Selected models" hint="Clears every choice, including models not shown" actionLabel="Clear" onPress={() => edit({ ...selection, allowedModels: [] })} disabled={busy || !view.supported || selectedKeys.size === 0} />
        <SettingsAction
          label={query.isFetching ? "Refreshing models" : "Refresh models"}
          hint={dirty ? "Save or discard edits first" : undefined}
          actionLabel={query.isError ? "Retry" : "Refresh"}
          onPress={refresh}
          disabled={busy || dirty}
        />
      </SettingsSection>
      <SettingsSection theme={theme} title="Changes">
        <SettingsAction
          label={save.isSuccess ? "Settings saved" : "Save selection"}
          hint="Applies to new sessions"
          error={saveError}
          actionLabel={save.isPending ? "Saving" : "Save"}
          onPress={() => {
            if (!dirty || busy || emptyEnabled || conflict || launchChanged || !view.supported || query.isError) return;
            save.mutate({ input: { profile: view.profile, revision: view.revision, selection }, launchRevision });
          }}
          disabled={!dirty || busy || emptyEnabled || conflict || launchChanged || !view.supported || query.isError}
        />
        <SettingsAction label="Reload saved settings" hint="Discards your unsaved changes" actionLabel="Discard and refresh" onPress={discardAndRefresh} disabled={busy || (!dirty && !save.isError)} />
      </SettingsSection>
    </>
  );

  return (
    <>
      <SettingsSection theme={theme} title="Subagents">
        <SettingsAction
          label={`Model selection: ${selection.enabled ? "On" : "Off"}${save.isPending ? " · Saving…" : dirty ? " · Unsaved changes" : ""}`}
          hint={`${selection.allowedModels.length} selected · ${view.models.length} available`}
          actionLabel={!hasModal && editorOpen ? "Close editor" : "Edit models"}
          onPress={() => setEditorOpen((value) => hasModal || !value)}
          error={emptyEnabled ? "Select at least one model, or turn off Use selected models." : saveError}
        />
        {feedback}
      </SettingsSection>
      {hasModal ? (
        <Modal title="Subagent models" open={editorOpen} onOpenChange={setEditorOpen}>
          <Modal.Content>{editor}</Modal.Content>
        </Modal>
      ) : editorOpen ? editor : null}
    </>
  );
}
