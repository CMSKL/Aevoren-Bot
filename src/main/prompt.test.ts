import { describe, expect, it } from "vitest";
import type { Bot, Session, TranscriptEntry } from "@shared/contracts";
import { buildPrompt } from "./prompt";

const bot: Bot = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Bot",
  label: "Label",
  description: "Description",
  instructions: "Profile instructions",
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const session: Session = {
  id: "00000000-0000-4000-8000-000000000002",
  botId: bot.id,
  kind: "MAIN",
  generation: 1,
  createdAt: bot.createdAt,
  updatedAt: bot.updatedAt,
};

function entry(seq: number, role: "user" | "assistant", body: string, status: TranscriptEntry["status"] = "completed"): TranscriptEntry {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    sessionId: session.id,
    generation: 1,
    seq,
    clientNonce: role === "user" ? `10000000-0000-4000-8000-${String(seq).padStart(12, "0")}` : null,
    role,
    body,
    status,
    sendState: role === "user" ? "acked" : null,
    updatedSeq: seq,
    createdAt: `2026-01-0${seq}T00:00:00.000Z`,
    updatedAt: `2026-01-0${seq}T00:00:00.000Z`,
  };
}

describe("buildPrompt", () => {
  it("orders profile and valid transcript entries through the target user", () => {
    const prompt = buildPrompt(
      bot,
      session,
      [entry(3, "user", "later"), entry(1, "user", "first"), entry(2, "assistant", "failed", "failed")],
      1,
    );
    expect(prompt.messages).toEqual([
      { role: "system", content: "Profile instructions" },
      { role: "user", content: "first" },
    ]);
    expect(prompt.manifest).toMatchObject({ profileVersion: 3, inputSeq: 1, generation: 1 });
  });

  it("builds a deterministic metadata-only manifest", () => {
    const entries = [entry(1, "user", "secret prompt body")];
    const first = buildPrompt(bot, session, entries, 1);
    const second = buildPrompt(bot, session, entries, 1);
    expect(first.manifest).toEqual(second.manifest);
    const persisted = JSON.stringify(first.manifest);
    expect(persisted).not.toContain("secret prompt body");
    expect(persisted).not.toContain("Profile instructions");
    expect(first.manifest.blocks.every((block) => block.digest.length === 64)).toBe(true);
  });

  it("uses the visible description as the profile for a new bot without legacy Instructions", () => {
    const newBot = { ...bot, description: "帮助我整理研究结论。", instructions: "" };
    const prompt = buildPrompt(newBot, session, [entry(1, "user", "开始")], 1);

    expect(prompt.messages[0]).toEqual({ role: "system", content: "帮助我整理研究结论。" });
    expect(prompt.manifest.blocks[0]?.provenance).toBe(`bot:${bot.id}:description:v${bot.version}`);
  });
});
