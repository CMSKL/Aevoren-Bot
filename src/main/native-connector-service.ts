import type { EnvironmentScope } from "@shared/environment-contracts";
import type { ConnectorAccessInput, ConnectorBindInput, ConnectorBindingsInput, ConnectorConfigureInput, ConnectorDraftCreateInput, ConnectorDraftDeleteInput,
  ConnectorDraftReadInput, ConnectorDraftUpdateInput, ConnectorIdInput, ConnectorListInput, ConnectorReadInput, ConnectorReadResult, ConnectorSearchInput,
  ConnectorUnbindInput, NativeConnection } from "@shared/native-connector-contracts";
import { connectorConfigureSchema, connectorIdSchema, connectorReadSchema, connectorSearchSchema } from "@shared/native-connector-schemas";
import type { AppRepository } from "./database";
import type { SecretCodec } from "./settings";
import { ConnectorStateError } from "./native-connector-repository";
import { GoogleNativeOAuth } from "./native-connectors/google-oauth";
import { GmailNativeAdapter } from "./native-connectors/gmail";
import { DriveNativeAdapter } from "./native-connectors/drive";
import { NotionNativeAdapter } from "./native-connectors/notion";
import { NativeConnectorError, type NativeAuthorization, type NativeCredentials } from "./native-connectors/types";

