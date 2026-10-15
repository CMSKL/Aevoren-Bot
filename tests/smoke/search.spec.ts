import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
function data<T>(result:ApiResult<T>):T{if(!result.ok)throw new Error(`${result.error.code}: ${result.error.safeMessage}`);return result.data;}
async function fixture(work:(f:{page:Page;app:ElectronApplication;owner:ReturnType<AppRepository["createBot"]>;document:ReturnType<AppRepository["library"]["create"]>;messageId:string;taskSessionId:string})=>Promise<void>):Promise<void>{
  const directory=mkdtempSync(join(tmpdir(),"aevoren-search-ui-")),repository=new AppRepository(join(directory,"aevoren-bot.sqlite")),owner=repository.createBot();
  repository.updateBot(owner.bot.id,owner.bot.version,{name:"灯塔搜索助手",mcpServerIds:[]});
  let messageId="";
  for(let i=0;i<35;i++){const nonce=randomUUID();repository.prepareMessage({sessionId:owner.session.id,clientNonce:nonce,text:`灯塔第${String(i).padStart(2,"0")}条原始消息`});const entry=repository.acknowledgeUserMessage(nonce);if(i===0)messageId=entry.id;}
  const document=repository.library.create({sessionId:owner.session.id,kind:"document",name:"灯塔设计资料",body:"灯塔原始固定正文。"});
  const original=repository.getTranscriptEntry(messageId),task=repository.tasks.create({parentSessionId:owner.session.id,expectedScopeVersion:repository.tasks.scopeVersion(owner.session.id),clientNonce:randomUUID(),title:"灯塔独立任务",selections:[{executorBotId:owner.bot.id,memories:[],history:[{entryId:original.id,generation:original.generation,digest:createHash("sha256").update(original.body).digest("hex")}],workspaces:[],mcp:[],resourceRefs:[],mediaRefs:[],productOperations:[],network:false,clipboard:false}]});
  const other=repository.createBot();const otherNonce=randomUUID();repository.prepareMessage({sessionId:other.session.id,clientNonce:otherNonce,text:"灯塔另一会话消息"});repository.acknowledgeUserMessage(otherNonce);
  repository.setSetting("memory.capture.enabled","false",false);repository.close();
  const executablePath=process.env.AEVOREN_PACKAGED_APP_PATH;
  const app=await electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:["."],cwd:process.cwd(),env:{...Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!key.startsWith("AEVOREN_"))),AEVOREN_BOT_USER_DATA_DIR:directory,AEVOREN_BOT_FAKE_PROVIDER:"1",AEVOREN_BOT_TEST_HIDDEN:"1",AEVOREN_BOT_DISABLE_UPDATES:"1"}});
  const page=await app.firstWindow(),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  try{await expect(page.locator(".app-shell")).toBeVisible();if(executablePath)expect(await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}))).toEqual({packaged:true,version:JSON.parse(readFileSync(join(process.cwd(),"package.json"),"utf8")).version});await work({page,app,owner,document,messageId,taskSessionId:task.session.id});expect(errors).toEqual([]);}
  finally{const owned=app.process();await closeTestApplication(app);expect({code:owned.exitCode,signal:owned.signalCode}).toEqual({code:0,signal:null});removeTestDirectory(directory);}
}
test("searches saved resources with pagination, reads a fixed document version and blocks revoked sources",async()=>{
  test.setTimeout(60_000);
  await fixture(async({page,owner,document,messageId})=>{
    await page.getByRole("button",{name:"打开全资源搜索"}).click();const dialog=page.getByRole("dialog",{name:"全资源搜索",exact:true});
    await dialog.getByLabel("搜索范围").selectOption("all");await dialog.getByLabel("搜索所有资源").fill("灯塔");await dialog.getByRole("button",{name:"搜索",exact:true}).click();
    await expect(dialog.locator(".search-results>li")).toHaveCount(30);await dialog.getByRole("button",{name:"加载更多结果"}).click();await expect(dialog.locator(".search-results>li")).toHaveCount(39);
    await dialog.getByLabel("搜索类型").selectOption("document");await dialog.getByRole("button",{name:"搜索",exact:true}).click();await expect(dialog.locator(".search-results>li")).toHaveCount(1);
    data(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.library.update(input),{sessionId:owner.session.id,id:document.resource.id,expectedVersion:document.resource.version,body:"灯塔后来的第二版正文。"}));
    await dialog.getByRole("button",{name:/灯塔设计资料/}).click();await expect(dialog.locator(".search-source")).toContainText("灯塔原始固定正文。");await expect(dialog.locator(".search-source")).not.toContainText("后来的第二版");
    data(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.library.unbind(input),{sessionId:owner.session.id,id:document.resource.id}));await expect(dialog.locator(".search-source")).toHaveCount(0);await expect(dialog.getByRole("alert")).toContainText("来源状态已变化");
    await dialog.getByRole("button",{name:/灯塔设计资料/}).click();await expect(dialog.getByRole("alert")).toBeVisible();await expect(dialog.locator(".search-source")).toHaveCount(0);
    await dialog.getByLabel("搜索类型").selectOption("message");await dialog.getByLabel("搜索所有资源").fill("灯塔第00条");await dialog.getByRole("button",{name:"搜索",exact:true}).click();await expect(dialog.locator(".search-results>li")).toHaveCount(2);
    await dialog.locator(".search-results>li").filter({hasNotText:"已选历史"}).getByRole("button").click();await expect(dialog).toHaveCount(0);await expect(page.locator(`[data-transcript-entry="${messageId}"]`)).toHaveClass(/search-result-focus/u);await expect(page.locator(`[data-transcript-entry="${messageId}"]`)).toBeInViewport();
  });
});
test("locates selected historical messages by exact source and rejects cleared-generation lookalikes",async()=>{
  test.setTimeout(60_000);
  await fixture(async({page,owner,taskSessionId,messageId})=>{
    const result=data(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.search.query(input),{query:"灯塔第00条",scope:{kind:"session" as const,sessionId:taskSessionId},kinds:["message" as const]}));
    expect(result.items).toHaveLength(1);const source=result.items[0]!.source;expect(source).toMatchObject({type:"message",sessionId:taskSessionId,originSessionId:owner.session.id,id:messageId});
    expect(data(await page.evaluate(source=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.search.open({source}),source)).source).toEqual(source);
    data(await page.evaluate(sessionId=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.conversations.clear(sessionId),owner.session.id));
    const nonce=randomUUID();const sent=data(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.messages.send(input),{sessionId:owner.session.id,clientNonce:nonce,text:"灯塔第00条原始消息"}));
    await expect.poll(async()=>data(await page.evaluate(sessionId=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.runtime.getSessionSnapshot(sessionId),owner.session.id)).runs.find(run=>run.id===sent.runId)?.state,{timeout:10_000}).toBe("completed");
    const stale=await page.evaluate(source=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.search.open({source}),source);expect(stale).toMatchObject({ok:false});
    const current=data(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.search.query(input),{query:"灯塔第00条",scope:{kind:"session" as const,sessionId:taskSessionId}}));expect(current.items).toEqual([]);
  });
});
