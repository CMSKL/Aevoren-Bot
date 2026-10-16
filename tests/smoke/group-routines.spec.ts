import { appendFileSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type Page, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
const value=<T>(result:ApiResult<T>):T=>{if(!result.ok)throw new Error(`${result.error.code}: ${result.error.safeMessage}`);return result.data;};
type Capture={model:string;response:ServerResponse;released:boolean;aborted:boolean};
async function listRuns(page:Page){return value(await page.evaluate(()=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.routines.listRuns()));}
type CloseProbe = { record(phase: string): void; phases: Record<string, unknown>[]; detach(): void };
const CLOSE_PHASE_PREFIX = "AEVOREN_CLOSE_PHASE ";

/** Fixture-owned, bounded diagnostics only; no process arguments or application data. */
async function installCloseProbe(application: ElectronApplication): Promise<CloseProbe> {
  const owned = application.process(), started = performance.now(), phases: Record<string, unknown>[] = [];
  let exitSeen = false, closeSeen = false, buffered = "";
  const record = (phase: string): void => {
    if (phases.length >= 120) return;
    phases.push({ phase, elapsedMs: Math.round(performance.now() - started), pid: owned.pid ?? null, exitCode: owned.exitCode, signalCode: owned.signalCode,
      killed: owned.killed, exitSeen, closeSeen, stdio: owned.stdio.map(stream => stream ? { destroyed: stream.destroyed } : null) });
  };
  const exited = (): void => { exitSeen = true; record("owned-exit"); };
  const closed = (): void => { closeSeen = true; record("owned-close"); };
  const streams = owned.stdio.flatMap((stream, index) => stream ? [{ stream, listener: () => record(`stdio-${index}-close`) }] : []);
  const stderr = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8"); const lines = buffered.split("\n"); buffered = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(CLOSE_PHASE_PREFIX) && phases.length < 120) {
      try { phases.push({ source: "main", ...JSON.parse(line.slice(CLOSE_PHASE_PREFIX.length)) as Record<string, unknown> }); } catch { record("invalid-main-phase"); }
    }
    if (buffered.length > 4_096) buffered = "";
  };
  owned.once("exit", exited); owned.once("close", closed); owned.stderr?.on("data", stderr);
  for (const { stream, listener } of streams) stream.once("close", listener);
  record("probe-installed");
  try {
    await application.evaluate(({ app, BrowserWindow, ipcMain }) => {
      const started = performance.now();
      const record = (phase: string, state: Record<string, string | number | boolean> = {}): void => {
        console.error("AEVOREN_CLOSE_PHASE " + JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), ...state }));
      };
      app.on("before-quit", () => record("app-before-quit")); app.on("will-quit", () => record("app-will-quit")); app.on("quit", () => record("app-quit"));
      for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents, send = contents.send.bind(contents);
        contents.send = (channel, ...args) => {
          if (channel === "app:before-close" || channel === "app:close-blocked") record(channel, { loading: contents.isLoadingMainFrame(), destroyed: contents.isDestroyed() });
          return send(channel, ...args);
        };
        window.on("close", () => record("window-close", { loading: contents.isLoadingMainFrame() })); window.on("closed", () => record("window-closed"));
        contents.on("did-navigate", () => record("main-navigation-committed")); contents.on("did-stop-loading", () => record("loading-stopped"));
        contents.on("render-process-gone", (_event, details) => record("renderer-gone", { reason: details.reason, exitCode: details.exitCode }));
      }
      ipcMain.on("app:renderer-ready", event => record("renderer-ready", { mainFrame: event.senderFrame === event.sender.mainFrame }));
      ipcMain.on("app:confirm-close", (event, value: unknown) => record("flush-ack", { mainFrame: event.senderFrame === event.sender.mainFrame, canClose: value === true }));
    });
  } catch { record("main-probe-unavailable"); }
  return { record, phases, detach() { owned.removeListener("exit", exited); owned.removeListener("close", closed); owned.stderr?.removeListener("data", stderr); for (const { stream, listener } of streams) stream.removeListener("close", listener); } };
}


