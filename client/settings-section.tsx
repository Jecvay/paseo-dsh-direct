import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Text, View } from "react-native";

/** Keep section titles more prominent than field labels in every host theme. */
export default function SettingsSection({ title, theme, children }: {
  title: string;
  theme: PluginSurfaceProps["theme"];
  children: ReactNode;
}) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600", marginHorizontal: 16, marginBottom: 8 }}
      >
        {title}
      </Text>
      <View>{children}</View>
    </View>
  );
}
