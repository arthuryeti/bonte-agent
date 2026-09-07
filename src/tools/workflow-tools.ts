import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { getWorkflowContext } from "../workflows/context.js";
import { getWorkflowStore } from "../workflows/store.js";
import { leadRegistrationSchema, registerLead, reconcileRegistration, registrationConfig } from "../workflows/lead-registration.js";
import { finishFollowUp, saveLeadMonitor, scheduleFollowUp, type FollowUpTask, type LeadMonitor } from "../workflows/tasks.js";
import { buyerBriefSchema, matchProperties, searchProperties, type BuyerBrief } from "../workflows/crm-properties.js";

const id=z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/);
const result=async(work:()=>Promise<unknown>)=>{try{return JSON.stringify(await work());}catch(error){return JSON.stringify({state:"error",message:error instanceof Error?error.message:String(error)});}};
const registration=tool(async fields=>result(()=>registerLead(getWorkflowContext(),fields)),{
  name:"register_crm_lead",description:"Register an explicitly requested lead using a validated tenant contract, full available-history contact matching, exact property/agent resolution and durable duplicate protection. Source is a name mapped in server configuration; never invent numeric source/status IDs. Retains buying criteria. Does not subscribe anyone to marketing. Existing-contact/multi-intent profile limitations are explicit.",schema:leadRegistrationSchema});
const reconcile=tool(async({actionId})=>result(()=>reconcileRegistration(getWorkflowContext(),actionId)),{
  name:"reconcile_crm_registration",description:"Read-only reconciliation of an uncertain registration. Does not resend a write or claim a candidate match proves creation.",schema:z.object({actionId:id})});
