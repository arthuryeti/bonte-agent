import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerLead, reconcileRegistration, registrationConfig, type LeadRegistrationInput, type RegistrationConfig } from "../src/workflows/lead-registration.js";
import { MemoryWorkflowStore } from "../src/workflows/store.js";
import type { CrmRequest, CrmResponse } from "../src/client/crm-client.js";

const context={workspaceId:"test-team",actorId:"broker",conversationId:"test-chat"};
const config:RegistrationConfig={validated:true,statusId:8,origins:{instagram:12}};
const fields:LeadRegistrationInput={name:"Synthetic Buyer",email:"buyer@example.test",source:"Instagram",type:"Buyer",propertyReference:"BON-20",agentName:"Test Broker",profile:{Price:{From:1000000,To:3000000},Bedrooms:{From:3,To:5},PropertyType:["Villa"],Cities:["Cascais"],Note:"Pool and elevator are mandatory."}};
const success={Code:"OK"};
class FakeCrm {
  calls:CrmRequest[]=[];
  leads:any[]=[];
  propertyData:any={Success:success,PropertyList:[{id:20,reference:"BON-20"}],Count:1};
  agentData:any={Success:success,Entities:[{EntityID:4,EntityName:"Test Broker",EmailAddress:"broker@example.test"}]};
  insertData:any={Success:success,LeadId:55,Warnings:[]};
  failInsert=false;blockInsert?:Promise<void>;leadData?:any;
  request=async (request:CrmRequest):Promise<CrmResponse>=>{
    this.calls.push(request);
    if(request.endpoint.includes("ListProperties"))return{status:200,data:this.propertyData};
    if(request.endpoint.includes("GetAgents"))return{status:200,data:this.agentData};
    if(request.endpoint==="/api/Leads/List")return{status:200,data:this.leadData??{Success:success,Opportunities:this.leads}};
    if(request.endpoint==="/api/Leads/Insert"){
      if(this.blockInsert)await this.blockInsert;
      if(this.failInsert)throw new Error("Synthetic insertion timeout");
      const body=request.body as any;
      if(this.insertData.LeadId===55)this.leads.push({Id:"55",Title:body.Settings.LeadTitle,Customer:{Name:body.Contact.Name,EmailAddress:body.Contact.Email,PhoneNumber:body.Contact.Phone},Properties:body.Settings.AssignToPropertyId?[{PropertyID:body.Settings.AssignToPropertyId}]:[]});
      return{status:200,data:this.insertData};
    }
    throw new Error("Unexpected test CRM endpoint");
  };
  writes(){return this.calls.filter(call=>call.endpoint==="/api/Leads/Insert");}
}
function fixture(){const store=new MemoryWorkflowStore();const crm=new FakeCrm();return{store,crm,deps:{store,request:crm.request,config}};}

