import { randomBytes,randomUUID } from "node:crypto";
import { createServer,type Server,type ServerResponse } from "node:http";
import type { EnvironmentScope } from "@shared/environment-contracts";
import type { McpAppView,McpWriteIdInput,McpWriteIntent } from "@shared/mcp-write-contracts";
import { mcpAppCloseSchema,mcpJsonArgumentsSchema } from "@shared/mcp-write-schemas";
import { z } from "zod";
import type { McpService } from "./mcp-service";
import type { McpWriteService } from "./mcp-write-service";
import { canonicalMcpJson,mcpDigest } from "./mcp-write-repository";
import { AevorenBotError } from "./errors";
const APP_PROTOCOL="2026-01-26",MAX_RPC_BYTES=160000;
const rpcSchema=z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string().max(100),z.number().int()]).optional(),method:z.string().min(1).max(100),params:z.record(z.string(),z.json()).optional()}).strict();
type Rpc=z.infer<typeof rpcSchema>;
type Viewer={view:McpAppView;token:string;html:string;input:Record<string,unknown>;result:unknown;grantId:string;grantVersion:number;credentialDigest:string;
 controller:AbortController;initialized:boolean;ready:boolean;inputSent:boolean;events:Set<ServerResponse>;requests:Map<string,{digest:string;promise:Promise<unknown>}>};
