import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OrganizationContext, OrganizationCreateSection, OrganizationDeleteSection, OrganizationMoveSession, OrganizationRenameSection, OrganizationReorderSections, OrganizationSavePreferences, OrganizationSnapshot, SidebarAssignment, SidebarSection } from "@shared/organization-contracts";
import { organizationContextSchema, organizationCreateSectionSchema, organizationDeleteSectionSchema, organizationMoveSessionSchema, organizationRenameSectionSchema, organizationReorderSectionsSchema, organizationSavePreferencesSchema } from "@shared/organization-schemas";
import { AevorenBotError } from "./errors";

export const ORGANIZATION_MIGRATION = { version: 46, sql: `
  ALTER TABLE bots ADD COLUMN avatar_image_json TEXT;
  CREATE TABLE organization_sections (
    id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name)>0 AND length(name)<=80),position INTEGER NOT NULL CHECK(position>=0)
  );
  CREATE TABLE organization_assignments (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    section_id TEXT REFERENCES organization_sections(id) ON DELETE SET NULL,position INTEGER NOT NULL CHECK(position>=0)
  );
  CREATE INDEX organization_assignment_order ON organization_assignments(section_id,position,session_id);
  CREATE TABLE organization_preferences (
    id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version>0),default_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
    notify_approvals INTEGER NOT NULL CHECK(notify_approvals IN(0,1)),notify_completion INTEGER NOT NULL CHECK(notify_completion IN(0,1)),
    notify_failure INTEGER NOT NULL CHECK(notify_failure IN(0,1)),notify_routines INTEGER NOT NULL CHECK(notify_routines IN(0,1)),sound INTEGER NOT NULL CHECK(sound IN(0,1))
  );
  INSERT INTO organization_preferences VALUES(1,1,NULL,1,0,0,1,1);
  CREATE TRIGGER organization_deleted_session AFTER DELETE ON organization_assignments BEGIN
    UPDATE organization_preferences SET version=version+1 WHERE id=1;
  END;
  CREATE TRIGGER organization_deleted_bot BEFORE DELETE ON bots BEGIN
    UPDATE organization_preferences SET default_bot_id=NULL,version=version+1 WHERE id=1 AND default_bot_id=OLD.id;
  END;
  CREATE TRIGGER organization_retired_bot AFTER UPDATE OF deleted_at ON bots WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE organization_preferences SET default_bot_id=NULL,version=version+1 WHERE id=1 AND default_bot_id=NEW.id;
  END;
` } as const;
export type OrganizationHost = { assertContext(context: OrganizationContext): void; assertSession(id: string): void; assertBot(id: string): void };
type PreferencesRow={version:number;default_bot_id:string|null;notify_approvals:number;notify_completion:number;notify_failure:number;notify_routines:number;sound:number};

