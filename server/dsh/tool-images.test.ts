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

  it("rejects inherited media types and non-positive or unsafe integer metadata", () => {
    const invalid = [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    const blocks = [
      ...["__proto__", "constructor", "toString"].map((mediaType) =>
        imageBlock(`sha256:${SHA}`, mediaType),
      ),
      ...["bytes", "width", "height"].flatMap((field) =>
        invalid.map((value) => imageBlock(`sha256:${SHA}`, "image/png", { [field]: value })),
      ),
    ];
    assert.deepEqual(imageBlocksOf(toolMessage(blocks) as never), []);
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

  it("shares concurrent image work while preserving each block's index and name", async () => {
    const freshBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const freshSha = createHash("sha256").update(freshBytes).digest("hex");
    const block = imageBlock(`sha256:${freshSha}`, "image/png", { bytes: freshBytes.length, name: "first.png" });
    const second = imageBlock(`sha256:${freshSha}`, "image/png", { bytes: freshBytes.length, name: "second.png" });
    let reads = 0;
    const service = {
      readImage: async () => {
        reads += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { ref: {}, data: freshBytes };
      },
    };
    const ctx = contextWith(service);
    const cachedPath = join(dir, `${freshSha}.png`);
    const message = toolMessage([{ type: "text", text: "images" }, block, second]) as never;
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => materializeToolImages(ctx, dir, message)),
    );
    assert.equal(reads, 1);
    for (const outcomes of runs) {
      assert.deepEqual(outcomes, [
        { status: "ready", path: cachedPath, index: 1, name: "first.png" },
        { status: "ready", path: cachedPath, index: 2, name: "second.png" },
      ]);
    }
    assert.deepEqual(new Uint8Array(await readFile(cachedPath)), freshBytes);

    // Completed work must not hide later corruption, even in the same context.
    await writeFile(cachedPath, new Uint8Array(freshBytes.length));
    await materializeToolImages(ctx, dir, message);
    assert.equal(reads, 2);
    assert.deepEqual(new Uint8Array(await readFile(cachedPath)), freshBytes);
  });

  it("isolates contexts and verification fields and retries failed work", async () => {
    let reads = 0;
    const service = {
      readImage: async () => {
        reads += 1;
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("unavailable");
      },
    };
    const ctx = contextWith(service);
    const otherCtx = contextWith(service);
    const attachmentId = `sha256:${"e".repeat(64)}`;
    const block = imageBlock(attachmentId);
    const message = toolMessage([
      block,
      block,
      imageBlock(attachmentId, "image/png", { bytes: PNG_BYTES.length + 1 }),
      imageBlock(attachmentId, "image/png", { width: 9 }),
      imageBlock(attachmentId, "image/png", { height: 9 }),
    ]) as never;
    const results = await Promise.all([
      materializeToolImages(ctx, dir, message),
      materializeToolImages(otherCtx, dir, toolMessage([block]) as never),
    ]);
    assert.equal(reads, 5);
    assert.ok(results.flat().every((outcome) => outcome.status === "failed"));
    await materializeToolImages(ctx, dir, toolMessage([block]) as never);
    assert.equal(reads, 6);
  });

  it("reports a failed read without rejecting", async () => {
    const service = {
      readImage: async () => {
        throw new Error("sensitive-error-marker");
      },
    };
    const fresh = `sha256:${"c".repeat(64)}`;
    const outcomes = await materializeToolImages(contextWith(service), dir, toolMessage([imageBlock(fresh)]) as never);
    assert.deepEqual(outcomes, [{
      index: 0,
      status: "failed",
      code: "read_failed",
      message: "Attachment read failed",
    }]);
    assert.ok(!JSON.stringify(outcomes).includes("sensitive-error-marker"));
  });

  it("does not expose filesystem error paths in failed image outcomes", async () => {
    const blockedDirectory = join(dir, "sensitive-path-marker");
    await writeFile(blockedDirectory, "not a directory");
    const service = { readImage: async () => ({ ref: {}, data: PNG_BYTES }) };
    const outcomes = await materializeToolImages(
      contextWith(service),
      blockedDirectory,
      toolMessage([imageBlock()]) as never,
    );
    assert.deepEqual(outcomes, [{
      index: 0,
      status: "failed",
      code: "write_failed",
      message: "Attachment write failed",
    }]);
    assert.ok(!JSON.stringify(outcomes).includes("sensitive-path-marker"));
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