type Options={requestAndWait:(intent:McpWriteIntent,signal:AbortSignal)=>Promise<McpWriteIntent>};
const rpcError=(id:Rpc["id"],code:number,message:string,data?:unknown)=>({jsonrpc:"2.0",id:id??null,error:{code,message,...(data?{data}:{})}});
export class McpAppsBridge{
 private server:Server|null=null;
 private origin="";
 private readonly viewers=new Map<string,Viewer>();
 private readonly unsubscribe:()=>void;
 constructor(private readonly writes:McpWriteService,private readonly mcp:McpService,private readonly options:Options){
 this.unsubscribe=mcp.onScopedInvalidation(id=>{for(const viewer of this.viewers.values())if(viewer.view.serverId===id)this.retire(viewer);});}
 private scope(input:EnvironmentScope){return {sessionId:input.sessionId,executorBotId:input.executorBotId};}
 private assertCurrent(viewer:Viewer){viewer.controller.signal.throwIfAborted();this.writes.ledger.current(viewer.view,viewer.view.intentId);
 const grant=this.writes.ledger.assertGrant(viewer.view,viewer.grantId,viewer.grantVersion);
 if(grant.serverId!==viewer.view.serverId||grant.serverVersion!==viewer.view.serverVersion||this.mcp.scopedCredentialDigest(grant.serverId)!==viewer.credentialDigest)
 throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");}
 private retire(viewer:Viewer){viewer.controller.abort();this.viewers.delete(viewer.view.id);for(const response of viewer.events){response.write(`data: ${JSON.stringify({closed:true})}\n\n`);response.end();}viewer.events.clear();}
 private async listen(){if(this.server)return;const server=createServer((request,response)=>{void(async()=>{
 const url=new URL(request.url??"/","http://127.0.0.1"),match=/^\/view\/([a-f0-9-]{36})\/([a-f0-9]{64})(?:\/(rpc|events|inner))?$/u.exec(url.pathname);
 const viewer=match?this.viewers.get(match[1]!):undefined;
 if(!viewer||viewer.token!==match?.[2]||url.search){response.writeHead(404).end();return;}
 try{this.assertCurrent(viewer);}catch{this.retire(viewer);response.writeHead(410).end();return;}
 response.setHeader("cache-control","no-store");response.setHeader("referrer-policy","no-referrer");response.setHeader("x-content-type-options","nosniff");
 if(!match?.[3]&&request.method==="GET"){
 response.writeHead(200,{"content-type":"text/html; charset=utf-8","content-security-policy":`default-src 'none'; script-src 'nonce-${viewer.token}'; connect-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'none'`,
 "permissions-policy":"camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()"}).end(this.proxyHtml(viewer));return;}
 if(match?.[3]==="inner"&&request.method==="GET"){
 response.writeHead(200,{"content-type":"text/html; charset=utf-8","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
 "permissions-policy":"camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()"}).end(viewer.html);return;}
 if(request.headers.origin!==this.origin&&!(match?.[3]==="events"&&!request.headers.origin&&request.headers["sec-fetch-site"]==="same-origin")){response.writeHead(403).end();return;}
 if(match?.[3]==="events"&&request.method==="GET"){response.writeHead(200,{"content-type":"text/event-stream"});response.write(": connected\n\n");viewer.events.add(response);request.on("close",()=>viewer.events.delete(response));return;}
 if(match?.[3]!=="rpc"||request.method!=="POST"||!request.headers["content-type"]?.startsWith("application/json")){response.writeHead(405).end();return;}
 let total=0;const chunks:Buffer[]=[];for await(const chunk of request){total+=chunk.length;if(total>MAX_RPC_BYTES){response.writeHead(413).end();return;}chunks.push(Buffer.from(chunk));}
 let message:unknown;try{message=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{response.writeHead(400).end();return;}
 const result=await this.handleMessage(viewer,message);if(!viewer.controller.signal.aborted)response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(result));else response.writeHead(410).end();
 })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("MCP Apps bridge did not bind");
 this.server=server;this.origin=`http://127.0.0.1:${address.port}`;}
 async openApp(input:McpWriteIdInput):Promise<McpAppView>{await this.listen();const resource=await this.writes.appResource(input);
 for(const old of this.viewers.values())if(old.view.sessionId===input.sessionId&&old.view.executorBotId===input.executorBotId)this.retire(old);
 const id=randomUUID(),token=randomBytes(32).toString("hex"),view:McpAppView={...this.scope(input),id,intentId:resource.intent.id,serverId:resource.tool.serverId,serverVersion:resource.tool.serverVersion,
 resourceUri:resource.tool.uiResourceUri!,epoch:1,proxyUrl:`${this.origin}/view/${id}/${token}`,title:resource.tool.name,
 permissionsNotice:"第三方 App 在隔离视图中运行。相机、麦克风、剪贴板、外部网络和宿主文件均未授权；工具调用仍需会话授权和逐次审批。"};
 const viewer:Viewer={view,token,html:resource.html,input:resource.intent.review.arguments,result:(resource.intent.result as{response?:unknown}|null)?.response??resource.intent.result,
 grantId:resource.intent.review.grantId,grantVersion:resource.intent.review.grantVersion,credentialDigest:this.writes.ledger.credentialForIntent(resource.intent.id),
 controller:new AbortController(),initialized:false,ready:false,inputSent:false,events:new Set(),requests:new Map()};this.viewers.set(id,viewer);this.assertCurrent(viewer);return view;}
 closeApp(input:EnvironmentScope&{id:string;expectedEpoch:number}){const parsed=mcpAppCloseSchema.parse(input),viewer=this.viewers.get(parsed.id);if(!viewer)return;
 if(viewer.view.sessionId!==parsed.sessionId||viewer.view.executorBotId!==parsed.executorBotId||viewer.view.epoch!==parsed.expectedEpoch)throw new AevorenBotError("RUNTIME_CONTROL_SCOPE_INVALID");this.retire(viewer);}
 private async handleMessage(viewer:Viewer,raw:unknown):Promise<unknown>{const parsed=rpcSchema.safeParse(raw);if(!parsed.success)return rpcError(undefined,-32600,"Invalid request");const rpc=parsed.data;
 this.assertCurrent(viewer);if(rpc.id!==undefined){const key=String(rpc.id),digest=mcpDigest(rpc),prior=viewer.requests.get(key);if(prior)return prior.digest===digest?prior.promise:rpcError(rpc.id,-32600,"Request id conflict");
 if(viewer.requests.size>=200)return rpcError(rpc.id,-32000,"Viewer request limit reached");const promise=this.dispatch(viewer,rpc);viewer.requests.set(key,{digest,promise});return promise;}return this.dispatch(viewer,rpc);}
 private async dispatch(viewer:Viewer,rpc:Rpc):Promise<unknown>{try{
 if(rpc.method==="ui/notifications/sandbox-proxy-ready")return {notification:{jsonrpc:"2.0",method:"ui/notifications/sandbox-resource-ready",params:{html:viewer.html,viewId:viewer.view.id,epoch:viewer.view.epoch}}};
 if(rpc.method==="ui/initialize"){
 if(viewer.initialized||rpc.id===undefined||rpc.params?.protocolVersion!==APP_PROTOCOL)return rpcError(rpc.id,-32602,"Unsupported initialization");
 viewer.initialized=true;return {jsonrpc:"2.0",id:rpc.id,result:{protocolVersion:APP_PROTOCOL,hostInfo:{name:"Aevoren Bot",version:"1"},hostCapabilities:{serverTools:{},serverResources:{}},
 hostContext:{displayMode:"inline",theme:"dark",containerDimensions:{height:480,width:640}}}};}
 if(rpc.method==="ui/notifications/initialized"){if(!viewer.initialized||viewer.ready)return {notifications:[]};viewer.ready=true;viewer.inputSent=true;
 return {notifications:[{jsonrpc:"2.0",method:"ui/notifications/tool-input",params:{arguments:viewer.input}},
 {jsonrpc:"2.0",method:"ui/notifications/tool-result",params:viewer.result}]};}
 if(!viewer.ready)return rpcError(rpc.id,-32000,"View is not initialized");
 if(rpc.method==="ping")return {jsonrpc:"2.0",id:rpc.id,result:{}};
 if(rpc.method==="resources/read"){if(rpc.params?.uri!==viewer.view.resourceUri)return rpcError(rpc.id,-32602,"Resource is outside this view grant");
 const resource=await this.writes.appResource({...this.scope(viewer.view),id:viewer.view.intentId,expectedVersion:this.writes.ledger.current(viewer.view,viewer.view.intentId).version},{signal:viewer.controller.signal});
 this.assertCurrent(viewer);return {jsonrpc:"2.0",id:rpc.id,result:resource.resourceResult};}
 if(rpc.method==="tools/call"){
 const name=typeof rpc.params?.name==="string"?rpc.params.name:"",args=mcpJsonArgumentsSchema.parse(rpc.params?.arguments??{}),grant=this.writes.toolGrants(viewer.view).find(value=>value.serverId===viewer.view.serverId&&value.toolName===name&&!value.revokedAt);
 if(!grant)return rpcError(rpc.id,-32602,"Tool lacks a current session grant");
 const targetEntries=Object.entries(args).filter(([key])=>/(target|path|url|recipient|resource|(?:^|_)id$|^to$)/iu.test(key));
 const targetPreview=`App 目标参数：${canonicalMcpJson(targetEntries.length?Object.fromEntries(targetEntries):args).slice(0,1900)}`;
 const intent=await this.writes.prepareTool({...this.scope(viewer.view),grantId:grant.id,expectedGrantVersion:grant.version,arguments:args,targetPreview,clientNonce:randomUUID()},{signal:viewer.controller.signal},"app");
 const finished=await this.options.requestAndWait(intent,viewer.controller.signal);this.assertCurrent(viewer);
 if(finished.state!=="confirmed")return rpcError(rpc.id,-32000,finished.state==="unknown"?"Result unknown; do not resend":"Tool action was not completed",{intentId:finished.id,state:finished.state});
 return {jsonrpc:"2.0",id:rpc.id,result:(finished.result as{response?:unknown}|null)?.response??{content:[]}};}
 if(rpc.method==="notifications/message")return {notifications:[]};
 return rpcError(rpc.id,-32601,"Host capability is not supported");
 }catch{return rpcError(rpc.id,-32000,"Request denied or connection authorization changed");}}
 private proxyHtml(viewer:Viewer){const config=JSON.stringify({viewId:viewer.view.id,epoch:viewer.view.epoch,origin:this.origin}).replaceAll("<","\\u003c");
 return `<!doctype html><html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#181818;color:white}</style><body><script nonce="${viewer.token}">
 const config=${config}; let view=null; const endpoint=location.href+'/rpc';
 async function send(message){const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)});
 if(!response.ok){close();return;}const result=await response.json(); if(result.notification?.method==='ui/notifications/sandbox-resource-ready'){
 const inner=document.createElement('iframe');inner.sandbox='allow-scripts';inner.referrerPolicy='no-referrer';inner.allow="camera 'none'; microphone 'none'; clipboard-read 'none'; clipboard-write 'none'";
 inner.src=location.href+'/inner';
 document.body.append(inner);view=inner;return;} if(result.notifications){for(const item of result.notifications)view?.contentWindow.postMessage(item,'*');return;}view?.contentWindow.postMessage(result,'*');}
 function close(){view?.remove();view=null;document.body.textContent='此 App 的连接或授权已关闭。';}
 addEventListener('message',event=>{if(!view||event.source!==view.contentWindow||event.origin!=='null')return;const message=event.data;
 if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||message.method.startsWith('ui/notifications/sandbox-'))return;
 if(JSON.stringify(message).length>${MAX_RPC_BYTES})return;void send(message).catch(close);});
 const stream=new EventSource(location.href+'/events');stream.onmessage=event=>{if(JSON.parse(event.data).closed){stream.close();close();}};stream.onerror=()=>{stream.close();close();};
 const ready={jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{viewId:config.viewId,epoch:config.epoch}};
 parent.postMessage(ready,'*');void send(ready).catch(close);
 </script></body></html>`;}
 async dispose(){this.unsubscribe();for(const viewer of this.viewers.values())this.retire(viewer);const server=this.server;this.server=null;if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}
}
