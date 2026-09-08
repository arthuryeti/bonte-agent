import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import PizZip from "pizzip";
import WebSocket from "ws";
import type { DeepAgent } from "deepagents";
import { Gateway } from "../src/gateway/gateway.js";
import { WebAdapter, type WebGatewayEvent } from "../src/gateway/platforms/web.js";
import { GatewayWebSocketServer } from "../src/gateway/websocket-server.js";
import { SessionStore } from "../src/gateway/session.js";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import { saveGeneratedAttachment, type WorkflowAttachment } from "../src/workflows/documents-attachments.js";
import { ensureTestS3 } from "./s3-harness.js";

const scope = "11111111-1111-4111-8111-111111111111";
const otherScope = "22222222-2222-4222-8222-222222222222";
const conversation = `${scope}_first-chat`;
const authHeaders = { authorization: "Bearer document-http-test", "x-workspace-id": scope, "x-actor-id": scope, "x-conversation-id": conversation };
let store: MemoryWorkflowStore;
let gateway: Gateway;
let server: GatewayWebSocketServer;
let origin: string;
let agentInputs: string[];
const sockets: WebSocket[] = [];

function fixture() {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Party identification for Example Company Ltd</w:t></w:r></w:p></w:body></w:document>');
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}
async function upload(headers = authHeaders, bytes: Buffer = fixture()) {
  return fetch(`${origin}/attachments`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream",
    "x-file-name": "party.docx", "x-file-category": "party", "x-file-mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, body: bytes });
}
async function rpcClient() {
  const socket = new WebSocket(server.url, { headers: { authorization: authHeaders.authorization } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const events: WebGatewayEvent[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: WebGatewayEvent };
    if (frame.method === "event" && frame.params) events.push(frame.params);
    if (frame.id) { const call = pending.get(frame.id); if (call) { pending.delete(frame.id); if (frame.error) call.reject(new Error(frame.error.message)); else call.resolve(frame.result); } }
  });
  let id = 0;
  return { events, request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const requestId = ++id;
    return new Promise((resolve, reject) => { pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject }); socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })); });
  } };
}
async function completed(events: WebGatewayEvent[], turnId: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.turn_id === turnId && event.type === "turn.complete")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Accepted document turn did not complete.");
}

beforeEach(async () => {
  await ensureTestS3();
  store = new MemoryWorkflowStore(); setWorkflowStore(store);
  agentInputs = [];
  const agent = { async invoke(input: { messages: Array<{ content: string }> }) {
    agentInputs.push(String(input.messages.at(-1)?.content));
    return { messages: [{ role: "assistant", content: "Document request processed." }] };
  } } as unknown as DeepAgent;
  gateway = new Gateway(agent, { platforms: [{ platform: "web" }] }, new SessionStore({ databaseUrl: "", databaseHost: "", allowInMemory: true }));
  await gateway.start();
  const adapter = gateway.getAdapter<WebAdapter>("web"); assert.ok(adapter);
  server = new GatewayWebSocketServer(gateway, adapter, { host: "127.0.0.1", port: 0, token: "document-http-test" });
  await server.start(); origin = server.url.replace(/^ws/, "http").replace(/\/ws$/, "");
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.stop(); await gateway?.stop();
});

test("HTTP upload/list/download/delete use bearer auth and isolate workspace and conversation data", async () => {
  assert.equal((await fetch(`${origin}/attachments`, { headers: { ...authHeaders, authorization: "Bearer invalid" } })).status, 401);
  const response = await upload(); assert.equal(response.status, 201);
  const { attachment } = await response.json() as { attachment: { id: string } };
  const list = await fetch(`${origin}/attachments`, { headers: authHeaders });
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(((await list.json()) as { attachments: Array<{ id: string }> }).attachments.map((item) => item.id), [attachment.id]);
  const download = await fetch(`${origin}/attachments?id=${attachment.id}`, { headers: authHeaders });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), fixture());
  const foreign = { ...authHeaders, "x-workspace-id": otherScope, "x-actor-id": otherScope, "x-conversation-id": `${otherScope}_chat` };
  assert.equal((await fetch(`${origin}/attachments?id=${attachment.id}`, { headers: foreign })).status, 404);
  const otherChat = await fetch(`${origin}/attachments`, { headers: { ...authHeaders, "x-conversation-id": `${scope}_second-chat` } });
  assert.deepEqual((await otherChat.json() as { attachments: unknown[] }).attachments, []);
  assert.equal((await upload({ ...authHeaders, "x-conversation-id": `${otherScope}_chat` })).status, 400);
  assert.equal((await upload({ ...authHeaders, "x-conversation-id": `${scope}_../invalid` })).status, 400);
  assert.equal((await fetch(`${origin}/attachments?id=${attachment.id}`, { method: "DELETE", headers: foreign })).status, 404);
  assert.equal((await fetch(`${origin}/attachments?id=${attachment.id}`, { method: "DELETE", headers: authHeaders })).status, 200);
  assert.equal((await fetch(`${origin}/attachments?id=${attachment.id}`, { headers: authHeaders })).status, 404);
});

