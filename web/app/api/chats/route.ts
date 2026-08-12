import { randomUUID } from "node:crypto";
import { getAuthSession, workspaceIdForUser } from "../../../lib/auth-session";
import { GatewayRpcClient } from "../chat/gateway-client";

export const runtime = "nodejs";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

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
  const session = await getAuthSession(request.headers);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const workspaceId = workspaceIdForUser(session.user.id);
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
  const session = await getAuthSession(request.headers);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({})) as {
    sessionId?: unknown;
  };
  const workspaceId = workspaceIdForUser(session.user.id);
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
