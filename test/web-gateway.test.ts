import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { DeepAgent } from "deepagents";
import WebSocket from "ws";
import { Gateway } from "../src/gateway/gateway.js";
import { WebAdapter, type WebGatewayEvent } from "../src/gateway/platforms/web.js";
import { GatewayWebSocketServer } from "../src/gateway/websocket-server.js";

interface RpcFrame {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: WebGatewayEvent;
}

const servers: Array<{ server: GatewayWebSocketServer; gateway: Gateway }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async ({ server, gateway }) => {
      await server.stop();
      await gateway.stop();
    })
  );
});

async function startTestGateway(agent: DeepAgent) {
  const gateway = new Gateway(agent, {
    platforms: [{ enabled: true, platform: "web" }],
  });
  await gateway.start();
  const adapter = gateway.getAdapter<WebAdapter>("web");
  assert.ok(adapter);

  const server = new GatewayWebSocketServer(gateway, adapter, {
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
  });
  await server.start();
  servers.push({ server, gateway });
  return { server };
}

async function connect(url: string): Promise<{
  socket: WebSocket;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  events: WebGatewayEvent[];
}> {
  const socket = new WebSocket(url, {
    headers: { authorization: "Bearer test-token" },
  });
  const events: WebGatewayEvent[] = [];
  const pending = new Map<number, (frame: RpcFrame) => void>();
  let nextId = 0;

  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as RpcFrame;
    if (frame.method === "event" && frame.params) {
      events.push(frame.params);
      return;
    }
    if (typeof frame.id === "number") pending.get(frame.id)?.(frame);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    events,
    request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, (frame) => {
          pending.delete(id);
          if (frame.error) reject(new Error(frame.error.message));
          else resolve(frame.result as T);
        });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
  };
}

async function waitForEvent(
  events: WebGatewayEvent[],
  predicate: (event: WebGatewayEvent) => boolean,
  timeoutMs = 2_000
): Promise<WebGatewayEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for gateway event");
}

