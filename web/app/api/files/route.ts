import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";

export const runtime = "nodejs";

const FILE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(pdf|docx|xlsx|pptx|csv|zip)$/;

function gatewayOrigin(): string {
  const ws = process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws";
  return ws.replace(/^ws/i, "http").replace(/\/ws\/?$/, "");
}

export async function GET(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) {
    return new Response("Authentication required.", { status: 401 });
  }

  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (!FILE_NAME_PATTERN.test(name)) {
    return new Response("Not found", { status: 404 });
  }

  const upstream = await fetch(
    `${gatewayOrigin()}/files?name=${encodeURIComponent(name)}`,
    {
      headers: { "x-workspace-id": workspaceIdForUser(session.user.id),
        ...(process.env.GATEWAY_WEB_TOKEN ? { authorization: `Bearer ${process.env.GATEWAY_WEB_TOKEN}` } : {}) },
    },
  );
  if (!upstream.ok || !upstream.body) {
    return new Response("Not found", { status: upstream.status === 401 ? 401 : 404 });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
