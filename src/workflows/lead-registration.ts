import { createHash } from "node:crypto";
import * as z from "zod";
import { callCrmApi, callCrmApiWithPagination, assertCrmApplicationSuccess, type CrmRequest, type CrmResponse, type CrmPaginatedResponse } from "../client/crm-client.js";
import { buyerBriefSchema, type BuyerBrief, type PropertyCriteria } from "./crm-properties.js";
import type { WorkflowContext } from "./context.js";
import { getWorkflowStore, type WorkflowStore } from "./store.js";

const range = z.object({From:z.number().int().nonnegative(),To:z.number().int().nonnegative()}).refine(r=>r.To>=r.From,"Range maximum must be at least its minimum.");
const profile = z.object({Bedrooms:range.optional(),Bathrooms:range.optional(),Price:range.optional(),HouseArea:range.optional(),LandArea:range.optional(),
  PropertyType:z.array(z.enum(["Apartment","Building","Castle","Chalet","CommercialProperty","Complex","DuplexApartment","Farmhouse","Garage","Hotel","Land","Office","ParkingPlace","Plot","Ruin","StorageRoom","Townhouse","Villa","Warehouse","Farm","Studio","UrbanLand","RestaurantsBarsShops","ComercialShop","SemiDetached","RuralLand","ManorHouse","LandWithProject","RestaurantSnack","CountryHouse","VillaFloor","VilaToBeRenovated","Room","Loft","Business"])).optional(),
  Regions:z.array(z.string()).optional(),Cities:z.array(z.string()).optional(),Localities:z.array(z.string()).optional(),Zone:z.array(z.string()).optional(),Note:z.string().max(8000).optional()}).strict();
export const leadRegistrationSchema = z.object({
  name:z.string().trim().min(1).max(200), email:z.string().trim().email().transform(value=>value.toLowerCase()).optional(),phone:z.string().trim().min(5).max(40).refine(value=>normalizePhone(value).length>=5,"Phone must contain at least five digits.").optional(),
  type:z.enum(["Buyer","Renter","Seller"]), additionalIntent:z.enum(["Buyer","Renter","Seller"]).optional(),
  message:z.string().max(12000).optional(),title:z.string().max(250).optional(),source:z.string().trim().min(1).max(120),
  propertyReference:z.string().trim().min(1).max(120).optional(),agentName:z.string().trim().min(1).max(200).optional(),agentEmail:z.string().trim().email().transform(value=>value.toLowerCase()).optional(),
  countryISO:z.string().regex(/^[A-Z]{2}$/).optional(),language:z.enum(["pt","en","es","fr","it","de","nl","sv","da","no","pl","zh","ru","fi"]).default("en"),
  profile:profile.optional(),buyerBrief:buyerBriefSchema.optional().describe("A complete structured clarification of the user's mandatory and preferred requirements, including any requirements in profile.Note/Regions/Zone/HouseArea. Do not pass an empty or partial brief merely to bypass unresolved free-text criteria."),
}).strict();
export type LeadRegistrationInput=z.input<typeof leadRegistrationSchema>;
type Json=Record<string,any>;
export interface RegistrationConfig {validated:boolean;statusId?:number;origins:Record<string,number>}
export function registrationConfig(env = process.env):RegistrationConfig {
  let origins:Record<string,number>={};
  try {
    const raw=z.record(z.number().int().positive()).parse(JSON.parse(env.CRM_LEAD_ORIGIN_IDS||"{}"));
    for(const[k,v]of Object.entries(raw)){
      const key=k.trim().toLowerCase();
      if(!key||(origins[key]!==undefined&&origins[key]!==v))throw new Error("Ambiguous source name");
      origins[key]=v;
    }
  }catch{throw new Error("CRM_LEAD_ORIGIN_IDS must be a JSON object mapping unique source names to verified positive integer IDs.");}
  const statusId=Number(env.CRM_LEAD_STATUS_ID);
  if(env.CRM_LEAD_STATUS_ID&&(!Number.isInteger(statusId)||statusId<=0))throw new Error("CRM_LEAD_STATUS_ID must be a verified positive integer ID.");
  return {validated:env.CRM_LEAD_INSERT_VALIDATED==="true",statusId:Number.isInteger(statusId)&&statusId>0?statusId:undefined,origins};
}
export function normalizeEmail(value:unknown):string{return typeof value==="string"?value.trim().toLowerCase():"";}
export function normalizePhone(value:unknown):string{return typeof value==="string"?value.replace(/\D/g,"").replace(/^00/,""):"";}
function customerMatch(row:Json,input:{email?:string;phone?:string}):boolean {
  const c=row.Customer||{};const email=normalizeEmail(input.email);const phone=normalizePhone(input.phone);
  return Boolean((email&&normalizeEmail(c.EmailAddress)===email)||(phone&&normalizePhone(c.PhoneNumber)===phone));
}
function ensureResult(response:CrmResponse):Json {
  const d=response.data as Json;
  if(response.status<200||response.status>=300)throw new Error("CRM rejected the HTTP request. No success has been verified.");
  assertCrmApplicationSuccess(d);
  return d;
}
interface RegistrationAction {state:"pending"|"succeeded"|"uncertain";payload:Json;fingerprint:string;leadId?:string;message?:string;createdAt:string;briefId?:string}
interface Dependencies {store?:WorkflowStore;request?:(r:CrmRequest)=>Promise<CrmResponse>;config?:RegistrationConfig}

