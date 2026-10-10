import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, normalizeBotAvatarColor, normalizeBotAvatarShape, type BotAvatarColor, type BotAvatarShape } from "@shared/bot-avatar";
import coordinator from "./assets/avatars/coordinator.png";
import research from "./assets/avatars/research.png";
import writer from "./assets/avatars/writer.png";
import data from "./assets/avatars/data.png";
import coding from "./assets/avatars/coding.png";
import organizer from "./assets/avatars/organizer.png";
import publisher from "./assets/avatars/publisher.png";
import userDefault from "./assets/avatars/user-default.png";

const botAvatars = [coordinator, research, writer, data, coding, organizer, publisher] as const;

export const DEFAULT_USER_AVATAR_URL = userDefault;

export function botAvatarUrl(shape: BotAvatarShape | null | undefined, color: BotAvatarColor | null | undefined): string {
  const shapeIndex = BOT_AVATAR_SHAPES.indexOf(normalizeBotAvatarShape(shape));
  const colorIndex = BOT_AVATAR_COLORS.indexOf(normalizeBotAvatarColor(color));
  return botAvatars[(shapeIndex * BOT_AVATAR_COLORS.length + colorIndex) % botAvatars.length]!;
}
