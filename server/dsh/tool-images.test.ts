import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { imageBlocksOf, materializeToolImages } from "./tool-images.js";
import type { HostContext } from "./host.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA = createHash("sha256").update(PNG_BYTES).digest("hex");

function toolMessage(content: unknown[]): Record<string, unknown> {
  return { role: "tool", content };
}

function imageBlock(
  attachmentId = `sha256:${SHA}`,
  mediaType = "image/png",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "image",
    attachment: { attachmentId, mediaType, bytes: PNG_BYTES.length, width: 8, height: 8, ...extra },
  };
}

function contextWith(service: unknown): HostContext {
  return { get: (name: string) => (name === "attachments" ? service : undefined) } as unknown as HostContext;
}

describe("tool images", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-tool-images-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds only image blocks and keeps their order", () => {
    const blocks = imageBlocksOf(
      toolMessage([
        { type: "text", text: "<type>image</type>" },
        imageBlock(),
        imageBlock(`sha256:${"b".repeat(64)}`),
      ]) as never,
    );
    assert.deepEqual(
      blocks.map((block) => block.index),
      [1, 2],
    );
  });

  it("ignores references that are not strict sha256 or a known media type", () => {
    const blocks = imageBlocksOf(
      toolMessage([
        { type: "image", attachment: { attachmentId: "../etc/passwd", mediaType: "image/png", bytes: 1, width: 1, height: 1 } },
        { type: "image", attachment: { attachmentId: `sha256:${SHA}`, mediaType: "image/svg+xml", bytes: 1, width: 1, height: 1 } },
        { type: "image", attachment: { attachmentId: `sha256:${SHA}`, mediaType: "image/png", bytes: 0, width: 1, height: 1 } },
        imageBlock(),
      ]) as never,
    );
    assert.equal(blocks.length, 1);
  });

  it("writes the verified bytes under a content-addressed name", async () => {
    const service = { readImage: async () => ({ ref: {}, data: PNG_BYTES }) };
    const outcomes = await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock()]) as never);

    assert.equal(outcomes.length, 1);
    const outcome = outcomes[0]!;
    assert.equal(outcome.status, "ready");
    assert.equal(outcome.index, 0);
    if (outcome.status !== "ready") return;
    assert.equal(outcome.path, join(dir, `${SHA}.png`));
    assert.equal((await stat(outcome.path)).size, PNG_BYTES.length);
  });

  it("reuses an existing file whose size and sha256 match without reading the store again", async () => {
    let reads = 0;
    const service = {
      readImage: async () => {
        reads += 1;
        return { ref: {}, data: PNG_BYTES };
      },
    };
    await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock()]) as never);
    const before = reads;
    const outcomes = await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock()]) as never);
    assert.equal(outcomes[0]?.status, "ready");
    assert.equal(reads, before);
  });

  it("rewrites a cached file whose size matches but whose sha256 digest does not", async () => {
    const cachedPath = join(dir, `${SHA}.png`);
    // Same byte length as PNG_BYTES, different content.
    await writeFile(cachedPath, new Uint8Array(PNG_BYTES.length));
    let reads = 0;
    const service = {
      readImage: async () => {
        reads += 1;
        return { ref: {}, data: PNG_BYTES };
      },
    };

    const outcomes = await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock()]) as never);
    assert.equal(outcomes[0]?.status, "ready");
    assert.equal(reads, 1);
    assert.deepEqual(new Uint8Array(await readFile(cachedPath)), PNG_BYTES);
  });

  it("handles concurrent materialization of the same image without temp-file collisions", async () => {
    const freshBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const freshSha = createHash("sha256").update(freshBytes).digest("hex");
    const block = imageBlock(`sha256:${freshSha}`, "image/png", { bytes: freshBytes.length });
    const service = {
      readImage: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return { ref: {}, data: freshBytes };
      },
    };

    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        materializeToolImages(contextWith(service), dir, toolMessage([block, block]) as never),
      ),
    );
    for (const outcomes of runs) {
      assert.equal(outcomes.length, 2);
      assert.equal(outcomes[0]?.status, "ready");
      assert.equal(outcomes[1]?.status, "ready");
    }
    assert.deepEqual(new Uint8Array(await readFile(join(dir, `${freshSha}.png`))), freshBytes);
  });

  it("reports a failed read without rejecting", async () => {
    const service = {
      readImage: async () => {
        throw new Error("digest mismatch");
      },
    };
    const fresh = `sha256:${"c".repeat(64)}`;
    const outcomes = await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock(fresh)]) as never);
    assert.equal(outcomes[0]?.status, "failed");
    if (outcomes[0]?.status === "failed") assert.equal(outcomes[0].code, "read_failed");
  });

  it("reports unavailable when the profile has no readImage", async () => {
    const fresh = `sha256:${"d".repeat(64)}`;
    const outcomes = await materializeToolImages(contextWith({}), dir, toolMessage([imageBlock(fresh)]) as never);
    assert.equal(outcomes[0]?.status, "unavailable");
  });

  it("keeps a good image when a sibling fails", async () => {
    const second = "b".repeat(64);
    const service = {
      readImage: async (ref: { attachmentId: string }) => {
        if (ref.attachmentId.endsWith(second)) throw new Error("gone");
        return { ref: {}, data: PNG_BYTES };
      },
    };
    const outcomes = await materializeToolImages(
      contextWith(service),
      dir,
      toolMessage([imageBlock(), imageBlock(`sha256:${second}`)]) as never,
    );
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]?.status, "ready");
    assert.equal(outcomes[1]?.status, "failed");
  });

  it("returns nothing when the message has no image blocks", async () => {
    const outcomes = await materializeToolImages(
      contextWith({}),
      dir,
      toolMessage([{ type: "text", text: "ok" }]) as never,
    );
    assert.deepEqual(outcomes, []);
  });
});
