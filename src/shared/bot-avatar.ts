/**
 * The small, role-oriented avatar system used throughout the app.
 *
 * These names intentionally describe the silhouette rather than a job or
 * provider.  That keeps avatar identity stable when a Bot's instructions or
 * model changes and gives us room to add a proper image-upload flow later.
 */
export const BOT_AVATAR_SHAPES = [
  "rounded",
  "fin",
  "swoop",
  "crest",
  "flare",
  "fold",
  "halo",
  "corner",
  "peak",
  "orbit",
  "notch",
  "pill",
] as const;

export const BOT_AVATAR_COLORS = [
  "cobalt",
  "cyan",
  "teal",
  "indigo",
  "violet",
  "coral",
  "amber",
  "ice",
] as const;

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export const DEFAULT_BOT_AVATAR_SHAPE: BotAvatarShape = "rounded";
export const DEFAULT_BOT_AVATAR_COLOR: BotAvatarColor = "cobalt";

export function isBotAvatarShape(value: unknown): value is BotAvatarShape {
  return typeof value === "string" && (BOT_AVATAR_SHAPES as readonly string[]).includes(value);
}

export function isBotAvatarColor(value: unknown): value is BotAvatarColor {
  return typeof value === "string" && (BOT_AVATAR_COLORS as readonly string[]).includes(value);
}

export function normalizeBotAvatarShape(value: unknown): BotAvatarShape {
  return isBotAvatarShape(value) ? value : DEFAULT_BOT_AVATAR_SHAPE;
}

export function normalizeBotAvatarColor(value: unknown): BotAvatarColor {
  return isBotAvatarColor(value) ? value : DEFAULT_BOT_AVATAR_COLOR;
}
