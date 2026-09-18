import type { ProviderInstanceInfo } from "@shared/contracts";
import { CheckIcon } from "./Icons";
import { providerDisplayState, providerMarkText, providerStateLabel } from "./provider-presentation";

export function ProviderMark({ provider, size = "medium" }: {
  provider: ProviderInstanceInfo;
  size?: "small" | "medium" | "large";
}): React.JSX.Element {
  return (
    <span
      className={`provider-mark provider-mark-${size}`}
      data-provider-kind={provider.driverKind}
      aria-hidden="true"
    >
      {providerMarkText(provider)}
    </span>
  );
}

export function ProviderStatusPill({ provider }: { provider: ProviderInstanceInfo }): React.JSX.Element {
  const state = providerDisplayState(provider);
  return (
    <span className={`provider-status-pill provider-status-${state}`} data-provider-state={state}>
      {state === "ready" ? <CheckIcon /> : <i aria-hidden="true" />}
      {providerStateLabel(provider)}
    </span>
  );
}
