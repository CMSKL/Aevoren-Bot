import { z } from "zod";
import { resourceReferencesSchema } from "./library-schemas";
import { messageMediaReferencesSchema } from "./media-schemas";
const id=z.string().uuid(),version=z.number().int().positive(),digest=z.string().regex(/^[a-f0-9]{64}$/u);
const unique=<T extends z.ZodType>(schema:T,key:(item:z.infer<T>)=>string,max:number)=>z.array(schema).max(max).refine(items=>new Set(items.map(key)).size===items.length,"Selections must be unique");
export const taskExecutorSelectionSchema=z.object({
  executorBotId:id,
  memories:unique(z.object({id,version,digest}).strict(),item=>item.id,100).default([]),
  history:unique(z.object({entryId:id,generation:version,digest}).strict(),item=>item.entryId,100).default([]),
  workspaces:unique(z.object({id,read:z.boolean(),write:z.boolean(),automation:z.boolean()}).strict().refine(item=>item.read&&(!item.automation||item.write)),item=>item.id,20).default([]),
  mcp:unique(z.object({serverId:id,expectedVersion:version,toolNames:z.array(z.string().min(1).max(200)).max(100).refine(items=>new Set(items).size===items.length)}).strict(),item=>item.serverId,20).default([]),
  resourceRefs:resourceReferencesSchema.default([]),mediaRefs:messageMediaReferencesSchema.default([]),
  productOperations:z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9.]*$/u).max(120)).max(400).refine(items=>new Set(items).size===items.length).default([]),
  network:z.boolean().default(false),clipboard:z.boolean().default(false),
}).strict();
export const taskSelectionsSchema=unique(taskExecutorSelectionSchema,item=>item.executorBotId,6).min(1);
export const taskCreateSchema=z.object({parentSessionId:id,expectedScopeVersion:version,clientNonce:id,title:z.string().trim().min(1).max(120),selections:taskSelectionsSchema}).strict();
export const taskScopeSchema=z.object({sessionId:id}).strict();
export const taskListSchema=z.object({parentSessionId:id,limit:z.number().int().min(1).max(100).optional()}).strict();
export const taskUpdateSchema=taskScopeSchema.extend({expectedVersion:version,title:z.string().trim().min(1).max(120)});
export const taskSelectionUpdateSchema=taskScopeSchema.extend({expectedVersion:version,selections:taskSelectionsSchema});
export const taskCancelSchema=taskScopeSchema.extend({expectedVersion:version});
