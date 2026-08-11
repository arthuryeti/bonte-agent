import { randomUUID } from "node:crypto";
import { GatewayRpcClient } from "../chat/gateway-client";

export const runtime = "nodejs";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RecentChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function createGatewayClient(): GatewayRpcClient {
  return new GatewayRpcClient(
    process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787/ws",
    process.env.GATEWAY_WEB_TOKEN,
  );
}

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return Response.json({ error: "A valid workspace is required." }, { status: 400 });
  }
  const sessionPrefix = `${workspaceId}_`;
  const gateway = createGatewayClient();
  try {
    await gateway.connect(request.signal);
    const result = await gateway.request<{ sessions: RecentChat[] }>(
      "session.list",
      { limit: 50, session_prefix: sessionPrefix },
      request.signal,
    );
    return Response.json({
      chats: result.sessions.map((session) => ({
        ...session,
        id: session.id.slice(sessionPrefix.length),
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[Web] could not load recent chats:", error);
    return Response.json(
      { error: "Recent chats are temporarily unavailable." },
      { status: 503 },
    );
  } finally {
    gateway.close();
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    sessionId?: unknown;
    workspaceId?: unknown;
  };
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return Response.json({ error: "A valid workspace is required." }, { status: 400 });
  }
  const requestedId = typeof body.sessionId === "string" ? body.sessionId : "";
  const sessionId = requestedId || randomUUID();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json({ error: "A valid session is required." }, { status: 400 });
  }

  const gateway = createGatewayClient();
  try {
    await gateway.connect(request.signal);
    const result = await gateway.request<{ session: RecentChat }>(
      "session.create",
      { session_id: `${workspaceId}_${sessionId}` },
      request.signal,
    );
    return Response.json({
      chat: { ...result.session, id: sessionId },
    }, { status: 201 });
  } catch (error) {
    console.error("[Web] could not create a chat:", error);
    return Response.json(
      { error: "A new chat could not be created." },
      { status: 503 },
    );
  } finally {
    gateway.close();
  }
}
