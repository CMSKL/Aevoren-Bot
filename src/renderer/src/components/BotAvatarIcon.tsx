import type { BotAvatarColor, BotAvatarShape } from "@shared/bot-avatar";
import { DEFAULT_BOT_AVATAR_COLOR, DEFAULT_BOT_AVATAR_SHAPE } from "@shared/bot-avatar";

type BotAvatarIconProps = {
  shape?: BotAvatarShape | null;
  color?: BotAvatarColor | null;
  size?: number;
  className?: string;
  title?: string;
};

const colorValues: Record<BotAvatarColor, string> = {
  cobalt: "#2f80ed",
  cyan: "#25bfd5",
  teal: "#2dbb9b",
  indigo: "#5865f2",
  violet: "#8b5cf6",
  coral: "#f47d7d",
  amber: "#e7aa42",
  ice: "#9cbde8",
};

const shellPaths: Record<BotAvatarShape, string> = {
  rounded: "M6 22C6 11.5 11.5 6 22 6h4c10.5 0 16 5.5 16 16v4c0 10.5-5.5 16-16 16h-4C11.5 42 6 36.5 6 26v-4Z",
  fin: "M5 23C5 12 12 6 22 6h9c8.5 0 12 4.5 12 13v10c0 8.5-4 13-12 13H21C10 42 5 35 5 25v-2Z",
  swoop: "M7 18c3-8 9-12 18-12h6c8 0 12 5 12 14v8c0 9-5 14-14 14H20C10 42 5 34 7 24l1-3Z",
  crest: "M6 23c0-10 5-17 14-17l4 5 5-5c9 0 13 7 13 17v4c0 10-6 15-15 15H21C11 42 6 36 6 27v-4Z",
  flare: "M6 20c1-9 7-14 16-14h11c6 0 9 4 9 10v6l-4 2 4 4c0 9-5 14-14 14H20C10 42 5 35 6 25l2-3-2-2Z",
  fold: "M7 14c4-5 9-8 16-8h11c6 0 9 5 9 12v12c0 8-5 12-13 12H20C11 42 6 36 6 27V19c0-2 .3-3.5 1-5Z",
  halo: "M7 19c2-8 8-13 17-13h4c9 0 14 6 14 16v8c0 8-5 12-14 12H20C11 42 6 36 7 27l2-4-2-4Z",
  corner: "M7 6h24c7 0 11 5 11 13v10c0 9-5 13-14 13H21C11 42 6 36 6 27V13c0-4 0-7 1-7Z",
  peak: "M6 25 11 8c1-3 4-4 7-2l5 3 5-3c3-2 6-1 7 2l5 17v3c0 9-6 14-15 14H21C12 42 6 36 6 28v-3Z",
  orbit: "M6 23C6 12 12 6 23 6h2c10 0 15 6 15 17v4c0 10-5 15-15 15h-4C11 42 6 36 6 27v-4Z",
  notch: "M6 22C6 11 12 6 22 6h17c2 0 3 2 3 4v17c0 10-6 15-16 15H21C11 42 6 36 6 27v-5Z",
  pill: "M8 22c0-10 6-16 16-16h1c9 0 15 6 15 16v4c0 10-6 16-15 16h-1C14 42 8 36 8 26v-4Z",
};

const facePath = "M9 23c0-8 5-13 13-13h4c8 0 13 5 13 13v5c0 8-5 13-13 13h-4c-8 0-13-5-13-13v-5Z";

export function BotAvatarIcon({
  shape = DEFAULT_BOT_AVATAR_SHAPE,
  color = DEFAULT_BOT_AVATAR_COLOR,
  size = 24,
  className,
  title,
}: BotAvatarIconProps): React.JSX.Element {
  const safeShape = shellPaths[shape ?? DEFAULT_BOT_AVATAR_SHAPE] ? shape ?? DEFAULT_BOT_AVATAR_SHAPE : DEFAULT_BOT_AVATAR_SHAPE;
  const safeColor = colorValues[color ?? DEFAULT_BOT_AVATAR_COLOR] ? color ?? DEFAULT_BOT_AVATAR_COLOR : DEFAULT_BOT_AVATAR_COLOR;
  const label = title ? undefined : "Bot 头像";
  return (
    <svg
      className={`bot-avatar-icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="4 4 40 40"
      preserveAspectRatio="xMidYMid slice"
      role={title ? "img" : undefined}
      aria-label={title ? title : label}
      aria-hidden={title ? undefined : true}
      focusable="false"
      data-avatar-shape={safeShape}
      data-avatar-color={safeColor}
    >
      {title ? <title>{title}</title> : null}
      <path d={shellPaths[safeShape]} fill={colorValues[safeColor]} />
      <path d={facePath} fill="#f5f8fc" />
      <rect x="15" y="17" width="6" height="15" rx="3" transform="rotate(-34 15 17)" fill="#111820" />
      <rect x="29" y="15" width="6" height="15" rx="3" transform="rotate(-28 29 15)" fill="#111820" />
      <circle cx="28" cy="35" r="3" fill="#f36f3f" />
    </svg>
  );
}
