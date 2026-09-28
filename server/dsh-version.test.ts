import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectDshVersion } from "./dsh-version.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-dsh-version-test-"));
  return {
    root,
    async script(name: string, body: string): Promise<string> {
      const file = path.join(root, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
      return file;
    },
  };
}

describe("detectDshVersion", () => {
  it("parses the version a well-behaved executable prints", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-ok", `echo "0.1.7-rc.2"`);
      assert.equal(await detectDshVersion(exe), "0.1.7-rc.2");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("tolerates surrounding text around the version", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-prefixed", `echo "dsh version 0.2.0-rc.1"`);
      assert.equal(await detectDshVersion(exe), "0.2.0-rc.1");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string on a non-zero exit", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-fails", `echo "boom" >&2\nexit 1`);
      assert.equal(await detectDshVersion(exe), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string when the output has no parseable version", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-garbled", `echo "not a version"`);
      assert.equal(await detectDshVersion(exe), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("returns an empty string and kills the process on timeout", async () => {
    const f = await fixture();
    try {
      const exe = await f.script("dsh-hangs", `sleep 5`);
      assert.equal(await detectDshVersion(exe, { timeoutMs: 50 }), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("caches by executable path: a second call does not spawn again", async () => {
    const f = await fixture();
    try {
      const log = path.join(f.root, "calls.log");
      const exe = await f.script("dsh-counted", `echo called >> "${log}"\necho "0.1.1"`);
      assert.equal(await detectDshVersion(exe), "0.1.1");
      assert.equal(await detectDshVersion(exe), "0.1.1");
      assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