test("failed uploads do not create phantom attachments and valid retries work", async () => {
  assert.equal((await upload(authHeaders, Buffer.from("invalid DOCX"))).status, 400);
  assert.equal((await store.list(scope, "attachment")).length, 0);
  assert.equal((await upload()).status, 201);
  assert.equal((await store.list(scope, "attachment")).length, 1);
});

test("wrong-conversation and malformed chat attachments reject before reserving request IDs", async () => {
  const response = await upload(); const { attachment } = await response.json() as { attachment: { id: string } };
  const client = await rpcClient();
  const wrongConversation = `${scope}_second-chat`;
  await client.request("session.create", { session_id: wrongConversation });
  await assert.rejects(() => client.request("prompt.submit", { session_id: wrongConversation, request_id: "retry-same-id", text: "Read the document", attachment_ids: [attachment.id] }), /not found/);
  assert.equal(agentInputs.length, 0);
  const corrected = await client.request<{ turn_id: string; duplicate?: boolean }>("prompt.submit", { session_id: wrongConversation, request_id: "retry-same-id", text: "Continue without a document", attachment_ids: [] });
  assert.ok(!corrected.duplicate, "A rejected attachment must not poison retry idempotency.");
  await completed(client.events, corrected.turn_id);
  await assert.rejects(() => client.request("prompt.submit", { session_id: conversation, request_id: "invalid-type", text: "Read document", attachment_ids: "not-an-array" }), /Invalid attachment/);
});

test("accepted chat attachments persist references and reach agent evidence context across turns", async () => {
  const response = await upload(); const { attachment } = await response.json() as { attachment: { id: string } };
  const client = await rpcClient();
  await client.request("session.create", { session_id: conversation });
  const accepted = await client.request<{ turn_id: string }>("prompt.submit", { session_id: conversation, request_id: "document-turn", text: "Prepare the NDA intake", attachment_ids: [attachment.id] });
  await completed(client.events, accepted.turn_id);
  assert.match(agentInputs[0], /Uploaded documents/); assert.ok(agentInputs[0].includes(attachment.id));
  assert.ok(!agentInputs[0].includes("Example Company Ltd"), "Raw private source text is loaded through the scoped evidence tool only.");
  const history = await client.request<{ messages: Array<{ role: string; content: string; data_parts?: Array<{ type: string; id: string }> }> }>("session.history", { session_id: conversation });
  const userMessage = history.messages.find((message) => message.role === "user");
  assert.equal(userMessage?.content, "Prepare the NDA intake");
  assert.ok(userMessage?.data_parts?.some((part) => part.type === "source-document" && part.id === attachment.id), "Persist the uploaded source reference on its chat message.");
  const second = await client.request<{ turn_id: string }>("prompt.submit", { session_id: conversation, request_id: "next-document-turn", text: "What documents are still missing?" });
  await completed(client.events, second.turn_id);
  assert.ok(await store.get(scope, "attachment", attachment.id), "Source evidence remains available on subsequent turns.");
});

