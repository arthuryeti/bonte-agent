import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentAdapter,
  documentAttachment,
  streamReply,
  toAssistantMessage,
} from "../web/app/assistant-adapter.js";
import type { CrmChatMessage } from "../web/app/chat-types.js";
import { formatCrmDate, formatCrmPrice, safeCrmUrl } from "../web/app/crm-details.js";
import { normalizeLeadView } from "../src/gateway/crm-ui.js";

const document = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  readable: true,
  generated: false,
  warnings: [],
};

test("assistant-ui preserves document identities and structured CRM records for detail panels", () => {
  const user = toAssistantMessage(
    {
      id: "user-1",
      role: "user",
      parts: [
        { type: "text", text: "Review this" },
        { type: "data-source-document", data: { attachmentId: document.id } },
      ],
    },
    [document],
  );
  assert.equal(user.id, "user-1");
  assert.equal(user.attachments?.[0].id, document.id);
  assert.deepEqual(
    user.attachments?.[0].content,
    documentAttachment(document).content,
  );
  const message = toAssistantMessage({
    id: "result",
    role: "assistant",
    parts: [
      {
        type: "data-lead-list",
        data: {
          id: "leads",
          generatedAt: "2026-09-09",
          truncated: false,
          totalRecords: 1,
          returnedRecords: 1,
          leads: [
            {
              id: "1",
              title: "Name | [unsafe](javascript:alert(1))",
              crmUrl: "javascript:alert(1)",
              agents: [],
              properties: [],
              events: [],
              agentCount: 0,
              propertyCount: 0,
              eventCount: 0,
            },
          ],
        },
      },
    ],
  });
  assert.ok(Array.isArray(message.content));
  const part = message.content[0];
  assert.equal(part.type, "data");
  if (part.type !== "data") return;
  assert.equal(part.name, "lead-list");
  assert.equal(part.data.leads[0].id, "1");
  assert.equal(part.data.leads[0].title, "Name | [unsafe](javascript:alert(1))");
  assert.equal(safeCrmUrl(part.data.leads[0].crmUrl), undefined);
  const propertyList = {
    id: "properties", generatedAt: "2026-09-09", truncated: true, totalRecords: 8, returnedRecords: 1,
    properties: [{ id: "101", reference: "22568", title: "Lisbon apartment", price: "1200000", features: ["Terrace"] }],
  };
  const properties = toAssistantMessage({ id: "properties", role: "assistant", parts: [{ type: "data-property-list", data: propertyList }] });
  assert.deepEqual(properties.content, [{ type: "data", name: "property-list", data: propertyList }]);
});

test("CRM details preserve full notes, safe listing links and exact price values", () => {
  assert.equal(formatCrmPrice("1250000"), "€1,250,000");
  assert.equal(formatCrmPrice("0"), "€0");
  assert.equal(formatCrmPrice("1250.75", "USD"), "US$1,250.75");
  assert.equal(formatCrmPrice("1.250.000,50 €"), "1.250.000,50 €");
  assert.equal(formatCrmPrice("1250000", "EUR", false), "Price on request");
  assert.equal(formatCrmPrice(undefined), "Not provided");
  assert.equal(formatCrmDate("unknown"), "unknown");
  assert.equal(formatCrmDate(undefined), "Not provided");
  const listing = "https://bontefilipidis.com/property/lisbon-apartment/";
  assert.equal(safeCrmUrl(listing, true), listing);
  for (const url of ["javascript:alert(1)", "http://bontefilipidis.com/property/test", "https://bontefilipidis.com.evil.test/", "https://bontefilipidis.com@evil.test/", "https://user:pass@bontefilipidis.com/", "https://other.test/"]) {
    assert.equal(safeCrmUrl(url, true), undefined, url);
  }
  const raw = { Id: "lead-1", Description: `<p>${"Full notes. ".repeat(100)}</p>`, OutcomeDate: "2026-09-01", Events: [{ Title: "Viewing", Description: "<p>Buyer requested a second visit.</p>" }] };
  const lead = normalizeLeadView(raw, 0, false);
  assert.equal(lead?.description, "Full notes. ".repeat(100).trim());
  assert.equal(lead?.events[0].description, "Buyer requested a second visit.");
  assert.equal(lead?.outcomeDate, "2026-09-01");
  assert.equal(normalizeLeadView(raw)?.description, undefined);
});

