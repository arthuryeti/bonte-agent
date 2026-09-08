import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DeepAgent } from "deepagents";
import { Gateway } from "../src/gateway/gateway.js";
import { BasePlatformAdapter } from "../src/gateway/platforms/base.js";
import { SessionStore } from "../src/gateway/session.js";
import { MemoryWorkflowStore, setWorkflowStore } from "../src/workflows/store.js";
import { saveGeneratedAttachment } from "../src/workflows/documents-attachments.js";
import { ensureTestS3 } from "./s3-harness.js";
import type {
  MessageEvent,
  OutboundMediaType,
  SendDocumentOptions,
  SendLocationOptions,
  SendMediaOptions,
  SendOptions,
} from "../src/gateway/types.js";

class RecordingAdapter extends BasePlatformAdapter {
  readonly platform = "telegram" as const;
  messages: string[] = [];
  documents: Array<{ filePath: string; options?: SendDocumentOptions }> = [];
  media: Array<{
    filePath: string;
    type: OutboundMediaType;
    options?: SendMediaOptions;
  }> = [];
  locations: Array<{
    latitude: number;
    longitude: number;
    options?: SendLocationOptions;
  }> = [];

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  status(): string {
    return "connected";
  }
  async sendMessage(
    _chatId: string,
    text: string,
    _options?: SendOptions
  ): Promise<void> {
    this.messages.push(text);
  }
  async sendDocument(
    _chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    this.documents.push({ filePath, options });
  }
  async sendMedia(
    _chatId: string,
    filePath: string,
    type: OutboundMediaType,
    options?: SendMediaOptions
  ): Promise<void> {
    this.media.push({ filePath, type, options });
  }
  async sendLocation(
    _chatId: string,
    latitude: number,
    longitude: number,
    options?: SendLocationOptions
  ): Promise<void> {
    this.locations.push({ latitude, longitude, options });
  }
}

beforeEach(async () => {
  await ensureTestS3();
  setWorkflowStore(new MemoryWorkflowStore());
});