/** Only documented explicit criteria become mandatory; free-text notes remain available for clarification. */
export function registrationBuyerBrief(fields:z.output<typeof leadRegistrationSchema>):BuyerBrief {
  const mandatory:PropertyCriteria={};const p=fields.profile;
  if(fields.type==="Buyer")mandatory.businessTypes=["Sale"];
  if(fields.type==="Renter")mandatory.businessTypes=["Rent"];
  if(p){
    if(p.PropertyType?.length)mandatory.propertyTypes=p.PropertyType;
    if(p.Cities?.length)mandatory.cities=p.Cities;
    if(p.Localities?.length)mandatory.localities=p.Localities;
    if(p.Bedrooms)mandatory.bedrooms={min:p.Bedrooms.From,max:p.Bedrooms.To};
    if(p.Bathrooms)mandatory.bathrooms={min:p.Bathrooms.From,max:p.Bathrooms.To};
    if(p.Price)mandatory.price={min:p.Price.From,max:p.Price.To};
    // HouseArea does not establish whether the user means living or gross area.
    if(p.LandArea)mandatory.plotArea={min:p.LandArea.From,max:p.LandArea.To};
  }
  // Keep both representations; contradictions need clarification instead of overwriting one.
  if(fields.buyerBrief){
    for(const[key,value]of Object.entries(fields.buyerBrief.mandatory)){
      const derived=mandatory[key as keyof PropertyCriteria];
      if(derived!==undefined&&JSON.stringify(derived)!==JSON.stringify(value))throw new Error(`Buyer criteria conflict between profile and buyerBrief for ${key}. Clarify this before registering.`);
    }
    return buyerBriefSchema.parse({mandatory:{...mandatory,...fields.buyerBrief.mandatory},preferred:fields.buyerBrief.preferred});
  }
  return buyerBriefSchema.parse({mandatory});
}

