import { mkdir, rename, stat, writeFile, unlink } from "node:fs/promises";
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
    if (EXTENSIONS[mediaType] === undefined) return;
    if (bytes <= 0 || width <= 0 || height <= 0) return;
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

function targetPath(dir: string, ref: ImageAttachmentRef): string {
  const match = SHA256_HEX.exec(ref.attachmentId)!;
  return join(dir, `${match[1]}.${EXTENSIONS[ref.mediaType]}`);
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
async function materialize(
  ctx: HostContext,
  dir: string,
  ref: ImageAttachmentRef,
): Promise<ToolImageOutcome & { index: number }> {
  const path = targetPath(dir, ref);
  try {
    const existing = await stat(path).catch(() => undefined);
    if (existing !== undefined && existing.size === ref.bytes)
      return { index: -1, status: "ready", path, ...(ref.name ? { name: ref.name } : {}) };
  } catch {
    // Fall through and rewrite the file.
  }
  const service = ctx.get("attachments");
  if (service === undefined || typeof service.readImage !== "function")
    return { index: -1, status: "unavailable" };

  let stored;
  try {
    stored = await service.readImage(ref, AbortSignal.timeout(10_000));
  } catch (error) {
    return {
      index: -1,
      status: "failed",
      code: "read_failed",
      message: error instanceof Error ? error.message : "Attachment read failed",
    };
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Write under a temporary name first so a concurrent reader never sees a
    // half-written file, then publish it with rename.
    await writeFile(temporary, stored.data, { mode: 0o600 });
    await rename(temporary, path);
    return { index: -1, status: "ready", path, ...(ref.name ? { name: ref.name } : {}) };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    return {
      index: -1,
      status: "failed",
      code: "write_failed",
      message: error instanceof Error ? error.message : "Attachment write failed",
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
    blocks.map(async (block) => ({
      ...(await materialize(ctx, dir, block.ref)),
      index: block.index,
    })),
  );
  return outcomes;
}
