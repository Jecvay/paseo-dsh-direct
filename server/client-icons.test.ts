import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SETTINGS_SCREEN_ICON } from "../shared/settings.js";

// Copied from the names Paseo accepts: exports of `lucide-react-native`, matched by exact
// PascalCase name (packages/app/src/plugins/icons.ts, `findLucideIcon` in getpaseo/paseo).
// Keep only names present in Paseo 0.11.0 and later.
const PASEO_ICON_ALLOWLIST = ["Settings", "Terminal", "File", "CircleDot"];

describe("client icons", () => {
  it("uses a Lucide name Paseo accepts for the settings screen", () => {
    assert.ok(PASEO_ICON_ALLOWLIST.includes(SETTINGS_SCREEN_ICON));
  });

  it("passes no inline icon string from index.client.tsx", () => {
    const source = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /icon:\s*"/);
  });
});
