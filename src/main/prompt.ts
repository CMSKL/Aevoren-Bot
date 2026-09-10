import { createHash } from "node:crypto";
import type {
  Bot,
  PromptAuthority,
  PromptManifest,
  PromptManifestBlock,
  Session,
  TranscriptEntry,
  TranscriptRole,
} from "@shared/contracts";

export type PromptMessage = {
  role: "system" | TranscriptRole;
  content: string;
};

type PromptBlock = PromptManifestBlock & {
  content: string;
};

export type BuiltPrompt = {
  messages: PromptMessage[];
  manifest: PromptManifest;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function transcriptAuthority(entry: TranscriptEntry): PromptAuthority {
  return entry.role;
}

export function buildPrompt(
  bot: Bot,
  session: Session,
  entries: TranscriptEntry[],
  inputSeq: number,
): BuiltPrompt {
  const blocks: PromptBlock[] = [
    {
      authority: "agent-profile",
      provenance: `bot:${bot.id}:instructions:v${bot.version}`,
      scope: `bot:${bot.id}`,
      content: bot.instructions,
      digest: digest(bot.instructions),
      createdAt: bot.updatedAt,
      sourceEntryId: null,
    },
    ...entries
      .filter(
        (entry) =>
          entry.generation === session.generation &&
          entry.seq <= inputSeq &&
          entry.status !== "failed" &&
          entry.status !== "cancelled" &&
          entry.body.trim().length > 0,
      )
      .toSorted((left, right) => left.seq - right.seq)
      .map((entry) => ({
        authority: transcriptAuthority(entry),
        provenance: `transcript:${entry.id}:u${entry.updatedSeq}`,
        scope: `session:${session.id}:generation:${session.generation}`,
        content: entry.body,
        digest: digest(entry.body),
        createdAt: entry.createdAt,
        sourceEntryId: entry.id,
      })),
  ];

  const manifestBlocks = blocks.map(({ content: _content, ...metadata }) => metadata);
  const manifestBase = {
    schemaVersion: 1 as const,
    botId: bot.id,
    profileVersion: bot.version,
    sessionId: session.id,
    generation: session.generation,
    inputSeq,
    blocks: manifestBlocks,
  };
  const manifest: PromptManifest = { ...manifestBase, digest: digest(JSON.stringify(manifestBase)) };

  return {
    messages: blocks.map((block) => ({
      role: block.authority === "agent-profile" ? "system" : block.authority,
      content: block.content,
    })),
    manifest,
  };
}
