import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { MsBotError } from "./errors";

const repositories: AppRepository[] = [];
const temporaryDirectories: string[] = [];

function memoryRepository(): AppRepository {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  return repository;
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
      version: 1,
    });
    expect(created.session.kind).toBe("MAIN");
    expect(repository.listBots()).toHaveLength(1);
    expect(repository.getMainSession(created.bot.id).id).toBe(created.session.id);
  });

  it("rolls back the bot when its MAIN session cannot be created", () => {
    const directory = mkdtempSync(join(tmpdir(), "ms-bot-create-rollback-"));
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
      expect.objectContaining<Partial<MsBotError>>({ code: "BOT_VERSION_CONFLICT" }),
    );
    expect(repository.getBot(bot.id).description).toBe("新版描述");
  });

  it("deduplicates the same nonce and rejects a different body", () => {
    const repository = memoryRepository();
    const { session } = repository.createBot();
    const command = { sessionId: session.id, clientNonce: crypto.randomUUID(), text: "同一条消息" };
    expect(repository.prepareMessage(command).disposition).toBe("prepared");
    expect(repository.prepareMessage(command).disposition).toBe("duplicate");
    expect(() => repository.prepareMessage({ ...command, text: "不同内容" })).toThrowError(
      expect.objectContaining<Partial<MsBotError>>({ code: "MESSAGE_NONCE_CONFLICT" }),
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
    const directory = mkdtempSync(join(tmpdir(), "ms-bot-database-"));
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
