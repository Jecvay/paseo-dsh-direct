import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PLUGIN_ID } from "../shared/timeline-cards.js";

describe("PLUGIN_ID", () => {
  it("equals the id in paseo-plugin.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../paseo-plugin.json", import.meta.url), "utf8")) as { id: string };
    assert.equal(PLUGIN_ID, manifest.id);
  });
});
