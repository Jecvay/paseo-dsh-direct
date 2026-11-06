import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsRow } from "@getpaseo/plugin/client/ui";
import SettingsSection from "./settings-section.js";
import { useRef } from "react";
import { DEFAULT_STARTUP_TIMEOUT_SECONDS, DSH_SETTINGS, MAX_STARTUP_TIMEOUT_SECONDS, type DshSettingsValues } from "../shared/settings.js";
import SubagentSettings from "./subagent-settings.js";

const EXECUTABLE_HINT = "DSH command or path; environment takes priority";
const PROFILE_HINT = "Default: paseo, unless set by environment";
const STARTUP_TIMEOUT_HINT = `Seconds to wait for dsh to start, ${DEFAULT_STARTUP_TIMEOUT_SECONDS} by default, up to ${MAX_STARTUP_TIMEOUT_SECONDS}`;

/** Edits the dsh executable, profile and startup timeout that the server reads when it launches a bridge. */
export default function DshSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(DSH_SETTINGS);
  const draftState = useRef<{ revision: string | undefined; edits: DshSettingsValues }>({
    revision: undefined,
    edits: {},
  });

  if (settings.status === "loading") {
    return (
      <ScrollView>
        <SettingsSection title="Connection" theme={theme}>
          <SettingsRow label="Loading settings" />
        </SettingsSection>
      </ScrollView>
    );
  }
  if (settings.status === "error") {
    return (
      <ScrollView>
        <SettingsSection title="Connection" theme={theme}>
          <SettingsRow label="Settings unavailable" error={settings.error} />
          <SettingsAction label="Load settings" actionLabel="Retry" onPress={() => void settings.reload()} />
        </SettingsSection>
      </ScrollView>
    );
  }
  if (settings.status === "invalid") {
    return (
      <ScrollView>
        <SettingsSection title="Connection" theme={theme}>
          <SettingsRow label="Saved settings are invalid" error={settings.error} hint="Reset to use default settings" />
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} disabled={settings.saving} />
        </SettingsSection>
      </ScrollView>
    );
  }

  const { revision, values } = settings;
  // Edits belong to the revision they were typed against; a new revision remounts the inputs, so drop them.
  if (draftState.current.revision !== revision) {
    draftState.current = { revision, edits: {} };
  }
  const draft = { current: draftState.current.edits };
  const save = () =>
    void settings.save(
      {
        executable: draft.current.executable ?? values.executable ?? "",
        profile: draft.current.profile ?? values.profile ?? "",
        startupTimeoutSeconds: draft.current.startupTimeoutSeconds ?? values.startupTimeoutSeconds ?? "",
      },
      revision,
    );

  return (
    <ScrollView>
      <SettingsSection title="Connection" theme={theme}>
        <SettingsInput
          key={`executable-${revision}`}
          label="Executable"
          hint={EXECUTABLE_HINT}
          placeholder="dsh"
          initialValue={values.executable ?? ""}
          onChangeText={(text) => {
            draft.current.executable = text;
          }}
          disabled={settings.saving}
        />
        <SettingsInput
          key={`profile-${revision}`}
          label="Profile"
          hint={PROFILE_HINT}
          placeholder="paseo"
          initialValue={values.profile ?? ""}
          onChangeText={(text) => {
            draft.current.profile = text;
          }}
          disabled={settings.saving}
        />
        <SettingsInput
          key={`startup-timeout-${revision}`}
          label="Startup timeout"
          hint={STARTUP_TIMEOUT_HINT}
          placeholder={String(DEFAULT_STARTUP_TIMEOUT_SECONDS)}
          initialValue={values.startupTimeoutSeconds ?? ""}
          onChangeText={(text) => {
            draft.current.startupTimeoutSeconds = text;
          }}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Save settings"
          hint="Applies to new sessions"
          error={settings.saveError}
          actionLabel={settings.saving ? "Saving" : "Save"}
          onPress={save}
          disabled={settings.saving}
        />
      </SettingsSection>
      <SubagentSettings theme={theme} launchRevision={revision} launchSaving={settings.saving} />
    </ScrollView>
  );
}