describe("gateway document delivery", () => {
  it("stores human replies and suppresses the agent during handover", async () => {
    let invocations = 0;
    const fakeAgent = {
      async invoke() {
        invocations += 1;
        return { messages: [] };
      },
    } as unknown as DeepAgent;
    const gateway = new Gateway(fakeAgent, { platforms: [] });
    const handleMessage = (
      gateway as unknown as {
        handleMessage(message: MessageEvent): Promise<void>;
      }
    ).handleMessage.bind(gateway);

    await handleMessage({
      id: "owner-message",
      platform: "whatsapp",
      chatId: "customer-chat",
      senderId: "owner",
      senderName: "Owner",
      text: "I can help you personally.",
      timestamp: new Date(),
      isGroup: false,
      fromOwner: true,
      handoverActive: true,
    });
    await handleMessage({
      id: "customer-message",
      platform: "whatsapp",
      chatId: "customer-chat",
      senderId: "customer",
      senderName: "Customer",
      text: "Thank you.",
      timestamp: new Date(),
      isGroup: false,
      handoverActive: true,
    });

    const sessions = (
      gateway as unknown as { sessions: SessionStore }
    ).sessions;
    assert.equal(invocations, 0);
    assert.deepEqual(
      (await sessions.getMessages("whatsapp", "customer-chat"))
        .map(({ role, content }) => ({ role, content })),
      [
        { role: "assistant", content: "I can help you personally." },
        { role: "user", content: "Thank you." },
      ]
    );
  });

  it("clears chat history without invoking the agent for /reset", async () => {
    let invoked = false;
    const fakeAgent = {
      async invoke() {
        invoked = true;
        return { messages: [] };
      },
    } as unknown as DeepAgent;

    const gateway = new Gateway(fakeAgent, { platforms: [] });
    const adapter = new RecordingAdapter();
    (
      gateway as unknown as {
        adapters: Map<string, BasePlatformAdapter>;
      }
    ).adapters.set("telegram", adapter);

    const sessions = (
      gateway as unknown as {
        sessions: SessionStore;
      }
    ).sessions;
    await sessions.addAssistantMessage("telegram", "chat-1", "stale answer");

    const event: MessageEvent = {
      id: "message-reset",
      platform: "telegram",
      chatId: "chat-1",
      senderId: "user-1",
      senderName: "Tester",
      text: "/reset",
      timestamp: new Date(),
      isGroup: false,
    };

    await (
      gateway as unknown as {
        handleMessage(message: MessageEvent): Promise<void>;
      }
    ).handleMessage(event);

    assert.equal(invoked, false);
    assert.equal((await sessions.getMessages("telegram", "chat-1")).length, 0);
    assert.deepEqual(adapter.messages, [
      "Conversation reset. I’ll use a fresh context for your next request.",
    ]);
  });

  it("sends a successful PDF tool result even when final prose omits MEDIA", async () => {
    const saved = await saveGeneratedAttachment(
      { workspaceId: "telegram:chat-1", conversationId: "chat-1", actorId: "user-1" },
      { fileName: "property-A444.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") },
    );
    const fakeAgent = {
      async invoke(_input: unknown, options: unknown) {
        const callbacks = (
          options as {
            callbacks: Array<{
              handleToolStart(
                tool: unknown,
                input: string,
                runId: string,
                parentRunId?: string,
                tags?: string[],
                metadata?: Record<string, unknown>,
                runName?: string
              ): void;
              handleToolEnd(output: unknown, runId: string): void;
            }>;
          }
        ).callbacks;
        const callback = callbacks[0];
        const runId = "pdf-tool-run";
        callback.handleToolStart(
          { name: "generate_property_pdf" },
          '{"reference":"A444"}',
          runId,
          undefined,
          undefined,
          undefined,
          "generate_property_pdf"
        );
        callback.handleToolEnd(
          { content: JSON.stringify({ success: true, fileName: saved.fileName, attachmentId: saved.id, downloadName: "property-A444.pdf" }) },
          runId
        );
        return { messages: [{ role: "assistant", content: [{ type: "text", text: "The brochure for A444 is ready." }] }] };
      },
    } as unknown as DeepAgent;
    const sessions = new SessionStore({ databaseUrl: "", databaseHost: "", allowInMemory: true });
    const gateway = new Gateway(fakeAgent, { platforms: [], resetPolicy: "after_minutes", resetAfterMinutes: 60 }, sessions);
    const adapter = new RecordingAdapter();
    const send = adapter.sendDocument.bind(adapter);
    adapter.sendDocument = async (chatId, filePath, options) => {
      assert.equal(fs.existsSync(filePath), true);
      assert.deepEqual(fs.readFileSync(filePath), Buffer.from("%PDF-1.4 test"));
      await send(chatId, filePath, options);
    };
    (gateway as unknown as { adapters: Map<string, BasePlatformAdapter> }).adapters.set("telegram", adapter);
    const event: MessageEvent = {
      id: "message-1", platform: "telegram", chatId: "chat-1", senderId: "user-1",
      senderName: "Tester", text: "Create a PDF for A444", timestamp: new Date(), isGroup: false,
    };
    await (gateway as unknown as { handleMessage(message: MessageEvent): Promise<void> }).handleMessage(event);
    assert.deepEqual(adapter.messages, ["The brochure for A444 is ready."]);
    assert.equal(adapter.documents.length, 1);
    assert.equal(fs.existsSync(adapter.documents[0].filePath), false);
    assert.equal(adapter.documents[0].options?.mimeType, "application/pdf");
    assert.equal(adapter.documents[0].options?.fileName, "property-A444.pdf");
    const assistant = (await sessions.getMessages("telegram", "chat-1")).find((message) => message.role === "assistant");
    assert.equal(assistant?.dataParts?.[0]?.type, "attachment");
    const attachment = assistant?.dataParts?.[0]?.data;
    assert.ok(attachment && typeof attachment === "object" && "fileName" in attachment);
    assert.equal(attachment.fileName, "property-A444.pdf");
  });

  it("deletes the native brochure temp file when send fails", async () => {
    const bytes = Buffer.from("%PDF-1.4 fail");
    const saved = await saveGeneratedAttachment(
      { workspaceId: "telegram:chat-fail", conversationId: "chat-fail", actorId: "user-1" },
      { fileName: "property-FAIL.pdf", mimeType: "application/pdf", bytes },
    );
    const fakeAgent = {
      async invoke(_input: unknown, options: unknown) {
        const callbacks = (
          options as {
            callbacks: Array<{
              handleToolStart(tool: unknown, input: string, runId: string, parentRunId?: string, tags?: string[], metadata?: Record<string, unknown>, runName?: string): void;
              handleToolEnd(output: unknown, runId: string): void;
            }>;
          }
        ).callbacks;
        callbacks[0].handleToolStart({ name: "generate_property_pdf" }, "{}", "pdf-fail", undefined, undefined, undefined, "generate_property_pdf");
        callbacks[0].handleToolEnd(JSON.stringify({ success: true, fileName: saved.fileName, attachmentId: saved.id, downloadName: "property-FAIL.pdf" }), "pdf-fail");
        return { messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }] };
      },
    } as unknown as DeepAgent;
    const gateway = new Gateway(fakeAgent, { platforms: [] }, new SessionStore({ databaseUrl: "", databaseHost: "", allowInMemory: true }));
    const adapter = new RecordingAdapter();
    let temp = "";
    adapter.sendDocument = async (_chatId, filePath) => {
      temp = filePath;
      assert.equal(fs.existsSync(filePath), true);
      throw new Error("send failed");
    };
    (gateway as unknown as { adapters: Map<string, BasePlatformAdapter> }).adapters.set("telegram", adapter);
    await assert.rejects(
      () => (gateway as unknown as { handleMessage(message: MessageEvent): Promise<void> }).handleMessage({
        id: "message-fail", platform: "telegram", chatId: "chat-fail", senderId: "user-1",
        senderName: "Tester", text: "PDF", timestamp: new Date(), isGroup: false,
      }),
      /send failed/,
    );
    assert.ok(temp);
    assert.equal(fs.existsSync(temp), false);
  });

  it("sends a visible fallback instead of silently dropping an empty agent reply", async () => {
    const fakeAgent = {
      async invoke() {
        return {
          messages: [{ role: "assistant", content: [] }],
        };
      },
    } as unknown as DeepAgent;

    const gateway = new Gateway(fakeAgent, { platforms: [] });
    const adapter = new RecordingAdapter();
    (
      gateway as unknown as {
        adapters: Map<string, BasePlatformAdapter>;
      }
    ).adapters.set("telegram", adapter);

    const event: MessageEvent = {
      id: "message-empty",
      platform: "telegram",
      chatId: "chat-1",
      senderId: "user-1",
      senderName: "Tester",
      text: "Can you give me the last leads?",
      timestamp: new Date(),
      isGroup: false,
    };

    await (
      gateway as unknown as {
        handleMessage(message: MessageEvent): Promise<void>;
      }
    ).handleMessage(event);

    assert.deepEqual(adapter.messages, [
      "I couldn’t produce a usable response. Please try again; if this was a CRM request, check the CRM connection logs.",
    ]);
  });
});
