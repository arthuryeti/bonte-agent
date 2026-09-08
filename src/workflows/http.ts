import type { IncomingMessage, ServerResponse } from "node:http";
import { CrmApiError } from "../client/crm-client.js";
import { normalizeLeadView, normalizePropertyView, type LeadPropertyView } from "../gateway/crm-ui.js";
import { fetchAllLeads } from "./crm-leads.js";
import { string } from "./crm-common.js";
import { propertyTitle, resolveExactProperty } from "./crm-properties.js";
import { attachmentSummary, deleteAttachment, listAttachments, MAX_ATTACHMENT_BYTES, readAttachment, uploadAttachment, DocumentWorkflowError } from "./documents-attachments.js";
import type { WorkflowContext } from "./context.js";
import { getWorkflowStore } from "./store.js";
import { finishFollowUp } from "./tasks.js";

export function trustedHttpContext(request:IncomingMessage,requireConversation=false):WorkflowContext {
  const workspaceId=String(request.headers["x-workspace-id"]||"");
  const actorId=String(request.headers["x-actor-id"]||workspaceId);
  const conversationId=String(request.headers["x-conversation-id"]||"");
  const suffix = conversationId.startsWith(`${workspaceId}_`) ? conversationId.slice(workspaceId.length + 1) : "";
  if(!/^[a-zA-Z0-9-]{1,128}$/.test(workspaceId)||actorId!==workspaceId||
    (conversationId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(suffix))||(requireConversation&&!conversationId))throw new DocumentWorkflowError("Invalid authenticated workflow scope.");
  return {workspaceId,actorId,conversationId:conversationId||`${workspaceId}_downloads`};
}
async function bytes(request:IncomingMessage,limit:number):Promise<Buffer>{
  if(Number(request.headers["content-length"])>limit)throw new DocumentWorkflowError("Request exceeds the upload limit.",413);
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){const part=Buffer.from(chunk);size+=part.length;if(size>limit)throw new DocumentWorkflowError("Request exceeds the upload limit.",413);chunks.push(part);}return Buffer.concat(chunks);
}
function json(response:ServerResponse,status:number,body:unknown){response.writeHead(status,{"content-type":"application/json","cache-control":"private, no-store","x-content-type-options":"nosniff"});response.end(JSON.stringify(body));}