describe("validated lead registration",()=>{
  it("reports malformed or ambiguous source config instead of silently swallowing it",()=>{
    assert.throws(()=>registrationConfig({CRM_LEAD_ORIGIN_IDS:"not-json"}),/CRM_LEAD_ORIGIN_IDS/);
    assert.throws(()=>registrationConfig({CRM_LEAD_ORIGIN_IDS:'{"Instagram":"12"}'}),/positive integer/);
    assert.throws(()=>registrationConfig({CRM_LEAD_ORIGIN_IDS:'{"Instagram":12,"instagram":13}'}),/unique source/);
    assert.throws(()=>registrationConfig({CRM_LEAD_STATUS_ID:"NaN"}),/CRM_LEAD_STATUS_ID/);
    assert.equal(registrationConfig({CRM_LEAD_ORIGIN_IDS:'{" Instagram ":12}'}).origins.instagram,12);
  });
  it("persists explicit criteria and source before a missing configuration gate",async()=>{
    const{store,crm,deps}=fixture();
    const result=await registerLead(context,fields,{...deps,config:{validated:false,origins:{}}});
    assert.equal(result.state,"needs_configuration");assert.equal(crm.calls.length,0);
    const brief=(await store.list<any>(context.workspaceId,"buyer_brief"))[0]!.data;
    assert.equal(brief.origin,"Instagram");assert.deepEqual(brief.brief.mandatory.price,{min:1000000,max:3000000});
    assert.deepEqual(brief.brief.mandatory.businessTypes,["Sale"]);assert.equal(brief.requirementsNeedClarification,true);
    assert.equal(brief.unmappedRequirements.note,"Pool and elevator are mandatory.");
  });
  it("creates one verified lead, preserves matching criteria, and returns warnings and readback",async()=>{
    const{store,crm,deps}=fixture();crm.insertData.Warnings=[{Code:"SyntheticWarning"}];
    const result=await registerLead(context,fields,deps);
    assert.equal(result.state,"succeeded");assert.equal(result.leadId,"55");assert.equal(result.readbackVerified,true);
    assert.equal(result.warnings?.length,1);assert.equal(crm.writes().length,1);
    const body=crm.writes()[0]!.body as any;
    assert.equal(body.Settings.AssignToPropertyId,20);assert.equal(body.Settings.ForceAgent.AgentId,4);
    assert.equal(body.Settings.AssignToCustomerOriginId,12);assert.equal(body.Settings.IncludeMailing,false);
    assert.deepEqual(body.Contact.Profile,fields.profile);assert.equal(body.Contact.Profile.ForceNewProfileToExistingContact,undefined);
    const brief=(await store.get<any>(context.workspaceId,"buyer_brief",result.briefId!))!.data;
    assert.equal(brief.leadId,"55");assert.equal(brief.crmProfilePending,false);assert.deepEqual(brief.brief.mandatory.cities,["Cascais"]);
    assert.equal((await registerLead(context,fields,deps)).state,"succeeded");assert.equal(crm.writes().length,1);
  });
  it("normalizes email/phone on retries without creating another request",async()=>{
    const{crm,deps}=fixture();
    await registerLead(context,{...fields,email:" Buyer@Example.test ",phone:"00351 912 345 678"},deps);
    await registerLead(context,{...fields,email:"buyer@example.test",phone:"+351912345678"},deps);
    assert.equal(crm.writes().length,1);
    await assert.rejects(registerLead(context,{...fields,email:undefined,phone:"-----"},deps),/five digits/);
  });
  it("does not discard requirements when finding an existing opportunity",async()=>{
    const{store,crm,deps}=fixture();crm.leads=[{Id:"existing",Customer:{EmailAddress:fields.email},Properties:[{PropertyID:20}]}];
    const result=await registerLead(context,fields,deps);
    assert.equal(result.state,"existing_opportunity");assert.equal(crm.writes().length,0);
    assert.ok(await store.get(context.workspaceId,"buyer_brief",result.briefId!));
  });
  it("allows an existing contact's new property enquiry while gating unverified profile changes",async()=>{
    const{crm,deps}=fixture();crm.leads=[{Id:"old",Customer:{EmailAddress:fields.email},Properties:[{PropertyID:99}]}];
    const gated=await registerLead(context,fields,deps);assert.equal(gated.state,"needs_configuration");assert.equal(crm.writes().length,0);
    const added=await registerLead(context,{...fields,profile:undefined},deps);assert.equal(added.state,"succeeded");assert.equal(crm.writes().length,1);
  });
  it("keeps both seller/buyer intents and never silently creates two contacts",async()=>{
    const{store,crm,deps}=fixture();const result=await registerLead(context,{...fields,type:"Seller",additionalIntent:"Buyer"},deps);
    assert.equal(result.state,"needs_input");assert.equal(crm.writes().length,0);
    assert.deepEqual((await store.list<any>(context.workspaceId,"buyer_brief"))[0]!.data.intents,["Seller","Buyer"]);
  });
  it("requires property and broker identity evidence and rejects incomplete search coverage",async()=>{
    const{crm,deps}=fixture();crm.propertyData.PropertyList[0].reference="WRONG";
    assert.equal((await registerLead(context,fields,deps)).state,"needs_input");
    crm.propertyData.PropertyList[0].reference="BON-20";crm.propertyData.Count=2;
    assert.equal((await registerLead(context,fields,deps)).state,"needs_configuration");
    crm.propertyData.Count=1;
    assert.equal((await registerLead(context,{...fields,agentEmail:"someone-else@example.test"},deps)).state,"needs_input");
    crm.agentData._pagination={truncated:true};assert.equal((await registerLead(context,fields,deps)).state,"needs_configuration");
    assert.equal(crm.writes().length,0);
  });
  it("does not treat incomplete or rejected lead lookup as an empty directory",async()=>{
    const{crm,deps}=fixture();crm.leadData={Success:success,Opportunities:[],TotalRecords:10};
    assert.equal((await registerLead(context,fields,deps)).state,"needs_configuration");
    crm.leadData={Success:null,Warnings:[{Code:"Denied"}],Opportunities:[]};
    await assert.rejects(registerLead(context,fields,deps),/rejected/);assert.equal(crm.writes().length,0);
  });
  it("retains uncertain insertion and refuses retries, including changed titles that target the same enquiry",async()=>{
    const{store,crm,deps}=fixture();crm.failInsert=true;
    const uncertain=await registerLead(context,fields,deps);assert.equal(uncertain.state,"uncertain");
    crm.failInsert=false;
    assert.equal((await registerLead(context,fields,deps)).state,"uncertain");
    assert.equal((await registerLead(context,{...fields,title:"New wording for the same request"},deps)).state,"needs_review");
    assert.equal(crm.writes().length,1);
    assert.equal((await reconcileRegistration({...context,workspaceId:"other-team"},uncertain.actionId!,{store,request:crm.request})).state,"not_found");
    crm.leads=[{Id:"candidate",Title:"Enquiry: Synthetic Buyer",Customer:{EmailAddress:fields.email},Properties:[{PropertyID:20}]}];
    const reconciled=await reconcileRegistration(context,uncertain.actionId!,deps);
    assert.equal(reconciled.state,"needs_review");assert.deepEqual(reconciled.candidateLeadIds,["candidate"]);assert.equal(crm.writes().length,1);
  });
  it("claims concurrent identical submissions atomically before one insertion",async()=>{
    const{crm,deps}=fixture();let release!:()=>void;crm.blockInsert=new Promise(resolve=>{release=resolve;});
    const first=registerLead(context,fields,deps);
    while(!crm.writes().length)await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await registerLead(context,fields,deps)).state,"pending");release();
    assert.equal((await first).state,"succeeded");assert.equal(crm.writes().length,1);
  });
  it("rejects malformed lead IDs and missing application success even in an HTTP 200",async()=>{
    for(const insertData of [{Success:success,LeadId:-1},{Success:success,LeadId:[55]},{LeadId:55},{Success:null,LeadId:55}]){
      const{crm,deps}=fixture();crm.insertData=insertData;
      assert.equal((await registerLead(context,fields,deps)).state,"uncertain");assert.equal(crm.writes().length,1);
    }
  });
  it("rejects contradictory explicit profile/brief constraints before creating CRM data",async()=>{
    const{crm,deps}=fixture();
    await assert.rejects(registerLead(context,{...fields,buyerBrief:{mandatory:{price:{min:1,max:100}}}},deps),/criteria conflict/);
    assert.equal(crm.writes().length,0);
  });
});