export async function registerLead(context:WorkflowContext,input:LeadRegistrationInput,deps:Dependencies={}) {
  const fields=leadRegistrationSchema.parse(input);const store=deps.store||getWorkflowStore();const request=deps.request||callCrmApi;
  if(fields.phone)fields.phone=/^(?:\+|00)/.test(fields.phone)?`+${normalizePhone(fields.phone)}`:normalizePhone(fields.phone);
  if(!fields.email&&!fields.phone)return {state:"needs_input",missing:["email or phone for reliable contact matching"]};
  const intakeId=createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  const intake={conversationId:context.conversationId,...fields,origin:fields.source,source:"explicit_user",intents:[...new Set([fields.type,fields.additionalIntent].filter(Boolean))]};
  await store.create(context.workspaceId,"registration_intake",intakeId,intake);
  let briefId:string|undefined;
  if(fields.profile||fields.buyerBrief||fields.additionalIntent){
    const brief=registrationBuyerBrief(fields);briefId=`registration-${intakeId}`;
    await store.create(context.workspaceId,"buyer_brief",briefId,{...intake,brief,crmProfilePending:true,
      requirementsNeedClarification:Boolean(fields.additionalIntent&&fields.additionalIntent!==fields.type)||!fields.buyerBrief&&Boolean(fields.profile?.Note||fields.profile?.Regions?.length||fields.profile?.Zone?.length||fields.profile?.HouseArea),
      unmappedRequirements:{note:fields.profile?.Note,regions:fields.profile?.Regions,zones:fields.profile?.Zone,houseArea:fields.profile?.HouseArea}});
  }
  if(fields.additionalIntent&&fields.additionalIntent!==fields.type) {
    return {state:"needs_input",briefId,message:"Both intents and the buyer requirements are saved in Bonte. Casafari accepts one contact type per insertion; choose the primary type or configure a verified multi-profile workflow before creating the CRM record."};
  }
  let config:RegistrationConfig;
  try{config=deps.config||registrationConfig();}catch(error){return {state:"needs_configuration",briefId,message:error instanceof Error?error.message:"Invalid CRM registration configuration."};}
  const sourceId=config.origins[fields.source.toLowerCase()];
  const missing=[!config.validated&&"CRM_LEAD_INSERT_VALIDATED (a tested tenant insertion contract)",!config.statusId&&"CRM_LEAD_STATUS_ID",!sourceId&&`CRM_LEAD_ORIGIN_IDS mapping for ${fields.source}`].filter(Boolean);
  if(missing.length)return {state:"needs_configuration",missing,briefId,message:"No CRM record was created. CodeTable does not document lead source/status mappings."};
  let propertyId:number|undefined;
  if(fields.propertyReference){
    const propertyRequest:CrmRequest={endpoint:"/api/Property/ListProperties",method:"POST",body:{Reference:fields.propertyReference,MaxResponses:100,SequenceNmbr:1,Lang:fields.language}};
    const propertyResponse=deps.request?await request(propertyRequest):await callCrmApiWithPagination(propertyRequest,{maxPages:10});
    const data=ensureResult(propertyResponse);
    if((propertyResponse as CrmPaginatedResponse).pagination?.truncated||data._pagination?.truncated||Number(data.Count)>(data.PropertyList?.length??0))return {state:"needs_configuration",briefId,message:"Property lookup is incomplete; no assignment or CRM insertion was attempted."};
    const matches=(data.PropertyList||[]).filter((p:Json)=>p.reference===fields.propertyReference);
    if(matches.length!==1)return {state:"needs_input",message:"The property reference did not resolve to exactly one verified property."};
    propertyId=Number(matches[0].propertyId??matches[0].id);
    if(!Number.isInteger(propertyId)||propertyId<=0)return {state:"needs_configuration",message:"CRM returned no usable property identifier."};
  }
  let agentId:number|undefined;
  if(fields.agentName||fields.agentEmail){
    const agentRequest:CrmRequest={endpoint:"/api/Entity/GetAgents",method:"POST",body:{Lang:fields.language,EntitySearchFilters:fields.agentName?{Name:fields.agentName}:{}}};
    const response=deps.request?await request(agentRequest):await callCrmApiWithPagination(agentRequest);
    const data=ensureResult(response);
    if((response as CrmPaginatedResponse).pagination?.truncated||data._pagination?.truncated)return {state:"needs_configuration",message:"Agent search is incomplete; assignment has not been resolved."};
    const agents=(data.Entities||[]).filter((a:Json)=>(!fields.agentEmail||normalizeEmail(a.EmailAddress)===normalizeEmail(fields.agentEmail))&&(!fields.agentName||String(a.EntityName||"").trim().toLowerCase()===fields.agentName.trim().toLowerCase()));
    if(agents.length!==1)return {state:"needs_input",message:"Specify an exact broker name or email; assignment is ambiguous or unavailable."};
    agentId=Number(agents[0].EntityID);
    if(!Number.isInteger(agentId)||agentId<=0)return {state:"needs_configuration",message:"No verified agent ID was returned."};
  }
  const payload:Json={Settings:{LeadTitle:fields.title||`Enquiry: ${fields.name}`,AssignToStatusId:config.statusId,AssignToCustomerOriginId:sourceId,
    ...(propertyId?{AssignToPropertyId:propertyId}:{}),...(agentId?{ForceAgent:{AgentId:agentId}}:{}),IncludeMailing:false,IncludeOptIn:false},
    Contact:{Name:fields.name,Email:fields.email,Phone:fields.phone,Message:fields.message,Type:fields.type,Culture:fields.language,CountryISO:fields.countryISO,Profile:fields.profile}};
  const fingerprint=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  // A repeated identical payload has the same operation even across browser/turn retries.
  const actionId=`lead-${fingerprint}`;
  const existing=await store.get<RegistrationAction>(context.workspaceId,"registration",actionId);
  if(existing?.data.state==="succeeded")return {state:"succeeded",leadId:existing.data.leadId,briefId:existing.data.briefId||briefId,reused:true};
  if(existing)return {state:existing.data.state,message:"This registration may already have reached the CRM. Reconcile it before retrying; no second write was sent.",actionId};
  const leadResponse=await request({endpoint:"/api/Leads/List",method:"POST",body:{Language:fields.language}});
  const leadData=ensureResult(leadResponse);const leads=leadData.Opportunities;
  if(!Array.isArray(leads))return {state:"needs_configuration",message:"Lead lookup returned an unexpected shape; duplicate checks could not be completed."};
  if((leadResponse as CrmPaginatedResponse).pagination?.truncated||leadData._pagination?.truncated||Number(leadData.TotalRecords)>leads.length)return {state:"needs_configuration",briefId,message:"Lead lookup is incomplete; duplicate checks could not be completed. No CRM record was created."};
  const contacts=leads.filter((l:Json)=>customerMatch(l,fields));
  // Same-contact same-property enquiries need disambiguation, not automatic new leads.
  const duplicates=contacts.filter((l:Json)=>propertyId?(l.Properties||[]).some((p:Json)=>String(p.PropertyID)===String(propertyId)):!(l.Properties?.length));
  if(duplicates.length)return {state:"existing_opportunity",leadIds:duplicates.map((l:Json)=>String(l.Id)),briefId,message:"A matching contact already has an opportunity for this property or general enquiry. No duplicate was created; supplied criteria are saved in Bonte.",coverage:"Customer records returned by Leads/List; not the complete CRM contact directory."};
  if(contacts.length&&fields.profile)return {state:"needs_configuration",message:"This contact already exists. The CRM's existing-contact profile behavior must be verified before adding these criteria. Requirements are retained in Bonte.",
    briefId};
  const action:RegistrationAction={state:"pending",payload,fingerprint,createdAt:new Date().toISOString(),briefId};
  // Different prompts/payloads can still describe the same contact/property enquiry.
  // Keep this claim through uncertain outcomes so changing the title/source cannot bypass it.
  const targetId=createHash("sha256").update(JSON.stringify([normalizeEmail(fields.email)||normalizePhone(fields.phone),propertyId??"general"])).digest("hex");
  if(!await store.create(context.workspaceId,"registration_target",targetId,{actionId,createdAt:action.createdAt})){
    const target=await store.get<{actionId:string}>(context.workspaceId,"registration_target",targetId);
    if(target?.data.actionId!==actionId)return {state:"needs_review",actionId:target?.data.actionId,briefId,message:"Another registration already targets this contact/property enquiry. Reconcile it before changing the request; no second write was sent."};
  }
  if(!await store.create(context.workspaceId,"registration",actionId,action))return {state:"pending",actionId,message:"Registration already in progress; no second write was sent."};
  try {
    const response=ensureResult(await request({endpoint:"/api/Leads/Insert",method:"POST",body:payload}));
    if(!response.Success||!(typeof response.LeadId==="number"||typeof response.LeadId==="string"&&/^\d+$/.test(response.LeadId))||!Number.isSafeInteger(Number(response.LeadId))||Number(response.LeadId)<=0)throw new Error("No successful positive LeadId confirmation was returned.");
    const leadId=String(response.LeadId);
    // Commit the confirmed provider outcome before any secondary local work/readback.
    await store.put(context.workspaceId,"registration",actionId,{...action,state:"succeeded",leadId});
    if(briefId){const saved=await store.get<Json>(context.workspaceId,"buyer_brief",briefId);if(saved)await store.compareAndSet(context.workspaceId,"buyer_brief",briefId,saved.version,{...saved.data,leadId,crmProfilePending:false});}
    let readbackVerified=false;
    try{const all=ensureResult(await request({endpoint:"/api/Leads/List",method:"POST",body:{Language:fields.language}}));readbackVerified=(all.Opportunities||[]).some((l:Json)=>String(l.Id)===leadId&&customerMatch(l,fields));}catch{}
    return {state:"succeeded",leadId,readbackVerified,actionId,briefId,warnings:response.Warnings||[]};
  }catch(error){
    const current=await store.get<RegistrationAction>(context.workspaceId,"registration",actionId);
    if(current?.data.state==="succeeded")return {state:"succeeded",leadId:current.data.leadId,warning:"CRM creation succeeded; a local follow-up step needs retry."};
    await store.put(context.workspaceId,"registration",actionId,{...action,state:"uncertain",message:error instanceof Error?error.message:"CRM insertion did not complete"});
    return {state:"uncertain",actionId,message:"Creation was not verified. No automatic retry will be made; reconcile the action to avoid duplicates."};
  }
}

export async function reconcileRegistration(context:WorkflowContext,actionId:string,deps:Dependencies={}) {
  const store=deps.store||getWorkflowStore();const request=deps.request||callCrmApi;
  const action=await store.get<RegistrationAction>(context.workspaceId,"registration",actionId);
  if(!action)return {state:"not_found"};
  if(action.data.state==="succeeded")return {state:"succeeded",leadId:action.data.leadId};
  const d=ensureResult(await request({endpoint:"/api/Leads/List",method:"POST",body:{Language:"en"}}));
  const p=action.data.payload;const matches=(d.Opportunities||[]).filter((l:Json)=>customerMatch(l,{email:p.Contact.Email,phone:p.Contact.Phone})&&l.Title===p.Settings.LeadTitle&&
    (!p.Settings.AssignToPropertyId||(l.Properties||[]).some((v:Json)=>String(v.PropertyID)===String(p.Settings.AssignToPropertyId))));
  // No operation-ID field in the API: matching a record alone cannot prove this write.
  return {state:"needs_review",actionId,candidateLeadIds:matches.map((l:Json)=>String(l.Id)),message:"Review these candidates in the CRM. The API lacks a documented operation ID for conclusive reconciliation; no write was retried."};
}
