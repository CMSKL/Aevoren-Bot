import type {
  ModelSelection,
  ProviderCapabilities,
  ProviderDriverKind,
  ProviderInstanceInfo,
  RuntimeRoute,
} from "@shared/contracts";
import type { ModelProvider } from "../model";

export interface RuntimeProviderInstance {
  readonly id: string;
  readonly driverKind: ProviderDriverKind;
  readonly capabilities: ProviderCapabilities;
  readonly route: Exclude<RuntimeRoute, "fake">;
  describe(): Promise<ProviderInstanceInfo>;
  createProvider(modelId: string): ModelProvider;
  testConnection(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProviderResolver {
  getRoute(selection: ModelSelection): RuntimeRoute;
  createProvider(selection: ModelSelection): ModelProvider;
  getCapabilities(selection: ModelSelection): ProviderCapabilities;
}
