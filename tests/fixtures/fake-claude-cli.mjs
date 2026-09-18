#!/usr/bin/env node
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.273-fixture (Claude Code)\n");
  process.exit(0);
}

if (process.argv[2] === "auth" && process.argv[3] === "status" && process.argv.includes("--json")) {
  process.stdout.write('{"loggedIn":true,"authMethod":"oauth_token"}\n');
  process.exit(0);
}

if (!process.argv.includes("-p")) process.exit(2);
if (process.env.FAKE_CLAUDE_EXPECT_SETTING === "1") {
  if (process.env.ANTHROPIC_AUTH_TOKEN !== "fixture-auth-token") process.exit(5);
  if (process.argv.includes("--settings")) process.exit(6);
  if (process.env.UNRELATED_SECRET) process.exit(7);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.includes("[user]")) process.exit(3);
  const sessionId = randomUUID();
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  send({ type: "system", subtype: "init", session_id: sessionId });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude " } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "reply" } } });
  send({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "Claude reply" });
});
