import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { WhatsAppAdapter } from "../src/gateway/platforms/whatsapp.js";
import {
  clearWhatsAppAuthState,
  createBoundedIdTracker,
  createHandoverTracker,
  createSerialQueue,
  createWhatsAppVersionResolver,
  formatWhatsAppText,
  getWhatsAppMessageContent,
  isWhatsAppSelfChat,
  matchesWhatsAppAllowlist,
  normalizeWhatsAppIdentifier,
  resolveWhatsAppChatId,
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

  it("resets forbidden credentials and returns to pairing", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-auth-test-"));
    tempDirs.push(parent);
    const authDir = path.join(parent, ".whatsapp-auth");
    fs.mkdirSync(authDir);
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}");

    const adapter = new WhatsAppAdapter({ authDir });
    const socket = {
      ev: { removeAllListeners: (_event: string) => undefined },
    };
    let resolveReconnect!: (delayMs: number) => void;
    const reconnectScheduled = new Promise<number>((resolve) => {
      resolveReconnect = resolve;
    });
    Object.assign(adapter as object, {
      sock: socket,
      connected: true,
      scheduleReconnect: (delayMs: number) => resolveReconnect(delayMs),
    });

    const handleConnectionUpdate = (
      adapter as unknown as {
        handleConnectionUpdate(
          socket: unknown,
          baileys: unknown,
          authDir: string,
          update: unknown
        ): void;
      }
    ).handleConnectionUpdate.bind(adapter);
    handleConnectionUpdate(
      socket,
      {
        DisconnectReason: {
          loggedOut: 401,
          forbidden: 403,
          restartRequired: 515,
          unavailableService: 503,
        },
      },
      authDir,
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 403 } } },
      }
    );

    assert.equal(await reconnectScheduled, 1000);
    assert.deepEqual(fs.readdirSync(authDir), []);
  });

  it("backs off after a temporary WhatsApp 503", (t) => {
    t.mock.method(console, "warn", () => undefined);
    const adapter = new WhatsAppAdapter({});
    const socket = {
      ev: { removeAllListeners: (_event: string) => undefined },
    };
    let reconnectDelay: number | undefined;
    Object.assign(adapter as object, {
      sock: socket,
      connected: true,
      scheduleReconnect: (delayMs: number) => {
        reconnectDelay = delayMs;
      },
    });

    const handleConnectionUpdate = (
      adapter as unknown as {
        handleConnectionUpdate(
          socket: unknown,
          baileys: unknown,
          authDir: string,
          update: unknown
        ): void;
      }
    ).handleConnectionUpdate.bind(adapter);
    handleConnectionUpdate(
      socket,
      {
        DisconnectReason: {
          loggedOut: 401,
          forbidden: 403,
          restartRequired: 515,
          unavailableService: 503,
        },
      },
      ".whatsapp-auth",
      {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 503 } } },
      }
    );

    assert.equal(reconnectDelay, 15_000);
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

  it("routes a direct LID chat through its alternate phone JID", () => {
    assert.equal(
      resolveWhatsAppChatId(
        {
          key: {
            remoteJid: "134406773694515@lid",
            remoteJidAlt: "351911111111@s.whatsapp.net",
          },
        },
        ".whatsapp-auth"
      ),
      "351911111111@s.whatsapp.net"
    );
  });

  it("routes a direct LID chat through the persisted phone mapping", () => {
    const authDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "whatsapp-route-lid-test-")
    );
    tempDirs.push(authDir);
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-134406773694515_reverse.json"),
      JSON.stringify("351911111111")
    );

    assert.equal(
      resolveWhatsAppChatId(
        { key: { remoteJid: "134406773694515@lid" } },
        authDir
      ),
      "351911111111@s.whatsapp.net"
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

  it("closes and reopens code fences across long chunks", () => {
    const chunks = splitWhatsAppMessage(
      `Intro\n\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\`\nDone`,
      128
    );

    assert.ok(chunks.length > 1);
    assert.ok(chunks[0].endsWith("\n```"));
    assert.ok(chunks[1].startsWith("```ts\n"));
    assert.ok(chunks.every((chunk) => chunk.length <= 128));
  });

  it("converts Markdown to WhatsApp formatting while preserving code", () => {
    assert.equal(
      formatWhatsAppText(
        "# Heading\n**bold** *italic* ~~gone~~ [site](https://example.com)\n`**code**`\u200B"
      ),
      "*Heading*\n*bold* _italic_ ~gone~ site (https://example.com)\n`**code**`"
    );
  });

  it("tracks outbound IDs and expires human handovers", () => {
    const ids = createBoundedIdTracker(2);
    ids.remember("one");
    ids.remember("two");
    ids.remember("three");
    assert.equal(ids.has("one"), false);
    assert.equal(ids.has("three"), true);

    let now = 1_000;
    const handovers = createHandoverTracker(500, () => now);
    handovers.activate("chat");
    assert.equal(handovers.isActive("chat"), true);
    now = 1_500;
    assert.equal(handovers.isActive("chat"), false);
  });

  it("recognizes both phone and LID self chats", () => {
    const socket = {
      user: {
        id: "351920461967:1@s.whatsapp.net",
        lid: "134406773694515:1@lid",
      },
    };
    assert.equal(
      isWhatsAppSelfChat("351920461967@s.whatsapp.net", socket),
      true
    );
    assert.equal(isWhatsAppSelfChat("134406773694515@lid", socket), true);
    assert.equal(isWhatsAppSelfChat("351911111111@s.whatsapp.net", socket), false);
  });

  it("recognizes a self-chat LID through the persisted phone mapping", () => {
    const authDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "whatsapp-self-lid-test-")
    );
    tempDirs.push(authDir);
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-351920461967.json"),
      JSON.stringify("134406773694515")
    );
    fs.writeFileSync(
      path.join(authDir, "lid-mapping-134406773694515_reverse.json"),
      JSON.stringify("351920461967")
    );

    assert.equal(
      isWhatsAppSelfChat(
        "134406773694515@lid",
        { user: { id: "351920461967:1@s.whatsapp.net" } },
        authDir
      ),
      true
    );
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

  it("uses self-chat input, prefixes replies, and ignores outbound echoes", async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    let sentId = 0;
    const socket = {
      user: { id: "351920461967:1@s.whatsapp.net" },
      async sendMessage(
        _chatId: string,
        payload: Record<string, unknown>
      ) {
        sentPayloads.push(payload);
        sentId += 1;
        return {
          key: {
            id: `sent-${sentId}`,
            remoteJid: "351920461967@s.whatsapp.net",
            fromMe: true,
          },
          message: payload,
        };
      },
    };
    const adapter = new WhatsAppAdapter({
      mode: "self-chat",
      replyPrefix: "BOT\n",
    });
    Object.assign(adapter as object, { sock: socket, connected: true });
    const events: unknown[] = [];
    adapter.onMessage(async (event) => {
      events.push(event);
    });

    const handleUpsert = (
      adapter as unknown as {
        handleMessageUpsert(socket: unknown, upsert: unknown): Promise<void>;
      }
    ).handleMessageUpsert.bind(adapter);
    await handleUpsert(socket, {
      type: "append",
      messages: [
        {
          key: {
            id: "owner-input",
            remoteJid: "351920461967@s.whatsapp.net",
            // Baileys may label a linked-account self-chat message either way.
            fromMe: false,
          },
          messageTimestamp: 1,
          message: { conversation: "hello" },
        },
      ],
    });
    await adapter.sendMessage(
      "351920461967@s.whatsapp.net",
      "**answer**"
    );
    await handleUpsert(socket, {
      type: "append",
      messages: [
        {
          key: {
            id: "sent-1",
            remoteJid: "351920461967@s.whatsapp.net",
            fromMe: true,
          },
          messageTimestamp: 2,
          message: { conversation: "BOT answer" },
        },
      ],
    });

    assert.equal(events.length, 1);
    assert.deepEqual(sentPayloads[0], { text: "BOT\n*answer*" });
  });

  it("accepts an external bot message delivered as an append upsert", async () => {
    const socket = {
      user: { id: "351920461967:1@s.whatsapp.net" },
    };
    const adapter = new WhatsAppAdapter({ mode: "bot" });
    Object.assign(adapter as object, { sock: socket, connected: true });
    const events: Array<{ text: string; fromOwner?: boolean }> = [];
    adapter.onMessage(async (event) => {
      events.push({ text: event.text, fromOwner: event.fromOwner });
    });
    const handleUpsert = (
      adapter as unknown as {
        handleMessageUpsert(socket: unknown, upsert: unknown): Promise<void>;
      }
    ).handleMessageUpsert.bind(adapter);

    await handleUpsert(socket, {
      type: "append",
      messages: [
        {
          key: {
            id: "external-leads-request",
            remoteJid: "351911111111@s.whatsapp.net",
            fromMe: false,
          },
          pushName: "Customer",
          messageTimestamp: 1,
          message: { conversation: "Can you give me the last leads?" },
        },
      ],
    });

    assert.deepEqual(events, [
      {
        text: "Can you give me the last leads?",
        fromOwner: undefined,
      },
    ]);
  });

  it("uses the phone JID as the bot session and reply route for a LID DM", async () => {
    const socket = {
      user: { id: "351920461967:1@s.whatsapp.net" },
    };
    const adapter = new WhatsAppAdapter({ mode: "bot" });
    Object.assign(adapter as object, { sock: socket, connected: true });
    const events: Array<{ chatId: string; senderId: string }> = [];
    adapter.onMessage(async (event) => {
      events.push({ chatId: event.chatId, senderId: event.senderId });
    });
    const handleUpsert = (
      adapter as unknown as {
        handleMessageUpsert(socket: unknown, upsert: unknown): Promise<void>;
      }
    ).handleMessageUpsert.bind(adapter);

    await handleUpsert(socket, {
      type: "notify",
      messages: [
        {
          key: {
            id: "lid-customer-1",
            remoteJid: "134406773694515@lid",
            remoteJidAlt: "351911111111@s.whatsapp.net",
            fromMe: false,
          },
          pushName: "Customer",
          messageTimestamp: 1,
          message: { conversation: "Can you give me the last leads?" },
        },
      ],
    });

    assert.deepEqual(events, [
      {
        chatId: "351911111111@s.whatsapp.net",
        senderId: "351911111111@s.whatsapp.net",
      },
    ]);
  });

  it("marks accepted customer messages read and flags owner handover", async () => {
    const readKeys: unknown[] = [];
    const socket = {
      user: { id: "351920461967:1@s.whatsapp.net" },
      async readMessages(keys: unknown[]) {
        readKeys.push(...keys);
      },
    };
    const adapter = new WhatsAppAdapter({
      mode: "bot",
      allowFrom: ["351911111111"],
      forwardOwnerMessages: true,
      handoverMinutes: 5,
      sendReadReceipts: true,
    });
    Object.assign(adapter as object, { sock: socket, connected: true });
    const events: Array<{ fromOwner?: boolean; handoverActive?: boolean }> = [];
    adapter.onMessage(async (event) => {
      events.push(event);
    });
    const handleUpsert = (
      adapter as unknown as {
        handleMessageUpsert(socket: unknown, upsert: unknown): Promise<void>;
      }
    ).handleMessageUpsert.bind(adapter);
    const remoteJid = "351911111111@s.whatsapp.net";

    await handleUpsert(socket, {
      type: "notify",
      messages: [
        {
          key: { id: "owner-1", remoteJid, fromMe: true },
          messageTimestamp: 1,
          message: { conversation: "I will take this" },
        },
      ],
    });
    await handleUpsert(socket, {
      type: "notify",
      messages: [
        {
          key: { id: "customer-1", remoteJid, fromMe: false },
          messageTimestamp: 2,
          message: { conversation: "Thank you" },
        },
      ],
    });

    assert.equal(events[0].fromOwner, true);
    assert.equal(events[1].handoverActive, true);
    assert.equal(readKeys.length, 1);
  });

  it("edits live responses and sends native media and locations", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-media-test-"));
    tempDirs.push(parent);
    const imagePath = path.join(parent, "photo.png");
    fs.writeFileSync(imagePath, "png");
    const payloads: Array<Record<string, any>> = [];
    let sentId = 0;
    const socket = {
      async sendMessage(_chatId: string, payload: Record<string, any>) {
        payloads.push(payload);
        sentId += 1;
        return {
          key: { id: `sent-${sentId}`, remoteJid: "chat", fromMe: true },
          message: payload,
        };
      },
    };
    const adapter = new WhatsAppAdapter({ mode: "bot" });
    Object.assign(adapter as object, { sock: socket, connected: true });

    const ref = await adapter.sendMessageUpdate("chat", "draft");
    await adapter.sendMessageUpdate("chat", "**final**", undefined, ref);
    await adapter.sendMedia("chat", imagePath, "image", {
      mimeType: "image/png",
    });
    await adapter.sendLocation("chat", 38.7223, -9.1393, {
      name: "Lisbon",
    });

    assert.equal(ref?.messageId, "sent-1");
    assert.equal(payloads[1].text, "*final*");
    assert.equal(payloads[1].edit.id, "sent-1");
    assert.ok(Buffer.isBuffer(payloads[2].image));
    assert.equal(payloads[3].location.name, "Lisbon");
  });
});