type PrivateConfig = { clientId: string; clientSecret?: string } | { token: string };
export type NativeConnectorDependencies = {
  openExternal(url: string): Promise<void>;
  oauth?: Pick<GoogleNativeOAuth, "authorize" | "refresh" | "identity">;
  gmail?: Pick<GmailNativeAdapter, "search" | "read">;
  drive?: Pick<DriveNativeAdapter, "search" | "read">;
  notion?: Pick<NotionNativeAdapter, "identity" | "search" | "read">;
};
export type ConnectorExecutionContext = { signal?: AbortSignal; assertCurrent?(): void };
type InFlight = { connectionId: string; scope?: EnvironmentScope; controller: AbortController; completion: Promise<void> };
export class NativeConnectorService {
  private readonly oauth: NonNullable<NativeConnectorDependencies["oauth"]>;
  private readonly gmail: NonNullable<NativeConnectorDependencies["gmail"]>;
  private readonly drive: NonNullable<NativeConnectorDependencies["drive"]>;
  private readonly notion: NonNullable<NativeConnectorDependencies["notion"]>;
  private readonly inFlight = new Set<InFlight>();
  private closed = false;
  private readonly authorizations = new Map<string, InFlight>();
  constructor(private readonly repository: AppRepository, private readonly codec: SecretCodec, private readonly dependencies: NativeConnectorDependencies) {
    this.oauth = dependencies.oauth ?? new GoogleNativeOAuth(); this.gmail = dependencies.gmail ?? new GmailNativeAdapter();
    this.drive = dependencies.drive ?? new DriveNativeAdapter(); this.notion = dependencies.notion ?? new NotionNativeAdapter();
    this.repository.connectors.recoverAuthorizations();
  }
  private encrypt(value: unknown): string {
    if (!this.codec.isAvailable()) throw new NativeConnectorError("AUTH_REQUIRED");
    try { return this.codec.encrypt(JSON.stringify(value)); } catch { throw new NativeConnectorError("AUTH_INVALID"); }
  }
  private decrypt<T>(value: string): T {
    if (!this.codec.isAvailable()) throw new NativeConnectorError("AUTH_REQUIRED");
    try { return JSON.parse(this.codec.decrypt(value)) as T; } catch { throw new NativeConnectorError("AUTH_INVALID"); }
  }
  list(input: ConnectorListInput = {}): NativeConnection[] { return this.repository.connectors.list(input); }
  configure(input: ConnectorConfigureInput): NativeConnection {
    const parsed = connectorConfigureSchema.parse(input);
    const config: PrivateConfig = parsed.provider === "notion" ? { token: parsed.token! } : { clientId: parsed.clientId!, ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}) };
    const encrypted = this.encrypt(config), result = this.repository.connectors.configure(parsed, encrypted);
    this.abortConnection(result.id); return result;
  }
  private abortConnection(connectionId: string, scope?: EnvironmentScope): void {
    for (const item of this.inFlight) if (item.connectionId === connectionId && (!scope || item.scope?.sessionId === scope.sessionId && item.scope.executorBotId === scope.executorBotId)) item.controller.abort();
  }
  private begin(connectionId: string, context: ConnectorExecutionContext, scope?: EnvironmentScope): { item: InFlight; finish(): void } {
    if (this.closed) throw new NativeConnectorError("AUTH_CANCELLED");
    context.signal?.throwIfAborted(); context.assertCurrent?.();
    let complete!: () => void; const completion = new Promise<void>(resolve => { complete = resolve; });
    const item: InFlight = { connectionId, controller: new AbortController(), completion, ...(scope ? { scope: { sessionId: scope.sessionId, executorBotId: scope.executorBotId } } : {}) };
    const abort = (): void => item.controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", abort, { once: true }); this.inFlight.add(item);
    if (context.signal?.aborted) abort();
    return { item, finish: () => { context.signal?.removeEventListener("abort", abort); this.inFlight.delete(item); complete(); } };
  }
  async authorize(input: ConnectorIdInput, context: ConnectorExecutionContext = {}): Promise<NativeConnection> {
    const parsed = connectorIdSchema.parse(input);
    if (this.closed) throw new NativeConnectorError("AUTH_CANCELLED");
    context.signal?.throwIfAborted(); context.assertCurrent?.();
    if (this.authorizations.has(parsed.id)) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", this.repository.connectors.get(parsed.id).version);
    const value = this.repository.connectors.beginAuthorization(parsed); this.abortConnection(value.id);
    const flow = this.begin(value.id, context); this.authorizations.set(value.id, flow.item);
    const assertCurrent = (): void => {
      flow.item.controller.signal.throwIfAborted(); context.assertCurrent?.();
      const current = this.repository.connectors.get(value.id);
      if (current.authVersion !== value.authVersion || current.state !== "authorizing") throw new ConnectorStateError("CONNECTOR_AUTH_CHANGED");
    };
    try {
      const config = this.decrypt<PrivateConfig>(this.repository.connectors.secrets(value.id).config);
      let credentials: NativeCredentials, identity: import("@shared/native-connector-contracts").ConnectorIdentity, scopes: string[], selectedIds: string[];
      if (value.provider === "notion") {
        if (!("token" in config)) throw new NativeConnectorError("AUTH_INVALID");
        credentials = { kind: "notion", token: config.token };
        identity = await this.notion.identity({ credentials, assertCurrent, signal: flow.item.controller.signal }); scopes = ["shared-pages-read"]; selectedIds = [];
      } else {
        if (!("clientId" in config)) throw new NativeConnectorError("AUTH_INVALID");
        const result = await this.oauth.authorize({ provider: value.provider, ...config, openExternal: this.dependencies.openExternal, signal: flow.item.controller.signal });
        assertCurrent(); credentials = result.credentials; identity = result.identity; scopes = result.credentials.scopes; selectedIds = result.selectedFileIds;
      }
      assertCurrent(); return this.repository.connectors.completeAuthorization(value.id, value.authVersion, identity, scopes, selectedIds, this.encrypt(credentials));
    } catch (error) { this.repository.connectors.endAuthorization(value.id, value.authVersion); throw error; }
    finally { if (this.authorizations.get(value.id) === flow.item) this.authorizations.delete(value.id); flow.finish(); }
  }
  cancelAuthorization(input: ConnectorIdInput): NativeConnection {
    const parsed = connectorIdSchema.parse(input), current = this.repository.connectors.get(parsed.id);
    if (parsed.expectedVersion !== current.version) throw new ConnectorStateError("CONNECTOR_VERSION_CONFLICT", current.version);
    const flow = this.authorizations.get(parsed.id); flow?.controller.abort();
    return this.repository.connectors.endAuthorization(parsed.id, current.authVersion);
  }
  revoke(input: ConnectorIdInput): NativeConnection { const result = this.repository.connectors.revoke(input); this.abortConnection(result.id); return result; }
  bindings(input: ConnectorBindingsInput) { return this.repository.connectors.bindings(input); }
  bind(input: ConnectorBindInput) { const result = this.repository.connectors.bind(input); this.abortConnection(result.connectionId, result); return result; }
  unbind(input: ConnectorUnbindInput) { const result = this.repository.connectors.unbind(input); this.abortConnection(result.connectionId, result); return result; }
  private async authorized<T>(input: ConnectorAccessInput, context: ConnectorExecutionContext, work: (auth: NativeAuthorization, allowedIds: string[]) => Promise<T>): Promise<T> {
    const scope = { sessionId: input.sessionId, executorBotId: input.executorBotId };
    const initial = this.repository.connectors.access(input), flow = this.begin(input.connectionId, context, scope);
    const assertCurrent = (): void => {
      flow.item.controller.signal.throwIfAborted(); context.signal?.throwIfAborted(); context.assertCurrent?.();
      this.repository.connectors.access(input);
    };
    try {
      const stored = this.repository.connectors.secrets(input.connectionId).credentials;
      if (!stored) throw new NativeConnectorError("AUTH_REQUIRED");
      let credentials = this.decrypt<NativeCredentials>(stored); assertCurrent();
      if (credentials.kind === "google" && credentials.expiresAt <= Date.now() + 30_000) {
        const previous = credentials, refreshed = await this.oauth.refresh(credentials, flow.item.controller.signal); assertCurrent();
        if (refreshed.provider !== previous.provider || JSON.stringify([...refreshed.scopes].sort()) !== JSON.stringify([...previous.scopes].sort())) throw new NativeConnectorError("AUTH_INVALID");
        const identity = await this.oauth.identity(refreshed, flow.item.controller.signal, assertCurrent); assertCurrent();
        if (identity.accountId !== initial.connection.account!.accountId) throw new NativeConnectorError("AUTH_INVALID");
        this.repository.connectors.refreshCredentials(input.connectionId, input.expectedAuthVersion, this.encrypt(refreshed)); credentials = refreshed;
      }
      const result = await work({ credentials, assertCurrent, signal: flow.item.controller.signal }, initial.binding.allowedResourceIds);
      assertCurrent(); return result;
    } catch (error) {
      if (error instanceof NativeConnectorError && (error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED" || error.status === 401)) {
        this.repository.connectors.requireAuthentication(input.connectionId, input.expectedAuthVersion); this.abortConnection(input.connectionId);
      }
      throw error;
    } finally { flow.finish(); }
  }
  async search(input: ConnectorSearchInput, context: ConnectorExecutionContext = {}) {
    const parsed = connectorSearchSchema.parse(input), provider = this.repository.connectors.access(parsed).connection.provider;
    return this.authorized(parsed, context, (auth, ids) => provider === "gmail" ? this.gmail.search(auth, parsed.query, parsed.cursor, parsed.limit)
      : provider === "drive" ? this.drive.search(auth, parsed.query, ids, parsed.cursor, parsed.limit) : this.notion.search(auth, parsed.query, parsed.cursor, parsed.limit));
  }
  async read(input: ConnectorReadInput, context: ConnectorExecutionContext = {}): Promise<ConnectorReadResult> {
    const parsed = connectorReadSchema.parse(input), provider = this.repository.connectors.access(parsed).connection.provider;
    return this.authorized(parsed, context, async (auth, ids) => {
      const value = provider === "gmail" ? await this.gmail.read(auth, parsed.resourceId) : provider === "drive" ? await this.drive.read(auth, parsed.resourceId, ids) : await this.notion.read(auth, parsed.resourceId);
      auth.assertCurrent();
      return { id: value.id, title: value.title, mimeType: value.mimeType, text: value.text, truncated: value.truncated,
        metadata: { ...value.metadata, ...(value.bytes ? { binaryBytesRead: value.bytes.byteLength } : {}) },
        ...(value.attachments ? { attachments: value.attachments } : {}), binaryContentAvailable: false };
    });
  }
  listDrafts(input: EnvironmentScope) { return this.repository.connectors.listDrafts(input); }
  createDraft(input: ConnectorDraftCreateInput) { return this.repository.connectors.createDraft(input); }
  updateDraft(input: ConnectorDraftUpdateInput) { return this.repository.connectors.updateDraft(input); }
  readDraft(input: ConnectorDraftReadInput) { return this.repository.connectors.readDraft(input); }
  draftVersions(input: ConnectorDraftReadInput) { return this.repository.connectors.draftVersions(input); }
  deleteDraft(input: ConnectorDraftDeleteInput) { return this.repository.connectors.deleteDraft(input); }
  dispose(): void { this.closed = true; for (const item of this.inFlight) item.controller.abort(); }
  async shutdown(): Promise<void> { this.dispose(); await Promise.allSettled([...this.inFlight].map(item => item.completion)); }
}
