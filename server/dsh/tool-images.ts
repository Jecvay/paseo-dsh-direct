import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "../../shared/bridge-protocol.js";
import type { ToolImageOutcome } from "../../shared/bridge-protocol.js";
import type { HostContext } from "./host.js";

/** Media types DSH normalizes attachments to, and the extension Paseo keys on. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

const SHA256_HEX = /^sha256:([0-9a-f]{64})$/u;

type MaterializedImage =
  | { status: "ready"; path: string }
  | { status: "failed"; code: string; message: string }
  | { status: "unavailable" };

// Share only concurrent work; later calls must revalidate the on-disk cache.
const inflightImages = new WeakMap<HostContext, Map<string, Promise<MaterializedImage>>>();

interface ImageAttachmentRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/**
 * Pull the `image` content blocks out of a tool result message.
 *
 * Only these blocks carry an attachment; the sibling `text` block is a human
 * summary (`<type>image</type>` plus dimensions) and is left to the normal text
 * path.
 */
export function imageBlocksOf(message: JsonObject): Array<{ index: number; ref: ImageAttachmentRef }> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const found: Array<{ index: number; ref: ImageAttachmentRef }> = [];
  content.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const block = raw as Record<string, unknown>;
    if (block.type !== "image") return;
    const attachment = block.attachment;
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) return;
    const record = attachment as Record<string, unknown>;
    const attachmentId = typeof record.attachmentId === "string" ? record.attachmentId : "";
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
    const bytes = typeof record.bytes === "number" ? record.bytes : -1;
    const width = typeof record.width === "number" ? record.width : -1;
    const height = typeof record.height === "number" ? record.height : -1;
    // Reject anything that could not be a real reference: the id is the only
    // value that ever reaches a file name, and it is matched strictly.
    if (!SHA256_HEX.test(attachmentId)) return;
    if (!Object.hasOwn(EXTENSIONS, mediaType)) return;
    if (![bytes, width, height].every((value) => Number.isSafeInteger(value) && value > 0)) return;
    found.push({
      index,
      ref: {
        attachmentId,
        mediaType,
        bytes,
        width,
        height,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      },
    });
  });
  return found;
}

function targetFile(dir: string, ref: ImageAttachmentRef): { path: string; digest: string } {
  const match = SHA256_HEX.exec(ref.attachmentId)!;
  const digest = match[1]!;
  return { path: join(dir, `${digest}.${EXTENSIONS[ref.mediaType]}`), digest };
}

async function hasValidCachedImage(
  path: string,
  ref: ImageAttachmentRef,
  expectedDigest: string,
): Promise<boolean> {
  try {
    const existing = await stat(path);
    if (!existing.isFile() || existing.size !== ref.bytes) return false;
    const data = await readFile(path);
    if (data.byteLength !== ref.bytes) return false;
    return createHash("sha256").update(data).digest("hex") === expectedDigest;
  } catch {
    return false;
  }
}

/**
 * Write one tool-result image where the plugin can serve it from, and return
 * what the plugin should do with it.
 *
 * The bytes come from DSH's attachment store through `readImage`, which
 * re-verifies the digest, size and dimensions before handing them back. Writing
 * straight from the on-disk object instead would skip that check and would
 * assume a backend layout the profile is free to change.
 */
function materialize(
  ctx: HostContext,
  dir: string,
  ref: ImageAttachmentRef,
): Promise<MaterializedImage> {
  const { path, digest } = targetFile(dir, ref);
  let inflight = inflightImages.get(ctx);
  if (!inflight) {
    inflight = new Map();
    inflightImages.set(ctx, inflight);
  }
  const key = JSON.stringify([path, ref.bytes, ref.width, ref.height]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = materializeFile(ctx, dir, path, digest, ref).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

async function materializeFile(
  ctx: HostContext,
  dir: string,
  path: string,
  digest: string,
  ref: ImageAttachmentRef,
): Promise<MaterializedImage> {
  if (await hasValidCachedImage(path, ref, digest)) {
    return { status: "ready", path };
  }
  const service = ctx.get("attachments");
  if (service === undefined || typeof service.readImage !== "function")
    return { status: "unavailable" };

  let stored;
  try {
    stored = await service.readImage(ref, AbortSignal.timeout(10_000));
  } catch {
    return {
      status: "failed",
      code: "read_failed",
      message: "Attachment read failed",
    };
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Write under a unique temporary name first so concurrent writers never
    // collide on the staging file and concurrent readers never see a
    // half-written file, then publish it with rename.
    await writeFile(temporary, stored.data, { mode: 0o600 });
    await rename(temporary, path);
    return { status: "ready", path };
  } catch {
    await unlink(temporary).catch(() => undefined);
    return {
      status: "failed",
      code: "write_failed",
      message: "Attachment write failed",
    };
  }
}

/** Materialize every image a tool result carries, preserving block order. */
export async function materializeToolImages(
  ctx: HostContext,
  dir: string,
  message: JsonObject,
): Promise<ToolImageOutcome[]> {
  const blocks = imageBlocksOf(message);
  if (blocks.length === 0) return [];
  const outcomes = await Promise.all(
    blocks.map(async (block) => {
      const outcome = await materialize(ctx, dir, block.ref);
      return {
        ...outcome,
        index: block.index,
        ...(outcome.status === "ready" && block.ref.name ? { name: block.ref.name } : {}),
      };
    }),
  );
  return outcomes;
}
