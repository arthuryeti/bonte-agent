/**
 * WhatsApp platform adapter using Baileys.
 *
 * Inspired by Hermes Agent's WhatsApp bridge pattern, but implemented
 * directly in TypeScript since we're already in Node.js.
 *
 * Baileys connects via WhatsApp Web protocol (WebSocket-based).
 * On first connect, a QR code is printed to the terminal for pairing.
 * Session credentials are saved to disk so subsequent restarts don't
 * require re-pairing.
 */

import { BasePlatformAdapter } from "./base.js";
import type { MessageEvent, SendOptions } from "../types.js";

export interface WhatsAppConfig {
  /** Directory to store auth state (default: .whatsapp-auth) */
  authDir?: string;
  /** Only respond to these JIDs in DMs (empty = all) */
  allowFrom?: string[];
  /** Only respond in these groups (empty = all) */
  allowGroups?: string[];
  /** Require @mention in groups */
  requireMention?: boolean;
}

export class WhatsAppAdapter extends BasePlatformAdapter {
  readonly platform = "whatsapp" as const;
  private config: WhatsAppConfig;
  private sock: any = null;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    console.log("[WhatsApp] starting adapter...");

    // Dynamic import so the project compiles even if baileys isn't installed
    let baileys: any;
    try {
      baileys = await import("@whiskeysockets/baileys");
    } catch {
      throw new Error(
        "WhatsApp support requires @whiskeysockets/baileys.\n" +
          "Install it with: npm install @whiskeysockets/baileys\n" +
          "Note: this may require Python and build tools for native dependencies."
      );
    }

    const authDir = this.config.authDir || ".whatsapp-auth";
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);

    this.sock = baileys.makeWASocket({
      auth: state,
      printQRInTerminal: true,
      defaultQueryTimeoutMs: undefined,
    });

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds);

    // Connection state changes
    this.sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[WhatsApp] scan the QR code above to pair");
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect =
          statusCode !== baileys.DisconnectReason.loggedOut;

        console.log(
          `[WhatsApp] connection closed (reason: ${statusCode}), reconnect: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          this.scheduleReconnect();
        }
      } else if (connection === "open") {
        this.connected = true;
        console.log("[WhatsApp] connection established");
      }
    });

    // Incoming messages
    this.sock.ev.on("messages.upsert", async (upsert: any) => {
      if (upsert.type !== "notify") return;

      for (const msg of upsert.messages) {
        if (msg.key.fromMe) continue;
        const event = this.toMessageEvent(msg);
        if (!event) continue;
        await this.emit(event);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((err) => {
        console.error("[WhatsApp] reconnect failed:", err);
      });
    }, 5000);
  }

  private toMessageEvent(msg: any): MessageEvent | null {
    const jid: string = msg.key.remoteJid || "";
    const isGroup = jid.endsWith("@g.us");

    // Allowlist filters
    if (!isGroup && this.config.allowFrom?.length) {
      if (!this.config.allowFrom.includes(jid)) return null;
    }
    if (isGroup && this.config.allowGroups?.length) {
      if (!this.config.allowGroups.includes(jid)) return null;
    }

    // Extract text from various message types
    const messageContent = msg.message || {};
    let text = "";
    if (messageContent.conversation) {
      text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage?.text) {
      text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage?.caption) {
      text = messageContent.imageMessage.caption;
    } else if (messageContent.videoMessage?.caption) {
      text = messageContent.videoMessage.caption;
    }

    if (!text) return null; // Skip non-text messages for now

    return {
      id: msg.key.id || "",
      platform: "whatsapp",
      chatId: jid,
      senderId: msg.key.participant || jid,
      senderName: msg.pushName || "Unknown",
      text,
      timestamp: new Date(msg.messageTimestamp * 1000 || Date.now()),
      isGroup,
      replyTo: messageContent.extendedTextMessage?.contextInfo?.stanzaId,
    };
  }

  async disconnect(): Promise<void> {
    console.log("[WhatsApp] disconnecting...");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sock) {
      this.sock.end();
      this.sock = null;
    }
    this.connected = false;
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: SendOptions
  ): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");

    // WhatsApp practical limit ~4096 for readability
    const chunks = this.chunkText(text, 4096);
    for (const chunk of chunks) {
      await this.sock.sendMessage(chatId, { text: chunk });
    }
  }

  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let cutAt = remaining.lastIndexOf("\n", maxLength);
      if (cutAt <= 0) cutAt = maxLength;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).trimStart();
    }
    return chunks;
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): string {
    return this.connected ? "connected" : "disconnected";
  }
}
