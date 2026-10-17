import type { Bot, ProviderInstanceInfo } from "@shared/contracts";

export function eligibleRoomLeads(bots: readonly Bot[], providers: readonly ProviderInstanceInfo[]): Bot[] {
  return bots.filter(bot => {
    const provider = providers.find(candidate => candidate.id === bot.modelSelection.providerInstanceId);
    return provider?.enabled && provider.status === "available" && provider.capabilities.handoff &&
      Boolean(bot.modelSelection.modelId) && provider.models.options.some(model => model.id === bot.modelSelection.modelId);
  });
}
