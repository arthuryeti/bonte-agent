/**
 * Base platform adapter — inspired by Hermes Agent's BasePlatformAdapter.
 *
 * Every messaging platform (Telegram, WhatsApp, etc.) extends this
 * and implements the lifecycle and send methods.
 */

import path from "node:path";
import type {
  MessageEvent,
  Platform,
  SendDocumentOptions,
  SendOptions,
  SentMessageRef,
} from "../types.js";

export type MessageHandler = (event: MessageEvent) => Promise<void>;

export abstract class BasePlatformAdapter {
  abstract readonly platform: Platform;

  private _handler?: MessageHandler;

  /** Called by the Gateway to attach the incoming-message handler. */
  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /** Subclasses call this when a new message arrives from the platform. */
  protected async emit(event: MessageEvent): Promise<void> {
    if (this._handler) {
      await this._handler(event);
    }
  }

  /** Connect to the platform API (start bot, open WebSocket, etc.). */
  abstract connect(): Promise<void>;

  /** Disconnect cleanly. */
  abstract disconnect(): Promise<void>;

  /** Send a text message to a chat. */
  abstract sendMessage(
    chatId: string,
    text: string,
    options?: SendOptions
  ): Promise<void>;

  /** Whether this adapter can edit a previously sent text message. */
  supportsMessageUpdates(): boolean {
    return false;
  }

  /** Show a short-lived platform action, such as Telegram's typing indicator. */
  async sendChatAction(_chatId: string, _action = "typing"): Promise<void> {
    // Not all platforms expose chat actions.
  }

  /** Send a new live message or update an existing one. */
  async sendMessageUpdate(
    chatId: string,
    text: string,
    options?: SendOptions,
    ref?: SentMessageRef
  ): Promise<SentMessageRef | undefined> {
    if (ref) return ref;
    await this.sendMessage(chatId, text, options);
    return undefined;
  }

  /** Send a local file as a downloadable document when the platform supports it. */
  async sendDocument(
    chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    const fileName = options?.fileName || path.basename(filePath);
    const text = [options?.caption, `File ready: ${fileName}`]
      .filter(Boolean)
      .join("\n");
    await this.sendMessage(chatId, text, options);
  }

  /** Health check — is the adapter currently connected? */
  abstract isConnected(): boolean;

  /** Human-readable status for logging. */
  abstract status(): string;
}
