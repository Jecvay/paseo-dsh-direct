import { createServer, type Server } from "node:http";

// All model and MCP traffic is served on loopback; no real model credentials are used.
export async function createFixture() {
  const requests: any[] = [];
  const mcpCalls: string[] = [];
  let reply: (body: any) => { text?: string; tool?: string; args?: unknown } = () => ({ text: "fixture-ok" });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/mcp") {
        const result = body.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : body.method === "tools/list"
            ? { tools: ["echo", "echo_neighbor"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } })) }
            : body.method === "tools/call"
              ? (mcpCalls.push(body.params.name), { content: [{ type: "text", text: `external:${body.params.name}:${body.params.arguments.value}` }] })
              : {};
        if (body.id === undefined) { res.writeHead(202).end(); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      requests.push(body);
      const output = reply(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant", content: "" });
      if (output.tool) {
        send({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: output.tool, arguments: JSON.stringify(output.args ?? {}) } }] });
        send({}, "tool_calls");
      } else { send({ content: output.text ?? "fixture-ok" }); send({}, "stop"); }
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests, mcpCalls,
    script(handler: typeof reply) { reply = handler; },
    async close() { await closeServer(server); },
  };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export function hookPlugin(url: string, auditFile: string) {
  return `import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { appendFileSync } from "node:fs";
const audit = value => appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify(value) + "\\n");
export default function(server) {
  server.before("agent.session_open", ({ request }) => {
    audit({ reason: request.reason, provider: request.provider, agentId: request.agentId });
    request.mcpServers.fixture_external = { type: "http", url: ${JSON.stringify(url + "/mcp")} };
    request.tools.push(defineAgentTool({ name: "fixture_agent_echo", description: "Echo through a per-agent Paseo tool", input: z.object({ value: z.string() }), execute(input, context) { audit({ tool: "fixture_agent_echo", agentId: context.agent.id, value: input.value }); return { text: "per-agent:" + input.value }; } }));
    return request;
  });
  return () => {};
}
`;
}
