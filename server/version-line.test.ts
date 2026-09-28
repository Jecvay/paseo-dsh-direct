import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchVersionLine, versionLine, versionWarningMessage } from "./version-line.js";

describe("matchVersionLine", () => {
  it("matches when major.minor agree despite a dsh prerelease suffix", () => {
    assert.equal(matchVersionLine("0.1.1", "0.1.7-rc.2"), "match");
  });

  it("flags a different minor line even with a prerelease suffix", () => {
    assert.equal(matchVersionLine("0.1.1", "0.2.0-rc.1"), "mismatch");
  });

  it("cannot confirm a blank or garbled dsh version", () => {
    assert.equal(matchVersionLine("0.1.1", ""), "unknown");
    assert.equal(matchVersionLine("0.1.1", "garbled-output"), "unknown");
  });

  it("flags a different major line", () => {
    assert.equal(matchVersionLine("1.0.0", "0.1.0"), "mismatch");
  });
});

describe("versionLine", () => {
  it("drops patch and prerelease information", () => {
    assert.equal(versionLine("0.1.7-rc.2"), "0.1");
    assert.equal(versionLine("2.10.3"), "2.10");
  });

  it("returns undefined for unparseable input", () => {
    assert.equal(versionLine(""), undefined);
    assert.equal(versionLine("garbled-output"), undefined);
  });
});

describe("versionWarningMessage", () => {
  it("names the plugin line, the dsh line and the detected version for a mismatch", () => {
    const message = versionWarningMessage("mismatch", "0.1.1", "0.2.0-rc.1");
    assert.match(message, /0\.1\.\*/);
    assert.match(message, /0\.2\.0-rc\.1/);
    assert.match(message, /0\.2\.x/);
  });

  it("names the plugin line for an unconfirmed dsh version", () => {
    const message = versionWarningMessage("unknown", "0.1.1", "");
    assert.match(message, /0\.1\.\*/);
  });
});