async function fixture(count:number,work:(f:{page:Page;bots:{id:string;name:string;sessionId:string;model:string}[];room:ReturnType<AppRepository["createRoom"]>;captures:Capture[]})=>Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),"aevoren-group-routines-")),path=join(directory,"aevoren-bot.sqlite"),repo=new AppRepository(path);
  const bots=Array.from({length:7},(_,index)=>{const made=repo.createBot(),model=`routine-fixture-${index+1}`,bot=repo.updateBot(made.bot.id,made.bot.version,{name:`任务成员${index+1}`,mcpServerIds:[],modelSelection:{providerInstanceId:"openai-compatible.default",modelId:model}});return{id:bot.id,name:bot.name,sessionId:made.session.id,model};});
  const room=repo.createRoom({name:"自动化并行群",leadBotId:null,memberBotIds:bots.slice(0,count).map(bot=>bot.id)});repo.setSetting("memory.capture.enabled","false",false);repo.close();
  const captures:Capture[]=[],errors:string[]=[],pageErrors:string[]=[];
  const server=createServer(async(request,response)=>{try{let body="";for await(const chunk of request)body+=chunk;const input=JSON.parse(body);if(request.headers.authorization!=="Bearer routine-fixture-token"||!bots.some(bot=>bot.model===input.model))throw Error("Unexpected loopback model request");const capture:Capture={model:input.model,response,released:false,aborted:false};captures.push(capture);response.on("close",()=>{if(!capture.released)capture.aborted=true;});response.writeHead(200,{"content-type":"text/event-stream"});response.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:null}]})}\n\n`);}catch(error){errors.push(String(error));if(!response.headersSent)response.writeHead(500);response.end();}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw Error("Missing loopback port");
  const executablePath=process.env.AEVOREN_PACKAGED_APP_PATH??process.env.AEVOREN_BOT_PACKAGED_EXECUTABLE;
  const app=await electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:["."],cwd:process.cwd(),env:{...process.env,AEVOREN_BOT_USER_DATA_DIR:directory,AEVOREN_BOT_TEST_HIDDEN:"1",AEVOREN_BOT_FAKE_PROVIDER:"0",AEVOREN_BOT_DISABLE_UPDATES:"1",AEVOREN_BOT_ROUTINE_TICK_MS:"100"}});
  const page=await app.firstWindow();let completed=false,closeFailure:unknown;
  const probe=await installCloseProbe(app);
  let stderrTail="";
  const stderr=(chunk:Buffer):void=>{stderrTail=(stderrTail+chunk.toString("utf8")).slice(-16_384);};
  const ownedProcess=app.process();ownedProcess.stderr?.on("data",stderr);
  try{
    await expect(page).toHaveTitle("Aevoren Bot");await expect(page.locator(".app-shell")).toBeVisible();page.on("pageerror",error=>pageErrors.push(error.message));
    if(executablePath){const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}));expect(runtime).toEqual({packaged:true,version:JSON.parse(readFileSync(join(process.cwd(),"package.json"),"utf8")).version});await test.info().attach("actual-routine-package",{body:JSON.stringify(runtime),contentType:"application/json"});}
    value(await page.evaluate(async baseUrl=>{const api=(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot,listed=await api.providers.list(),provider=listed.ok?listed.data.find(item=>item.id==="openai-compatible.default"):null;if(!provider)throw Error("Missing test provider");return api.providers.saveOpenAiCompatible({instanceId:provider.id,expectedVersion:provider.version,baseUrl,apiKey:"routine-fixture-token"});},`http://127.0.0.1:${address.port}/v1`));
    await page.getByRole("button",{name:"设置",exact:true}).click();await page.getByRole("button",{name:"主动服务",exact:true}).click();
    await work({page,bots,room,captures});expect(errors).toEqual([]);expect(pageErrors).toEqual([]);expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(window=>!window.isVisible()))).toBe(true);completed=true;
  }finally{
    if(!completed){await test.info().attach("routine-loopback-states",{body:JSON.stringify({captures:captures.map(({model,released,aborted})=>({model,released,aborted})),runs:await listRuns(page).catch(()=>[])}),contentType:"application/json"});}
    for(const capture of captures)capture.response.destroy();
    const beforeClose={runs:await listRuns(page).then(runs=>runs.map(({id,state,runtimeRunId,batchId})=>({id,state,runtimeRunId,batchId}))).catch(()=>[]),captures:captures.map(({model,released,aborted})=>({model,released,aborted}))};
    probe.record("fixture-close-requested");
    try {
      const owned=app.process();await closeTestApplication(app);probe.record("fixture-close-returned");expect({code:owned.exitCode,signal:owned.signalCode}).toEqual({code:0,signal:null});
    } catch(error) {completed=false;closeFailure=error;}
    finally {
      const safeStderr=stderrTail.split("\n").filter(line=>line.startsWith(CLOSE_PHASE_PREFIX)).map(line=>line.slice(0,2048)).concat([...stderrTail.matchAll(/\b(?:[A-Za-z]*Error|ERR_[A-Z0-9_]+|E(?:CONNRESET|PIPE|INVAL|ACCES|PERM))\b/gu)].map(match=>match[0])).slice(-120).join("\n");
      const diagnostic={test:test.info().title,beforeClose,phases:probe.phases,stderr:safeStderr};
      await test.info().attach("routine-close-diagnostics",{body:JSON.stringify(diagnostic),contentType:"application/json"});
      if(process.env.AEVOREN_ROUTINE_CLOSE_EVIDENCE_PATH)appendFileSync(process.env.AEVOREN_ROUTINE_CLOSE_EVIDENCE_PATH,JSON.stringify(diagnostic)+"\n",{encoding:"utf8",mode:0o600});
      probe.detach();ownedProcess.stderr?.removeListener("data",stderr);
      if(!completed){const copy=test.info().outputPath("owned-routine.sqlite");copyFileSync(path,copy);await test.info().attach("owned-routine-database",{path:copy,contentType:"application/octet-stream"});}
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));removeTestDirectory(directory);
    }
  }
  if(closeFailure)throw closeFailure;
}
async function create(page:Page,name:string,target:string){await page.getByLabel("Routine 名称",{exact:true}).fill(name);await page.getByLabel("Routine 提示",{exact:true}).fill(`执行 ${name} 的固定指令`);await page.getByLabel("Routine 执行目标",{exact:true}).selectOption(target);await page.getByLabel("Routine 计划类型",{exact:true}).selectOption("interval");await page.getByRole("button",{name:"创建为暂停状态",exact:true}).click();const card=page.locator(".routine-card").filter({has:page.getByText(name,{exact:true})});await expect(card).toContainText("已暂停");return card;}

