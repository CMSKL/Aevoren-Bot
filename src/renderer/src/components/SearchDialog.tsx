import { useEffect, useRef, useState } from "react";
import type { ApiResult, Project } from "@shared/contracts";
import { SEARCH_KINDS, type SearchItem, type SearchPage, type SearchQueryInput, type SearchSourceReference } from "@shared/search-contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { MediaPreviewDialog } from "./MediaPreviewDialog";
import { CloseIcon, SearchIcon } from "./Icons";
import "../styles/search.css";
const labels={message:"消息",document:"资料",skill:"Skill",media:"媒体与转录",task:"任务线程",routine:"自动任务","local-draft":"应用草稿"};
function data<T>(result:ApiResult<T>):T{if(!result.ok)throw new Error(result.error.safeMessage);return result.data;}
async function sourceText(source:SearchSourceReference):Promise<string>{
  const api=window.aevorenBot,scope={sessionId:source.sessionId,id:source.id};
  switch(source.type){
    case "document":case "skill":return data(await api.library.read({...scope,revisionId:source.revisionId})).revision.body;
    case "voice-transcript":return data(await api.voice.get(scope)).transcript??"尚无转录文字。";
    case "realtime-transcript":return data(await api.voice.realtime.snapshot({sessionId:source.sessionId,id:source.voiceSessionId})).turns.find(item=>item.id===source.id)?.transcript??"尚无转录文字。";
    case "routine":return data(await api.routines.list()).find(item=>item.id===source.id)?.prompt??"自动任务已不可用。";
    case "local-draft":{const content=data(await api.drafts.read({...scope,executorBotId:source.executorBotId,revisionId:source.revisionId})).revision.content;
      return content.kind==="gmail-message"?`收件人：${content.to.join("、")}\n抄送：${content.cc.join("、")}\n主题：${content.subject}\n\n${content.body}`:content.kind==="notion-page-title"?content.title:content.text;}
    default:return "";
  }
}
export function SearchDialog({sessionId,projectId,projects,onClose,onNavigate}:{sessionId?:string;projectId?:string;projects:Project[];onClose():void;onNavigate(source:SearchSourceReference):Promise<boolean>}):React.JSX.Element{
  const [query,setQuery]=useState(""),[scope,setScope]=useState(sessionId?"session":"all"),[kind,setKind]=useState("all"),[page,setPage]=useState<SearchPage|null>(null),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[preview,setPreview]=useState<{item:SearchItem;text:string}|null>(null),[media,setMedia]=useState<Extract<SearchSourceReference,{type:"media"}>|null>(null);
  const request=useRef(0),mounted=useRef(true),inputRef=useRef<HTMLInputElement>(null),submitted=useRef<SearchQueryInput|null>(null);
  useEffect(()=>{mounted.current=true;const original=document.activeElement;inputRef.current?.focus();return()=>{mounted.current=false;if(original instanceof HTMLElement&&original.isConnected)original.focus();};},[]);
  const reset=():void=>{request.current++;setPage(null);setPreview(null);setMedia(null);setError(null);setPending(false);submitted.current=null;};
  const search=async(more=false):Promise<void>=>{
    if(!query.trim()||pending)return;
    const current=++request.current;setPending(true);setError(null);setPreview(null);
    const selection=scope==="session"&&sessionId?{kind:"session" as const,sessionId}:scope==="project"&&projectId?{kind:"project" as const,projectId}:{kind:"all" as const};
    const command:SearchQueryInput=more&&submitted.current?{...submitted.current,cursor:page?.nextCursor??undefined}:{query:query.trim(),scope:selection,...(kind!=="all"?{kinds:[kind as SearchItem["kind"]]}:{}),limit:30};
    try{const result=data(await window.aevorenBot.search.query(command));if(!mounted.current||request.current!==current)return;
      submitted.current={...command,cursor:undefined};setPage(previous=>more&&previous?.queryDigest===result.queryDigest?{...result,items:[...previous.items,...result.items]}:result);
    }catch(failure){if(mounted.current&&request.current===current)setError(failure instanceof Error?failure.message:"搜索未完成。");}
    finally{if(mounted.current&&request.current===current)setPending(false);}
  };
  const open=async(item:SearchItem):Promise<void>=>{
    const current=++request.current;setPending(true);setError(null);setPreview(null);
    try{const {source}=data(await window.aevorenBot.search.open({source:item.source}));if(!mounted.current||request.current!==current)return;
      if(source.type==="media"){setMedia(source);return;}
      if(source.type==="message"||source.type==="task"){if(await onNavigate(source)){if(mounted.current&&request.current===current)onClose();}else if(mounted.current&&request.current===current)setError("无法打开原会话，请重新搜索。");return;}
      const text=await sourceText(source);if(!mounted.current||request.current!==current)return;data(await window.aevorenBot.search.open({source}));if(mounted.current&&request.current===current)setPreview({item,text});
    }catch(failure){if(mounted.current&&request.current===current)setError(failure instanceof Error?failure.message:"来源不可用，请重新搜索。");}
    finally{if(mounted.current&&request.current===current)setPending(false);}
  };
  useEffect(()=>{if(!preview)return;const invalidate=():void=>{request.current++;setPreview(null);setPending(false);setError("来源状态已变化，请重新打开搜索结果。");};
    const stops=[window.aevorenBot.library.onChanged(event=>{if(event.sessionId===preview.item.source.sessionId)invalidate();}),window.aevorenBot.voice.onChanged(event=>{if(event.task.sessionId===preview.item.source.sessionId)invalidate();}),window.aevorenBot.sessions.onTasksChanged(event=>{if(event.sessionId===preview.item.source.sessionId)invalidate();})];return()=>stops.forEach(stop=>stop());},[preview]);
  return <>{!media?<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className="search-dialog" role="dialog" aria-modal="true" aria-label="全资源搜索" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();onClose();}if(event.key==="Tab"){const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]'));const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
    <header><h2>全资源搜索</h2><button className="icon-button" aria-label="关闭搜索" onClick={onClose}><CloseIcon/></button></header>
    <form onSubmit={event=>{event.preventDefault();void search();}}><label className="search-query"><SearchIcon/><input ref={inputRef} aria-label="搜索所有资源" placeholder="搜索消息、资料、Skill、媒体或任务" value={query} maxLength={200} onChange={event=>{reset();setQuery(event.target.value);}}/></label><div className="search-filters"><label>范围<select aria-label="搜索范围" value={scope} onChange={event=>{reset();setScope(event.target.value);}}><option value="all">全部本地资源</option>{sessionId?<option value="session">当前会话</option>:null}{projectId&&projects.some(item=>item.id===projectId)?<option value="project">当前项目</option>:null}</select></label><label>类型<select aria-label="搜索类型" value={kind} onChange={event=>{reset();setKind(event.target.value);}}><option value="all">全部类型</option>{SEARCH_KINDS.map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label><button type="submit" className="primary-button" disabled={pending||!query.trim()}>搜索</button></div></form>
    {error?<p className="dialog-error" role="alert">{error}</p>:null}<div className="search-content" aria-busy={pending}>{preview?<article className="search-source"><button type="button" onClick={()=>setPreview(null)}>返回结果</button><h3>{preview.item.title}</h3><p>已核验的{labels[preview.item.kind]}原内容</p><AssistantMarkdown body={preview.text}/></article>:<><div role="status">{pending?"正在读取…":page?`当前已显示 ${page.items.length} 项结果`:"输入关键词后搜索。只有已保存的本地内容会进入结果。"}</div><ul className="search-results">{page?.items.map(item=><li key={item.id}><button type="button" disabled={pending} onClick={()=>void open(item)}><span className="search-kind">{labels[item.kind]}</span><strong>{item.title}</strong><p>{item.snippet}</p><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString()}</time></button></li>)}</ul>{page?.nextCursor?<button type="button" disabled={pending} onClick={()=>void search(true)}>加载更多结果</button>:null}</>}</div>
  </section></div>:<MediaPreviewDialog sessionId={media.sessionId} reference={media.reference} onClose={()=>setMedia(null)}/>}</>;
}
