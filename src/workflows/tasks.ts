import { createHash } from "node:crypto";
import type { WorkflowContext } from "./context.js";
import { getWorkflowStore, type WorkflowStore, type WorkflowRecord } from "./store.js";

export interface FollowUpTask {
  title:string; leadId?:string; note?:string; conversationId:string;
  state:"scheduled"|"due"|"completed"|"cancelled";nextRunAt:string;completedAt?:string;
}
export async function scheduleFollowUp(context:WorkflowContext,input:{id:string;title:string;leadId?:string;note?:string;scheduledFor:string},store=getWorkflowStore()) {
  if(!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.scheduledFor))throw new Error("Follow-up time requires a timezone offset.");
  const date=new Date(input.scheduledFor);
  if(!Number.isFinite(date.getTime()))throw new Error("Choose a valid follow-up time.");
  if(!input.title.trim()||input.title.length>500||input.note&&input.note.length>8000)throw new Error("Invalid follow-up title or note.");
  const task:FollowUpTask={title:input.title.trim(),leadId:input.leadId,note:input.note,conversationId:context.conversationId,state:"scheduled",nextRunAt:date.toISOString()};
  const previous=await store.get<FollowUpTask>(context.workspaceId,"follow_up",input.id);
  if(!previous&&date.getTime()<=Date.now())throw new Error("Choose a follow-up time in the future.");
  const created=previous?false:await store.create(context.workspaceId,"follow_up",input.id,task);
  const existing=await store.get<FollowUpTask>(context.workspaceId,"follow_up",input.id);
  if(!created&&existing&&(existing.data.title!==task.title||existing.data.leadId!==task.leadId||existing.data.nextRunAt!==task.nextRunAt||existing.data.note!==task.note))throw new Error("This action ID already belongs to a different follow-up.");
  return {id:input.id,created,...existing?.data,location:"Bonte",message:"Saved in Bonte. This does not create a CRM activity or calendar event."};
}

export async function finishFollowUp(context:WorkflowContext,id:string,state:"completed"|"cancelled",store=getWorkflowStore()) {
  const task=await store.get<FollowUpTask>(context.workspaceId,"follow_up",id);
  if(!task)throw new Error("Follow-up not found.");
  const ok=await store.compareAndSet(context.workspaceId,"follow_up",id,task.version,{...task.data,state,completedAt:state==="completed"?new Date().toISOString():undefined});
  if(!ok)throw new Error("The follow-up changed; refresh and retry.");
  return {id,state};
}

export interface LeadMonitor {state:"scheduled"|"cancelled";conversationId:string;nextRunAt:string;intervalMinutes:number;filters:Record<string,unknown>;lastFingerprint?:string;lastRunAt?:string;lastError?:string;pendingRunAt?:string}
export async function saveLeadMonitor(context:WorkflowContext,input:{id:string;intervalMinutes:number;filters?:Record<string,unknown>},store=getWorkflowStore()) {
  if(!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<15||input.intervalMinutes>43200)throw new Error("Monitor interval must be between 15 minutes and 30 days.");
  const old=await store.get<LeadMonitor>(context.workspaceId,"lead_monitor",input.id);
  const monitor:LeadMonitor={state:"scheduled",conversationId:context.conversationId,nextRunAt:new Date().toISOString(),intervalMinutes:input.intervalMinutes,filters:input.filters||{}};
  if(old&&JSON.stringify(old.data.filters)===JSON.stringify(monitor.filters)){monitor.lastFingerprint=old.data.lastFingerprint;monitor.lastError=old.data.lastError;}
  if(old){if(!await store.compareAndSet(context.workspaceId,"lead_monitor",input.id,old.version,monitor))throw new Error("Monitor changed; retry.");}
  else if(!await store.create(context.workspaceId,"lead_monitor",input.id,monitor))throw new Error("Monitor already exists; retry.");
  return {id:input.id,...monitor,delivery:"Bonte notifications; external reminders are not sent."};
}