test("runs six saved group members before any finishes and cancels only that Routine while its sibling completes",async()=>{
  test.setTimeout(60_000);await fixture(6,async({page,bots,room,captures})=>{
    const card=await create(page,"六人并行任务",`room:${room.room.id}`);await expect(card).toContainText("Everyone");for(const bot of bots.slice(0,6))await expect(card).toContainText(bot.name);
    await card.getByRole("button",{name:"立即运行",exact:true}).click();await expect.poll(()=>captures.length).toBe(6);expect(captures.every(capture=>!capture.released&&!capture.aborted)).toBe(true);expect(new Set(captures.map(capture=>capture.model)).size).toBe(6);
    await expect.poll(async()=>{const result=value(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.roomRuntime.getSnapshot(input),{roomId:room.room.id,sessionId:room.session.id}));return result.turns.filter(turn=>turn.state==="running").length;}).toBe(6);
    const group=(await listRuns(page)).find(run=>run.routineName==="六人并行任务")!;expect(group).toMatchObject({runtimeRunId:null,batchId:expect.any(String),targetSnapshot:{membershipVersion:room.room.membershipVersion,target:{routingMode:"everyone",targetBotIds:bots.slice(0,6).map(bot=>bot.id)}}});
    const siblingCard=await create(page,"独立兄弟任务",`bot:${bots[6]!.id}`);await siblingCard.getByRole("button",{name:"立即运行",exact:true}).click();await expect.poll(()=>captures.length).toBe(7);await page.getByRole("button",{name:"刷新",exact:true}).click();
    await page.getByRole("button",{name:"取消 Routine 运行 六人并行任务",exact:true}).click();await expect.poll(async()=>(await listRuns(page)).find(run=>run.id===group.id)?.state).toBe("cancelled");await expect.poll(()=>captures.slice(0,6).every(capture=>capture.aborted)).toBe(true);
    const sibling=(await listRuns(page)).find(run=>run.routineName==="独立兄弟任务")!;expect(sibling.state).toBe("running");expect(captures[6]!.aborted).toBe(false);
    captures[6]!.released=true;captures[6]!.response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"Sibling completed after independent cancellation"},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);await expect.poll(async()=>(await listRuns(page)).find(run=>run.id===sibling.id)?.state).toBe("completed");
    await page.getByRole("button",{name:"刷新",exact:true}).click();const history=page.locator(".routine-run-list");await expect(history).toContainText("已取消");await expect(history).toContainText("已完成");await expect(page.locator("vite-error-overlay")).toHaveCount(0);if(process.platform!=="win32")await test.info().attach("routine-six-ui",{body:await page.screenshot(),contentType:"image/png"});await test.info().attach("routine-six-actual-results",{body:JSON.stringify({runs:await listRuns(page),models:captures.map(({model,released,aborted})=>({model,released,aborted}))}),contentType:"application/json"});
  });
});

