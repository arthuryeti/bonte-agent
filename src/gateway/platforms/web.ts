import { randomUUID } from "node:crypto";
import { BasePlatformAdapter } from "./base.js";
import type {
  MessageEvent,
  SendDocumentOptions,
  SendLocationOptions,
  SendOptions,
  SentMessageRef,
} from "../types.js";
import type { LeadListView } from "../crm-ui.js";

export type WebGatewayEventType =
  | "turn.start"
  | "turn.complete"
  | "turn.error"
  | "message.start"
  | "message.delta"
  | "message.complete"
  | "tool.start"
  | "tool.complete"
  | "tool.error"
  | "lead.list.available"
  | "attachment.available"
  | "location.available";

export interface WebGatewayEvent<P = unknown> {
  type: WebGatewayEventType;
  session_id: string;
  turn_id?: string;
  payload?: P;
}

export type WebGatewayEventHandler = (event: WebGatewayEvent) => void;

/**
 * In-process platform adapter used by the browser JSON-RPC transport.
 *
 * The adapter deliberately knows nothing about HTTP, React, or the AI SDK. It
 * translates the same Gateway delivery calls used by Telegram and WhatsApp
 * into transport-neutral events, keeping the agent and session lifecycle in
 * one long-running process.
 */
export class WebAdapter extends BasePlatformAdapter {
  readonly platform = "web" as const;

  private connected = false;
  private listeners = new Set<WebGatewayEventHandler>();
  private activeTurns = new Map<string, string>();
  private messageText = new Map<string, string>();

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.activeTurns.clear();
    this.messageText.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): string {
    return this.connected ? "connected" : "disconnected";
  }

  onEvent(handler: WebGatewayEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  async submit(
    sessionId: string,
    text: string,
    turnId = randomUUID(),
    agentText?: string
  ): Promise<void> {
    if (!this.connected) {
      throw new Error("web gateway is not connected");
    }
    if (this.activeTurns.has(sessionId)) {
      throw new Error("a turn is already running for this session");
    }

    this.activeTurns.set(sessionId, turnId);
    this.publish({ type: "turn.start", session_id: sessionId, turn_id: turnId });

    const event: MessageEvent = {
      id: turnId,
      platform: "web",
      chatId: sessionId,
      senderId: sessionId,
      senderName: "Web user",
      text,
      agentText,
      timestamp: new Date(),
      isGroup: false,
    };

    try {
      await this.emit(event);
      this.publish({ type: "turn.complete", session_id: sessionId, turn_id: turnId });
    } catch (error) {
      this.publish({
        type: "turn.error",
        session_id: sessionId,
        turn_id: turnId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      this.activeTurns.delete(sessionId);
      for (const key of this.messageText.keys()) {
        if (key.startsWith(`${sessionId}:`)) this.messageText.delete(key);
      }
    }
  }

  supportsMessageUpdates(): boolean {
    return true;
  }

  liveUpdateIntervalMs(): number {
    return 33;
  }

  liveUpdateMinChars(): number {
    return 24;
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: SendOptions
  ): Promise<void> {
    const messageId = randomUUID();
    this.publishMessageStart(chatId, messageId);
    if (text) {
      this.publish({
        type: "message.delta",
        session_id: chatId,
        turn_id: this.activeTurns.get(chatId),
        payload: { message_id: messageId, delta: text },
      });
    }
    this.publishMessageComplete(chatId, messageId);
  }

  async sendMessageUpdate(
    chatId: string,
    text: string,
    options?: SendOptions,
    ref?: SentMessageRef
  ): Promise<SentMessageRef> {
    const messageId = ref?.messageId ?? randomUUID();
    const key = `${chatId}:${messageId}`;
    const previous = this.messageText.get(key);

    if (previous === undefined) {
      this.messageText.set(key, "");
      this.publishMessageStart(chatId, messageId);
    }

    const current = this.messageText.get(key) ?? "";
    const delta = text.startsWith(current) ? text.slice(current.length) : text;
    this.messageText.set(key, text);

    if (delta) {
      this.publish({
        type: "message.delta",
        session_id: chatId,
        turn_id: this.activeTurns.get(chatId),
        payload: { message_id: messageId, delta },
      });
    }

    // Gateway uses plain mode for interim updates and markdown for its final
    // delivery, giving the adapter a transport-neutral completion signal.
    if (options?.parseMode === "markdown") {
      this.publishMessageComplete(chatId, messageId);
    }

    return { chatId, messageId };
  }

  async sendDocument(
    chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    this.publish({
      type: "attachment.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload: {
        file_name: options?.fileName,
        file_path: filePath,
        mime_type: options?.mimeType,
      },
    });
  }

  async sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    options?: SendLocationOptions
  ): Promise<void> {
    this.publish({
      type: "location.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload: {
        latitude,
        longitude,
        name: options?.name,
        address: options?.address,
      },
    });
  }

  publishToolStart(
    chatId: string,
    payload: { run_id: string; tool_name: string }
  ): void {
    this.publish({
      type: "tool.start",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload,
    });
  }

  publishToolComplete(
    chatId: string,
    payload: { run_id: string; tool_name: string }
  ): void {
    this.publish({
      type: "tool.complete",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload,
    });
  }

  publishToolError(
    chatId: string,
    payload: { run_id: string; tool_name: string; message: string }
  ): void {
    this.publish({
      type: "tool.error",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload,
    });
  }

  publishLeadList(chatId: string, data: LeadListView): void {
    this.publish({
      type: "lead.list.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload: { id: data.id, data },
    });
  }

  private publishMessageStart(chatId: string, messageId: string): void {
    this.publish({
      type: "message.start",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload: { message_id: messageId },
    });
  }

  private publishMessageComplete(chatId: string, messageId: string): void {
    this.publish({
      type: "message.complete",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId),
      payload: { message_id: messageId },
    });
  }

  private publish(event: WebGatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
