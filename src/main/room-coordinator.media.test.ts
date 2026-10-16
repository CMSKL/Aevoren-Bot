import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { RoomCoordinator } from "./room-coordinator";
import type { RuntimeExecutor } from "./runtime-executor";

const repositories: AppRepository[] = [];
function fixture() {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const members = [repository.createBot(), repository.createBot()], detail = repository.createRoom({ memberBotIds: members.map(value => value.bot.id), leadBotId: null });
  const items = repository.media.publishImport(detail.session.id, ["a", "b"].map(value => ({
    asset: { reference: { id: randomUUID(), name: `${value}.png`, size: 1, mimeType: "image/png", sha256: value.repeat(64) }, kind: "image", width: 1, height: 1 }, extraction: null,
  })));
  return { repository, members, detail, items };
}
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

describe("Room media references in routing and duplicate delivery", () => {
  it("rejects a changed media reference while the original automatic routing decision is pending", async () => {
    const f = fixture(), selectRoomOwner = vi.fn(() => new Promise<{ ownerAgentId: string; reason: string }>(() => {}));
    const coordinator = new RoomCoordinator(f.repository, { selectRoomOwner } as unknown as RuntimeExecutor, { transcript: vi.fn(), roomRuntime: vi.fn() });
    const command = { roomId: f.detail.room.id, sessionId: f.detail.session.id, clientNonce: randomUUID(), text: "", targetBotIds: [], routingMode: "automatic" as const, mediaRefs: [f.items[0]!.reference] };
    const pending = coordinator.routeAndSend(command), interrupted = expect(pending).rejects.toMatchObject({ code: "APP_INTERRUPTED" });
    await expect(coordinator.routeAndSend({ ...command, mediaRefs: [f.items[1]!.reference] })).rejects.toMatchObject({ code: "MESSAGE_NONCE_CONFLICT" });
    expect(selectRoomOwner).toHaveBeenCalledTimes(1); expect(f.repository.getSend(command.clientNonce)).toBeNull();
    await coordinator.shutdown(); await interrupted;
  });
  it("reuses only the exact stored Room reference and keeps the original media on duplicate delivery", async () => {
    const f = fixture(), command = { roomId: f.detail.room.id, sessionId: f.detail.session.id, clientNonce: randomUUID(), text: "", targetBotIds: f.members.map(value => value.bot.id),
      routingMode: "everyone" as const, mediaRefs: [f.items[0]!.reference] };
    const prepared = f.repository.createRoomRunWithInitialTurns({ ...command, membershipVersion: f.detail.room.membershipVersion, maxTurns: 2, maxHops: 0, maxTargetsPerTurn: 2,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), initialTurns: command.targetBotIds.map(agentId => ({ agentId, nonce: randomUUID() })), orchestrationEnabled: false });
    const start = vi.fn(), coordinator = new RoomCoordinator(f.repository, { start } as unknown as RuntimeExecutor, { transcript: vi.fn(), roomRuntime: vi.fn() });
    expect(await coordinator.routeAndSend(command)).toMatchObject({ batchId: prepared.run.id, disposition: "duplicate" });
    await expect(coordinator.routeAndSend({ ...command, mediaRefs: [f.items[1]!.reference] })).rejects.toMatchObject({ code: "MESSAGE_NONCE_CONFLICT" });
    expect(f.repository.getUserMessage(command.clientNonce).mediaRefs).toEqual(command.mediaRefs); expect(start).not.toHaveBeenCalled();
  });
});
