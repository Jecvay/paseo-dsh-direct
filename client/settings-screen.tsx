import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { DSH_SETTINGS } from "../shared/settings.js";

const EXECUTABLE_HINT =
  "Path or command of dsh. PASEO_DSH_EXECUTABLE overrides this; leave it empty to use the Paseo provider command or dsh on PATH. Changes apply to new sessions.";
const PROFILE_HINT =
  'Name of the dsh profile to launch. PASEO_DSH_PROFILE overrides this; leave it empty to use the "paseo" profile. Changes apply to new sessions.';

/** Edits the dsh executable and profile that the server reads when it launches a bridge. */
export default function DshSettingsScreen() {
  const settings = useSettings(DSH_SETTINGS);
  const draftState = useRef<{ revision: string | undefined; edits: { executable?: string; profile?: string } }>({
    revision: undefined,
    edits: {},
  });

  if (settings.status === "loading") {
    return (
      <ScrollView>
        <SettingsSection title="DeepSeek Harness">
          <SettingsRow label="Loading settings" />
        </SettingsSection>
      </ScrollView>
    );
  }
  if (settings.status === "error") {
    return (
      <ScrollView>
        <SettingsSection title="DeepSeek Harness">
          <SettingsRow label="Settings unavailable" error={settings.error} />
          <SettingsAction label="Retry" actionLabel="Retry" onPress={() => void settings.reload()} />
        </SettingsSection>
      </ScrollView>
    );
  }
  if (settings.status === "invalid") {
    return (
      <ScrollView>
        <SettingsSection title="DeepSeek Harness">
          <SettingsRow label="Stored settings are invalid" error={settings.error} hint="They are ignored until you reset them." />
          <SettingsAction label="Reset" actionLabel="Reset" onPress={() => void settings.reset()} disabled={settings.saving} />
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
      },
      revision,
    );

  return (
    <ScrollView>
      <SettingsSection title="DeepSeek Harness">
        <SettingsInput
          key={`executable-${revision}`}
          label="dsh executable"
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
          label="dsh profile"
          hint={PROFILE_HINT}
          placeholder="paseo"
          initialValue={values.profile ?? ""}
          onChangeText={(text) => {
            draft.current.profile = text;
          }}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Save"
          hint={settings.saveError ?? undefined}
          error={settings.saveError}
          actionLabel={settings.saving ? "Saving" : "Save"}
          onPress={save}
          disabled={settings.saving}
        />
      </SettingsSection>
    </ScrollView>
  );
}
