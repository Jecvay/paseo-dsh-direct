import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJsonlFramer } from "./jsonl-frames.js";

describe("createJsonlFramer", () => {
  it("keeps U+2028 and U+2029 inside the frame", () => {
    // JSON.stringify leaves both raw; readline treated them as line breaks.
    const frames: string[] = [];
    createJsonlFramer((frame) => frames.push(frame)).push('{"text":"a\u2028b\u2029c"}\n');
    assert.deepEqual(frames, ['{"text":"a\u2028b\u2029c"}']);
  });

  it("frames on LF, drops CR, and reassembles a chunked frame", () => {
    const frames: string[] = [];
    const framer = createJsonlFramer((frame) => frames.push(frame));
    framer.push('{"a":1}\r');
    framer.push('\n{"b"');
    framer.push(':2}');
    framer.flush();
    assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
  });
});
