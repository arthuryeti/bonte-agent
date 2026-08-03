import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { WhatsAppAdapter } from "../src/gateway/platforms/whatsapp.js";
import {
  clearWhatsAppAuthState,
  createSerialQueue,
  createWhatsAppVersionResolver,
  getWhatsAppMessageContent,
  matchesWhatsAppAllowlist,
  normalizeWhatsAppIdentifier,
  splitWhatsAppMessage,
} from "../src/gateway/platforms/whatsapp-helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("WhatsApp authentication recovery", () => {
  it("clears revoked credentials but preserves the auth directory", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-auth-test-"));
    tempDirs.push(parent);
    const authDir = path.join(parent, ".whatsapp-auth");
    const keyDir = path.join(authDir, "nested");
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}");
    fs.writeFileSync(path.join(keyDir, "key.json"), "{}");

    await clearWhatsAppAuthState(authDir);

    assert.equal(fs.statSync(authDir).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(authDir), []);
  });

  it("creates a missing auth directory", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-auth-test-"));
    tempDirs.push(parent);
    const authDir = path.join(parent, ".whatsapp-auth");

    await clearWhatsAppAuthState(authDir);

    assert.equal(fs.statSync(authDir).isDirectory(), true);
  });

  it("refuses to clear the process working directory", async () => {
    await assert.rejects(
      clearWhatsAppAuthState(process.cwd()),
      /Refusing to clear unsafe WhatsApp auth directory/
    );
  });
});

describe("Hermes-compatible WhatsApp behavior", () => {
  it("normalizes phone JIDs and device suffixes", () => {
    assert.equal(
      normalizeWhatsAppIdentifier("+351912345678@s.whatsapp.net"),
      "351912345678"
    );
    assert.equal(
      normalizeWhatsAppIdentifier("351912345678:2@s.whatsapp.net"),
      "351912345678"
    );
  });

  it("matches an incoming LID through the persisted phone mapping", () => {
    const authDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "whatsapp-lid-test-")
    );
    tempDirs.push(authDir);
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-351912345678.json"),
      JSON.stringify("134406773694515")
    );
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-134406773694515_reverse.json"),
      JSON.stringify("351912345678")
    );

    assert.equal(
      matchesWhatsAppAllowlist(
        ["134406773694515@lid"],
        ["351912345678"],
        authDir
      ),
      true
    );
  });

  it("unwraps ephemeral and view-once text content", () => {
    const content = getWhatsAppMessageContent({
      message: {
        ephemeralMessage: {
          message: {
            viewOnceMessageV2: {
              message: { extendedTextMessage: { text: "hello" } },
            },
          },
        },
      },
    });
    assert.equal(content.extendedTextMessage.text, "hello");
  });

  it("serializes concurrent send operations and survives one rejection", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first");
    });
    const failed = queue.enqueue(async () => {
      order.push("failed");
      throw new Error("expected");
    });
    const last = queue.enqueue(async () => {
      order.push("last");
    });

    await first;
    await assert.rejects(failed, /expected/);
    await last;
    assert.deepEqual(order, ["first", "failed", "last"]);
  });

  it("caches the last protocol version when a later lookup fails", async () => {
    let calls = 0;
    const logs: string[] = [];
    const resolveVersion = createWhatsAppVersionResolver(
      async () => {
        calls += 1;
        if (calls === 1) return { version: [2, 3000, 123] };
        throw new Error("network down");
      },
      { log: (message) => logs.push(message) }
    );

    assert.deepEqual(await resolveVersion(), [2, 3000, 123]);
    assert.deepEqual(await resolveVersion(), [2, 3000, 123]);
    assert.match(logs[0], /cached version/);
  });

  it("chunks long text at a useful word boundary", () => {
    assert.deepEqual(splitWhatsAppMessage("one two three", 8), [
      "one two",
      "three",
    ]);
  });

  it("enforces group mention gating while allowing commands", () => {
    const adapter = new WhatsAppAdapter({ requireMention: true });
    const toEvent = (
      adapter as unknown as {
        toMessageEvent(message: unknown, socket: unknown): unknown;
      }
    ).toMessageEvent.bind(adapter);
    const socket = {
      user: {
        id: "351920461967:1@s.whatsapp.net",
        lid: "134406773694515:1@lid",
      },
    };
    const base = {
      key: {
        id: "message-1",
        remoteJid: "group@g.us",
        participant: "351911111111@s.whatsapp.net",
      },
      messageTimestamp: 1,
      pushName: "Tester",
    };

    assert.equal(
      toEvent({ ...base, message: { conversation: "hello" } }, socket),
      null
    );
    assert.ok(
      toEvent({ ...base, message: { conversation: "/reset" } }, socket)
    );
    assert.ok(
      toEvent(
        {
          ...base,
          message: {
            extendedTextMessage: {
              text: "@351920461967 hello",
              contextInfo: {
                mentionedJid: ["351920461967@s.whatsapp.net"],
              },
            },
          },
        },
        socket
      )
    );
  });
});
