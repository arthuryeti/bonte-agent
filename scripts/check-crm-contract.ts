/** Read-only tenant diagnostics. Outputs shapes and aggregate counts, never contact records. */
import 'dotenv/config';
import { callCrmApi } from '../src/client/crm-client.js';
const requests = [
  {name:'leads',endpoint:'/api/Leads/List',method:'POST' as const,body:{Language:'en'}},
  {name:'properties',endpoint:'/api/Property/ListProperties',method:'POST' as const,body:{MaxResponses:2,SequenceNmbr:1,Lang:'en',PropertyIncludes:{IncludeFeatures:true,IncludeBrokers:true}}},
  {name:'agents',endpoint:'/api/Entity/GetAgents',method:'POST' as const,body:{Lang:'en',PagingRq:{Current:1,ResultsPerPage:1}}},
  {name:'code_tables',endpoint:'/api/CodeTable',method:'GET' as const,queryParams:{'rq.includeBusinessTypes':true,'rq.includePropertyTypes':true,'rq.includeZones':false}},
];
for (const request of requests) {
 try {
  const {data,status}=await callCrmApi(request);const d=data as Record<string,any>;
  const out:Record<string,unknown>={name:request.name,status,keys:Object.keys(d)};
  if(request.name==='leads'){
   const leads=Array.isArray(d.Opportunities)?d.Opportunities:[];
   const counts=(values:unknown[])=>values.reduce<Record<string,number>>((a,v)=>{const k=String(v||'(missing)');a[k]=(a[k]||0)+1;return a;},{});
   out.count=leads.length;out.statuses=counts(leads.map((l:any)=>l.CurrentStatus));out.outcomes=counts(leads.map((l:any)=>l.Outcome));out.origins=counts(leads.map((l:any)=>l.Origin));
   out.outcomeDates=leads.filter((l:any)=>l.OutcomeDate).length;out.salePrices=leads.filter((l:any)=>l.SalePrice).length;
   out.eventTypes=counts(leads.flatMap((l:any)=>(l.Events||[]).map((e:any)=>`${e.EventTypeID}:${e.EventType}`)));
   out.leadKeys=Object.keys(leads[0]||{});out.eventKeys=Object.keys(leads.find((l:any)=>l.Events?.length)?.Events[0]||{});
  }
  if(request.name==='properties'){out.count=d.Count;out.propertyKeys=Object.keys(d.PropertyList?.[0]||{});out.types=d.PropertyList?.map((p:any)=>({type:p.type,status:p.status,features:p.features_list_enum}));}
  if(request.name==='agents')out.entityKeys=Object.keys(d.Entities?.[0]||{});
  console.log(JSON.stringify(out));
 } catch(error) {console.log(JSON.stringify({name:request.name,error:error instanceof Error?error.message:String(error)}));}
}
