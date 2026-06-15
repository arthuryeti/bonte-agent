/**
 * Base platform adapter — inspired by Hermes Agent's BasePlatformAdapter.
 *
 * Every messaging platform (Telegram, WhatsApp, etc.) extends this
 * and implements the lifecycle and send methods.
 */

import type { MessageEvent, Platform, SendOptions } from "../types.js";

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

  /** Health check — is the adapter currently connected? */
  abstract isConnected(): boolean;

  /** Human-readable status for logging. */
  abstract status(): string;
}
