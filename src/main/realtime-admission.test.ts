import { afterEach, expect, it } from "vitest";
import { AppRepository } from "./database";
import { captureRealtimeAdmission, assertRealtimeAdmission } from "./realtime-admission";
const repositories: AppRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
it("pins the selected revision but retires its original binding after unbind/rebind", () => {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const {bot, session} = repository.createBot();
  const document = repository.library.create({sessionId: session.id, kind: "document", name: "Voice reference", body: "original"});
  const admission = captureRealtimeAdmission(repository, {sessionId:session.id,executorBotId:bot.id,expectedConfigVersion:1,routingMode:"automatic",targetBotIds:[],resourceRefs:[document.reference]});
  repository.library.update({sessionId:session.id,id:document.resource.id,expectedVersion:document.resource.version,body:"new revision"});
  expect(() => assertRealtimeAdmission(repository, admission)).not.toThrow();
  repository.library.unbind({sessionId:session.id,id:document.resource.id});
  repository.library.bind({sessionId:session.id,id:document.resource.id});
  expect(() => assertRealtimeAdmission(repository, admission)).toThrow();
});
it("does not admit a new room member or a new session generation into a voice connection", () => {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const first=repository.createBot(), second=repository.createBot(), third=repository.createBot();
  const room=repository.createRoom({name:"voice scope",memberBotIds:[first.bot.id,second.bot.id]});
  const admission=captureRealtimeAdmission(repository,{sessionId:room.session.id,executorBotId:first.bot.id,expectedConfigVersion:1,routingMode:"everyone",targetBotIds:[first.bot.id,second.bot.id]});
  expect(() => assertRealtimeAdmission(repository, admission)).not.toThrow();
  repository.addRoomMember(room.room.id,third.bot.id,room.room.membershipVersion);
  expect(() => assertRealtimeAdmission(repository, admission)).toThrow();
  const direct=captureRealtimeAdmission(repository,{sessionId:first.session.id,executorBotId:first.bot.id,expectedConfigVersion:1,routingMode:"automatic",targetBotIds:[]});
  repository.clearConversation(first.session.id);
  expect(() => assertRealtimeAdmission(repository,direct)).toThrow();
});
