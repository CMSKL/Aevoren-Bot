import type { BotAvatarColor, BotAvatarShape } from "@shared/bot-avatar";
import { normalizeBotAvatarColor, normalizeBotAvatarShape } from "@shared/bot-avatar";
import { botAvatarUrl } from "../avatar-catalog";

type BotAvatarIconProps = {
  shape?: BotAvatarShape | null;
  color?: BotAvatarColor | null;
  size?: number;
  className?: string;
  title?: string;
};

export function BotAvatarIcon({
  shape,
  color,
  size = 24,
  className,
  title,
}: BotAvatarIconProps): React.JSX.Element {
  const safeShape = normalizeBotAvatarShape(shape);
  const safeColor = normalizeBotAvatarColor(color);
  return (
    <img
      className={`bot-avatar-icon${className ? ` ${className}` : ""}`}
      src={botAvatarUrl(safeShape, safeColor)}
      width={size}
      height={size}
      alt={title || ""}
      title={title}
      aria-hidden={title ? undefined : true}
      draggable={false}
      decoding="async"
      data-avatar-shape={safeShape}
      data-avatar-color={safeColor}
    />
  );
}
