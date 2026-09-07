"use client";
import { useCallback, useEffect, useState } from "react";
interface Row {id:string;data:{title?:string;state?:string;nextRunAt?:string;read?:boolean;message?:string;type?:string;result?:{counts?:Record<string,number>;findings?:unknown[];totalFindings?:number}}}
interface Snapshot {notifications:Row[];followUps:Row[];monitors:Row[]}
export function WorkflowPanel({refreshKey}:{refreshKey:string}){
  const [open,setOpen]=useState(false);const [snapshot,setSnapshot]=useState<Snapshot>();const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{try{const r=await fetch("/api/workflows",{signal});if(!r.ok)throw new Error("Saved workflows are temporarily unavailable.");setSnapshot(await r.json());setError("");}catch(e){if(!signal?.aborted)setError(e instanceof Error?e.message:"Unable to load workflows.");}},[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);const interval=setInterval(()=>{if(document.visibilityState==="visible")void load(controller.signal);},60000);return()=>{controller.abort();clearInterval(interval);};},[load,refreshKey]);
  const act=async(id:string,action:string)=>{setBusy(true);try{const r=await fetch("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,action})});if(!r.ok)throw new Error("The change could not be saved.");await load();}catch(e){setError(e instanceof Error?e.message:"Could not save.");}finally{setBusy(false);}};
  const unread=snapshot?.notifications.filter(n=>!n.data.read).length||0;
  const tasks=snapshot?.followUps.filter(n=>n.data.state!=="completed"&&n.data.state!=="cancelled")||[];
  return <section className="workflow-panel" aria-label="Saved follow-ups and notifications">
    <button className="workflow-toggle" type="button" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>Follow-ups & updates{unread?` · ${unread} new`:""}</button>
    {open?<div className="workflow-panel-body">
      {error?<p role="alert">{error}</p>:null}
      <div className="workflow-section"><strong>Upcoming follow-ups</strong>{!tasks.length?<p>No pending follow-ups. Ask the assistant to save one.</p>:tasks.map(row=><div className="workflow-row" key={row.id}><div><strong>{row.data.title}</strong><small>{row.data.state==="due"?"Due · ":""}{row.data.nextRunAt?new Date(row.data.nextRunAt).toLocaleString():""}</small></div><button type="button" disabled={busy} onClick={()=>void act(row.id,"complete")}>Complete</button><button type="button" disabled={busy} onClick={()=>void act(row.id,"cancel")}>Cancel</button></div>)}</div>
      <div className="workflow-section"><strong>Updates</strong>{!snapshot?.notifications.length?<p>No updates yet. Enabled monitors will report new findings here.</p>:snapshot.notifications.map(row=><div className="workflow-row" key={row.id}><div><strong>{row.data.title}</strong>{row.data.message?<p>{row.data.message}</p>:null}{row.data.result?.findings?<small>{row.data.result.totalFindings ?? row.data.result.findings.length} findings · Ask the assistant for the audit details.</small>:null}</div>{!row.data.read?<button type="button" disabled={busy} onClick={()=>void act(row.id,"read")}>Mark read</button>:<small>Read</small>}</div>)}</div>
      <small>{snapshot?.monitors.filter(m=>m.data.state==="scheduled").length||0} active lead monitors</small>
    </div>:null}
  </section>;
}