describe("web JSON-RPC gateway", () => {
  it("owns browser session history and emits streamed message events", async () => {
    const fakeAgent = {
      async invoke(input: { messages: Array<{ content: string }> }) {
        const latest = input.messages.at(-1)?.content;
        return {
          messages: [{ role: "assistant", content: `Gateway received: ${latest}` }],
        };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "browser-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "browser-session",
      text: "hello",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const deltas = client.events
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { delta?: string })?.delta ?? "")
      .join("");
    assert.equal(deltas, "Gateway received: hello");

    const history = await client.request<{
      messages: Array<{ role: string; content: string }>;
    }>("session.history", { session_id: "browser-session" });
    assert.deepEqual(
      history.messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Gateway received: hello" },
      ]
    );
    const recent = await client.request<{
      sessions: Array<{ id: string; title: string }>;
    }>("session.list", { limit: 10 });
    assert.equal(recent.sessions[0]?.id, "browser-session");
    assert.equal(recent.sessions[0]?.title, "hello");
    client.socket.close();
  });

  it("supports cooperative prompt cancellation", async () => {
    const fakeAgent = {
      async invoke(_input: unknown, options: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
        return { messages: [] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "cancel-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "cancel-session",
      text: "wait",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.start" && event.turn_id === accepted.turn_id
    );
    const stopped = await client.request<{ stopped: boolean }>("prompt.stop", {
      session_id: "cancel-session",
    });

    assert.equal(stopped.stopped, true);
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );
    client.socket.close();
  });

  it("scopes recent browser chats to an anonymous workspace prefix", async () => {
    const fakeAgent = {
      async invoke() {
        return { messages: [{ role: "assistant", content: "unused" }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "workspace_a" });
    await client.request("session.create", { session_id: "another_b" });
    const recent = await client.request<{
      sessions: Array<{ id: string }>;
    }>("session.list", { session_prefix: "workspace_" });

    assert.deepEqual(recent.sessions.map((session) => session.id), ["workspace_a"]);
    client.socket.close();
  });

  it("publishes normalized lead data and retains it in session history", async () => {
    const fakeAgent = {
      async invoke(
        _input: unknown,
        options: { callbacks?: Array<{
          handleToolStart(tool: unknown, input: string, runId: string): void;
          handleToolEnd(output: unknown, runId: string): void;
        }> }
      ) {
        const callback = options.callbacks?.[0];
        callback?.handleToolStart(
          { name: "call_crm_api" },
          JSON.stringify({ endpoint: "/api/Leads/List", method: "POST" }),
          "crm-run-1"
        );
        callback?.handleToolEnd(
          JSON.stringify({
            Opportunities: [{
              Id: "lead-1",
              Title: "Viewing request",
              Customer: { Name: "Customer", EmailAddress: "customer@example.com" },
            }],
            _result: { totalRecords: 1, returnedRecords: 1, truncated: false },
          }),
          "crm-run-1"
        );
        return { messages: [{ role: "assistant", content: "I found one lead." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "lead-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "lead-session",
      text: "Show my latest leads",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const leadEvent = client.events.find((event) => event.type === "lead.list.available");
    assert.ok(leadEvent);
    const leadData = (leadEvent.payload as { data?: { leads?: Array<{ id: string }> } }).data;
    assert.equal(leadData?.leads?.[0]?.id, "lead-1");
    assert.ok(client.events.some((event) => event.type === "tool.start"));
    assert.ok(client.events.some((event) => event.type === "tool.complete"));

    const history = await client.request<{
      messages: Array<{ data_parts?: Array<{ type: string; data: unknown }> }>;
    }>("session.history", { session_id: "lead-session" });
    assert.equal(history.messages.at(-1)?.data_parts?.[0]?.type, "lead-list");
    client.socket.close();
  });

  it("validates and de-duplicates confirmed follow-up actions", async () => {
    let agentPrompt = "";
    const fakeAgent = {
      async invoke(input: { messages: Array<{ content: string }> }) {
        agentPrompt = input.messages.at(-1)?.content ?? "";
        return { messages: [{ role: "assistant", content: "Follow-up scheduled." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    const scheduledFor = new Date(Date.now() + 86_400_000).toISOString();
    const params = {
      session_id: "action-session",
      action_id: "action-1",
      type: "schedule_follow_up",
      lead_id: "lead-42",
      lead_title: "Viewing request",
      contact_name: "Customer",
      scheduled_for: scheduledFor,
      note: "Call after lunch",
      display_text: "Schedule a follow-up with Customer tomorrow.",
    };

    await client.request("session.create", { session_id: "action-session" });
    const accepted = await client.request<{ turn_id: string }>("lead.action.submit", params);
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    assert.match(agentPrompt, /<confirmed_action>/);
    assert.match(agentPrompt, /"leadId":"lead-42"/);
    const history = await client.request<{
      messages: Array<{ role: string; content: string }>;
    }>("session.history", { session_id: "action-session" });
    assert.equal(
      history.messages[0]?.content,
      "Schedule a follow-up with Customer tomorrow."
    );
    await assert.rejects(
      client.request("lead.action.submit", params),
      /already submitted/
    );
    await assert.rejects(
      client.request("lead.action.submit", {
        ...params,
        action_id: "action-2",
        scheduled_for: new Date(Date.now() - 86_400_000).toISOString(),
      }),
      /future/
    );
    client.socket.close();
  });

  it("requires a token for non-loopback bindings", () => {
    const fakeGateway = {} as Gateway;
    const fakeAdapter = {} as WebAdapter;
    assert.throws(
      () =>
        new GatewayWebSocketServer(fakeGateway, fakeAdapter, {
          host: "0.0.0.0",
          token: "",
        }),
      /GATEWAY_WEB_TOKEN/
    );
  });
});
