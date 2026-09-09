import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import type { DeepAgent } from "deepagents";
import WebSocket from "ws";
import { Gateway } from "../src/gateway/gateway.js";
import { WebAdapter, type WebGatewayEvent } from "../src/gateway/platforms/web.js";
import { SessionStore } from "../src/gateway/session.js";
import { GatewayWebSocketServer } from "../src/gateway/websocket-server.js";
import { MemoryWorkflowStore, setWorkflowStore, getWorkflowStore } from "../src/workflows/store.js";
import { saveGeneratedAttachment, deleteAttachment } from "../src/workflows/documents-attachments.js";
import { migrateAttachmentsToS3 } from "../src/workflows/migrate-attachments-s3.js";
import { ensureTestS3 } from "./s3-harness.js";

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
  await ensureTestS3();
  setWorkflowStore(new MemoryWorkflowStore());
  const sessions = new SessionStore({ databaseUrl: "", databaseHost: "", allowInMemory: true });
  const gateway = new Gateway(
    agent,
    { platforms: [{ platform: "web" }] },
    sessions
  );
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
  return { server, sessions };
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

    const turnEvents = client.events.filter(
      (event) => event.turn_id === accepted.turn_id
    );
    assert.deepEqual(
      turnEvents.map((event) => event.sequence),
      turnEvents.map((_, index) => index + 1)
    );
    assert.equal(
      new Set(turnEvents.map((event) => event.event_id)).size,
      turnEvents.length
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

  it("adds compact CRM-table guidance without persisting it as the user message", async () => {
    let agentMessage = "";
    const fakeAgent = {
      async invoke(input: { messages: Array<{ content: string }> }) {
        agentMessage = input.messages.at(-1)?.content ?? "";
        return { messages: [{ role: "assistant", content: "I found 20 of 184 leads." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "compact-leads" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "compact-leads",
      text: "Show my latest leads",
      compact_crm_results: true,
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    assert.match(agentMessage, /lead table/);
    assert.match(agentMessage, /property table/);
    assert.match(agentMessage, /decision-useful summary/);
    assert.match(agentMessage, /sale\/rent and property-type mix/);
    assert.match(agentMessage, /property tables render below/i);
    assert.match(agentMessage, /Show my latest leads/);
    const history = await client.request<{
      messages: Array<{ role: string; content: string }>;
    }>("session.history", { session_id: "compact-leads" });
    assert.equal(history.messages[0]?.content, "Show my latest leads");
    client.socket.close();
  });

  it("does not append the final answer twice after a streamed tool preamble", async () => {
    const preamble = "I’ll fetch the latest leads for you. ";
    const finalAnswer = "Here are the latest leads, newest first.";
    const fakeAgent = {
      async stream() {
        return (async function* () {
          yield ["messages", [{ type: "ai", id: "preamble", content: preamble }]];
          yield ["messages", [{ type: "ai", id: "answer", content: finalAnswer }]];
          yield ["values", {
            messages: [{ role: "assistant", content: finalAnswer }],
          }];
        })();
      },
      async invoke() {
        return { messages: [{ role: "assistant", content: finalAnswer }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "stream-overlap" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "stream-overlap",
      text: "Show me the latest leads",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const visibleText = client.events
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { delta?: string })?.delta ?? "")
      .join("");
    assert.equal(visibleText, preamble + finalAnswer);
    assert.equal(visibleText.split(finalAnswer).length - 1, 1);
    client.socket.close();
  });

  it("delivers a complete final answer after only a partial preview was acknowledged", async () => {
    const preamble = "I’ll fetch the latest leads. ";
    const partialAnswer = "Here are the latest ";
    const finalAnswer = `${partialAnswer}leads.`;
    const fakeAgent = {
      async stream() {
        return (async function* () {
          yield ["messages", [{ type: "ai", id: "preamble", content: preamble }]];
          yield ["messages", [{ type: "ai", id: "answer", content: partialAnswer }]];
          yield ["values", {
            messages: [{ role: "assistant", content: finalAnswer }],
          }];
        })();
      },
      async invoke() {
        return { messages: [{ role: "assistant", content: finalAnswer }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "stream-partial" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "stream-partial",
      request_id: "partial-request",
      text: "Show me the latest leads",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const visibleText = client.events
      .filter((event) => event.type === "message.delta")
      .map((event) => (event.payload as { delta?: string })?.delta ?? "")
      .join("");
    assert.equal(visibleText, `${preamble.trim()}\n\n${finalAnswer}`);
    assert.equal(visibleText.split(finalAnswer).length - 1, 1);
    client.socket.close();
  });

  it("does not replay an agent turn after streaming has produced output", async () => {
    let invocations = 0;
    const fakeAgent = {
      async stream() {
        return (async function* () {
          yield ["messages", [{ type: "ai", id: "started", content: "Working…" }]];
          throw new Error("provider rejected a later model step");
        })();
      },
      async invoke() {
        invocations += 1;
        return { messages: [{ role: "assistant", content: "replayed" }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "no-stream-replay" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "no-stream-replay",
      text: "Run this once",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    assert.equal(invocations, 0);
    assert.equal(
      client.events
        .filter((event) => event.type === "message.delta")
        .some((event) => (event.payload as { delta?: string }).delta === "replayed"),
      false
    );
    const history = await client.request<{
      messages: Array<{ role: string; content: string; platform_message_id?: string }>;
    }>("session.history", { session_id: "no-stream-replay" });
    assert.match(history.messages.at(-1)?.content ?? "", /AI service returned an error/);
    assert.equal(
      history.messages.at(-1)?.platform_message_id,
      `assistant:${accepted.turn_id}`,
    );
    client.socket.close();
  });

  it("does not replay when a tool starts before the first stream chunk", async () => {
    let invocations = 0;
    const fakeAgent = {
      async stream(
        _input: unknown,
        options: {
          callbacks?: Array<{
            handleToolStart(tool: unknown, input: string, runId: string): void;
          }>;
        }
      ) {
        options.callbacks?.[0]?.handleToolStart(
          { name: "call_crm_api" },
          JSON.stringify({ endpoint: "/api/Property/ListProperties" }),
          "started-before-chunk"
        );
        throw new Error("provider failed after the tool started");
      },
      async invoke() {
        invocations += 1;
        return { messages: [{ role: "assistant", content: "replayed" }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "no-tool-replay" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "no-tool-replay",
      text: "Run the CRM request once",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    assert.equal(invocations, 0);
    const history = await client.request<{
      messages: Array<{ role: string; content: string }>;
    }>("session.history", { session_id: "no-tool-replay" });
    assert.match(history.messages.at(-1)?.content ?? "", /AI service returned an error/);
    client.socket.close();
  });

  it("falls back to invoke when streaming fails before producing output", async () => {
    let invocations = 0;
    const fakeAgent = {
      async stream() {
        throw new Error("streaming is unavailable");
      },
      async invoke() {
        invocations += 1;
        return { messages: [{ role: "assistant", content: "Fallback response." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "safe-stream-fallback" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "safe-stream-fallback",
      text: "Use the safe fallback",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    assert.equal(invocations, 1);
    assert.ok(
      client.events
        .filter((event) => event.type === "message.delta")
        .some((event) =>
          (event.payload as { delta?: string }).delta?.includes("Fallback response.")
        )
    );
    client.socket.close();
  });

  it("accepts only one simultaneous turn while async input validation is pending", async () => {
    let invocations = 0;
    const fakeAgent = { async invoke() {
      invocations++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { messages: [{ role: "assistant", content: "Accepted once." }] };
    }} as unknown as DeepAgent;
    const {server} = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    await client.request("session.create", { session_id: "racing-inputs" });
    const results = await Promise.allSettled(["first", "second"].map(request_id => client.request<{turn_id:string}>("prompt.submit", {session_id:"racing-inputs", request_id, text:"Only one active turn"})));
    const accepted = results.filter(result => result.status === "fulfilled");
    assert.equal(accepted.length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    await waitForEvent(client.events, event => event.type === "turn.complete");
    assert.equal(invocations, 1);
    client.socket.close();
  });

  it("treats a repeated browser request ID as the same persisted turn", async () => {
    let invocations = 0;
    const fakeAgent = {
      async invoke() {
        invocations += 1;
        return { messages: [{ role: "assistant", content: "One response." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    const params = {
      session_id: "idempotent-session",
      request_id: "ui-message-1",
      text: "Run this once",
    };

    await client.request("session.create", { session_id: params.session_id });
    const first = await client.request<{ turn_id: string }>("prompt.submit", params);
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === first.turn_id
    );
    const repeated = await client.request<{
      turn_id: string;
      duplicate: boolean;
      status: string;
    }>("prompt.submit", params);

    assert.equal(repeated.turn_id, first.turn_id);
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.status, "complete");
    assert.equal(invocations, 1);

    const history = await client.request<{
      messages: Array<{ role: string; platform_message_id?: string }>;
    }>("session.history", { session_id: params.session_id });
    assert.deepEqual(
      history.messages.map((message) => message.platform_message_id),
      ["ui-message-1", "assistant:ui-message-1"]
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
    const leadPayload = leadEvent.payload as {
      data?: { leads?: Array<{ id: string }> };
      run_id?: string;
    };
    const leadData = leadPayload.data;
    assert.equal(leadData?.leads?.[0]?.id, "lead-1");
    assert.equal(leadPayload.run_id, "crm-run-1");
    const toolStart = client.events.find((event) => event.type === "tool.start");
    assert.deepEqual(toolStart?.payload, {
      run_id: "crm-run-1",
      tool_name: "call_crm_api",
      endpoint: "/api/Leads/List",
    });
    assert.ok(client.events.some((event) => event.type === "tool.complete"));

    const history = await client.request<{
      messages: Array<{ data_parts?: Array<{ type: string; data: unknown }> }>;
    }>("session.history", { session_id: "lead-session" });
    assert.equal(history.messages.at(-1)?.data_parts?.[0]?.type, "lead-list");
    client.socket.close();
  });

  it("publishes normalized property data and retains it in session history", async () => {
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
          JSON.stringify({ endpoint: "/api/Property/ListProperties", method: "POST" }),
          "property-run-1"
        );
        callback?.handleToolEnd(
          JSON.stringify({
            PropertyList: [{
              propertyId: 42,
              reference: "LX-100",
              typeLocale: "Apartment",
              price: 475000,
              currency: "EUR",
            }],
            Count: 1,
            _pagination: { totalRecords: 1, returnedRecords: 1, truncated: false },
          }),
          "property-run-1"
        );
        return { messages: [{ role: "assistant", content: "I found one property." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "property-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "property-session",
      text: "Find available properties",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const propertyEvent = client.events.find(
      (event) => event.type === "property.list.available"
    );
    assert.ok(propertyEvent);
    const propertyPayload = propertyEvent.payload as {
      data?: { properties?: Array<{ id: string; reference: string }> };
      run_id?: string;
    };
    assert.deepEqual(propertyPayload.data?.properties?.[0], {
      id: "42",
      reference: "LX-100",
      title: "LX-100",
      propertyType: "Apartment",
      price: "475000",
      currency: "EUR",
      features: [],
    });
    assert.equal(propertyPayload.run_id, "property-run-1");

    const history = await client.request<{
      messages: Array<{ data_parts?: Array<{ type: string; data: unknown }> }>;
    }>("session.history", { session_id: "property-session" });
    assert.equal(history.messages.at(-1)?.data_parts?.[0]?.type, "property-list");
    client.socket.close();
  });

  it("publishes workflow cards and routes handled failures from every tool through tool.error", async () => {
    const property = { propertyId: 42, reference: "A-42", type: "Villa" };
    const outputs = [
      { name: "search_crm_properties", output: { ok: true, matches: [{ status: "exact", property }], unverified: [{ status: "unverified", property: { ...property, propertyId: 43 } }], exactMatchesInScannedRecords: 1, coverage: { totalRecords: 900, complete: false } } },
      { name: "get_verified_property", output: { ok: true, property, propertyId: 42, reference: "A-42" } },
      { name: "match_saved_buyer", output: { briefId: "buyer-1", matches: [{ status: "exact", property }], totalMatches: 1, coverage: { complete: true } } },
      { name: "get_buyer_matches", output: { matches: [{ status: "unverified", property: { ...property, propertyId: "idealista:42", source: "idealista", sourceId: "42", matchStatus: "unverified", matchReasons: ["Pool: unknown"] } }], totalMatches: 1,
        buyerSearch: { runId: "11111111-1111-4111-8111-111111111111", briefId: "buyer-1", name: "Buyer", page: 1, pages: 1, selectedIds: [], coverage: [] } } },
      { name: "query_crm_leads", output: { ok: true, leads: [{ Id: "lead-42" }], matchedRecords: 1 } },
      { name: "manage_follow_up", output: { state: "error", message: "Task unavailable" } },
      { name: "search_crm_properties", output: { ok: false, error: "CRM unavailable" } },
      { name: "generate_property_pdf", output: { success: false, message: "Property unavailable" } },
    ];
    const fakeAgent = {
      async invoke(_input: unknown, options: { callbacks?: Array<{
        handleToolStart(tool: unknown, input: string, runId: string): void;
        handleToolEnd(output: unknown, runId: string): void;
      }> }) {
        const callback = options.callbacks?.[0];
        for (const [index, value] of outputs.entries()) {
          callback?.handleToolStart({ name: value.name }, "{}", `workflow-${index}`);
          callback?.handleToolEnd({ content: [{ type: "text", text: JSON.stringify(value.output) }] }, `workflow-${index}`);
        }
        return { messages: [{ role: "assistant", content: "Verified results are available; three workflows need attention." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    await client.request("session.create", { session_id: "workflow-cards" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", { session_id: "workflow-cards", text: "Check the saved buyer matches and latest leads" });
    await waitForEvent(client.events, (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id);
    const propertyEvents = client.events.filter((event) => event.type === "property.list.available");
    assert.equal(propertyEvents.length, 4);
    const first = propertyEvents[0].payload as { data: { properties: unknown[]; totalRecords: number } };
    assert.equal(first.data.properties.length, 1);
    assert.equal(first.data.totalRecords, 1);
    assert.equal(client.events.filter((event) => event.type === "lead.list.available").length, 1);
    assert.equal(client.events.filter((event) => event.type === "tool.complete").length, 5);
    assert.deepEqual(client.events.filter((event) => event.type === "tool.error").map((event) => (event.payload as { message: string }).message), ["Task unavailable", "CRM unavailable", "Property unavailable"]);
    const history = await client.request<{ messages: Array<{ data_parts?: Array<{ type: string }> }> }>("session.history", { session_id: "workflow-cards" });
    assert.equal(history.messages.at(-1)?.data_parts?.length, 5);
    client.socket.close();
  });

  it("persists save and list email drafts without duplicating the same id", async () => {
    const v1 = {
      id: "11111111-1111-4111-8111-111111111111",
      revision: 1,
      subject: "Hi",
      body: "One",
      downloadAttachmentId: "22222222-2222-4222-8222-222222222222",
      attachmentIds: [],
      status: "draft",
    };
    const v2 = {
      id: "33333333-3333-4333-8333-333333333333",
      revision: 2,
      subject: "Hi",
      body: "Two",
      downloadAttachmentId: "44444444-4444-4444-8444-444444444444",
      attachmentIds: [],
      status: "draft",
    };
    const fakeAgent = {
      async invoke(_input: unknown, options: { callbacks?: Array<{
        handleToolStart(tool: unknown, input: string, runId: string, parent?: string, tags?: string[], metadata?: Record<string, unknown>, runName?: string): void;
        handleToolEnd(output: unknown, runId: string): void;
      }> }) {
        const callback = options.callbacks?.[0];
        callback?.handleToolStart({ name: "save_email_draft" }, "{}", "email-save", undefined, undefined, undefined, "save_email_draft");
        callback?.handleToolEnd({ content: [{ type: "text", text: JSON.stringify(v2) }] }, "email-save");
        callback?.handleToolStart({ name: "prepare_buyer_shortlist" }, "{}", "shortlist-save");
        callback?.handleToolEnd(JSON.stringify(v1), "shortlist-save");
        callback?.handleToolStart({ name: "list_document_drafts" }, "{}", "email-list", undefined, undefined, undefined, "list_document_drafts");
        callback?.handleToolEnd({ content: [{ type: "text", text: JSON.stringify([{ kind: "email-draft", ...v1 }, { kind: "email-draft", ...v2 }]) }] }, "email-list");
        return { messages: [{ role: "assistant", content: "The draft is saved." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    await client.request("session.create", { session_id: "email-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", { session_id: "email-session", text: "Save the email" });
    await waitForEvent(client.events, (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id);
    const history = await client.request<{ messages: Array<{ data_parts?: Array<{ type: string; id: string; data?: { revision?: number; subject?: string; body?: string } }> }> }>("session.history", { session_id: "email-session" });
    const drafts = history.messages.at(-1)?.data_parts?.filter((part) => part.type === "email-draft") ?? [];
    assert.deepEqual(drafts.map((part) => part.id).sort(), [v1.id, v2.id].sort());
    assert.deepEqual(new Set(drafts.map((part) => part.data?.revision)), new Set([1, 2]));
    assert.equal(drafts.find((part) => part.id === v1.id)?.data?.body, "One");
    assert.equal(drafts.find((part) => part.id === v2.id)?.data?.body, "Two");
    assert.equal(drafts.find((part) => part.id === v2.id)?.data?.subject, "Hi");
    client.socket.close();
  });

  it("retains generated PDFs as attachment data parts", async () => {
    const fileName = "property-21956-deadbeef.pdf";
    const fakeAgent = {
      async invoke(
        _input: unknown,
        options: { callbacks?: Array<{
          handleToolStart(tool: unknown, input: string, runId: string): void;
          handleToolEnd(output: unknown, runId: string): void;
        }> }
      ) {
        const callback = options.callbacks?.[0];
        const saved = await saveGeneratedAttachment(
          { workspaceId: "pdf-session", conversationId: "pdf-session", actorId: "pdf-session" },
          { fileName, mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") },
        );
        callback?.handleToolStart({ name: "generate_property_pdf" }, JSON.stringify({ reference: "21956" }), "pdf-run");
        callback?.handleToolEnd(JSON.stringify({ success: true, fileName, attachmentId: saved.id, downloadName: "property-21956.pdf" }), "pdf-run");
        return { messages: [{ role: "assistant", content: "Here's the PDF for 21956 — Duplex Penthouse in Estoril." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);
    await client.request("session.create", { session_id: "pdf-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", { session_id: "pdf-session", text: "Generate a PDF for 21956" });
    await waitForEvent(client.events, (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id);
    const available = client.events.find((event) => event.type === "attachment.available");
    assert.ok(available);
    const payload = available.payload;
    assert.ok(payload && typeof payload === "object" && "file_path" in payload);
    assert.equal(payload.file_path, fileName);
    assert.equal(fs.existsSync(fileName), false);
    const history = await client.request<{ messages: Array<{ data_parts?: Array<{ type: string; data?: { fileName?: string } }> }> }>("session.history", { session_id: "pdf-session" });
    assert.equal(history.messages.at(-1)?.data_parts?.[0]?.type, "attachment");
    assert.equal(history.messages.at(-1)?.data_parts?.[0]?.data?.fileName, fileName);
    client.socket.close();
  });

  it("publishes handled CRM failures as tool errors", async () => {
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
          "crm-error-run"
        );
        callback?.handleToolEnd(
          JSON.stringify({
            _error: true,
            message: "CRM API error: 403 Forbidden - request blocked by the CRM security service",
          }),
          "crm-error-run"
        );
        return { messages: [{ role: "assistant", content: "CRM access is blocked." }] };
      },
    } as unknown as DeepAgent;
    const { server } = await startTestGateway(fakeAgent);
    const client = await connect(server.url);

    await client.request("session.create", { session_id: "crm-error-session" });
    const accepted = await client.request<{ turn_id: string }>("prompt.submit", {
      session_id: "crm-error-session",
      text: "Show my latest leads",
    });
    await waitForEvent(
      client.events,
      (event) => event.type === "turn.complete" && event.turn_id === accepted.turn_id
    );

    const toolError = client.events.find((event) => event.type === "tool.error");
    assert.deepEqual(toolError?.payload, {
      run_id: "crm-error-run",
      tool_name: "call_crm_api",
      message: "CRM API error: 403 Forbidden - request blocked by the CRM security service",
    });
    assert.equal(
      client.events.some((event) => event.type === "tool.complete"),
      false
    );
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

    assert.match(agentPrompt, /already saved this follow-up in Bonte/);
    assert.match(agentPrompt, /"leadId":"lead-42"/);
    assert.equal((await getWorkflowStore().get("action-session","follow_up","action-1"))?.data.state,"scheduled");
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

  it("serves generated PDFs over authenticated HTTP", async () => {
    const { server } = await startTestGateway({
      async invoke() {
        return { messages: [{ role: "assistant", content: "ok" }] };
      },
    } as DeepAgent);
    const fileName = "property-download-test.pdf";
    const context={workspaceId:"owner",conversationId:"owner_chat",actorId:"owner"};
    const document=await saveGeneratedAttachment(context,{fileName,mimeType:"application/pdf",bytes:Buffer.from("pdf-bytes")});
    await getWorkflowStore().put("owner","generated_file",fileName,{attachmentId:document.id});
    const denied = await fetch(
      `http://127.0.0.1:${server.port}/files?name=${fileName}`
    );
    assert.equal(denied.status, 401);
    const traversal = await fetch(
      `http://127.0.0.1:${server.port}/files?name=../package.json`,
      { headers: { authorization: "Bearer test-token" } }
    );
    assert.equal(traversal.status, 404);
    const allowed = await fetch(
      `http://127.0.0.1:${server.port}/files?name=${fileName}`,
      { headers: { authorization: "Bearer test-token", "x-workspace-id":"owner" } }
    );
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "pdf-bytes");
    const other=await fetch(`http://127.0.0.1:${server.port}/files?name=${fileName}`,{headers:{authorization:"Bearer test-token","x-workspace-id":"other"}});
    assert.equal(other.status,404);
    await deleteAttachment(context,document.id);
    const deleted=await fetch(`http://127.0.0.1:${server.port}/files?name=${fileName}`,{headers:{authorization:"Bearer test-token","x-workspace-id":"owner"}});
    assert.equal(deleted.status,404);
  });

  it("serves explicitly migrated brochures and does not fall back to leftover local files", async () => {
    const { server, sessions } = await startTestGateway({ async invoke() { return { messages: [] }; } } as unknown as DeepAgent);
    const savedRetention = process.env.BONTE_ATTACHMENT_RETENTION_DAYS;
    process.env.BONTE_ATTACHMENT_RETENTION_DAYS = "30";
    const names = ["property-legacy-owned.pdf", "property-legacy-expired.pdf", "property-legacy-unproven.pdf"];
    const directory = fs.mkdtempSync(path.join(tmpdir(), "bonte-pdf-"));
    const proof = (fileName: string) => [{ type: "attachment" as const, id: fileName, data: { fileName, mimeType: "application/pdf" } }];
    const attachedAt = new Date(Date.now() - 10 * 86_400_000);
    const owned = await sessions.addAssistantMessage("web", "owner_historical", "Brochure attached", "legacy-1", proof(names[0]));
    owned.timestamp = attachedAt;
    const expired = await sessions.addAssistantMessage("web", "owner_historical", "Old brochure", "legacy-2", proof(names[1]));
    expired.timestamp = new Date(Date.now() - 40 * 86_400_000);
    await sessions.addAssistantMessage("web", "owner_historical", "Repeated old brochure", "legacy-3", proof(names[1]));
    await sessions.addAssistantMessage("web", "owner_historical", `File name in prose: ${names[2]}`);
    for (const name of names) fs.writeFileSync(path.join(directory, name), "%PDF-1.4 historical brochure");
    const download = (name: string, workspace = "owner") => fetch(`http://127.0.0.1:${server.port}/files?name=${name}`, { headers: { authorization: "Bearer test-token", "x-workspace-id": workspace } });
    try {
      await migrateAttachmentsToS3({
        store: getWorkflowStore(),
        apply: true,
        pdfDir: directory,
        proofs: await sessions.listLegacyBrochureProofs(),
      });
      assert.equal((await download(names[0], "other")).status, 404);
      assert.equal((await download(names[0], "owner2")).status, 404);
      assert.equal((await download(names[1])).status, 404, "Expired proofs must not renew retention");
      assert.equal((await download(names[2])).status, 404, "Text mentions are not ownership evidence");
      const migrated = await download(names[0]);
      assert.equal(migrated.status, 200);
      assert.equal(await migrated.text(), "%PDF-1.4 historical brochure");
      const mapping = await getWorkflowStore().get("owner", "generated_file", names[0]);
      assert.equal(mapping?.data.migratedFromHistory, true);
      const attachmentId = String(mapping?.data.attachmentId);
      await deleteAttachment({ workspaceId: "owner", actorId: "owner", conversationId: "owner_historical" }, attachmentId);
      assert.equal((await download(names[0])).status, 404, "Historical proof cannot revive a deleted protected attachment");
      assert.equal(fs.existsSync(path.join(directory, names[0])), true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      if (savedRetention === undefined) delete process.env.BONTE_ATTACHMENT_RETENTION_DAYS; else process.env.BONTE_ATTACHMENT_RETENTION_DAYS = savedRetention;
    }
  });
});