async function enrichRelatedPropertyNames(properties: LeadPropertyView[], warnings: string[]) {
  const pending: Array<{ key: string; propertyId?: number; reference?: string }> = [];
  const seen = new Set<string>();
  for (const item of properties) {
    if (item.title) continue;
    const propertyId = item.id && /^[1-9]\d*$/.test(item.id) && Number.isSafeInteger(Number(item.id)) ? Number(item.id) : undefined;
    if (propertyId === undefined && !item.reference) continue;
    const key = `${item.id ?? ""}\0${item.reference ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({ key, propertyId, reference: item.reference });
  }
  const titles = new Map<string, string>();
  let next = 0;
  // ponytail: 4 concurrent exact lookups; raise if a lead's related-property fan-out stalls
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) {
      const item = pending[next++];
      try {
        const verified = await resolveExactProperty({ propertyId: item.propertyId, reference: item.reference });
        const title = propertyTitle(verified.property);
        if (title) titles.set(item.key, title);
      } catch {
        warnings.push(`Could not resolve a name for related property ${item.reference ?? item.propertyId}.`);
      }
    }
  }));
  return properties.map((item) => {
    const title = titles.get(`${item.id ?? ""}\0${item.reference ?? ""}`);
    return title ? { ...item, title } : item;
  });
}

async function serveCrm(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== "GET") throw new DocumentWorkflowError("Unsupported workflow request.", 405);
  const type = url.searchParams.get("type");
  const fetchedAt = new Date().toISOString();
  try {
    if (type === "lead") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new DocumentWorkflowError("Provide a valid lead id.", 400);
      // Documented /api/Leads/List has no ID query or single-record endpoint.
      const dataset = await fetchAllLeads();
      const raw = dataset.leads.find((lead) => string(lead.Id) === id);
      const lead = raw ? normalizeLeadView(raw, 0, false) : undefined;
      if (!lead) throw new DocumentWorkflowError("Lead not found.", 404);
      const warnings = [...dataset.coverage.warnings];
      lead.properties = await enrichRelatedPropertyNames(lead.properties, warnings);
      json(response, 200, { lead, fetchedAt, ...(warnings.length ? { warnings } : {}) });
      return;
    }
    if (type === "property") {
      const rawId = url.searchParams.get("id");
      const rawRef = url.searchParams.get("reference");
      const reference = rawRef ? rawRef : undefined;
      if (reference !== undefined && (reference.length > 128 || /[\x00-\x1f\x7f]/.test(reference))) throw new DocumentWorkflowError("Provide a valid property reference.", 400);
      let propertyId: number | undefined;
      if (rawId) {
        if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) throw new DocumentWorkflowError("Property id must be a genuine numeric CRM propertyId.", 400);
        propertyId = Number(rawId);
      }
      if (propertyId === undefined && !reference) throw new DocumentWorkflowError("Provide a numeric property id or exact reference.", 400);
      const verified = await resolveExactProperty({ propertyId, reference });
      const title = propertyTitle(verified.property);
      const property = normalizePropertyView({ ...verified.property, listingUrl: verified.listingUrl, ...(title ? { title } : {}) }, 0, false);
      if (!property) throw new DocumentWorkflowError("Property not found.", 404);
      const warnings = property.listingUrl ? [] : ["Website listing unavailable."];
      json(response, 200, { property, fetchedAt, ...(warnings.length ? { warnings } : {}) });
      return;
    }
    throw new DocumentWorkflowError("type must be lead or property.", 400);
  } catch (error) {
    if (error instanceof DocumentWorkflowError) throw error;
    if (error instanceof CrmApiError) throw new DocumentWorkflowError(error.message, error.status && error.status >= 400 && error.status < 500 ? error.status : 503);
    const message = error instanceof Error ? error.message : "CRM request failed.";
    if (/no exact property found/i.test(message)) throw new DocumentWorkflowError(message, 404);
    if (/provide a property|positive integer|genuine numeric/i.test(message)) throw new DocumentWorkflowError(message, 400);
    throw new DocumentWorkflowError(message, 503);
  }
}

/** Called only after the gateway bearer check; workspace headers are set by Next auth. */
export async function serveWorkflowHttp(request:IncomingMessage,response:ServerResponse,url:URL):Promise<void>{
  try {
    const context=trustedHttpContext(request,request.method==="POST"&&url.pathname==="/attachments");
    if(url.pathname==="/attachments"){
      const id=url.searchParams.get("id");
      if(request.method==="POST"){
        let fileName:string;
        try{fileName=decodeURIComponent(String(request.headers["x-file-name"]||""));}catch{throw new DocumentWorkflowError("Invalid encoded file name.");}
        const attachment=await uploadAttachment(context,{fileName,mimeType:String(request.headers["x-file-mime"]||""),category:String(request.headers["x-file-category"]||"other"),bytes:await bytes(request,MAX_ATTACHMENT_BYTES)});
        json(response,201,{attachment:attachmentSummary(attachment)});return;
      }
      if(request.method==="GET"&&id){
        const {attachment,bytes:body}=await readAttachment(context,id);
        const fileName=attachment.fileName.replace(/[\r\n"\\]/g,"_");
        response.writeHead(200,{"content-type":attachment.mimeType,"content-disposition":`attachment; filename="${fileName.replace(/[^\x20-\x7E]/g,"_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,"content-length":body.length,"cache-control":"private, no-store","x-content-type-options":"nosniff"});response.end(body);return;
      }
      if(request.method==="GET"){json(response,200,{attachments:(await listAttachments(context)).map(attachmentSummary)});return;}
      if(request.method==="DELETE"&&id){json(response,200,await deleteAttachment(context,id));return;}
    }
    if(url.pathname==="/workflows"){
      const store=getWorkflowStore();
      if(request.method==="GET"){
        const [notifications,followUps,monitors]=await Promise.all([store.list(context.workspaceId,"notification",50),store.list(context.workspaceId,"follow_up",100),store.list(context.workspaceId,"lead_monitor",30)]);
        json(response,200,{workspaceId:context.workspaceId,notifications,followUps,monitors});return;
      }
      if(request.method==="POST"){
        let body:Record<string,unknown>;
        try{body=JSON.parse((await bytes(request,4096)).toString());}catch(error){if(error instanceof DocumentWorkflowError)throw error;throw new DocumentWorkflowError("Provide valid workflow JSON.");}
        if(!body||typeof body!=="object"||typeof body.id!=="string"||body.id.length>256)throw new DocumentWorkflowError("A saved workflow ID is required.");
        if(body.action==="read"){
          const row=await store.get(context.workspaceId,"notification",body.id);if(!row){json(response,404,{error:"Notification not found."});return;}
          await store.compareAndSet(context.workspaceId,"notification",body.id,row.version,{...row.data,read:true});json(response,200,{read:true});return;
        }
        if(body.action==="complete"||body.action==="cancel"){json(response,200,await finishFollowUp(context,body.id,body.action==="complete"?"completed":"cancelled"));return;}
      }
    }
    if(url.pathname==="/crm"){await serveCrm(request,response,url);return;}
    json(response,405,{error:"Unsupported workflow request."});
  }catch(error){json(response,error instanceof DocumentWorkflowError?error.status:503,{error:error instanceof DocumentWorkflowError?error.message:"Workflow request failed. Please try again."});}
}
