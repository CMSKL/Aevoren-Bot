import type { CSSProperties } from "react";
import type { Bot } from "@shared/contracts";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { RoomIcon } from "./Icons";
import { UserAvatar } from "./UserAvatar";

export function RoomAvatar({ bots, userProfile, size = 36 }: {
  bots?: readonly Bot[];
  userProfile?: { name?: string; avatarUrl?: string | null };
  size?: number;
}): React.JSX.Element {
  const members = bots?.slice(0, 3) ?? [];
  const memberSize = Math.ceil(size * .56);
  return <span className={`conversation-room-avatar${members.length ? " is-collage" : ""}`} data-member-count={members.length ? members.length + 1 : 0} aria-hidden="true" style={{ width: size, height: size, "--member-avatar-size": `${memberSize}px` } as CSSProperties}>
    {members.length ? <>{members.map(bot => <BotAvatarIcon key={bot.id} shape={bot.avatarShape} color={bot.avatarColor} size={memberSize} />)}<UserAvatar name={userProfile?.name} avatarUrl={userProfile?.avatarUrl} size={memberSize} /></> : <RoomIcon size={size * .65} />}
  </span>;
}
