import {EventEmitter} from "node:events";
import type {IncomingMessage,ServerResponse} from "node:http";
import {afterEach,describe,expect,it,vi} from "vitest";
import {EventHttpServer} from "./event-http-server";
import type {EventService} from "./event-service";
afterEach(()=>vi.useRealTimers());
describe("bounded early Webhook response close",()=>{
 it("half-closes after its response and destroys a trickling peer at the original absolute bound",async()=>{
  vi.useFakeTimers();const events={authenticate:vi.fn(),receiveWebhook:vi.fn()} as unknown as EventService,server=new EventHttpServer(events);
  Reflect.set(server,"state",{listening:true,host:"127.0.0.1",port:12345});
  const socket=Object.assign(new EventEmitter(),{remoteAddress:"127.0.0.1",end:vi.fn(),destroy:vi.fn()}),request=Object.assign(new EventEmitter(),{socket,method:"POST",url:"/hooks/00000000-0000-4000-8000-000000000000/1",complete:false,headers:{host:"127.0.0.1:12345",authorization:"Bearer controlled",'content-type':"application/json",'content-length':"131072",'idempotency-key':"oversized"},headersDistinct:{authorization:["Bearer controlled"],"content-type":["application/json"]},resume:vi.fn(),destroy:vi.fn()}),response={destroyed:false,writeHead:vi.fn(),end:vi.fn((_body:string,callback:()=>void)=>callback())};
  await Reflect.get(server,"handle").call(server,request as unknown as IncomingMessage,response as unknown as ServerResponse);
  expect(response.writeHead).toHaveBeenCalledWith(413,expect.objectContaining({Connection:"close"}));expect(request.resume).toHaveBeenCalledOnce();expect(socket.end).toHaveBeenCalledOnce();expect(request.destroy).not.toHaveBeenCalled();expect(events.receiveWebhook).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4_999);socket.emit("data",Buffer.from("still sending"));expect(socket.destroy).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(socket.destroy).toHaveBeenCalledOnce();socket.emit("close");expect(vi.getTimerCount()).toBe(0);
 });
 it("clears its absolute cleanup deadline when the peer closes normally",async()=>{
  vi.useFakeTimers();const server=new EventHttpServer({} as EventService);Reflect.set(server,"state",{listening:false,host:"127.0.0.1",port:null});const socket=Object.assign(new EventEmitter(),{remoteAddress:"127.0.0.1",end:vi.fn(),destroy:vi.fn()}),request={socket,complete:false,resume:vi.fn()},response={destroyed:false,writeHead:vi.fn(),end:vi.fn((_body:string,callback:()=>void)=>callback())};await Reflect.get(server,"handle").call(server,request,response);socket.emit("close");expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(5_000);expect(socket.destroy).not.toHaveBeenCalled();
 });
});