test("legacy brochure URLs respect protected attachment deletion and expiry", async () => {
  const ctx = { workspaceId: scope, actorId: scope, conversationId: conversation };
  const attachment = await saveGeneratedAttachment(ctx, { bytes: Buffer.from("%PDF-1.4\nSynthetic test bytes"), fileName: "test-brochure.pdf", mimeType: "application/pdf" });
  await store.put(scope, "generated_file", "test-brochure.pdf", { conversationId: conversation, attachmentId: attachment.id });
  const file = await fetch(`${origin}/files?name=test-brochure.pdf`, { headers: authHeaders });
  assert.equal(file.status, 200);
  const record = await store.get<WorkflowAttachment>(scope, "attachment", attachment.id); assert.ok(record);
  await store.put(scope, "attachment", attachment.id, { ...record.data, expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await fetch(`${origin}/files?name=test-brochure.pdf`, { headers: authHeaders })).status, 404);
});

test("GET /crm validates identifiers and returns a fresh record on the next read", async () => {
  const originalFetch = globalThis.fetch;
  let leadTitle = "Lisbon viewing";
  let propertyTitle = "Resolved villa";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(origin)) return originalFetch(input, init);
    if (url.includes("/Leads/List")) {
      return new Response(JSON.stringify({
        Opportunities: [{
          Id: "lead-42",
          Title: leadTitle,
          Properties: [
            { PropertyID: 42, Reference: "LX-100", Title: "Named loft" },
            { PropertyID: 99, Reference: "NO-NAME" },
          ],
          Events: Array.from({ length: 8 }, (_, i) => ({ EventID: `e${i}`, Title: `Event ${i}` })),
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      Success: true,
      PropertyList: [{
        id: 99,
        reference: "NO-NAME",
        locale: [{ language: "en", title: propertyTitle, description: "<p>Long copy</p>" }],
        features_list_enum: Array.from({ length: 20 }, (_, i) => `F${i}`),
      }],
      TotalPages: 1,
      TotalRecords: 1,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal((await fetch(`${origin}/crm?type=lead&id=lead-42`, { headers: { ...authHeaders, authorization: "Bearer invalid" } })).status, 401);
    assert.equal((await fetch(`${origin}/crm?type=property&id=property-1`, { headers: authHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/crm?type=property&id=${Number.MAX_SAFE_INTEGER + 1}`, { headers: authHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/crm?type=property&reference=${encodeURIComponent("NO-NAME\t")}`, { headers: authHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/crm?type=property&reference=${"A".repeat(129)}`, { headers: authHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/crm?type=property`, { headers: authHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/crm?type=lead&id=missing`, { headers: authHeaders })).status, 404);
    const leadRes = await fetch(`${origin}/crm?type=lead&id=lead-42`, { headers: authHeaders });
    assert.equal(leadRes.status, 200);
    assert.equal(leadRes.headers.get("cache-control"), "private, no-store");
    const leadBody = await leadRes.json() as { lead: { title: string; properties: Array<{ title?: string }>; events: unknown[] }; fetchedAt: string };
    assert.equal(leadBody.lead.title, "Lisbon viewing");
    assert.equal(leadBody.lead.properties[0].title, "Named loft");
    assert.equal(leadBody.lead.properties[1].title, "Resolved villa");
    assert.equal(leadBody.lead.events.length, 8);
    leadTitle = "Updated viewing";
    propertyTitle = "Updated villa";
    const leadAgain = await fetch(`${origin}/crm?type=lead&id=lead-42`, { headers: authHeaders });
    assert.equal(((await leadAgain.json()) as { lead: { title: string } }).lead.title, "Updated viewing");
    const propRes = await fetch(`${origin}/crm?type=property&id=99&reference=NO-NAME`, { headers: authHeaders });
    assert.equal(propRes.status, 200);
    const propBody = await propRes.json() as { property: { title: string; features: string[]; description?: string; listingUrl?: string }; warnings?: string[] };
    assert.equal(propBody.property.title, "Updated villa");
    assert.equal(propBody.property.features.length, 20);
    assert.equal(propBody.property.description, "Long copy");
    assert.equal(propBody.property.listingUrl, undefined);
    propertyTitle = "Second villa";
    const propAgain = await fetch(`${origin}/crm?type=property&id=99&reference=NO-NAME`, { headers: authHeaders });
    assert.equal(((await propAgain.json()) as { property: { title: string } }).property.title, "Second villa");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
