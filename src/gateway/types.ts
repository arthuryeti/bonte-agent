/**
 * Core gateway types inspired by Hermes Agent's gateway architecture.
 *
 * Abstracts messaging platforms (Telegram, WhatsApp) behind a common
 * interface so the agent doesn't care where messages come from.
 */

export type Platform = "telegram" | "whatsapp" | "web" | "local";

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
  /** Optional private instruction used for the current agent turn only. */
  agentText?: string;
  /** When the message was sent */
  timestamp: Date;
  /** True if this is a group chat */
  isGroup: boolean;
  /** ID of message this is replying to */
  replyTo?: string;
  /** Any attached files */
  attachments?: Attachment[];
  /** True when this was typed by the linked WhatsApp account owner. */
  fromOwner?: boolean;
  /** True while a human owner has taken over this conversation. */
  handoverActive?: boolean;
}

export interface SendOptions {
  /** Reply to a specific message ID */
  replyTo?: string;
  /** Parse mode for rich text */
  parseMode?: "markdown" | "html" | "plain";
}

export interface SentMessageRef {
  /** Chat / group / channel ID */
  chatId: string;
  /** Platform-specific message ID */
  messageId: string;
}

export interface SendDocumentOptions extends SendOptions {
  /** Caption to send with the document when the platform supports it */
  caption?: string;
  /** Display filename for the uploaded document */
  fileName?: string;
  /** MIME type for the uploaded document */
  mimeType?: string;
}

export type OutboundMediaType = "image" | "video" | "audio" | "document";

export interface SendMediaOptions extends SendDocumentOptions {
  /** Send supported audio as a push-to-talk voice note. */
  voice?: boolean;
  /** Render a compatible video as an auto-looping GIF. */
  gifPlayback?: boolean;
}

export interface SendLocationOptions extends SendOptions {
  /** Optional place or business name. */
  name?: string;
  /** Optional human-readable address. */
  address?: string;
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
