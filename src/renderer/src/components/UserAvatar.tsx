import { DEFAULT_USER_AVATAR_URL } from "../avatar-catalog";

type UserAvatarProps = {
  name?: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
};

export function UserAvatar({ name, avatarUrl, size = 48, className }: UserAvatarProps): React.JSX.Element {
  return (
    <img
      className={`user-avatar${className ? ` ${className}` : ""}`}
      src={avatarUrl || DEFAULT_USER_AVATAR_URL}
      width={size}
      height={size}
      alt={`${name?.trim() || "我"}的头像`}
      draggable={false}
      decoding="async"
    />
  );
}