test("keeps a stale group editor draft until explicit roster review and saves a fixed subset",async()=>{
  test.setTimeout(60_000);await fixture(2,async({page,bots,room,captures})=>{
    const card=await create(page,"需重新审阅的任务",`room:${room.room.id}`);await card.getByRole("button",{name:"编辑",exact:true}).click();await page.getByLabel("Routine 提示",{exact:true}).fill("保留这份正在编辑的指令");
    value(await page.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.rooms.addMember(input),{roomId:room.room.id,botId:bots[2]!.id,expectedMembershipVersion:room.room.membershipVersion}));await page.getByRole("button",{name:"刷新",exact:true}).click();await expect(page.getByRole("button",{name:"保存修改",exact:true})).toBeDisabled();await expect(page.getByLabel("Routine 提示",{exact:true})).toHaveValue("保留这份正在编辑的指令");await expect(card).toContainText("请编辑并重新选择目标");
    await page.getByRole("button",{name:"重新选择并审阅目标",exact:true}).click();await page.getByLabel("Routine 群聊路由",{exact:true}).selectOption("explicit");await page.getByLabel(`Routine 成员 ${bots[2]!.name}`,{exact:true}).uncheck();await page.getByRole("button",{name:"保存修改",exact:true}).click();await expect(card).toContainText("指定成员");await expect(card).toContainText("保留这份正在编辑的指令");
    const saved=value(await page.evaluate(()=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.routines.list())).find(item=>item.name==="需重新审阅的任务")!;expect(saved.target).toMatchObject({kind:"room",routingMode:"explicit",targetBotIds:bots.slice(0,2).map(bot=>bot.id),expectedMembershipVersion:room.room.membershipVersion+1});expect(saved.version).toBe(2);expect(captures).toEqual([]);if(process.platform!=="win32")await test.info().attach("routine-reviewed-subset-ui",{body:await page.screenshot(),contentType:"image/png"});
  });
});
