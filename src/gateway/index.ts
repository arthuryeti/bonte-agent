/**
 * Gateway module exports.
 *
 * Re-exports the core pieces needed to wire the DeepAgent to
 * messaging platforms (Telegram, WhatsApp, etc.).
 */

export { Gateway } from "./gateway.js";
export { SessionStore } from "./session.js";
export { platformRegistry } from "./registry.js";
export { BasePlatformAdapter } from "./platforms/base.js";
export { TelegramAdapter } from "./platforms/telegram.js";
export { WhatsAppAdapter } from "./platforms/whatsapp.js";
export { WebAdapter } from "./platforms/web.js";
export { GatewayWebSocketServer } from "./websocket-server.js";
export type {
  WhatsAppConfig,
  WhatsAppMode,
} from "./platforms/whatsapp.js";

export type {
  Platform,
  PlatformConfig,
  GatewayConfig,
  MessageEvent,
  Attachment,
  OutboundMediaType,
  SendDocumentOptions,
  SendLocationOptions,
  SendMediaOptions,
  SendOptions,
  SentMessageRef,
} from "./types.js";