test("assistant-ui uploads through the scoped gateway, validates size/type and reports failures", async (t) => {
  const controller = new AbortController();
  const notices: string[] = [];
  const adapter = attachmentAdapter(
    "session-one",
    () => controller.signal,
    (message) => notices.push(message),
  );
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(init.signal, controller.signal);
    if (init.method === "DELETE") {
      assert.equal(url, `/api/attachments?id=${document.id}`);
      return Response.json({ deleted: true });
    }
    assert.equal(url, "/api/attachments");
    const form = init.body as FormData;
    assert.equal(form.get("sessionId"), "session-one");
    assert.equal(form.get("category"), null, "Users do not have to classify uploads.");
    assert.equal((form.get("file") as File).name, "contract.pdf");
    return Response.json({ attachment: document });
  });
  await assert.rejects(
    adapter.add({ file: new File(["bad"], "file.exe") }) as Promise<unknown>,
    /PDF/,
  );
  await assert.rejects(
    adapter.add({ file: new File([], "empty.pdf") }) as Promise<unknown>,
    /non-empty/,
  );
  await assert.rejects(
    adapter.add({
      file: new File([new Uint8Array(16 * 1024 * 1024)], "large.pdf"),
    }) as Promise<unknown>,
    /15 MB/,
  );
  assert.equal(calls, 0);
  const pending = await adapter.add({
    file: new File(["test"], "contract.pdf", { type: "application/pdf" }),
  });
  assert.ok("status" in pending);
  const completed = await adapter.send(pending);
  assert.equal(completed.status.type, "complete");
  assert.equal(completed.id, document.id);
  await adapter.remove(completed);
  assert.equal(calls, 2);
  assert.deepEqual(notices, []);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Storage unavailable" }, { status: 503 }),
  );
  await assert.rejects(
    adapter.add({
      file: new File(["test"], "contract.pdf"),
    }) as Promise<unknown>,
    /Storage unavailable/,
  );
});

test("assistant-ui consumes gateway streams, keeps request identity, and surfaces stream errors", async (t) => {
  const message: CrmChatMessage = {
    id: "stable-request-id",
    role: "user",
    parts: [{ type: "text", text: "Review this" }],
  };
  const controller = new AbortController();
  const chunks = [
    {
      type: "data-tool-status",
      id: "work",
      data: { status: "running", label: "Reading documents" },
    },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "Olá " },
    { type: "text-delta", id: "text", delta: "Lisbon" },
    { type: "text-end", id: "text" },
    {
      type: "data-tool-status",
      id: "work",
      data: { status: "complete", label: "Done" },
    },
  ];
  const wire = new TextEncoder().encode(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      assert.equal(body.sessionId, "session-one");
      assert.equal(body.messages[0].id, message.id);
      assert.deepEqual(body.attachmentIds, [document.id]);
      assert.equal(init.signal, controller.signal);
      return new Response(
        new ReadableStream({
          start(stream) {
            for (let index = 0; index < wire.length; index += 7)
              stream.enqueue(wire.slice(index, index + 7));
            stream.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  const updates = [];
  for await (const update of streamReply(
    "session-one",
    message,
    [document.id],
    controller.signal,
  ))
    updates.push(update);
  const content = updates.at(-1)?.content;
  assert.ok(Array.isArray(content));
  assert.equal(
    content.find((part) => part.type === "text")?.text,
    "Olá Lisbon",
  );
  assert.equal(
    content.find((part) => part.type === "tool-call")?.result,
    "Done",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('data: {"type":"error","errorText":"Gateway failed"}\n\n'),
  );
  await assert.rejects(async () => {
    for await (const _ of streamReply(
      "session-one",
      message,
      [],
      controller.signal,
    )) {
      /* drain */
    }
  }, /Gateway failed/);
  await assert.rejects(async () => {
    for await (const _ of streamReply(
      "session-one",
      message,
      Array(13).fill(document.id),
      controller.signal,
    )) {
      /* drain */
    }
  }, /12 documents/);
});