const followUps=tool(async input=>result(async()=>{
  const context=getWorkflowContext();const store=getWorkflowStore();
  if(input.action==="list")return {tasks:await store.list<FollowUpTask>(context.workspaceId,"follow_up",100),location:"Bonte"};
  if(input.action==="complete"||input.action==="cancel")return finishFollowUp(context,input.id!,input.action==="complete"?"completed":"cancelled");
  return scheduleFollowUp(context,{id:input.id!,title:input.title!,leadId:input.leadId,note:input.note,scheduledFor:input.scheduledFor!});
}),{name:"manage_follow_up",description:"Save/list/complete/cancel durable follow-up tasks inside Bonte. Creating a task requires the user's requested due time and an explicit timezone offset. Completion only records the user's report, not proof of a CRM update. Due tasks appear in Bonte notifications; this tool never emails brokers or creates a Google event.",schema:z.object({action:z.enum(["create","list","complete","cancel"]),id:id.optional(),title:z.string().min(1).max(500).optional(),leadId:z.string().max(120).optional(),note:z.string().max(8000).optional(),scheduledFor:z.string().datetime({offset:true}).optional()}).superRefine((v,ctx)=>{if(v.action!=="list"&&!v.id)ctx.addIssue({code:"custom",message:"id is required"});if(v.action==="create"&&(!v.title||!v.scheduledFor))ctx.addIssue({code:"custom",message:"title and scheduledFor are required"});})});
const monitors=tool(async input=>result(async()=>{
  const context=getWorkflowContext();const store=getWorkflowStore();
  if(input.action==="list")return {monitors:await store.list(context.workspaceId,"lead_monitor",100)};
  if(input.action==="cancel"){
    const record=await store.get<LeadMonitor>(context.workspaceId,"lead_monitor",input.id!);if(!record)throw new Error("Monitor not found.");
    if(!await store.compareAndSet(context.workspaceId,"lead_monitor",input.id!,record.version,{...record.data,state:"cancelled"}))throw new Error("Monitor changed; retry.");
    return {id:input.id,state:"cancelled"};
  }
  return saveLeadMonitor(context,{id:input.id!,intervalMinutes:input.intervalMinutes!,filters:input.filters});
}),{name:"manage_lead_monitor",description:"Enable/list/cancel recurring full-data lead audits. Store configurable cadence and broker/source scope; new actionable findings or failures appear in Bonte notifications. Does not send messages to others. Use when the user explicitly requests recurring monitoring.",schema:z.object({action:z.enum(["create","list","cancel"]),id:id.optional(),intervalMinutes:z.number().int().min(15).max(43200).optional(),filters:z.object({agentName:z.string().optional(),origin:z.string().optional(),category:z.enum(["Sales","Listings"]).optional(),firstResponseHours:z.number().positive().max(8760).optional(),inactivityHours:z.number().positive().max(8760).optional()}).optional()}).superRefine((v,c)=>{if(v.action!=="list"&&!v.id)c.addIssue({code:"custom",message:"id required"});if(v.action==="create"&&!v.intervalMinutes)c.addIssue({code:"custom",message:"intervalMinutes required"});})});
export interface SavedBuyerBrief {name:string;leadId?:string;email?:string;brief:BuyerBrief;source:"explicit_user";conversationId:string;requirementsNeedClarification?:boolean}
const saveBrief=tool(async input=>result(async()=>{
  const context=getWorkflowContext();return getWorkflowStore().put<SavedBuyerBrief>(context.workspaceId,"buyer_brief",input.id,{name:input.name,leadId:input.leadId,email:input.email,brief:input.brief,source:"explicit_user",conversationId:context.conversationId});
}),{name:"save_buyer_brief",description:"Save explicitly supplied buyer criteria for future matching. Separate mandatory constraints from preferences. Never silently turn inferred preferences from an enquiry into explicit buyer requirements. This saves in Bonte, not an existing CRM profile.",schema:z.object({id,name:z.string().min(1).max(200),leadId:z.string().optional(),email:z.string().email().optional(),brief:buyerBriefSchema})});
const getBriefs=tool(async()=>result(async()=>{const c=getWorkflowContext();return {briefs:await getWorkflowStore().list(c.workspaceId,"buyer_brief",100),coverage:"Up to 100 most recently updated Bonte briefs; not an exhaustive CRM buyer directory."};}),{name:"get_buyer_briefs",description:"Read saved explicit buyer requirements and any registration intake awaiting CRM mapping.",schema:z.object({})});
const matchBrief=tool(async({briefId})=>result(async()=>{
  const c=getWorkflowContext();const row=await getWorkflowStore().get<SavedBuyerBrief>(c.workspaceId,"buyer_brief",briefId);if(!row?.data.brief)throw new Error("Save a structured buyer brief with mandatory/preferred criteria first.");
  if(row.data.requirementsNeedClarification)throw new Error("This intake contains unresolved requirements. Review the saved profile/notes and save a complete structured buyer brief before matching.");
  const search=await searchProperties({criteria:row.data.brief.mandatory,complete:true,pageSize:100});
  const matches=matchProperties(search.properties,row.data.brief);
  return {briefId,coverage:search.coverage,matches:matches.matches.slice(0,20),unverified:matches.unverified.slice(0,10),totalMatches:matches.matches.length};
}),{name:"match_saved_buyer",description:"Match a saved explicit buyer brief over all available relevant property pages, respecting hard criteria and exposing unknowns and coverage. Do not use this to infer unstated budgets or requirements.",schema:z.object({briefId:id})});
const status=tool(async()=>result(async()=>{
  const c=getWorkflowContext();const config=registrationConfig();
  return {workspaceId:c.workspaceId,actorId:c.actorId,requestId:c.requestId,capabilities:{crmRead:"connected when CRM credentials permit",leadContactEvidence:"depends on event history returned; statuses alone are not contact evidence",registration:{ready:config.validated&&Boolean(config.statusId)&&Object.keys(config.origins).length>0,configuredSources:Object.keys(config.origins),missing:[!config.validated&&"validated insertion contract",!config.statusId&&"status mapping",!Object.keys(config.origins).length&&"source mappings"].filter(Boolean)},documents:{ndaConfigured:Boolean(process.env.BONTE_NDA_CONFIG_PATH),required:"Bonte template configuration plus party and transaction documents"},calendar:{configured:Boolean(process.env.GOOGLE_CALENDAR_ALLOWED_IDS&&(process.env.GOOGLE_CALENDAR_REFRESH_TOKEN||process.env.GOOGLE_CALENDAR_ACCESS_TOKEN)),next:"Use calendar_workflow_status for account authorization and availability."},externalMarketSearch:{available:false,missing:"A separate Casafari market inventory API/feed"},generalContactDirectory:{available:false,coverage:"Lead customers and property-owner link IDs only"}},notifications:await getWorkflowStore().list(c.workspaceId,"notification",30)};
}),{name:"get_workflow_status",description:"Show this authenticated workspace's capabilities, missing configuration, identity for admin setup, and saved notifications. Never claim unconfigured features work.",schema:z.object({})});
export const workflowTools=[registration,reconcile,followUps,monitors,saveBrief,getBriefs,matchBrief,status];
