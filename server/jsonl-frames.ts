/** Splits the bridge's NDJSON stream into frames; see `createJsonlFramer`. */
export interface JsonlFramer {
  /** Feed one decoded chunk; complete frames are delivered synchronously. */
  push(chunk: string): void;
  /** Deliver a trailing frame that arrived without its LF. */
  flush(): void;
}

/**
 * Frame the bridge protocol the way JSONL actually defines it: a frame ends at
 * an LF byte and nowhere else.
 *
 * `node:readline` also treats U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
 * SEPARATOR as line breaks, while `JSON.stringify` leaves both characters raw
 * inside string values (they are legal JSON). A session history that contains
 * either character — file contents, quoted prose, an escaped-`\u2028` literal
 * copied into a prompt — therefore reaches the other side as two unparseable
 * halves, and the reply is dropped instead of answered. Framing on LF alone
 * keeps one JSON object per line whatever the payload contains.
 */
export function createJsonlFramer(onFrame: (frame: string) => void): JsonlFramer {
  let parts: string[] = [];
  const emit = (frame: string): void => {
    onFrame(frame.endsWith("\r") ? frame.slice(0, -1) : frame);
  };
  return {
    push(chunk: string): void {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline === -1) {
          if (start < chunk.length) parts.push(chunk.slice(start));
          return;
        }
        parts.push(chunk.slice(start, newline));
        // Join once per frame: a multi-megabyte reply split into many chunks
        // must not copy the accumulated prefix on every chunk.
        emit(parts.length === 1 ? parts[0]! : parts.join(""));
        parts = [];
        start = newline + 1;
      }
    },
    flush(): void {
      if (parts.length === 0) return;
      const frame = parts.join("");
      parts = [];
      if (frame) emit(frame);
    },
  };
}