type AuditRunner=(scope:string,filters:Record<string,unknown>)=>Promise<{findings:unknown[];[key:string]:unknown}>;
/** Durable CAS claims and deterministic notification keys recover safely after a restart. */
export class WorkflowWorker {
  private timer?:NodeJS.Timeout;private running=false;
  constructor(private store:WorkflowStore,private audit:AuditRunner,private cleanup?:()=>Promise<void>){}
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(e=>console.error("[Workflows] background run failed:",e instanceof Error?e.message:String(e)));},30000);this.timer.unref();void this.tick().catch(()=>{});}
  async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;while(this.running)await new Promise(r=>setTimeout(r,20));}
  async tick(now=new Date()):Promise<void>{
    if(this.running)return;this.running=true;
    try {
      for(const row of await this.store.due<FollowUpTask>("follow_up",now.toISOString())){
        await this.store.transitionWithRecords(row.workspaceId,"follow_up",row.id,row.version,{...row.data,state:"due"},[{kind:"notification",id:`follow-up-${row.id}`,data:{title:row.data.title,leadId:row.data.leadId,conversationId:row.data.conversationId,createdAt:now.toISOString(),read:false,type:"follow_up_due",expiresAt:new Date(now.getTime()+30*86400000).toISOString()}}]);
      }
      // ponytail: sequential audits per gateway; add bounded concurrency if monitor volume warrants it.
      for(const row of await this.store.due<LeadMonitor>("lead_monitor",now.toISOString()))await this.runMonitor(row,now);
      await this.cleanup?.();
    }finally{this.running=false;}
  }
  private async runMonitor(row:WorkflowRecord<LeadMonitor>,now:Date){
    const claimed={...row.data,pendingRunAt:row.data.pendingRunAt||row.data.nextRunAt,nextRunAt:new Date(now.getTime()+10*60000).toISOString()};
    if(!await this.store.compareAndSet(row.workspaceId,row.kind,row.id,row.version,claimed))return;
    let next:LeadMonitor;
    const records:Array<{kind:string;id:string;data:unknown}>=[];
    const expiresAt=new Date(now.getTime()+30*86400000).toISOString();
    try{
      const result=await this.audit(row.workspaceId,row.data.filters);
      // Audit adapters return stable findings; exclude changing elapsed durations from their keys.
      const fingerprint=createHash("sha256").update(JSON.stringify(result.findings)).digest("hex");
      if(fingerprint!==row.data.lastFingerprint&&(result.findings.length>0||row.data.lastFingerprint)){
        records.push({kind:"notification",id:`audit-${row.id}-${createHash("sha256").update(claimed.pendingRunAt+fingerprint).digest("hex")}`,data:{type:"lead_audit_changed",title:result.findings.length?"Lead audit needs attention":"Lead audit findings cleared",conversationId:row.data.conversationId,createdAt:now.toISOString(),read:false,result:{...result,findings:result.findings.slice(0,50),totalFindings:result.findings.length},expiresAt}});
      }
      records.push({kind:"audit_run",id:`${row.id}-${claimed.pendingRunAt}`,data:{...result,createdAt:now.toISOString(),monitorId:row.id,expiresAt}});
      next={...row.data,state:"scheduled",lastFingerprint:fingerprint,lastRunAt:now.toISOString(),lastError:undefined,pendingRunAt:undefined,nextRunAt:new Date(now.getTime()+row.data.intervalMinutes*60000).toISOString()};
    }catch(error){
      const message=error instanceof Error?error.message:"Audit failed";
      if(message!==row.data.lastError)records.push({kind:"notification",id:`audit-error-${row.id}-${createHash("sha256").update(claimed.pendingRunAt+message).digest("hex")}`,data:{type:"audit_failed",title:"Lead monitor could not refresh",message,conversationId:row.data.conversationId,createdAt:now.toISOString(),read:false,expiresAt}});
      next={...row.data,lastError:message,lastRunAt:now.toISOString(),pendingRunAt:undefined,nextRunAt:new Date(now.getTime()+Math.max(15,row.data.intervalMinutes)*60000).toISOString()};
    }
    // Do not overwrite a monitor edited/cancelled while its network request was running.
    await this.store.transitionWithRecords(row.workspaceId,row.kind,row.id,row.version+1,next,records);
  }
}
