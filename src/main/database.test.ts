import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES } from "@shared/bot-avatar";
import type { AttachmentDraft, PromptManifest } from "@shared/contracts";
import { AppRepository, MIGRATIONS } from "./database";
import { AevorenBotError } from "./errors";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function memoryRepository(): AppRepository {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  return repository;
}

function manifest(sessionId: string, botId: string): PromptManifest {
  return {
    schemaVersion: 1,
    botId,
    profileVersion: 1,
    sessionId,
    generation: 1,
    inputSeq: 1,
    blocks: [],
    digest: "digest",
  };
}

function createDatabaseAtVersion(filename: string, version: number, lastOpenedVersion = "0.1.0"): void {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= version)) {
    const foreignKeysOff = "foreignKeysOff" in migration && migration.foreignKeysOff;
    if (foreignKeysOff) database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, "2026-09-16T00:00:00.000Z");
    if (foreignKeysOff) database.exec("PRAGMA foreign_keys = ON;");
  }
  database.prepare("INSERT INTO app_settings(key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)")
    .run("app.lastOpenedVersion", lastOpenedVersion, "2026-09-16T00:00:00.000Z");
  database.close();
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("AppRepository", () => {
  it("does not create a migration backup for a new database", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-new-database-backup-"));
    temporaryDirectories.push(directory);
    const backupDirectory = join(directory, "Backups");
    const repository = new AppRepository(join(directory, "app.sqlite"), { appVersion: "0.2.0-beta.1", backupDirectory });
    repository.close();
    expect(existsSync(backupDirectory)).toBe(false);
  });

  it("creates and verifies a versioned backup before migrating an existing database", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-schema-backup-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const backupDirectory = join(directory, "Backups");
    const sourceSchemaVersion = MIGRATIONS.at(-2)!.version;
    const targetSchemaVersion = MIGRATIONS.at(-1)!.version;
    createDatabaseAtVersion(filename, sourceSchemaVersion);

    const repository = new AppRepository(filename, { appVersion: "0.2.0-beta.1", backupDirectory });
    repository.close();

    const backupFiles = readdirSync(backupDirectory);
    expect(backupFiles.filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
    expect(backupFiles.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const metadata = JSON.parse(readFileSync(join(backupDirectory, backupFiles.find((name) => name.endsWith(".json"))!), "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      sourceSchemaVersion,
      targetSchemaVersion,
      sourceAppVersion: "0.1.0",
      targetAppVersion: "0.2.0-beta.1",
    });
    if (process.platform !== "win32") {
      expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(String(metadata.databaseBackup)).mode & 0o777).toBe(0o600);
    }
    const backup = new DatabaseSync(String(metadata.databaseBackup), { readOnly: true });
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: sourceSchemaVersion });
    backup.close();
    const migrated = new DatabaseSync(filename, { readOnly: true });
    expect(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: targetSchemaVersion });
    migrated.close();
  });

  it("refuses to migrate when the safety backup cannot be created", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-schema-backup-failure-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const blockedBackupPath = join(directory, "not-a-directory");
    const sourceSchemaVersion = MIGRATIONS.at(-2)!.version;
    createDatabaseAtVersion(filename, sourceSchemaVersion);
    writeFileSync(blockedBackupPath, "blocked", "utf8");

    expect(() => new AppRepository(filename, { appVersion: "0.2.0-beta.1", backupDirectory: blockedBackupPath })).toThrow();
    const database = new DatabaseSync(filename, { readOnly: true });
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: sourceSchemaVersion });
    database.close();
  });

  it("migrates the legacy global model configuration into one provider instance without decrypting the key", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-provider-migration-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    createDatabaseAtVersion(filename, 12);
    const legacy = new DatabaseSync(filename);
    legacy.prepare(
      `INSERT INTO bots(
         id, name, label, description, instructions, pinned_at, hidden_at, has_unread,
         deleted_at, version, created_at, updated_at
       ) VALUES('bot','Legacy','','','',NULL,NULL,0,NULL,1,'t','t')`,
    ).run();
    legacy.prepare("INSERT INTO app_settings VALUES('model.baseUrl','https://legacy.example/v1',0,'t')").run();
    legacy.prepare("INSERT INTO app_settings VALUES('model.modelId','legacy-model',0,'t')").run();
    legacy.prepare("INSERT INTO app_settings VALUES('model.apiKey','ciphertext-without-decryption',1,'t')").run();
    legacy.close();

    const repository = new AppRepository(filename);
    repositories.push(repository);
    expect(repository.getBot("bot").modelSelection).toEqual({
      providerInstanceId: "openai-compatible.default",
      modelId: "legacy-model",
    });
    expect(repository.getProviderInstanceConfig("openai-compatible.default").config).toEqual({
      baseUrl: "https://legacy.example/v1",
    });
    expect(repository.getDefaultModelSelection()).toEqual({
      providerInstanceId: "openai-compatible.default",
      modelId: "legacy-model",
    });
    expect(repository.getSetting("provider.openai-compatible.default.apiKey")).toEqual({
      value: "ciphertext-without-decryption",
      encrypted: true,
    });
    expect(repository.getSetting("model.apiKey")).toBeNull();
    expect(repository.getSetting("model.baseUrl")).toBeNull();
    expect(repository.getSetting("model.modelId")).toBeNull();
  });

  it("adds discovered CLI instances through v15 without changing existing Provider configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-provider-v14-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    createDatabaseAtVersion(filename, 13);
    const before = new DatabaseSync(filename);
    before.prepare(
      "UPDATE provider_instances SET config_json = ?, version = 4 WHERE id = 'codex.default'",
    ).run(JSON.stringify({ cliPath: "/custom/codex" }));
    before.close();

    const repository = new AppRepository(filename);
    repositories.push(repository);

    expect(repository.listProviderInstanceConfigs()).toHaveLength(12);
    expect(repository.getProviderInstanceConfig("codex.default")).toMatchObject({
      driverKind: "codex-cli",
      config: { cliPath: "/custom/codex" },
      version: 4,
    });
    expect(repository.getProviderInstanceConfig("claude.default")).toMatchObject({
      driverKind: "claude-cli",
      displayName: "Claude Code",
      config: { cliPath: "claude" },
      version: 1,
    });
    expect(repository.getProviderInstanceConfig("ollama.default")).toMatchObject({
      driverKind: "ollama-cli",
      displayName: "Ollama",
      config: { cliPath: "ollama" },
      version: 1,
    });
    expect(repository.getProviderInstanceConfig("gemini.default")).toMatchObject({
      driverKind: "acp-cli",
      displayName: "Gemini CLI",
      config: { adapter: "gemini", cliPath: "gemini" },
      version: 1,
    });
    const created = repository.createBot();
    const bot = repository.updateBot(created.bot.id, created.bot.version, {
      modelSelection: { providerInstanceId: "claude.default", modelId: "claude-sonnet-5" },
    });
    const clientNonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: created.session.id, clientNonce, text: "v14 route" });
    expect(repository.createRuntimeRun(clientNonce, "claude-cli", manifest(created.session.id, bot.id))).toMatchObject({
      route: "claude-cli",
      providerInstanceId: "claude.default",
      providerModelId: "claude-sonnet-5",
    });
    repository.transitionRuntimeRun(repository.getLatestRuntimeRun(clientNonce)!.id, "failed");
    const acpCreated = repository.createBot();
    const acpBot = repository.updateBot(acpCreated.bot.id, acpCreated.bot.version, {
      modelSelection: { providerInstanceId: "gemini.default", modelId: "gemini-2.5-pro" },
    });
    const acpNonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: acpCreated.session.id, clientNonce: acpNonce, text: "v15 ACP route" });
    expect(repository.createRuntimeRun(acpNonce, "acp-cli", manifest(acpCreated.session.id, acpBot.id))).toMatchObject({
      route: "acp-cli",
      providerInstanceId: "gemini.default",
      providerModelId: "gemini-2.5-pro",
    });
  });

  it("creates a neutral Grok-shaped bot with one MAIN session", () => {
    const repository = memoryRepository();
    const created = repository.createBot();
    expect(created.bot).toMatchObject({
      name: "新建 Bot",
      label: "",
      description: "",
      instructions: "",
      pinnedAt: null,
      hiddenAt: null,
      hasUnread: false,
      version: 1,
    });
    expect(BOT_AVATAR_SHAPES).toContain(created.bot.avatarShape);
    expect(BOT_AVATAR_COLORS).toContain(created.bot.avatarColor);
    expect(created.session.kind).toBe("MAIN");
    expect(repository.listBots()).toHaveLength(1);
    expect(repository.getMainSession(created.bot.id).id).toBe(created.session.id);
  });

  it("rolls back the bot when its MAIN session cannot be created", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-create-rollback-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const repository = new AppRepository(filename);
    repositories.push(repository);
    const injector = new DatabaseSync(filename);
    injector.exec("CREATE TRIGGER reject_main BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test'); END;");
    injector.close();

    expect(() => repository.createBot()).toThrow();
    expect(repository.listBots()).toHaveLength(0);
  });

  it("does not rewrite an existing product requirements bot when creating a neutral bot", () => {
    const repository = memoryRepository();
    const existing = repository.createBot();
    const legacy = repository.updateBot(existing.bot.id, existing.bot.version, {
      name: "产品需求分析助手",
      label: "产品需求分析",
      description: "已有描述",
      instructions: "已有 Instructions",
    });
    repository.prepareMessage({
      sessionId: existing.session.id,
      clientNonce: crypto.randomUUID(),
      text: "已有 Transcript",
    });

    const created = repository.createBot();

    expect(repository.getBot(legacy.id)).toMatchObject({
      name: "产品需求分析助手",
      label: "产品需求分析",
      description: "已有描述",
      instructions: "已有 Instructions",
    });
    expect(repository.getMainSession(legacy.id).id).toBe(existing.session.id);
    expect(repository.listTranscript(existing.session.id)[0]?.body).toBe("已有 Transcript");
    expect(created.bot).toMatchObject({ name: "新建 Bot", label: "", description: "", instructions: "" });
    expect(repository.listTranscript(created.session.id)).toHaveLength(0);
  });

  it("uses expectedVersion to reject a stale profile update", () => {
    const repository = memoryRepository();
    const { bot } = repository.createBot();
    const updated = repository.updateBot(bot.id, bot.version, { description: "新版描述" });
    expect(updated.version).toBe(2);
    expect(() => repository.updateBot(bot.id, bot.version, { description: "旧请求" })).toThrowError(
      expect.objectContaining<Partial<AevorenBotError>>({ code: "BOT_VERSION_CONFLICT" }),
    );
    expect(repository.getBot(bot.id).description).toBe("新版描述");
  });

  it("persists one versioned model selection per Bot without changing the global default", () => {
    const repository = memoryRepository();
    const first = repository.createBot();
    const second = repository.createBot();
    const defaultSelection = repository.getDefaultModelSelection();

    const updated = repository.updateBot(first.bot.id, first.bot.version, {
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "bot-specific-model" },
    });

    expect(updated.modelSelection).toEqual({
      providerInstanceId: "openai-compatible.default",
      modelId: "bot-specific-model",
    });
    expect(repository.getBot(second.bot.id).modelSelection).toEqual(defaultSelection);
    expect(repository.getDefaultModelSelection()).toEqual(defaultSelection);
    expect(() => repository.updateBot(first.bot.id, first.bot.version, {
      modelSelection: { providerInstanceId: "codex.default", modelId: "stale-model" },
    })).toThrowError(expect.objectContaining<Partial<AevorenBotError>>({ code: "BOT_VERSION_CONFLICT" }));
  });

  it("persists pin, unread and hidden sidebar state without conflicting with profile versions", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-sidebar-state-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const first = new AppRepository(filename);
    const { bot } = first.createBot();

    expect(first.setBotPinned(bot.id, true)).toMatchObject({ pinnedAt: expect.any(String), version: 1 });
    expect(first.setBotUnread(bot.id, true)).toMatchObject({ hasUnread: true, version: 1 });
    expect(first.setBotHidden(bot.id, true)).toMatchObject({ hiddenAt: expect.any(String), pinnedAt: null, version: 1 });
    first.close();

    const second = new AppRepository(filename);
    repositories.push(second);
    expect(second.getBot(bot.id)).toMatchObject({ hiddenAt: expect.any(String), pinnedAt: null, hasUnread: true, version: 1 });
    expect(second.setBotHidden(bot.id, false)).toMatchObject({ hiddenAt: null, hasUnread: true });
    second.setBotHidden(bot.id, true);
    expect(second.setBotPinned(bot.id, true)).toMatchObject({ hiddenAt: null, pinnedAt: expect.any(String) });
  });

  it("duplicates profile data into a fresh visible MAIN conversation", () => {
    const repository = memoryRepository();
    const created = repository.createBot();
    const source = repository.updateBot(created.bot.id, created.bot.version, {
      name: "研究助手",
      label: "研究",
      description: "整理材料",
      instructions: "只使用可核验资料",
    });
    repository.setBotPinned(source.id, true);
    repository.setBotUnread(source.id, true);
    repository.prepareMessage({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "原会话" });

    const duplicate = repository.duplicateBot(source.id);

    expect(duplicate.bot).toMatchObject({
      name: "研究助手 副本",
      label: "研究",
      description: "整理材料",
      instructions: "只使用可核验资料",
      pinnedAt: null,
      hiddenAt: null,
      hasUnread: false,
      version: 1,
    });
    expect(duplicate.bot.id).not.toBe(source.id);
    expect(BOT_AVATAR_SHAPES).toContain(duplicate.bot.avatarShape);
    expect(BOT_AVATAR_COLORS).toContain(duplicate.bot.avatarColor);
    expect(duplicate.session.id).not.toBe(created.session.id);
    expect(repository.listTranscript(duplicate.session.id)).toHaveLength(0);
    expect(repository.listTranscript(created.session.id)).toHaveLength(1);
  });

  it("deletes a Bot conversation, removes Room membership and archives undersized Rooms", () => {
    const repository = memoryRepository();
    const target = repository.createBot();
    const second = repository.createBot();
    const third = repository.createBot();
    repository.prepareMessage({ sessionId: target.session.id, clientNonce: crypto.randomUUID(), text: "待删除" });
    const survivingRoom = repository.createRoom({ memberBotIds: [target.bot.id, second.bot.id, third.bot.id], name: "三人群聊" });
    const archivedRoom = repository.createRoom({ memberBotIds: [target.bot.id, second.bot.id], name: "双人群聊" });

    const result = repository.deleteBot(target.bot.id);

    expect(result.affectedRoomIds).toEqual([archivedRoom.room.id, survivingRoom.room.id].sort());
    expect(result.archivedRoomIds).toEqual([archivedRoom.room.id]);
    expect(repository.listBots().map((bot) => bot.id)).toEqual([second.bot.id, third.bot.id]);
    expect(() => repository.getBot(target.bot.id)).toThrowError(expect.objectContaining({ code: "BOT_NOT_FOUND" }));
    expect(() => repository.getSession(target.session.id)).toThrowError(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    expect(repository.listRoomMembers(survivingRoom.room.id).map((member) => [member.botId, member.position])).toEqual([
      [second.bot.id, 0],
      [third.bot.id, 1],
    ]);
    expect(repository.getRoom(survivingRoom.room.id).archivedAt).toBeNull();
    expect(repository.getRoom(archivedRoom.room.id).archivedAt).not.toBeNull();
  });

  it("refuses deletion while the Bot has an active runtime", () => {
    const repository = memoryRepository();
    const { bot, session } = repository.createBot();
    const clientNonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: session.id, clientNonce, text: "正在运行" });
    repository.createRuntimeRun(clientNonce, "fake", manifest(session.id, bot.id));

    expect(() => repository.deleteBot(bot.id)).toThrowError(expect.objectContaining({ code: "BOT_BUSY" }));
    expect(repository.getBot(bot.id).id).toBe(bot.id);
  });

  it("refuses deletion for every member while its Room has an active run", () => {
    const repository = memoryRepository();
    const first = repository.createBot();
    const second = repository.createBot();
    const untargeted = repository.createBot();
    const detail = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id, untargeted.bot.id] });
    repository.createRoomRunWithInitialTurns({
      roomId: detail.room.id,
      sessionId: detail.session.id,
      clientNonce: crypto.randomUUID(),
      text: "只让第一个 Bot 开始",
      membershipVersion: detail.room.membershipVersion,
      maxTurns: 4,
      maxHops: 2,
      maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: first.bot.id, nonce: crypto.randomUUID() }],
    });

    expect(() => repository.deleteBot(untargeted.bot.id)).toThrowError(expect.objectContaining({ code: "BOT_BUSY" }));
    expect(repository.listRoomMembers(detail.room.id)).toHaveLength(3);
  });

  it("deletes mixed Bot and Room selections atomically", () => {
    const repository = memoryRepository();
    const first = repository.createBot();
    const second = repository.createBot();
    const third = repository.createBot();
    const selectedRoom = repository.createRoom({ memberBotIds: [second.bot.id, third.bot.id], name: "批量删除群聊" });
    const affectedRoom = repository.createRoom({ memberBotIds: [first.bot.id, second.bot.id, third.bot.id], name: "保留群聊" });

    const result = repository.deleteConversations({ botIds: [first.bot.id], roomIds: [selectedRoom.room.id] });

    expect(result.rooms).toEqual([{ id: selectedRoom.room.id }]);
    expect(result.bots).toEqual([{
      id: first.bot.id,
      affectedRoomIds: [affectedRoom.room.id],
      archivedRoomIds: [],
    }]);
    expect(repository.listBots().map((bot) => bot.id)).toEqual([second.bot.id, third.bot.id]);
    expect(() => repository.getRoom(selectedRoom.room.id)).toThrowError(expect.objectContaining({ code: "ROOM_NOT_FOUND" }));
    expect(repository.listRoomMembers(affectedRoom.room.id).map((member) => member.botId)).toEqual([second.bot.id, third.bot.id]);
    expect(repository.getRoom(affectedRoom.room.id)).toMatchObject({ archivedAt: null, membershipVersion: 2 });
  });

  it("preflights every batch target and leaves all conversations unchanged when one Bot is busy", () => {
    const repository = memoryRepository();
    const first = repository.createBot();
    const busy = repository.createBot();
    const room = repository.createRoom({ memberBotIds: [first.bot.id, busy.bot.id], name: "不得部分删除" });
    const nonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: busy.session.id, clientNonce: nonce, text: "正在运行" });
    repository.createRuntimeRun(nonce, "fake", manifest(busy.session.id, busy.bot.id));

    expect(() => repository.deleteConversations({
      botIds: [first.bot.id, busy.bot.id],
      roomIds: [room.room.id],
    })).toThrowError(expect.objectContaining({ code: "BOT_BUSY" }));
    expect(repository.listBots().map((bot) => bot.id)).toEqual([first.bot.id, busy.bot.id]);
    expect(repository.getRoom(room.room.id).name).toBe("不得部分删除");
    expect(repository.listRoomMembers(room.room.id)).toHaveLength(2);
  });

  it("deduplicates the same nonce and rejects a different body", () => {
    const repository = memoryRepository();
    const { session } = repository.createBot();
    const command = { sessionId: session.id, clientNonce: crypto.randomUUID(), text: "同一条消息" };
    expect(repository.prepareMessage(command).disposition).toBe("prepared");
    expect(repository.prepareMessage(command).disposition).toBe("duplicate");
    expect(() => repository.prepareMessage({ ...command, text: "不同内容" })).toThrowError(
      expect.objectContaining<Partial<AevorenBotError>>({ code: "MESSAGE_NONCE_CONFLICT" }),
    );
    expect(repository.listTranscript(session.id)).toHaveLength(1);
  });

  it("persists attachment metadata, includes content in prompts, and detects attachment conflicts", () => {
    const repository = memoryRepository();
    const { session } = repository.createBot();
    const attachment: AttachmentDraft = {
      id: crypto.randomUUID(),
      name: "brief.md",
      mimeType: "text/markdown",
      size: 16,
      sha256: "34fc1b8daebc49b0787a099b0e71ca7ee9c253a1012fe263af11543b5faddba6",
      kind: "text",
      content: "# attached brief",
    };
    const nonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: session.id, clientNonce: nonce, text: "阅读附件", attachments: [attachment] });
    expect(repository.listTranscript(session.id)[0]?.attachments).toEqual([{
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sha256: attachment.sha256,
      kind: "text",
    }]);
    expect(repository.listPromptEntries(session.id)[0]?.attachmentContents?.[0]?.content).toBe(attachment.content);
    expect(() => repository.prepareMessage({
      sessionId: session.id,
      clientNonce: nonce,
      text: "阅读附件",
      attachments: [{ ...attachment, content: "different" }],
    })).toThrowError(expect.objectContaining({ code: "ATTACHMENT_INVALID" }));
  });

  it("persists the same attachment contract for a Room trigger message", () => {
    const repository = memoryRepository();
    const first = repository.createBot().bot;
    const second = repository.createBot().bot;
    const room = repository.createRoom({ memberBotIds: [first.id, second.id] });
    const content = "room attachment";
    const attachment: AttachmentDraft = {
      id: crypto.randomUUID(),
      name: "room.txt",
      mimeType: "text/plain",
      size: Buffer.byteLength(content),
      sha256: "3784a2d7c76837737cb66c0569921d20a3671f44bc60dbefc9029c4804c3e7a5",
      kind: "text",
      content,
    };
    const created = repository.createRoomRunWithInitialTurns({
      roomId: room.room.id,
      sessionId: room.session.id,
      clientNonce: crypto.randomUUID(),
      text: "请阅读群聊附件",
      attachments: [attachment],
      membershipVersion: room.room.membershipVersion,
      maxTurns: 2,
      maxHops: 1,
      maxTargetsPerTurn: 1,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: first.id, nonce: crypto.randomUUID() }],
      routingMode: "explicit",
      routingReason: null,
    });
    expect(created.disposition).toBe("created");
    expect(repository.listTranscript(room.session.id)[0]?.attachments?.[0]?.name).toBe("room.txt");
    expect(repository.listPromptEntries(room.session.id)[0]?.attachmentContents?.[0]?.content).toBe(content);
  });

  it("recovers pre-acceptance and uncertain sends without auto-resending", () => {
    const repository = memoryRepository();
    const { session } = repository.createBot();
    const queuedNonce = crypto.randomUUID();
    const acceptedNonce = crypto.randomUUID();
    repository.prepareMessage({ sessionId: session.id, clientNonce: queuedNonce, text: "queued" });
    repository.setSendState(queuedNonce, "queued");
    repository.prepareMessage({ sessionId: session.id, clientNonce: acceptedNonce, text: "accepted" });
    repository.setSendState(acceptedNonce, "accepted-awaiting-echo");
    repository.recoverInterruptedSends();
    expect(repository.getSendOrThrow(queuedNonce).state).toBe("failed-before-acceptance");
    expect(repository.getSendOrThrow(acceptedNonce).state).toBe("interrupted-unknown");
    expect(repository.listTranscript(session.id).map((entry) => entry.sendState)).toEqual([
      "failed-before-acceptance",
      "interrupted-unknown",
    ]);
  });

  it("persists data across repository restarts and repeated migrations", () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-database-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "app.sqlite");
    const first = new AppRepository(filename);
    const { bot } = first.createBot();
    first.close();
    const second = new AppRepository(filename);
    repositories.push(second);
    expect(second.listBots()[0]?.id).toBe(bot.id);
  });

  it("keeps MAIN sessions and transcripts isolated between bots", () => {
    const repository = memoryRepository();
    const first = repository.createBot();
    const second = repository.createBot();
    repository.prepareMessage({
      sessionId: first.session.id,
      clientNonce: crypto.randomUUID(),
      text: "仅属于第一个 Bot",
    });
    expect(repository.listTranscript(first.session.id)).toHaveLength(1);
    expect(repository.listTranscript(second.session.id)).toHaveLength(0);
  });
});
