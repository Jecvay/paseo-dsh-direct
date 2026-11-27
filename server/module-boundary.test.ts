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

function shippedSources(): string[] {
  return [
    path.join(ROOT, "index.server.ts"),
    path.join(ROOT, "index.client.tsx"),
    ...ALLOWED.filter((dir) => existsSync(dir)).flatMap((dir) => sources(dir)),
  ];
}

describe("plugin module boundary", () => {
  it("keeps relative imports inside client/, server/ and shared/", () => {
    const escapes: string[] = [];
    for (const file of shippedSources()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (!ALLOWED.some((dir) => target.startsWith(dir))) escapes.push(`${path.relative(ROOT, file)} -> ${match[1]}`);
      }
    }
    assert.deepEqual(escapes, []);
  });

  it("does not reference @getpaseo/client, which a clean install lacks", () => {
    // Paseo supplies its plugin SDK declarations, but a clean plugin directory has
    // no @getpaseo/client. A type-only reference would still fail the plugin build.
    const offenders = shippedSources().filter((file) =>
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@getpaseo\/client(?:\/[^"']*)?["']/.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(offenders.map((file) => path.relative(ROOT, file)), []);
  });

  it("only names host-provided packages in shipped sources", () => {
    // Paseo resolves these from its own installation. Any other bare import would
    // need a dependency installed in the plugin directory, which is not shipped.
    const hostModules = [
      /^@getpaseo\/plugin(?:\/|$)/,
      /^@tanstack\/react-query$/,
      /^react$/,
      /^react\/jsx-runtime$/,
      /^react-native$/,
      /^zod$/,
    ];
    const generated = new Set(["server/generated-bridge.ts", "server/generated-version.ts"]);
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      if (generated.has(path.relative(ROOT, file))) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
        if (!hostModules.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
