import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DeepAgent } from "deepagents";
import { Gateway } from "../src/gateway/gateway.js";
import { BasePlatformAdapter } from "../src/gateway/platforms/base.js";
import { SessionStore } from "../src/gateway/session.js";
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

let tempDir = "";
let pdfPath = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-gateway-media-"));
  pdfPath = path.join(tempDir, "property-A444.pdf");
  fs.writeFileSync(pdfPath, "%PDF-1.4 test");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
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
      sessions
        .getMessages("whatsapp", "customer-chat")
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
    sessions.addAssistantMessage("telegram", "chat-1", "stale answer");

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
    assert.equal(sessions.getMessages("telegram", "chat-1").length, 0);
    assert.deepEqual(adapter.messages, [
      "Conversation reset. I’ll use a fresh context for your next request.",
    ]);
  });

  it("sends a successful PDF tool result even when final prose omits MEDIA", async () => {
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
          {
            content: JSON.stringify({
              success: true,
              mediaTag: `MEDIA:${pdfPath}`,
            }),
          },
          runId
        );

        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The brochure for A444 is ready.",
                },
              ],
            },
          ],
        };
      },
    } as unknown as DeepAgent;

    const gateway = new Gateway(fakeAgent, {
      platforms: [],
      resetPolicy: "after_minutes",
      resetAfterMinutes: 60,
    });
    const adapter = new RecordingAdapter();
    (
      gateway as unknown as {
        adapters: Map<string, BasePlatformAdapter>;
      }
    ).adapters.set("telegram", adapter);

    const event: MessageEvent = {
      id: "message-1",
      platform: "telegram",
      chatId: "chat-1",
      senderId: "user-1",
      senderName: "Tester",
      text: "Create a PDF for A444",
      timestamp: new Date(),
      isGroup: false,
    };

    await (
      gateway as unknown as {
        handleMessage(message: MessageEvent): Promise<void>;
      }
    ).handleMessage(event);

    assert.deepEqual(adapter.messages, ["The brochure for A444 is ready."]);
    assert.equal(adapter.documents.length, 1);
    assert.equal(adapter.documents[0].filePath, pdfPath);
    assert.equal(adapter.documents[0].options?.mimeType, "application/pdf");
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
