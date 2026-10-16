import type { RealtimeStartInput } from "@shared/realtime-contracts";
import type { MessageMediaReference } from "@shared/media-contracts";
import type { ResourceReference } from "@shared/contracts";
import type { AppRepository } from "./database";
import { AevorenBotError } from "./errors";

export type RealtimeAdmission = {
  input: RealtimeStartInput; generation: number; roomId: string | null; membershipVersion: number | null; memberBotIds: string[];
  resources: Array<{ reference: ResourceReference; bindingVersion: number }>;
  media: Array<{ reference: MessageMediaReference; incarnation: string }>;
};
export function captureRealtimeAdmission(repository: AppRepository, input: RealtimeStartInput): RealtimeAdmission {
  repository.voice.assertScope(input.sessionId, { executorBotId: input.executorBotId });
  const session = repository.getSession(input.sessionId);
  const members = session.roomId ? repository.getRoomDetail(session.roomId).members.map(member => member.botId) : [input.executorBotId];
  if (!session.roomId && (input.routingMode !== "automatic" || input.targetBotIds.length) || input.targetBotIds.some(id => !members.includes(id))) throw new AevorenBotError("VOICE_NOT_GRANTED");
  return { input: structuredClone(input), generation: session.generation, roomId: session.roomId, membershipVersion: session.roomId ? repository.getRoom(session.roomId).membershipVersion : null, memberBotIds: members,
    resources: repository.library.captureReferenceBindings(session.id, input.resourceRefs ?? [], input.executorBotId),
    media: repository.media.captureSendReferences(session.id, input.mediaRefs ?? [], input.executorBotId) };
}
export function assertRealtimeAdmission(repository: AppRepository, admission: RealtimeAdmission): void {
  const {input} = admission;
  repository.voice.assertScope(input.sessionId, { executorBotId: input.executorBotId });
  if (repository.getSession(input.sessionId).generation !== admission.generation) throw new AevorenBotError("VOICE_NOT_GRANTED");
  repository.library.assertReferenceBindings(input.sessionId, admission.resources, input.executorBotId);
  const media = repository.media.captureSendReferences(input.sessionId, admission.media.map(item => item.reference), input.executorBotId);
  if (media.some((item, index) => item.incarnation !== admission.media[index]?.incarnation)) throw new AevorenBotError("VOICE_NOT_GRANTED");
  if (admission.roomId) {
    const detail = repository.getRoomDetail(admission.roomId);
    if (detail.room.membershipVersion !== admission.membershipVersion) throw new AevorenBotError("VOICE_NOT_GRANTED");
    const live = detail.members.map(member => member.botId);
    // The durable session's retirement trigger separately tombstones remove/re-add.
    if (admission.memberBotIds.some(id => !live.includes(id))) throw new AevorenBotError("VOICE_NOT_GRANTED");
  }
}
