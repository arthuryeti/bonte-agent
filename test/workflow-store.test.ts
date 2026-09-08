import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { MemoryWorkflowStore, PostgresWorkflowStore } from "../src/workflows/store.js";
import { SessionStore } from "../src/gateway/session.js";
import { workflowTools } from "../src/tools/workflow-tools.js";
import { setWorkflowStore } from "../src/workflows/store.js";
import { runWithWorkflowContext, getWorkflowContext } from "../src/workflows/context.js";

function adapter(db:PGlite):Pool {
  const query=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.affectedRows};};
  return {query,connect:async()=>({query,release(){}}),end:()=>db.close()} as unknown as Pool;
}
describe("durable workflow store",()=>{
  it("migrates actual PostgreSQL tables, persists scopes across reopening, and atomically publishes state/results",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"bonte-workflow-db-"));
    let db=await PGlite.create(dir);let store=new PostgresWorkflowStore(adapter(db));
    try{
      // Run the committed schema migration, not an imitation of it.
      await db.exec(await readFile(new URL("../web/drizzle/0002_wakeful_logan.sql",import.meta.url),"utf8"));
      await store.connect();
      assert.equal(await store.create("a","follow_up","one",{state:"scheduled",nextRunAt:"2026-01-01T00:00:00.000Z"}),true);
      assert.equal(await store.create("a","follow_up","one",{state:"overwrite"}),false);
      assert.equal(await store.get("b","follow_up","one"),null);
      assert.equal(await store.compareAndSet("a","follow_up","one",99,{state:"due"}),false);
      assert.equal(await store.transitionWithRecords("a","follow_up","one",1,{state:"due"},[{kind:"notification",id:"one",data:{title:"Due"}}]),true);
      assert.equal(await store.transitionWithRecords("a","follow_up","one",1,{state:"cancelled"},[{kind:"notification",id:"wrong",data:{title:"Wrong"}}]),false);
      assert.equal(await store.get("a","notification","wrong"),null);
      await store.put("a","attachment","expired",{expiresAt:"2026-01-01T00:00:00.000Z"});
      assert.equal((await store.expired("attachment","2026-02-01T00:00:00.000Z")).length,1);
      await store.close();db=await PGlite.create(dir);store=new PostgresWorkflowStore(adapter(db));
      assert.equal((await store.get("a","follow_up","one"))?.data.state,"due");
      assert.equal((await store.get("a","notification","one"))?.data.title,"Due");
      assert.equal((await store.list("b","notification")).length,0);
    }finally{await store.close();await rm(dir,{recursive:true,force:true});}
  });
  it("does not create notifications when atomic SQL transitions roll back",async()=>{
    const db=await PGlite.create();const store=new PostgresWorkflowStore(adapter(db));
    try{
      await db.exec(await readFile(new URL("../web/drizzle/0002_wakeful_logan.sql",import.meta.url),"utf8"));
      await store.create("a","follow_up","one",{state:"scheduled"});
      // A null JSON payload violates NOT NULL; the earlier update must roll back too.
      await assert.rejects(store.transitionWithRecords("a","follow_up","one",1,{state:"due"},[{kind:"notification",id:"bad",data:undefined}]));
      assert.equal((await store.get("a","follow_up","one"))?.data.state,"scheduled");
      assert.equal(await store.get("a","notification","bad"),null);
    }finally{await store.close();}
  });
  it("keeps concurrent async identities separate and fails closed without a context",async()=>{
    assert.throws(()=>getWorkflowContext(),/authenticated/);
    const results=await Promise.all(["alpha","beta"].map(workspaceId=>runWithWorkflowContext({workspaceId,conversationId:`${workspaceId}_chat`,actorId:workspaceId},async()=>{await new Promise(r=>setTimeout(r,10));return getWorkflowContext().workspaceId;})));
    assert.deepEqual(results,["alpha","beta"]);
    const store=new MemoryWorkflowStore();
    assert.deepEqual(await Promise.all([1,2,3].map(()=>store.create("a","operation","id",{}))),[true,false,false]);
  });
  it("blocks buyer matching until retained free-text requirements are clarified",async()=>{
    const store=new MemoryWorkflowStore();setWorkflowStore(store);
    await store.put("a","buyer_brief","intake",{brief:{mandatory:{}},requirementsNeedClarification:true});
    const tool=workflowTools.find(t=>t.name==="match_saved_buyer")!;
    const response=await runWithWorkflowContext({workspaceId:"a",conversationId:"a_chat",actorId:"a"},()=>tool.invoke({briefId:"intake"}));
    assert.match(String(response),/unresolved requirements/);
  });

  it("lists oldest exact brochure proofs with workspace_ chat boundaries",async()=>{
    const db=await PGlite.create();
    try{
      await db.exec(await readFile(new URL("../web/drizzle/0001_gateway_persistence.sql",import.meta.url),"utf8"));
      const name="property-TEST123-deadbeef.pdf";
      const part=JSON.stringify([{type:"attachment",id:name,data:{fileName:name,mimeType:"application/pdf"}}]);
      await db.query("INSERT INTO gateway_sessions(platform,chat_id) VALUES('web','owner_chat'),('web','owner_later'),('web','owner2_x'),('web','own_chat')");
      await db.query("INSERT INTO gateway_messages(platform,chat_id,role,content,data_parts,created_at) VALUES('web','owner_later','assistant','Newer',$1::jsonb,NOW() - INTERVAL '2 days')",[part]);
      await db.query("INSERT INTO gateway_messages(platform,chat_id,role,content,data_parts,created_at) VALUES('web','owner_chat','assistant','Older',$1::jsonb,NOW() - INTERVAL '10 days')",[part]);
      await db.query("INSERT INTO gateway_messages(platform,chat_id,role,content,data_parts,created_at) VALUES('web','owner_chat','assistant','Expired',$1::jsonb,NOW() - INTERVAL '40 days')",[part]);
      await db.query("INSERT INTO gateway_messages(platform,chat_id,role,content,data_parts) VALUES('web','owner2_x','assistant','Other',$1::jsonb)",[part]);
      await db.query("INSERT INTO gateway_messages(platform,chat_id,role,content,data_parts) VALUES('web','own_chat','assistant','Prefix',$1::jsonb)",[part]);
      const sessions=new SessionStore({databaseUrl:"",databaseHost:"",allowInMemory:true});
      Object.assign(sessions,{pool:adapter(db)});
      const proofs=await sessions.listLegacyBrochureProofs();
      const owned=proofs.filter(p=>p.workspaceId==="owner"&&p.fileName===name);
      assert.equal(owned.length,1);
      assert.equal(owned[0].chatId,"owner_chat");
      assert.ok(Math.abs(owned[0].timestamp.getTime() - Date.now() + 10 * 86_400_000) < 86_400_000);
      assert.equal(proofs.some(p=>p.workspaceId==="own"&&p.fileName===name),true);
      assert.equal(proofs.some(p=>p.workspaceId==="owner2"&&p.fileName===name),true);
      assert.equal(proofs.some(p=>p.workspaceId==="owner"&&p.chatId==="own_chat"),false);
    }finally{await db.close();}
  });
  it("scan resumes after the cursor when earlier rows are deleted",async()=>{
    const db=await PGlite.create();
    const store=new PostgresWorkflowStore(adapter(db));
    try{
      await db.exec(await readFile(new URL("../web/drizzle/0002_wakeful_logan.sql",import.meta.url),"utf8"));
      for(let i=0;i<501;i++)await store.put("a","attachment",String(i).padStart(3,"0"),{n:i});
      const first=await store.scan("attachment",500);
      assert.equal(first.length,500);
      for(const row of first)await store.remove(row.workspaceId,"attachment",row.id);
      const rest=await store.scan("attachment",500,{workspaceId:first[499].workspaceId,id:first[499].id});
      assert.equal(rest.length,1);
      assert.equal(rest[0].id,"500");
    }finally{await store.close();}
  });

});
