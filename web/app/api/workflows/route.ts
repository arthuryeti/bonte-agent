import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";
export const runtime="nodejs";
async function proxy(request:Request){
  const session=await getAuthSession(request.headers);
  if(!session)return Response.json({error:"Authentication required."},{status:401});
  if(request.method!=="GET"){
    const origin=request.headers.get("origin");
    if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Invalid request origin."},{status:403});
  }
  const scope=workspaceIdForUser(session.user.id);
  let body:string|undefined;
  if(request.method==="POST"){
    if(Number(request.headers.get("content-length"))>4096)return Response.json({error:"Request too large."},{status:413});
    const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader)while(true){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>4096){await reader.cancel();return Response.json({error:"Request too large."},{status:413});}chunks.push(v.value);}
    body=new TextDecoder().decode(Buffer.concat(chunks));
  }
  const origin=(process.env.GATEWAY_WS_URL||"ws://127.0.0.1:8787/ws").replace(/^ws/i,"http").replace(/\/ws\/?$/,"");
  try {
    const upstream=await fetch(`${origin}/workflows`,{method:request.method,headers:{"content-type":"application/json","x-workspace-id":scope,"x-actor-id":scope,...process.env.GATEWAY_WEB_TOKEN?{authorization:`Bearer ${process.env.GATEWAY_WEB_TOKEN}`}:{ }},body,signal:request.signal});
    return new Response(upstream.body,{status:upstream.status,headers:{"content-type":"application/json","cache-control":"private, no-store"}});
  }catch{return Response.json({error:"Workflows are temporarily unavailable."},{status:503});}
}
export const GET=proxy;
export const POST=proxy;
