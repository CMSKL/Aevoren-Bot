#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0-fixture\n");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if (!input.includes("[user]")) process.exit(3);
  const sendExec = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  sendExec({ type: "thread.started", thread_id: "fixture-exec-thread" });
  sendExec({ type: "turn.started" });
  sendExec({ type: "item.completed", item: { type: "agent_message", text: "Exec reply" } });
  sendExec({ type: "turn.completed" });
  process.exit(0);
}

if (!process.argv.includes("app-server")) process.exit(2);
if (process.env.FAKE_CODEX_APP_SERVER_FAIL === "1") process.exit(4);

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fake" } });
    return;
  }
  if (message.method === "account/read") {
    send({ jsonrpc: "2.0", id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === "model/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        data: [{ id: "fixture-model", displayName: "Fixture Model", hidden: false, isDefault: true }],
        nextCursor: null,
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "fixture-thread" }, model: message.params.model } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "fixture-turn", status: "inProgress", items: [], error: null };
    send({ jsonrpc: "2.0", id: message.id, result: { turn } });
    queueMicrotask(() => {
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "message", delta: "CLI " } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "message", delta: "reply" } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "fixture-thread", turn: { ...turn, status: "completed" } } });
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
});
