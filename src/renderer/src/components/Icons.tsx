import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function BotIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="6" y="5" width="12" height="14" rx="2" />
      <path d="M9 2h6M9 10h.01M15 10h.01M9 15h6" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04H5.3v-3h.14A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88L6.6 7.98l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.7 4.7v-.1h3v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.96 11h.14v3h-.14A1.7 1.7 0 0 0 19.4 15Z" />
    </IconBase>
  );
}

export function SendIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
      <path d="M7 12h14" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="m5 12 4 4L19 6" />
    </IconBase>
  );
}

export function StopIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}
