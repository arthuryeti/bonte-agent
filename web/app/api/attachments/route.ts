import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";

export const runtime = "nodejs";
export const maxDuration = 300;
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const idPattern = /^[a-f0-9-]{36}$/;
const maxUpload = 15 * 1024 * 1024;

function gatewayOrigin(): string {
  return (process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws").replace(/^ws/i, "http").replace(/\/ws\/?$/, "");
}
async function authorized(request: Request, sessionId = "") {
  const session = await getAuthSession(request.headers);
  if (!session) return null;
  const workspaceId = workspaceIdForUser(session.user.id);
  return { "x-workspace-id": workspaceId, "x-actor-id": workspaceId,
    "x-conversation-id": sessionId ? `${workspaceId}_${sessionId}` : "",
    ...(process.env.GATEWAY_WEB_TOKEN ? { authorization: `Bearer ${process.env.GATEWAY_WEB_TOKEN}` } : {}) };
}
function privateHeaders(upstream: Response) {
  return { "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "content-type": upstream.headers.get("content-type") || "application/json" };
}
function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
async function readLimitedBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Upload is empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new Error("Upload exceeds 15 MB."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const sessionId = url.searchParams.get("sessionId") || "";
  const headers = await authorized(request, sessionId);
  if (!headers) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (id ? !idPattern.test(id) : !sessionPattern.test(sessionId)) return Response.json({ error: "Invalid document request." }, { status: 400 });
  try {
    const upstream = await fetch(`${gatewayOrigin()}/attachments${id ? `?id=${encodeURIComponent(id)}` : ""}`, { headers, signal: request.signal });
    const responseHeaders: Record<string, string> = privateHeaders(upstream);
    const disposition = upstream.headers.get("content-disposition");
    if (disposition) responseHeaders["content-disposition"] = disposition;
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return Response.json({ error: "Documents are temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const headers = await authorized(request);
  if (!headers) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!isSameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (Number(request.headers.get("content-length")) > maxUpload + 1_000_000) return Response.json({ error: "Upload exceeds 15 MB." }, { status: 413 });
  let form: FormData;
  try {
    const bytes = await readLimitedBody(request, maxUpload + 1_000_000);
    form = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") || "" }, body: bytes }).formData();
  } catch { return Response.json({ error: "Upload a file up to 15 MB." }, { status: 400 }); }
  const file = form.get("file");
  const sessionId = String(form.get("sessionId") || "");
  const category = String(form.get("category") || "other");
  if (!(file instanceof File) || !file.size || file.size > maxUpload || !sessionPattern.test(sessionId) || !["party", "transaction", "other"].includes(category)) {
    return Response.json({ error: "Provide a document up to 15 MB and a valid conversation." }, { status: 400 });
  }
  try {
    const upstream = await fetch(`${gatewayOrigin()}/attachments`, { method: "POST", headers: { ...headers,
      "x-conversation-id": `${headers["x-workspace-id"]}_${sessionId}`, "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name), "x-file-mime": file.type, "x-file-category": category },
      body: await file.arrayBuffer(), signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: privateHeaders(upstream) });
  } catch { return Response.json({ error: "The document could not be uploaded. Please try again." }, { status: 503 }); }
}

export async function DELETE(request: Request) {
  const headers = await authorized(request);
  if (!headers) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (!isSameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!idPattern.test(id)) return Response.json({ error: "Invalid attachment." }, { status: 400 });
  try {
    const upstream = await fetch(`${gatewayOrigin()}/attachments?id=${encodeURIComponent(id)}`, { method: "DELETE", headers, signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: privateHeaders(upstream) });
  } catch { return Response.json({ error: "The document could not be deleted." }, { status: 503 }); }
}
