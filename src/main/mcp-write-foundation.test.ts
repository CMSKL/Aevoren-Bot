import { randomUUID } from "node:crypto";
import { createServer,type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterEach,describe,expect,it } from "vitest";
import { AppRepository } from "./database";
import { McpService } from "./mcp-service";
import { MCP_WRITE_MIGRATION,McpWriteRepository,mcpDigest } from "./mcp-write-repository";
import { McpWriteService } from "./mcp-write-service";
const fixtures:{repository:AppRepository;mcp:McpService;service:McpWriteService;server:Server;remotes:McpServer[]}[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.service.shutdown();await f.mcp.dispose();await Promise.all(f.remotes.map(value=>value.close()));f.server.closeAllConnections();await new Promise<void>(resolve=>f.server.close(()=>resolve()));f.repository.close();}});
async function fixture(){const repository=new AppRepository(":memory:"),database=(repository as unknown as{database:DatabaseSync}).database;
 // The branch starts at migration37. Registration waits for the real38–40 merge;
 // this isolated setup verifies the reserved41 business schema without no-op migrations.
 database.exec(MCP_WRITE_MIGRATION.sql);const ledger=new McpWriteRepository(database,scope=>repository.assertSessionExecutor(scope.sessionId,scope.executorBotId));
 let writes=0,writePosts=0,unauthorized=false,schemaExtra=false;const remotes:McpServer[]=[],transports=new Map<string,StreamableHTTPServerTransport>(),capabilities:unknown[]=[];
 const server=createServer((request,response)=>{const sessionId=request.headers["mcp-session-id"];const chunks:Buffer[]=[];
 request.on("data",chunk=>chunks.push(Buffer.from(chunk)));request.on("end",()=>{const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
 if(body?.method==="initialize")capabilities.push(body.params.capabilities);
 if(body?.method==="tools/call"){writePosts++;if(unauthorized){response.writeHead(401,{"content-type":"application/json"}).end(JSON.stringify({error:"unauthorized"}));return;}}
 const existing=typeof sessionId==="string"?transports.get(sessionId):undefined;
 if(existing){void existing.handleRequest(request,response,body);return;}
 if(request.method!=="POST"||body?.method!=="initialize"){response.writeHead(404).end();return;}
 const remote=new McpServer({name:"write-fixture",version:"1"});remotes.push(remote);
 remote.registerTool("change",{description:"Change a specific fixture object",inputSchema:{target:z.string(),value:z.string(),extra:schemaExtra?z.string():z.string().optional()},
 annotations:{readOnlyHint:false},_meta:{ui:{resourceUri:"ui://fixture/editor",visibility:["model","app"]}}},async(args:{target:string;value:string;extra?:string})=>{writes++;return {content:[{type:"text" as const,text:JSON.stringify(args)}],structuredContent:{changed:true,token:"STATIC_PRIVATE"}};});
 remote.registerTool("app_only",{inputSchema:{},_meta:{ui:{visibility:["app"]}}},async()=>({content:[]}));
 remote.registerTool("hidden",{inputSchema:{},_meta:{ui:{visibility:[]}}},async()=>({content:[]}));
 remote.registerResource("editor","ui://fixture/editor",{mimeType:"text/html;profile=mcp-app"},async()=>({contents:[{uri:"ui://fixture/editor",mimeType:"text/html;profile=mcp-app",text:"<!doctype html><title>Fixture App</title><button id='change'>Change</button>"}]}));
 const transport:StreamableHTTPServerTransport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:(id:string):void=>{transports.set(id,transport);}});
 void remote.connect(transport).then(()=>transport.handleRequest(request,response,body));});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No fixture address");
 const codec={isAvailable:()=>true,encrypt:(value:string)=>Buffer.from(value).toString("base64"),decrypt:(value:string)=>Buffer.from(value,"base64").toString()};
 const mcp=new McpService(repository,codec,"test"),config=await mcp.save({name:"fixture",config:{transport:"streamable-http",url:`http://127.0.0.1:${address.port}/mcp`,headers:{Authorization:"Bearer STATIC_PRIVATE"}}});
 const enabled=repository.setMcpServerEnabled(config.id,config.version,true),service=new McpWriteService(repository,ledger,mcp),owner=repository.createBot(),scope={sessionId:owner.session.id,executorBotId:owner.bot.id};
 fixtures.push({repository,mcp,service,server,remotes});const catalog=()=>service.toolCatalog({...scope,serverId:enabled.id,expectedServerVersion:enabled.version});
 return {repository,database,ledger,mcp,service,scope,owner,enabled,catalog,capabilities,writes:()=>writes,writePosts:()=>writePosts,setUnauthorized:()=>{unauthorized=true;},changeSchema:()=>{schemaExtra=true;}};
}
describe("MCP scoped write foundation with a real local SDK server",()=>{
 it("negotiates Apps, filters visibility, and never treats tool metadata as a Scope grant",async()=>{const f=await fixture(),tools=await f.catalog();expect(tools.map(value=>value.name)).toEqual(["change"]);
 expect(tools[0]?.readOnlyClaim).toBe(false);expect(tools[0]?.uiResourceUri).toBe("ui://fixture/editor");expect(f.capabilities[0]).toMatchObject({extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}});
 expect(f.ledger.grants(f.scope)).toEqual([]);await expect(f.service.prepareTool({...f.scope,grantId:randomUUID(),expectedGrantVersion:1,arguments:{target:"A",value:"B"},targetPreview:"Object A",clientNonce:randomUUID()})).rejects.toThrow();expect(f.writePosts()).toBe(0);});
 it("pins schema, canonical arguments and explicit target in a no-FK durable intent; edits to same nonce conflict",async()=>{const f=await fixture(),tool=(await f.catalog())[0]!,grant=await f.service.grantTool({...f.scope,serverId:tool.serverId,expectedServerVersion:tool.serverVersion,toolName:tool.name,schemaDigest:tool.schemaDigest});
 const command={...f.scope,grantId:grant.id,expectedGrantVersion:grant.version,arguments:{value:"next",target:"A"},targetPreview:"Object A",clientNonce:randomUUID()};
 const first=await f.service.prepareTool(command),same=await f.service.prepareTool({...command,arguments:{target:"A",value:"next"}});expect(same).toEqual(first);expect(first.review.argumentsDigest).toBe(mcpDigest({target:"A",value:"next"}));
 await expect(f.service.prepareTool({...command,arguments:{target:"A",value:"different"}})).rejects.toMatchObject({code:"TOOL_IDEMPOTENCY_CONFLICT"});
 expect(f.database.prepare("PRAGMA foreign_key_list(mcp_write_intents)").all()).toEqual([]);expect(f.writePosts()).toBe(0);});
 it("detects tool schema changes and invalid arguments before dispatch",async()=>{const f=await fixture(),tool=(await f.catalog())[0]!,grant=await f.service.grantTool({...f.scope,serverId:tool.serverId,expectedServerVersion:tool.serverVersion,toolName:tool.name,schemaDigest:tool.schemaDigest});
 await expect(f.service.prepareTool({...f.scope,grantId:grant.id,expectedGrantVersion:grant.version,arguments:{target:15,value:"B"},targetPreview:"Object A",clientNonce:randomUUID()})).rejects.toMatchObject({code:"INVALID_REQUEST"});
 f.changeSchema();await expect(f.service.prepareTool({...f.scope,grantId:grant.id,expectedGrantVersion:grant.version,arguments:{target:"A",value:"B"},targetPreview:"Object A",clientNonce:randomUUID()})).rejects.toMatchObject({code:"MCP_TOOL_NOT_FOUND"});expect(f.writePosts()).toBe(0);});
 it("does not perform OAuth refresh, discovery or tool replay after a write receives401",async()=>{const f=await fixture(),session=await f.mcp.openScoped(f.enabled.id,f.enabled.version,new AbortController().signal);f.setUnauthorized();
 await expect(session.call("change",{target:"A",value:"B"})).rejects.toThrow();await session.close();expect(f.writePosts()).toBe(1);expect(f.writes()).toBe(0);expect(f.capabilities).toHaveLength(1);});
 it("reads actual HTML from the same scoped server and redacts configured credentials from tool results",async()=>{const f=await fixture(),session=await f.mcp.openScoped(f.enabled.id,f.enabled.version,new AbortController().signal);
 const html=await session.readResource("ui://fixture/editor");expect(html.contents[0]).toMatchObject({uri:"ui://fixture/editor",mimeType:"text/html;profile=mcp-app",text:expect.stringContaining("Fixture App")});
 const result=await session.call("change",{target:"A",value:"B"});expect(JSON.stringify(result)).not.toContain("STATIC_PRIVATE");expect(JSON.stringify(result)).toContain("redacted credential");await session.close();expect(f.writes()).toBe(1);});
 it("recovery retains an uncertain dispatch and no ordinary read can replay it",async()=>{const f=await fixture(),tool=(await f.catalog())[0]!,grant=await f.service.grantTool({...f.scope,serverId:tool.serverId,expectedServerVersion:tool.serverVersion,toolName:tool.name,schemaDigest:tool.schemaDigest});
 const value=await f.service.prepareTool({...f.scope,grantId:grant.id,expectedGrantVersion:1,arguments:{target:"A",value:"B"},targetPreview:"Object A",clientNonce:randomUUID()});f.ledger.dispatch(f.scope,value.id,1);f.ledger.recover();
 expect(f.service.toolResult({...f.scope,id:value.id,expectedVersion:1})).toMatchObject({state:"unknown",version:3});expect(f.writePosts()).toBe(0);expect(()=>f.ledger.dispatch(f.scope,value.id,1)).toThrow();});
});
