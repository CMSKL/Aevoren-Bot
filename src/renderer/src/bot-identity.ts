import type { Bot } from "@shared/contracts";

type BotIdentitySource = Pick<Bot, "id" | "name" | "label">;

export type BotIdentity = {
  primary: string;
  secondary: string;
  inline: string;
  disambiguated: boolean;
};

function uniquePrefix(id: string, peerIds: string[]): string {
  let length = Math.min(6, id.length);
  while (length < id.length && peerIds.some((peerId) => peerId !== id && peerId.slice(0, length) === id.slice(0, length))) {
    length = Math.min(length + 2, id.length);
  }
  return id.slice(0, length);
}

export function buildBotIdentityMap(bots: readonly BotIdentitySource[]): Map<string, BotIdentity> {
  const byName = new Map<string, BotIdentitySource[]>();
  const byVisibleIdentity = new Map<string, BotIdentitySource[]>();
  for (const bot of bots) {
    const label = bot.label.trim();
    byName.set(bot.name, [...(byName.get(bot.name) ?? []), bot]);
    const key = `${bot.name}\u0000${label}`;
    byVisibleIdentity.set(key, [...(byVisibleIdentity.get(key) ?? []), bot]);
  }

  return new Map(bots.map((bot) => {
    const label = bot.label.trim();
    const sameName = byName.get(bot.name) ?? [bot];
    const sameVisibleIdentity = byVisibleIdentity.get(`${bot.name}\u0000${label}`) ?? [bot];
    const duplicateName = sameName.length > 1;
    const duplicateVisibleIdentity = sameVisibleIdentity.length > 1;
    const baseSecondary = label || "未设置标签";
    const secondary = duplicateVisibleIdentity
      ? `${baseSecondary} · #${uniquePrefix(bot.id, sameVisibleIdentity.map((peer) => peer.id))}`
      : baseSecondary;
    return [bot.id, {
      primary: bot.name,
      secondary,
      inline: duplicateName ? `${bot.name} · ${secondary}` : bot.name,
      disambiguated: duplicateName,
    }];
  }));
}

export function buildSnapshotIdentityMap(
  sources: readonly { id: string; name: string }[],
): Map<string, string> {
  const uniqueSources = new Map(sources.map((source) => [source.id, source]));
  const byName = new Map<string, Array<{ id: string; name: string }>>();
  for (const source of uniqueSources.values()) {
    byName.set(source.name, [...(byName.get(source.name) ?? []), source]);
  }
  return new Map([...uniqueSources.values()].map((source) => {
    const sameName = byName.get(source.name) ?? [source];
    return [
      source.id,
      sameName.length > 1
        ? `${source.name} · #${uniquePrefix(source.id, sameName.map((peer) => peer.id))}`
        : source.name,
    ];
  }));
}