/** Organization never copies conversation content or grants permission to a resource. */
export class OrganizationRepository {
  private sequence=0;
  constructor(private readonly database:DatabaseSync,private readonly host:OrganizationHost){}
  private transaction<T>(work:()=>T):T{
    const name=`organization_${++this.sequence}`;this.database.exec(`SAVEPOINT ${name}`);
    try{const result=work();this.database.exec(`RELEASE SAVEPOINT ${name}`);return result;}
    catch(error){this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}
  }
  private context(value?:OrganizationContext):OrganizationContext|undefined{if(!value)return;const parsed=organizationContextSchema.parse(value);this.host.assertContext(parsed);return parsed;}
  private preferences():PreferencesRow{return this.database.prepare("SELECT * FROM organization_preferences WHERE id=1").get() as PreferencesRow;}
  snapshot(context?:OrganizationContext):OrganizationSnapshot{
    const current=this.context(context);
    return this.transaction(()=>{const row=this.preferences();return {version:row.version,
      sections:this.database.prepare("SELECT id,name,position FROM organization_sections ORDER BY position,id").all() as SidebarSection[],
      assignments:(this.database.prepare("SELECT session_id AS sessionId,section_id AS sectionId,position FROM organization_assignments WHERE (? IS NULL OR session_id=?) ORDER BY section_id,position,session_id").all(current?.sessionId??null,current?.sessionId??null) as SidebarAssignment[]),
      preferences:{defaultAssistantBotId:row.default_bot_id,notifications:{approvals:Boolean(row.notify_approvals),taskCompletion:Boolean(row.notify_completion),taskFailure:Boolean(row.notify_failure),routines:Boolean(row.notify_routines)},sound:Boolean(row.sound)},
    };});
  }
  private mutate(version:number,context:OrganizationContext|undefined,work:()=>void):OrganizationSnapshot{
    const current=this.context(context);
    return this.transaction(()=>{const changed=this.database.prepare("UPDATE organization_preferences SET version=version+1 WHERE id=1 AND version=?").run(version);
      if(!changed.changes)throw new AevorenBotError("ORG_VERSION_CONFLICT",undefined,undefined,{currentVersion:this.preferences().version});
      work();return this.snapshot(current);
    });
  }
  private section(id:string):void{if(!this.database.prepare("SELECT 1 FROM organization_sections WHERE id=?").get(id))throw new AevorenBotError("INVALID_REQUEST");}
  createSection(input:OrganizationCreateSection,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationCreateSectionSchema.parse(input);
    return this.mutate(parsed.expectedVersion,context,()=>{const count=Number((this.database.prepare("SELECT COUNT(*) AS count FROM organization_sections").get() as {count:number}).count);
      if(count>=100)throw new AevorenBotError("INVALID_REQUEST");this.database.prepare("INSERT INTO organization_sections VALUES(?,?,?)").run(randomUUID(),parsed.name,count);
    });
  }
  renameSection(input:OrganizationRenameSection,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationRenameSectionSchema.parse(input);return this.mutate(parsed.expectedVersion,context,()=>{this.section(parsed.id);this.database.prepare("UPDATE organization_sections SET name=? WHERE id=?").run(parsed.name,parsed.id);});
  }
  deleteSection(input:OrganizationDeleteSection,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationDeleteSectionSchema.parse(input);
    return this.mutate(parsed.expectedVersion,context,()=>{this.section(parsed.id);const moved=this.assignments(parsed.id),defaults=this.assignments(null);
      defaults.forEach((sessionId,index)=>this.database.prepare("UPDATE organization_assignments SET position=? WHERE session_id=?").run(index,sessionId));
      moved.forEach((sessionId,index)=>this.database.prepare("UPDATE organization_assignments SET section_id=NULL,position=? WHERE session_id=?").run(defaults.length+index,sessionId));
      this.database.prepare("DELETE FROM organization_sections WHERE id=?").run(parsed.id);
      const sections=this.database.prepare("SELECT id FROM organization_sections ORDER BY position,id").all() as {id:string}[];
      sections.forEach((section,index)=>this.database.prepare("UPDATE organization_sections SET position=? WHERE id=?").run(index,section.id));
    });
  }
  reorderSections(input:OrganizationReorderSections,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationReorderSectionsSchema.parse(input);
    return this.mutate(parsed.expectedVersion,context,()=>{const existing=this.database.prepare("SELECT id FROM organization_sections").all() as {id:string}[];
      if(existing.length!==parsed.sectionIds.length||existing.some(item=>!parsed.sectionIds.includes(item.id)))throw new AevorenBotError("INVALID_REQUEST");
      parsed.sectionIds.forEach((id,index)=>this.database.prepare("UPDATE organization_sections SET position=? WHERE id=?").run(index,id));
    });
  }
  private assignments(sectionId:string|null):string[]{return (this.database.prepare("SELECT session_id FROM organization_assignments WHERE section_id IS ? ORDER BY position,session_id").all(sectionId) as {session_id:string}[]).map(item=>item.session_id);}
  moveSession(input:OrganizationMoveSession,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationMoveSessionSchema.parse(input),current=this.context(context);
    if(current&&current.sessionId!==parsed.sessionId)throw new AevorenBotError("APPROVAL_SCOPE_INVALID");
    return this.mutate(parsed.expectedVersion,current,()=>{this.host.assertSession(parsed.sessionId);if(parsed.sectionId)this.section(parsed.sectionId);
      const previous=this.database.prepare("SELECT section_id FROM organization_assignments WHERE session_id=?").get(parsed.sessionId) as {section_id:string|null}|undefined;
      const target=this.assignments(parsed.sectionId).filter(id=>id!==parsed.sessionId);target.splice(Math.min(parsed.position??target.length,target.length),0,parsed.sessionId);
      this.database.prepare("INSERT INTO organization_assignments(session_id,section_id,position) VALUES(?,?,0) ON CONFLICT(session_id) DO UPDATE SET section_id=excluded.section_id").run(parsed.sessionId,parsed.sectionId);
      target.forEach((id,index)=>this.database.prepare("UPDATE organization_assignments SET position=? WHERE session_id=?").run(index,id));
      if(previous&&previous.section_id!==parsed.sectionId)this.assignments(previous.section_id).forEach((id,index)=>this.database.prepare("UPDATE organization_assignments SET position=? WHERE session_id=?").run(index,id));
    });
  }
  savePreferences(input:OrganizationSavePreferences,context?:OrganizationContext):OrganizationSnapshot{
    const parsed=organizationSavePreferencesSchema.parse(input);
    return this.mutate(parsed.expectedVersion,context,()=>{const current=this.preferences(),patch=parsed.patch;
      if(patch.defaultAssistantBotId){this.host.assertBot(patch.defaultAssistantBotId);if(!this.database.prepare("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL").get(patch.defaultAssistantBotId))throw new AevorenBotError("BOT_NOT_FOUND");}
      this.database.prepare("UPDATE organization_preferences SET default_bot_id=?,notify_approvals=?,notify_completion=?,notify_failure=?,notify_routines=?,sound=? WHERE id=1").run(
        patch.defaultAssistantBotId===undefined?current.default_bot_id:patch.defaultAssistantBotId,
        patch.notifications?.approvals===undefined?current.notify_approvals:Number(patch.notifications.approvals),
        patch.notifications?.taskCompletion===undefined?current.notify_completion:Number(patch.notifications.taskCompletion),
        patch.notifications?.taskFailure===undefined?current.notify_failure:Number(patch.notifications.taskFailure),
        patch.notifications?.routines===undefined?current.notify_routines:Number(patch.notifications.routines),patch.sound===undefined?current.sound:Number(patch.sound));
    });
  }
}
