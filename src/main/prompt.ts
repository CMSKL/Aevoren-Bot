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
import { sanitizeRoomSpeakerOutput } from "@shared/room-speaker-envelope";

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

function attributedAssistantContent(entry: TranscriptEntry, body: string): string {
  const safeName = [...(entry.speakerNameSnapshot ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `[room-speaker id="${entry.speakerBotId ?? "unknown"}" name=${JSON.stringify(safeName)}]\n${body}`;
}

export function buildPrompt(
  bot: Bot,
  session: Session,
  entries: TranscriptEntry[],
  inputSeq: number,
  context?: {
    promptCutoffSeq: number;
    roomId: string;
    roomMembershipVersion: number;
    sourceTurnId: string;
  },
): BuiltPrompt {
  const promptCutoffSeq = context?.promptCutoffSeq ?? inputSeq;
  const profileField = bot.instructions.trim() ? "instructions" : "description";
  const profileContent = bot[profileField];
  const profileBlocks: PromptBlock[] = profileContent.trim()
    ? [{
        authority: "agent-profile",
        provenance: `bot:${bot.id}:${profileField}:v${bot.version}`,
        scope: `bot:${bot.id}`,
        content: profileContent,
        digest: digest(profileContent),
        createdAt: bot.updatedAt,
        sourceEntryId: null,
      }]
    : [];
  const blocks: PromptBlock[] = [
    ...profileBlocks,
    ...entries
      .filter(
        (entry) =>
          entry.generation === session.generation &&
          entry.seq <= promptCutoffSeq &&
          entry.status !== "failed" &&
          entry.status !== "cancelled" &&
          entry.body.trim().length > 0,
      )
      .toSorted((left, right) => left.seq - right.seq)
      .map((entry) => {
        const body = entry.role === "assistant" && entry.speakerBotId
          ? sanitizeRoomSpeakerOutput(entry.body)
          : entry.body;
        const content = context && entry.role === "assistant" && entry.speakerBotId
          ? attributedAssistantContent(entry, body)
          : body;
        return {
          authority: transcriptAuthority(entry),
          provenance: `transcript:${entry.id}:u${entry.updatedSeq}`,
          scope: `session:${session.id}:generation:${session.generation}`,
          content,
          digest: digest(content),
          createdAt: entry.createdAt,
          sourceEntryId: entry.id,
          ...(entry.speakerBotId ? { speakerBotId: entry.speakerBotId } : {}),
        };
      }),
  ];

  const manifestBlocks = blocks.map(({ content: _content, ...metadata }) => metadata);
  const manifestBase = {
    schemaVersion: context ? 2 as const : 1 as const,
    botId: bot.id,
    profileVersion: bot.version,
    sessionId: session.id,
    generation: session.generation,
    inputSeq,
    ...(context
      ? {
          roomId: context.roomId,
          roomMembershipVersion: context.roomMembershipVersion,
          promptCutoffSeq: context.promptCutoffSeq,
          executorBotId: bot.id,
          sourceTurnId: context.sourceTurnId,
        }
      : {}),
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
