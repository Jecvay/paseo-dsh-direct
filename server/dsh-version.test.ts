import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      const exe = await f.script("dsh-hangs", `exec sleep 5`);
      assert.equal(await detectDshVersion(exe, { timeoutMs: 50 }), "");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("aborts an uncached version probe and does not poison the shared cache", async () => {
    const f = await fixture();
    const controller = new AbortController();
    try {
      const pidFile = path.join(f.root, "child.pid");
      const exe = await f.script("dsh-abort", `echo $$ > "${pidFile}"\nexec sleep 30`);
      const probing = detectDshVersion(exe, { signal: controller.signal });
      while (true) {
        try { await stat(pidFile); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      controller.abort();
      await assert.rejects(probing, { name: "AbortError" });
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
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
