import {createHash} from "node:crypto";
import {AevorenBotError} from "./errors";
import {writeLibraryExport} from "./library-export";
import type {PreparedOfflineArtifact} from "./template-export-service";
/** Reuse owned-inode publication and revocation cleanup for one complete offline file. */
export async function saveOfflineArtifact(path:string,artifact:PreparedOfflineArtifact){
 try{await writeLibraryExport({kind:"document",name:artifact.name,resourceId:"offline-export",revisionId:"offline-export",files:[{relativePath:artifact.name,bytes:Buffer.from(artifact.bytes)}]},path,undefined,artifact.assertCurrent);}
 catch(error){if(error instanceof AevorenBotError&&error.code==="LIBRARY_EXPORT_CONFLICT")throw new AevorenBotError("ARTIFACT_ALREADY_EXISTS");throw error;}
 return {name:artifact.name,size:artifact.bytes.byteLength,sha256:createHash("sha256").update(artifact.bytes).digest("hex")};
}
