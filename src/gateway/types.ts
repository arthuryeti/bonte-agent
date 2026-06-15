/**
 * Core gateway types inspired by Hermes Agent's gateway architecture.
 *
 * Abstracts messaging platforms (Telegram, WhatsApp) behind a common
 * interface so the agent doesn't care where messages come from.
 */

export type Platform = "telegram" | "whatsapp" | "local";

export interface Attachment {
  type: "image" | "audio" | "video" | "document";
  url?: string;
  buffer?: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface MessageEvent {
  /** Unique message ID from the platform */
  id: string;
  /** Which platform this came from */
  platform: Platform;
  /** Chat / group / channel ID */
  chatId: string;
  /** Sender's platform-specific ID */
  senderId: string;
  /** Sender's display name */
  senderName: string;
  /** Message text content */
  text: string;
  /** When the message was sent */
  timestamp: Date;
  /** True if this is a group chat */
  isGroup: boolean;
  /** ID of message this is replying to */
  replyTo?: string;
  /** Any attached files */
  attachments?: Attachment[];
}

export interface SendOptions {
  /** Reply to a specific message ID */
  replyTo?: string;
  /** Parse mode for rich text */
  parseMode?: "markdown" | "html" | "plain";
}

export interface PlatformConfig {
  /** Is this platform enabled? */
  enabled: boolean;
  /** Platform identifier */
  platform: Platform;
  /** Default chat ID for cron / outbound delivery */
  homeChannel?: string;
  /** Platform-specific extra config */
  extra?: Record<string, unknown>;
}

export interface GatewayConfig {
  /** Platform configurations */
  platforms: PlatformConfig[];
  /** Session reset policy: "never" | "after_minutes" | "daily" */
  resetPolicy?: "never" | "after_minutes" | "daily";
  /** Minutes of inactivity before resetting session (when resetPolicy="after_minutes") */
  resetAfterMinutes?: number;
}
