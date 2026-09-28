import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// Paseo only loads plugin modules from client/, server/ and shared/; a relative
// import (or require) reaching any other file fails the plugin build on reload.
const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWED = ["client", "server", "shared"].map((dir) => path.join(ROOT, dir) + path.sep);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("plugin module boundary", () => {
  it("keeps relative imports inside client/, server/ and shared/", () => {
    const escapes: string[] = [];
    for (const file of ALLOWED.filter((dir) => existsSync(dir)).flatMap((dir) => sources(dir))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (!ALLOWED.some((dir) => target.startsWith(dir))) escapes.push(`${path.relative(ROOT, file)} -> ${match[1]}`);
      }
    }
    assert.deepEqual(escapes, []);
  });
});
