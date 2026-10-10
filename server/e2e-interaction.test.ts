import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { InteractionRequest } from "../shared/bridge-protocol.js";
import { launchDshBridge, resolveDshExecutable, type DshBridge } from "./bridge-client.js";
import { DSH_BRIDGE_SOURCE } from "./generated-bridge.js";

// Real dsh and a real model: runs only with DEEPSEEK_API_KEY set and dsh runnable.
const executable = resolveDshExecutable(process.env.PASEO_DSH_EXECUTABLE);
const hasDsh = spawnSync(executable, ["--version"], { stdio: "ignore" }).status === 0;
const skip = !process.env.DEEPSEEK_API_KEY
  ? "DEEPSEEK_API_KEY is not set"
  : !hasDsh
    ? `${executable} is not runnable`
    : false;
const TURN_TIMEOUT_MS = 180_000;

/** Runs one prompt and resolves with the interaction requests seen before the agent went idle. */
async function runTurn(
  bridge: DshBridge,
  sessionId: string,
  text: string,
  answer: (request: InteractionRequest) => Promise<void>,
): Promise<InteractionRequest[]> {
  const seen: InteractionRequest[] = [];
  let sawRunning = false;
  const idle = new Promise<void>((resolve) => {
    const off = bridge.on("session.status", (value) => {
      if (value.sessionId !== sessionId) return;
      if (value.status === "running") sawRunning = true;
      else if (sawRunning) {
        off();
        resolve();
      }
    });
  });
  const offRequest = bridge.on("interaction.request", (request) => {
    if (request.sessionId !== sessionId) return;
    seen.push(request);
    void answer(request);
  });
  try {
    await bridge.request("session.prompt", { sessionId, content: [{ type: "text", text }] });
    await Promise.race([
      idle,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn did not finish")), TURN_TIMEOUT_MS)),
    ]);
  } finally {
    offRequest();
  }
  return seen;
}

describe("approval and user question round trips (real dsh)", { skip }, () => {
  async function withSession(body: (bridge: DshBridge, sessionId: string) => Promise<void>): Promise<void> {
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-dsh-e2e-"));
    const bridge = await launchDshBridge({
      bridgeSource: DSH_BRIDGE_SOURCE,
      executable: process.env.PASEO_DSH_EXECUTABLE,
      profile: process.env.PASEO_DSH_PROFILE,
      ephemeral: true,
    });
    try {
      const { permissionPresets = [] } = bridge.initialized.catalog;
      const strict = permissionPresets.find((preset) => preset.id === "read-only") ?? permissionPresets[0];
      const opened = await bridge.request("session.open", { cwd, permissionPreset: strict?.id });
      try {
        await body(bridge, opened.sessionId);
      } finally {
        await bridge.request("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
      }
    } finally {
      await bridge.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("delivers a tool approval request and finishes the turn once it is allowed", async () => {
    await withSession(async (bridge, sessionId) => {
      assert.ok(bridge.initialized.capabilities.approvals, "the handshake reports approvals");
      const requests = await runTurn(
        bridge,
        sessionId,
        "Run the shell command `echo paseo-approval-ok > approved.txt` with your shell tool, then reply done.",
        async (request) => {
          if (request.kind === "approval") {
            await bridge.request("interaction.respond", { requestId: request.requestId, outcome: "allowed-once" });
          }
        },
      );
      assert.ok(requests.some((request) => request.kind === "approval"), "an approval request reached the provider");
    });
  });

  it("delivers a user question and finishes the turn once it is answered", async () => {
    await withSession(async (bridge, sessionId) => {
      assert.ok(bridge.initialized.capabilities.questions, "the handshake reports user questions");
      const requests = await runTurn(
        bridge,
        sessionId,
        "Before answering, use your ask-user question tool to ask me to choose between the options Red and Blue, then reply with my choice.",
        async (request) => {
          if (request.kind !== "questions") return;
          const answers = (request.questions ?? []).map((question) => ({
            id: question.id,
            selected: question.options?.[0] ? [question.options[0].label] : [],
            ...(question.options?.[0] ? {} : { custom: "Red" }),
          }));
          await bridge.request("interaction.respond", { requestId: request.requestId, answers });
        },
      );
      assert.ok(requests.some((request) => request.kind === "questions"), "a question request reached the provider");
    });
  });
});
