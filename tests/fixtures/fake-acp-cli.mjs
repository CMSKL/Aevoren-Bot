#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-acp 1.0.0\n");
  process.exit(0);
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
let promptRequest = null;
let promptSession = null;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: { promptCapabilities: { image: false }, mcpCapabilities: {} },
      _meta: { modelState: { currentModelId: "fixture-acp", availableModels: [{ modelId: "fixture-acp", name: "Fixture ACP" }] } },
    } });
    return;
  }
  if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "fixture-acp-session",
      models: { currentModelId: "fixture-acp", availableModels: [{ modelId: "fixture-acp", name: "Fixture ACP" }] },
    } });
    return;
  }
  if (message.method === "session/set_model" || message.method === "session/set_config_option") {
    const model = message.params.modelId ?? message.params.value;
    const currentModelId = process.env.FAKE_ACP_MODEL_MISMATCH === "1" ? "wrong-model" : model;
    send({ jsonrpc: "2.0", id: message.id, result: { models: { currentModelId } } });
    return;
  }
  if (message.method === "session/prompt") {
    promptRequest = message.id;
    promptSession = message.params.sessionId;
    send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: {
      sessionId: promptSession,
      toolCall: { toolCallId: "blocked-tool", kind: "execute", title: "blocked" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    } });
    return;
  }
  if (message.id === 900 && promptRequest !== null) {
    if (message.result?.outcome?.optionId !== "reject-once") process.exit(9);
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: promptSession,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP reply" } },
    } });
    send({ jsonrpc: "2.0", id: promptRequest, result: { stopReason: "end_turn" } });
    promptRequest = null;
    return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
});
