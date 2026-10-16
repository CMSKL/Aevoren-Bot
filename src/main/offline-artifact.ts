import {randomUUID,createHash} from "node:crypto";
import {open,link,unlink} from "node:fs/promises";
import {dirname,join} from "node:path";
import {AevorenBotError} from "./errors";
import type {PreparedOfflineArtifact} from "./template-export-service";
/** Atomic publication in the chosen directory; hard-link fails if destination already exists. */
export async function saveOfflineArtifact(path:string,artifact:PreparedOfflineArtifact){
 const temporary=join(dirname(path),`.aevoren-export-${randomUUID()}.tmp`);let published=false;
 try{artifact.assertCurrent();const file=await open(temporary,"wx",0o600);try{await file.writeFile(artifact.bytes);await file.sync();}finally{await file.close();}artifact.assertCurrent();await link(temporary,path);published=true;return {name:artifact.name,size:artifact.bytes.byteLength,sha256:createHash("sha256").update(artifact.bytes).digest("hex")};}
 catch(error){if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="EEXIST")throw new AevorenBotError("ARTIFACT_ALREADY_EXISTS");throw error;}
 finally{await unlink(temporary).catch(()=>{});if(!published){/* A failed link leaves the chosen destination untouched. */}}
}
