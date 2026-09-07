import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { MemoryWorkflowStore } from "../src/workflows/store.js";
import { scheduleFollowUp,finishFollowUp,saveLeadMonitor,WorkflowWorker,type FollowUpTask,type LeadMonitor } from "../src/workflows/tasks.js";
const context={workspaceId:"team",actorId:"broker",conversationId:"conversation"};

describe("durable follow-ups and lead monitors",()=>{
  it("keeps follow-ups through worker restart and creates one due notification",async()=>{
    const store=new MemoryWorkflowStore();const time=new Date(Date.now()+60_000).toISOString();
    await assert.rejects(scheduleFollowUp(context,{id:"no-offset",title:"Call buyer",scheduledFor:"2099-01-01T10:00:00"},store),/timezone offset/);
    const input={id:"follow-one",title:"Contact synthetic buyer",leadId:"20",note:"Confirm requirements",scheduledFor:time};
    await scheduleFollowUp(context,input,store);
    await new WorkflowWorker(store,async()=>({findings:[]})).tick(new Date(Date.parse(time)+1000));
    await new WorkflowWorker(store,async()=>({findings:[]})).tick(new Date(Date.parse(time)+2000));
    assert.equal((await store.get<FollowUpTask>("team","follow_up",input.id))?.data.state,"due");
    assert.equal((await store.list("team","notification")).length,1);
    assert.equal((await scheduleFollowUp(context,input,store)).created,false);
    await assert.rejects(scheduleFollowUp(context,{...input,note:"Conflicting note"},store),/different follow-up/);
  });
  it("replays an already-due action even if its original date is now past",async()=>{
    const store=new MemoryWorkflowStore();const scheduledFor="2025-01-01T00:00:00Z";
    await store.create<FollowUpTask>("team","follow_up","past",{title:"Already due",conversationId:context.conversationId,state:"due",nextRunAt:new Date(scheduledFor).toISOString()});
    const result=await scheduleFollowUp(context,{id:"past",title:"Already due",scheduledFor},store);
    assert.equal(result.created,false);assert.equal(result.state,"due");
    await assert.rejects(scheduleFollowUp(context,{id:"new-past",title:"New task",scheduledFor},store),/future/);
  });
  it("does not emit a due alert if a follow-up was cancelled after the worker snapshot",async()=>{
    class CancelDuringTransition extends MemoryWorkflowStore {
      override async transitionWithRecords<T>(...args:Parameters<MemoryWorkflowStore["transitionWithRecords"]>):Promise<boolean>{
        if(args[1]==="follow_up")await finishFollowUp(context,args[2],"cancelled",this);
        return super.transitionWithRecords(...args);
      }
    }
    const store=new CancelDuringTransition();const scheduledFor=new Date(Date.now()+60_000).toISOString();
    await scheduleFollowUp(context,{id:"cancel-race",title:"Call buyer",scheduledFor},store);
    await new WorkflowWorker(store,async()=>({findings:[]})).tick(new Date(Date.parse(scheduledFor)+1000));
    assert.equal((await store.get<FollowUpTask>("team","follow_up","cancel-race"))?.data.state,"cancelled");assert.equal((await store.list("team","notification")).length,0);
  });
  it("notifies changes and resolutions, stays quiet on unchanged findings, and survives a restart",async()=>{
    const store=new MemoryWorkflowStore();let findings:any[]=[{leadId:"1",reason:"Recorded completed contact is overdue"}];
    await saveLeadMonitor(context,{id:"monitor",intervalMinutes:15,filters:{broker:"Test"}},store);
    const now=new Date(Date.now()+1000);
    await new WorkflowWorker(store,async()=>({findings})).tick(now);
    assert.equal((await store.list("team","notification")).length,1);
    await new WorkflowWorker(store,async()=>({findings})).tick(new Date(now.getTime()+16*60_000));
    assert.equal((await store.list("team","notification")).length,1);
    findings=[];
    await new WorkflowWorker(store,async()=>({findings})).tick(new Date(now.getTime()+32*60_000));
    const notifications=await store.list<any>("team","notification");assert.equal(notifications.length,2);assert.ok(notifications.some(row=>row.data.title==="Lead audit findings cleared"));
  });
  it("preserves the last evidence fingerprint during interval-only edits",async()=>{
    const store=new MemoryWorkflowStore();const filters={broker:"Test"};
    await saveLeadMonitor(context,{id:"monitor",intervalMinutes:15,filters},store);
    await new WorkflowWorker(store,async()=>({findings:[{leadId:"1"}]})).tick(new Date(Date.now()+1000));
    const old=(await store.get<LeadMonitor>("team","lead_monitor","monitor"))!.data.lastFingerprint;
    await saveLeadMonitor(context,{id:"monitor",intervalMinutes:30,filters},store);
    assert.equal((await store.get<LeadMonitor>("team","lead_monitor","monitor"))!.data.lastFingerprint,old);
    await new WorkflowWorker(store,async()=>({findings:[{leadId:"1"}]})).tick(new Date(Date.now()+1000));
    assert.equal((await store.list("team","notification")).length,1);
  });
  it("suppresses results and notifications if a monitor is cancelled during its audit",async()=>{
    const store=new MemoryWorkflowStore();await saveLeadMonitor(context,{id:"monitor",intervalMinutes:15},store);
    const worker=new WorkflowWorker(store,async()=>{
      const row=(await store.get<LeadMonitor>("team","lead_monitor","monitor"))!;
      await store.compareAndSet("team","lead_monitor","monitor",row.version,{...row.data,state:"cancelled"});
      return{findings:[{leadId:"1"}]};
    });
    await worker.tick(new Date(Date.now()+1000));
    assert.equal((await store.list("team","notification")).length,0);assert.equal((await store.list("team","audit_run")).length,0);
    assert.equal((await store.get<LeadMonitor>("team","lead_monitor","monitor"))?.data.state,"cancelled");
  });
  it("emits one notification for repeated failures and keeps the monitor scheduled",async()=>{
    const store=new MemoryWorkflowStore();await saveLeadMonitor(context,{id:"monitor",intervalMinutes:15},store);
    const worker=new WorkflowWorker(store,async()=>{throw new Error("Synthetic CRM unavailable");});
    const now=new Date(Date.now()+1000);await worker.tick(now);await worker.tick(new Date(now.getTime()+16*60_000));
    assert.equal((await store.list("team","notification")).length,1);assert.equal((await store.get<LeadMonitor>("team","lead_monitor","monitor"))?.data.state,"scheduled");
  });
  it("isolates tasks by workspace",async()=>{
    const store=new MemoryWorkflowStore();await scheduleFollowUp(context,{id:"one",title:"Call buyer",scheduledFor:new Date(Date.now()+60_000).toISOString()},store);
    await assert.rejects(finishFollowUp({...context,workspaceId:"other-team"},"one","completed",store),/not found/);
  });
});
