import { describe,expect,it } from "vitest";
import { notificationOptions } from "./notification-policy";
const preferences={defaultAssistantBotId:null,notifications:{approvals:true,taskCompletion:false,taskFailure:true,routines:true},sound:false};
describe("personal notification dispatch",()=>{
  it("checks category and sound separately without muting other categories",()=>{expect(notificationOptions(preferences,"approvals",false,true)).toEqual({silent:true});expect(notificationOptions(preferences,"taskCompletion",false,true)).toBeNull();expect(notificationOptions({...preferences,sound:true},"taskFailure",false,true)).toEqual({silent:false});});
  it("never dispatches fixture or unsupported desktop notifications",()=>{expect(notificationOptions(preferences,"routines",true,true)).toBeNull();expect(notificationOptions(preferences,"routines",false,false)).toBeNull();});
});
