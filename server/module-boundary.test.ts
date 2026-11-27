import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

// Paseo only loads plugin modules from client/, server/ and shared/; a relative
// import (or require) reaching any other file fails the plugin build on reload.
const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWED = ["client", "server", "shared"].map((dir) => path.join(ROOT, dir) + path.sep);
const RELATIVE_SPECIFIER = /^\.\.?(\/|$)/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function shippedSources(): string[] {
  return [
    path.join(ROOT, "index.server.ts"),
    path.join(ROOT, "index.client.tsx"),
    ...ALLOWED.filter((dir) => existsSync(dir)).flatMap((dir) => sources(dir)),
  ];
}

function preprocess(file: string) {
  return ts.preProcessFile(readFileSync(file, "utf8"), true, true);
}

describe("plugin module boundary", () => {
  it("keeps relative imports inside client/, server/ and shared/", () => {
    const escapes: string[] = [];
    for (const file of shippedSources()) {
      const { importedFiles, referencedFiles } = preprocess(file);
      const localRefs = [
        ...importedFiles.map(({ fileName }) => fileName).filter((specifier) => RELATIVE_SPECIFIER.test(specifier)),
        ...referencedFiles.map(({ fileName }) => fileName),
      ];
      for (const specifier of localRefs) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!ALLOWED.some((dir) => target.startsWith(dir))) {
          escapes.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(escapes, []);
  });

  it("only names host-provided packages in shipped sources", () => {
    // Paseo resolves only these packages from its own installation. Any other bare
    // import (including type-only references to @getpaseo/client) would require a
    // package in the plugin directory, which a clean npm or Git install lacks.
    const hostModules = [
      /^@getpaseo\/plugin(?:\/|$)/,
      /^@tanstack\/react-query$/,
      /^react$/,
      /^react\/jsx-runtime$/,
      /^react-native$/,
      /^zod$/,
    ];
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const { importedFiles, typeReferenceDirectives } = preprocess(file);
      const externalRefs = [
        ...importedFiles
          .map(({ fileName }) => fileName)
          .filter((specifier) => !RELATIVE_SPECIFIER.test(specifier) && !specifier.startsWith("node:")),
        ...typeReferenceDirectives.map(({ fileName }) => fileName),
      ];
      for (const specifier of externalRefs) {
        if (!hostModules.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
