import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheHitPercent, formatElapsed, formatTokens, sessionMetrics, turnMetrics } from "./turn-metrics.js";

describe("turn metrics formatting", () => {
  it("keeps durations readable at every scale", () => {
    assert.equal(formatElapsed(0), "<0.1s");
    assert.equal(formatElapsed(12_431), "12.4s");
    assert.equal(formatElapsed(59_949), "59.9s");
    assert.equal(formatElapsed(59_950), "1m 0s");
    assert.equal(formatElapsed(605_000), "10m 5s");
    assert.equal(formatElapsed(Number.POSITIVE_INFINITY), undefined);
    assert.equal(formatElapsed(-1), undefined);
    assert.equal(formatElapsed(Number.NaN), undefined);
  });

  it("compacts token counts", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(999.6), "1.0K");
    assert.equal(formatTokens(18_900), "18.9K");
    assert.equal(formatTokens(99_999), "100.0K");
    assert.equal(formatTokens(999_999), "1.0M");
    assert.equal(formatTokens(2_340_000), "2.3M");
  });

  it("counts cached reads against the whole prompt", () => {
    assert.equal(cacheHitPercent({ inputTokens: 100, cachedInputTokens: 800, cacheWriteTokens: 100 }), 80);
    assert.equal(cacheHitPercent({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }), undefined);
    assert.equal(cacheHitPercent({ cachedInputTokens: 10, cacheWriteTokens: 0 }), undefined);
    assert.equal(cacheHitPercent({ inputTokens: 10, cachedInputTokens: 10 }), undefined);
    assert.equal(cacheHitPercent({ inputTokens: 100, cachedInputTokens: 100, cacheWriteTokens: 100 }), 33);
    assert.equal(cacheHitPercent({ inputTokens: 100, cachedInputTokens: -50, cacheWriteTokens: 0 }), undefined);
    assert.equal(cacheHitPercent({ inputTokens: -100, cachedInputTokens: 300, cacheWriteTokens: 0 }), undefined);
  });
});

describe("turn metrics rows", () => {
  it("reports model, elapsed, tokens and a healthy cache", () => {
    assert.deepEqual(
      turnMetrics({
        model: "DeepSeek Chat",
        elapsedMs: 12_431,
        inputTokens: 1000,
        cachedInputTokens: 3000,
        cacheWriteTokens: 1000,
        outputTokens: 300,
      }),
      [
        { label: "Model", value: "DeepSeek Chat" },
        { label: "Elapsed", value: "12.4s" },
        { label: "Tokens", value: "1.0K ↑ · 300 ↓" },
        { label: "Cache", value: "60%", tone: "ok" },
      ],
    );
  });

  it("leaves out rows whose data is missing instead of showing zero", () => {
    assert.deepEqual(turnMetrics({}), []);
    assert.deepEqual(turnMetrics({ elapsedMs: 0 }), [{ label: "Elapsed", value: "<0.1s" }]);
    assert.deepEqual(turnMetrics({ inputTokens: Number.NaN, outputTokens: Number.NaN }), []);
    assert.deepEqual(turnMetrics({ inputTokens: 100 }), []);
    assert.deepEqual(turnMetrics({ model: "DeepSeek Chat", elapsedMs: 1_000 }), [
      { label: "Model", value: "DeepSeek Chat" },
      { label: "Elapsed", value: "1.0s" },
    ]);
    assert.deepEqual(
      turnMetrics({
        inputTokens: 100,
        cachedInputTokens: 900,
        cacheWriteTokens: 0,
        outputTokens: 50,
      }),
      [
        { label: "Tokens", value: "100 ↑ · 50 ↓" },
        { label: "Cache", value: "90%", tone: "ok" },
      ],
    );
  });

  it("does not color a low cache hit", () => {
    assert.deepEqual(
      turnMetrics({
        inputTokens: 900,
        cachedInputTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 10,
      }).at(-1),
      { label: "Cache", value: "10%" },
    );
  });
});

describe("session metrics rows", () => {
  it("reports turns, session tokens and session cache", () => {
    assert.deepEqual(
      sessionMetrics({
        turns: 7,
        inputTokens: 2000,
        cachedInputTokens: 6000,
        cacheWriteTokens: 1000,
        outputTokens: 800,
      }),
      [
        { label: "Turns", value: "7" },
        { label: "Tokens", value: "2.0K ↑ · 800 ↓" },
        { label: "Cache", value: "67%", tone: "ok" },
      ],
    );
  });

  it("keeps turns when token totals are not available", () => {
    assert.deepEqual(sessionMetrics({ turns: 2 }), [{ label: "Turns", value: "2" }]);
  });

});
