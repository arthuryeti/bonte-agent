import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailDraftView } from "../src/gateway/crm-ui-types.js";
import { emailDraftMailto, isEmailDraftView } from "../web/app/email-draft-data.js";
import { selectRelevantDataParts } from "../web/app/api/chat/turn-presentation.js";

const draft: EmailDraftView = {
  id: "draft-1", revision: 1, recipient: "joão+buyer@example.com",
  subject: "Visita & preço + #22568", body: "Olá João,\nPreço & condições + #22568\r\nObrigada.\rAté breve!",
  downloadAttachmentId: "11111111-1111-4111-8111-111111111111", attachmentIds: [],
};

test("native mail draft preserves Unicode, reserved characters and CRLF without creating headers", () => {
  const uri = new URL(emailDraftMailto(draft));
  assert.equal(decodeURIComponent(uri.pathname), draft.recipient);
  assert.equal(uri.searchParams.get("subject"), draft.subject);
  assert.equal(uri.searchParams.get("body"), "Olá João,\r\nPreço & condições + #22568\r\nObrigada.\r\nAté breve!");
  assert.deepEqual([...uri.searchParams.keys()], ["subject", "body"]);
  assert.equal(uri.hash, "");
  assert.equal(isEmailDraftView({ ...draft, recipient: "buyer@example.com\r\nBcc: stranger@example.com" }), false);
  assert.equal(isEmailDraftView({ ...draft, subject: "Visit\nBcc: stranger@example.com" }), false);
  assert.equal(isEmailDraftView({ ...draft, attachmentIds: ["../another-workspace"] }), false);
});

test("ordinary comma-separated recipients remain separate mailboxes", () => {
  const uri = new URL(emailDraftMailto({ ...draft, recipient: "joão+buyer@example.com, seller@example.com" }));
  assert.deepEqual(uri.pathname.split(",").map(decodeURIComponent), ["joão+buyer@example.com", "seller@example.com"]);
});

test("blank recipient and a full 30,000-character draft remain available to the mail app", () => {
  const long = { ...draft, recipient: undefined, body: "é &+# ".repeat(5_000) };
  assert.equal(isEmailDraftView(long), true);
  const uri = new URL(emailDraftMailto(long));
  assert.equal(uri.pathname, "");
  assert.equal(uri.searchParams.get("body"), long.body);
});

test("saved and revised drafts survive history serialization independently of CRM relevance", () => {
  const revised = { ...draft, revision: 2, subject: "Updated visit", body: "A different message" };
  const parts = JSON.parse(JSON.stringify([
    { type: "email-draft", id: "draft-1:1", data: draft },
    { type: "property-list", id: "property-1", data: { properties: [{ id: "101", reference: "22568", title: "Ocean villa" }] } },
    { type: "email-draft", id: "draft-1:2", data: revised },
  ]));
  const displayed = selectRelevantDataParts(parts, "Ocean villa is ready.")
    .filter((part) => part.type === "email-draft")
    .map((part) => { assert.ok(isEmailDraftView(part.data)); return new URL(emailDraftMailto(part.data)); });
  assert.deepEqual(displayed.map((uri) => uri.searchParams.get("subject")), [draft.subject, revised.subject]);
  assert.equal(displayed[1].searchParams.get("body"), revised.body);
});
