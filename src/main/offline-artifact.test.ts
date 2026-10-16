import {mkdtempSync,existsSync,readFileSync,rmSync} from "node:fs";
import {unlink,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,it,expect,vi} from "vitest";
const {linkGate}=vi.hoisted(()=>({linkGate:{after:null as null|((path:string)=>Promise<void>)}}));
vi.mock("node:fs/promises",async importOriginal=>{const original=await importOriginal<typeof import("node:fs/promises")>();return {...original,link:async(from:string,to:string)=>{await original.link(from,to);await linkGate.after?.(to);}};});
import {saveOfflineArtifact} from "./offline-artifact";
const roots:string[]=[];afterEach(()=>{linkGate.after=null;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("owned offline publication",()=>{
 const fixture=()=>{const root=mkdtempSync(join(tmpdir(),"aevoren-offline-"));roots.push(root);return join(root,"selected.html");};
 it("writes actual bytes without overwriting an existing user file",async()=>{const path=fixture(),artifact={name:"selected.html",mimeType:"text/html" as const,bytes:Buffer.from("<!doctype html><p>selected</p>"),assertCurrent:()=>{}};const result=await saveOfflineArtifact(path,artifact);expect(readFileSync(path)).toEqual(artifact.bytes);expect(result.size).toBe(artifact.bytes.length);await expect(saveOfflineArtifact(path,{...artifact,bytes:Buffer.from("replacement")})).rejects.toMatchObject({code:"ARTIFACT_ALREADY_EXISTS"});expect(readFileSync(path)).toEqual(artifact.bytes);});
 it("removes its own publication when authorization is revoked while link is pending",async()=>{const path=fixture();let authorized=true;linkGate.after=async()=>{authorized=false;};await expect(saveOfflineArtifact(path,{name:"selected.html",mimeType:"text/html",bytes:Buffer.from("private"),assertCurrent:()=>{if(!authorized)throw Error("revoked");}})).rejects.toThrow("revoked");expect(existsSync(path)).toBe(false);});
 it("preserves a replacement user inode after a held link loses authorization",async()=>{const path=fixture();let authorized=true;linkGate.after=async chosen=>{await unlink(chosen);await writeFile(chosen,"user replacement",{flag:"wx"});authorized=false;};await expect(saveOfflineArtifact(path,{name:"selected.html",mimeType:"text/html",bytes:Buffer.from("private"),assertCurrent:()=>{if(!authorized)throw Error("revoked");}})).rejects.toThrow();expect(readFileSync(path,"utf8")).toBe("user replacement");});
});
