import { createHash } from "node:crypto";
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron,expect,test,type ElectronApplication,type Page } from "@playwright/test";
import type { AevorenBotApi,ApiResult } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { closeTestApplication,removeTestDirectory } from "./test-cleanup";
import { openInspector } from "./navigation";
function data<T>(value:ApiResult<T>):T{if(!value.ok)throw new Error(`${value.error.code}: ${value.error.safeMessage}`);return value.data;}
test("publishes real cropped Bot pixels through UI, preserves owned copies on restart and clears only the selected avatar",async()=>{
 test.setTimeout(90_000);
 const directory=mkdtempSync(join(tmpdir(),"aevoren-bot-image-")),source=join(directory,"selected-source");mkdirSync(source);writeFileSync(join(source,"image.png"),readFileSync(join(process.cwd(),"resources/icon.png")));
 const repository=new AppRepository(join(directory,"aevoren-bot.sqlite")),workspace=await new WorkspaceService(repository).registerRoot(source),created=repository.createBot(workspace.project.id);repository.updateBot(created.bot.id,created.bot.version,{name:"图片头像验收",mcpServerIds:[]});repository.setSetting("memory.capture.enabled","false",false);repository.close();
 const executablePath=process.env.AEVOREN_PACKAGED_APP_PATH;let app:ElectronApplication,page:Page;const errors:string[]=[];let completed=false;
 const launch=async():Promise<void>=>{app=await electron.launch({...(executablePath?{executablePath}:{}),args:executablePath?[]:["."],cwd:process.cwd(),env:{...Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!key.startsWith("AEVOREN_"))),AEVOREN_BOT_USER_DATA_DIR:directory,AEVOREN_BOT_TEST_HIDDEN:"1",AEVOREN_BOT_FAKE_PROVIDER:"1",AEVOREN_BOT_DISABLE_UPDATES:"1"}});page=await app.firstWindow();page.on("pageerror",error=>errors.push(error.message));await expect(page.locator(".app-shell")).toBeVisible();if(executablePath)expect(await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}))).toEqual({packaged:true,version:JSON.parse(readFileSync(join(process.cwd(),"package.json"),"utf8")).version});};
 const close=async():Promise<void>=>{const owned=app.process();await closeTestApplication(app);expect({code:owned.exitCode,signal:owned.signalCode}).toEqual({code:0,signal:null});};
 await launch();
 try{
  const imported=data(await page!.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.media.importPath(input),{sessionId:created.session.id,workspaceId:workspace.workspace.id,path:"image.png"}));expect(imported.failed).toEqual([]);expect(imported.imported).toHaveLength(1);
  await openInspector(page!);await page!.getByRole("button",{name:"更换图片头像",exact:true}).click();const dialog=page!.getByRole("dialog",{name:"Bot 图片头像",exact:true});await expect(dialog).toBeVisible();await dialog.locator(".media-library-item").filter({hasText:"image.png"}).getByRole("button",{name:"设为此 Bot 的头像",exact:true}).click();await expect(dialog).toHaveCount(0);
  const photo=page!.locator('.contact-profile-hero img[data-custom-avatar="true"]');await expect(photo).toBeVisible();expect(await photo.evaluate((node:HTMLImageElement)=>({width:node.naturalWidth,height:node.naturalHeight,complete:node.complete}))).toEqual({width:256,height:256,complete:true});
  let owner=data(await page!.evaluate(()=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.bots.list())).find(bot=>bot.id===created.bot.id)!;expect(owner.avatarImage?.id).not.toBe(imported.imported[0]!.reference.mediaId);
  const pixels=data(await page!.evaluate(botId=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.botImages.read({botId}),owner.id))!;expect(createHash("sha256").update(Buffer.from(pixels.dataBase64,"base64")).digest("hex")).toBe(owner.avatarImage?.sha256);
  data(await page!.evaluate(input=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.media.delete(input),{sessionId:created.session.id,id:imported.imported[0]!.asset.reference.id,expectedVersion:imported.imported[0]!.asset.version}));rmSync(source,{recursive:true,force:true});
  await close();await launch();await openInspector(page!);await expect(page!.locator('.contact-profile-hero img[data-custom-avatar="true"]')).toBeVisible();
  owner=data(await page!.evaluate(()=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.bots.list())).find(bot=>bot.id===created.bot.id)!;
  const duplicate=data(await page!.evaluate(id=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.bots.duplicate(id),owner.id));expect(duplicate.bot.avatarImage?.sha256).toBe(owner.avatarImage?.sha256);expect(duplicate.bot.avatarImage?.id).not.toBe(owner.avatarImage?.id);
  await page!.getByRole("button",{name:"恢复默认头像",exact:true}).click();await expect(page!.locator('.contact-profile-hero img[data-custom-avatar="true"]')).toHaveCount(0);expect(data(await page!.evaluate(botId=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.botImages.read({botId}),owner.id))).toBeNull();
  expect(data(await page!.evaluate(botId=>(window as unknown as {aevorenBot:AevorenBotApi}).aevorenBot.botImages.read({botId}),duplicate.bot.id))?.reference.sha256).toBe(pixels.reference.sha256);expect(errors).toEqual([]);completed=true;
 }finally{await close();if(!completed)copyFileSync(join(directory,"aevoren-bot.sqlite"),test.info().outputPath("isolated-avatar.sqlite"));removeTestDirectory(directory);}
});
