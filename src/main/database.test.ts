import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository } from "./database";
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

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("AppRepository", () => {
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
