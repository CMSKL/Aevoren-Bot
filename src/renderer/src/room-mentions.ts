export const EVERYONE_MENTION_ID = "everyone";

export type RoomMention =
  | { kind: "everyone"; id: typeof EVERYONE_MENTION_ID }
  | { kind: "bot"; id: string };

export type MentionSearchItem = {
  id: string;
  label: string;
  keywords: string[];
};

export type ActiveMentionQuery = {
  start: number;
  end: number;
  query: string;
};

export function findActiveMentionQuery(text: string, caret: number): ActiveMentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const beforeCaret = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCaret);
  if (!match) return null;
  const query = match[1] ?? "";
  return {
    start: caret - query.length - 1,
    end: caret,
    query,
  };
}

export function filterMentionItems(items: readonly MentionSearchItem[], query: string): MentionSearchItem[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return [...items];
  return items.filter((item) => [item.label, ...item.keywords]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized)));
}

export function addRoomMention(current: readonly RoomMention[], mention: RoomMention): RoomMention[] {
  if (mention.kind === "everyone") return [mention];
  const withoutEveryone = current.filter((item) => item.kind !== "everyone");
  if (withoutEveryone.some((item) => item.id === mention.id)) return [...withoutEveryone];
  return [...withoutEveryone, mention];
}

export function resolveRoomTargetIds(mentions: readonly RoomMention[], memberBotIds: readonly string[]): string[] {
  if (mentions.length === 0 || mentions.some((mention) => mention.kind === "everyone")) return [...memberBotIds];
  const mentioned = new Set(mentions.map((mention) => mention.id));
  return memberBotIds.filter((botId) => mentioned.has(botId));
}

export function removeMentionQuery(text: string, query: ActiveMentionQuery): { text: string; caret: number } {
  return {
    text: text.slice(0, query.start) + text.slice(query.end),
    caret: query.start,
  };
}
