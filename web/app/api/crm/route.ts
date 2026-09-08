import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";

export const runtime = "nodejs";
export const maxDuration = 300;
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await getAuthSession(request.headers);
    if (!session) return Response.json({ error: "Authentication required." }, { status: 401, headers: privateHeaders });
    const params = new URL(request.url).searchParams;
    const type = params.get("type");
    const id = params.get("id") || "";
    const reference = params.get("reference") || "";
    if ((type !== "lead" && type !== "property")
      || (type === "lead" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
      || (type === "property" && ((!id && !reference) || (id && (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) || reference.length > 128 || /[\x00-\x1f\x7f]/.test(reference)))) {
      return Response.json({ error: "A valid CRM record identifier is required." }, { status: 400, headers: privateHeaders });
    }
    const query = new URLSearchParams({ type });
    if (id) query.set("id", id);
    if (type === "property" && reference) query.set("reference", reference);
    const workspaceId = workspaceIdForUser(session.user.id);
    const origin = (process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws").replace(/^ws/i, "http").replace(/\/ws\/?$/, "");
    const upstream = await fetch(`${origin}/crm?${query}`, {
      cache: "no-store",
      signal: request.signal,
      headers: {
        "x-workspace-id": workspaceId,
        "x-actor-id": workspaceId,
        ...(process.env.GATEWAY_WEB_TOKEN ? { authorization: `Bearer ${process.env.GATEWAY_WEB_TOKEN}` } : {}),
      },
    });
    return new Response(upstream.body, { status: upstream.status, headers: {
      ...privateHeaders, "content-type": "application/json",
    } });
  } catch {
    return Response.json({ error: "CRM details are temporarily unavailable. Please try again." }, {
      status: request.signal.aborted ? 499 : 503, headers: privateHeaders,
    });
  }
}
