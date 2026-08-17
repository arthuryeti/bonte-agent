import { randomUUID } from "node:crypto";
import { BasePlatformAdapter } from "./base.js";
import type {
  MessageEvent,
  SendDocumentOptions,
  SendLocationOptions,
  SendOptions,
  SentMessageRef,
} from "../types.js";
import type { LeadListView, PropertyListView } from "../crm-ui.js";

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
  | "property.list.available"
  | "attachment.available"
  | "location.available";

export interface WebGatewayEvent<P = unknown> {
  event_id: string;
  sequence: number;
  type: WebGatewayEventType;
  session_id: string;
  turn_id?: string;
  payload?: P;
}

export type WebGatewayEventHandler = (event: WebGatewayEvent) => void;

type WebGatewayEventInput<P = unknown> = Omit<
  WebGatewayEvent<P>,
  "event_id" | "sequence"
>;

interface ActiveWebTurn {
  turnId: string;
  nextSequence: number;
}

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
  private activeTurns = new Map<string, ActiveWebTurn>();
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
    turnId: string = randomUUID(),
    agentText?: string
  ): Promise<void> {
    if (!this.connected) {
      throw new Error("web gateway is not connected");
    }
    if (this.activeTurns.has(sessionId)) {
      throw new Error("a turn is already running for this session");
    }

    this.activeTurns.set(sessionId, { turnId, nextSequence: 1 });
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
        turn_id: this.activeTurns.get(chatId)?.turnId,
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
    const delta = this.appendOnlyDelta(current, text);
    this.messageText.set(key, current + delta);

    if (delta) {
      this.publish({
        type: "message.delta",
        session_id: chatId,
        turn_id: this.activeTurns.get(chatId)?.turnId,
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

  /**
   * Browser message streams can only append; unlike Telegram or WhatsApp they
   * cannot replace an already emitted message. Agent tool turns sometimes
   * stream a short preamble followed by the final answer, then finalize with
   * just that answer. Preserve the preamble while avoiding a second copy of
   * the overlapping final text.
   */
  private appendOnlyDelta(current: string, next: string): string {
    if (!current) return next;
    if (next.startsWith(current)) return next.slice(current.length);
    if (current.endsWith(next)) return "";

    const maxOverlap = Math.min(current.length, next.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      if (current.endsWith(next.slice(0, length))) {
        return next.slice(length);
      }
    }

    return `${current.endsWith("\n") || next.startsWith("\n") ? "" : "\n\n"}${next}`;
  }

  async sendDocument(
    chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    this.publish({
      type: "attachment.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
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
      turn_id: this.activeTurns.get(chatId)?.turnId,
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
    payload: { run_id: string; tool_name: string; endpoint?: string }
  ): void {
    this.publish({
      type: "tool.start",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
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
      turn_id: this.activeTurns.get(chatId)?.turnId,
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
      turn_id: this.activeTurns.get(chatId)?.turnId,
      payload,
    });
  }

  publishLeadList(chatId: string, data: LeadListView, runId?: string): void {
    this.publish({
      type: "lead.list.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
      payload: { id: data.id, data, run_id: runId },
    });
  }

  publishPropertyList(chatId: string, data: PropertyListView, runId?: string): void {
    this.publish({
      type: "property.list.available",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
      payload: { id: data.id, data, run_id: runId },
    });
  }

  private publishMessageStart(chatId: string, messageId: string): void {
    this.publish({
      type: "message.start",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
      payload: { message_id: messageId },
    });
  }

  private publishMessageComplete(chatId: string, messageId: string): void {
    this.publish({
      type: "message.complete",
      session_id: chatId,
      turn_id: this.activeTurns.get(chatId)?.turnId,
      payload: { message_id: messageId },
    });
  }

  private publish(event: WebGatewayEventInput): void {
    const activeTurn = this.activeTurns.get(event.session_id);
    const turnId = event.turn_id ?? activeTurn?.turnId;
    const belongsToActiveTurn = Boolean(
      activeTurn && turnId === activeTurn.turnId
    );
    const sequence = belongsToActiveTurn ? activeTurn!.nextSequence++ : 0;
    const published: WebGatewayEvent = {
      ...event,
      event_id: turnId && sequence > 0
        ? `${turnId}:${sequence}`
        : randomUUID(),
      sequence,
      turn_id: turnId,
    };

    for (const listener of this.listeners) listener(published);
  }
}
