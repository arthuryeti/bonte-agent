/**
 * WhatsApp platform adapter using Baileys.
 *
 * Connection and delivery behavior follows NousResearch/hermes-agent's
 * WhatsApp bridge. Hermes needs a Node sidecar because its gateway is Python;
 * this project is already Node.js, so the same behavior stays in-process.
 */

import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { BasePlatformAdapter } from "./base.js";
import {
  clearWhatsAppAuthState,
  createBoundedMessageStore,
  createSerialQueue,
  createWhatsAppVersionResolver,
  getWhatsAppContextInfo,
  getWhatsAppMessageContent,
  matchesWhatsAppAllowlist,
  normalizeWhatsAppIdentifier,
  splitWhatsAppMessage,
} from "./whatsapp-helpers.js";
import type {
  MessageEvent,
  SendDocumentOptions,
  SendOptions,
} from "../types.js";

export { clearWhatsAppAuthState } from "./whatsapp-helpers.js";

type WhatsAppConnectionState =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "waiting for QR scan"
  | "connected";

export interface WhatsAppConfig {
  /** Directory to store auth state (default: .whatsapp-auth) */
  authDir?: string;
  /** Phone numbers, JIDs, LIDs, or `*` allowed in DMs (empty = all) */
  allowFrom?: string[];
  /** Only respond in these groups (empty = all) */
  allowGroups?: string[];
  /** Require a mention, command, or reply to the bot in groups */
  requireMention?: boolean;
  /** Enable verbose Baileys logs (may include message metadata) */
  debug?: boolean;
  /** Timeout for one Baileys send operation (default: 60 seconds) */
  sendTimeoutMs?: number;
  /** Delay between long-message chunks (default: 300ms) */
  chunkDelayMs?: number;
}

export class WhatsAppAdapter extends BasePlatformAdapter {
  readonly platform = "whatsapp" as const;
  private config: WhatsAppConfig;
  private sock: any = null;
  private connected = false;
  private connectionState: WhatsAppConnectionState = "disconnected";
  private reconnectTimer?: NodeJS.Timeout;
  private connectPromise?: Promise<void>;
  private versionResolver?: () => Promise<readonly number[] | undefined>;
  private stopped = false;
  private lifecycleId = 0;
  private readonly messageStore = createBoundedMessageStore(512);
  private readonly sendQueue = createSerialQueue();

  constructor(config: WhatsAppConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.sock) return;
    if (this.connectPromise) return this.connectPromise;

    this.stopped = false;
    const lifecycleId = this.lifecycleId;
    const attempt = this.openSocket(lifecycleId);
    this.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    }
  }

  private async openSocket(lifecycleId: number): Promise<void> {
    this.connectionState = "connecting";
    console.log("[WhatsApp] starting adapter...");

    let baileys: any;
    try {
      baileys = await import("@whiskeysockets/baileys");
    } catch {
      throw new Error(
        "WhatsApp support requires @whiskeysockets/baileys. " +
          "Install it with: npm install @whiskeysockets/baileys"
      );
    }

    if (!this.versionResolver) {
      this.versionResolver = createWhatsAppVersionResolver(
        () => baileys.fetchLatestBaileysVersion(),
        { log: (message) => console.warn(message) }
      );
    }

    const authDir = this.authDir();
    const [{ state, saveCreds }, version] = await Promise.all([
      baileys.useMultiFileAuthState(authDir),
      this.versionResolver(),
    ]);

    if (this.stopped || lifecycleId !== this.lifecycleId) return;

    const logger = pino({ level: this.config.debug ? "debug" : "warn" });
    const sock = baileys.makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["Bonte CRM Agent", "Chrome", "120.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Baileys v7 uses this callback to re-establish missing E2EE sessions.
      getMessage: async (key: any) =>
        this.messageStore.get(key?.id)?.message || { conversation: "" },
    });
    this.sock = sock;

    sock.ev.on("creds.update", () => {
      void saveCreds().catch((err: unknown) => {
        console.error("[WhatsApp] failed to persist credentials:", err);
      });
    });

    sock.ev.on("connection.update", (update: any) => {
      if (this.sock !== sock) return;
      this.handleConnectionUpdate(sock, baileys, authDir, update);
    });

    sock.ev.on("messages.upsert", (upsert: any) => {
      if (this.sock !== sock) return;
      void this.handleMessageUpsert(sock, upsert).catch((err) => {
        console.error("[WhatsApp] failed to process incoming messages:", err);
      });
    });
  }

  private handleConnectionUpdate(
    sock: any,
    baileys: any,
    authDir: string,
    update: any
  ): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.connectionState = "waiting for QR scan";
      console.log("\n[WhatsApp] scan this QR code to pair:\n");
      qrcode.generate(qr, { small: true });
      console.log("\n[WhatsApp] waiting for scan...\n");
    }

    if (connection === "open") {
      this.connected = true;
      this.connectionState = "connected";
      console.log("[WhatsApp] connection established");
      return;
    }
    if (connection !== "close") return;

    this.connected = false;
    const rawStatusCode =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.statusCode;
    const statusCode = Number.isFinite(Number(rawStatusCode))
      ? Number(rawStatusCode)
      : undefined;
    const authWasRevoked =
      statusCode === baileys.DisconnectReason.loggedOut;
    const reconnectDelay =
      statusCode === baileys.DisconnectReason.restartRequired ? 1000 : 3000;

    this.detachSocket(sock);
    this.sock = null;
    if (this.stopped) return;

    if (authWasRevoked) {
      this.connectionState = "reconnecting";
      console.warn(
        "[WhatsApp] linked device was removed; clearing the revoked session so a new QR code can be generated"
      );
      void clearWhatsAppAuthState(authDir)
        .then(() => this.scheduleReconnect(1000))
        .catch((err) => {
          this.connectionState = "disconnected";
          console.error(
            `[WhatsApp] could not reset revoked authentication in ${authDir}:`,
            err
          );
        });
      return;
    }

    this.connectionState = "reconnecting";
    if (statusCode === baileys.DisconnectReason.restartRequired) {
      console.log(
        "[WhatsApp] WhatsApp requested restart (code 515); reconnecting..."
      );
    } else {
      console.warn(
        `[WhatsApp] connection closed (reason: ${
          statusCode ?? "unknown"
        }); reconnecting in ${reconnectDelay / 1000}s...`
      );
    }
    this.scheduleReconnect(reconnectDelay);
  }

  private scheduleReconnect(delayMs = 3000): void {
    if (this.stopped || this.reconnectTimer || this.sock) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((err) => {
        if (this.stopped) return;
        this.connectionState = "reconnecting";
        console.warn(
          "[WhatsApp] reconnect failed; retrying in 5s:",
          err
        );
        this.scheduleReconnect(5000);
      });
    }, delayMs);
  }

  private async handleMessageUpsert(sock: any, upsert: any): Promise<void> {
    if (upsert.type !== "notify") return;

    for (const msg of upsert.messages || []) {
      try {
        if (this.sock !== sock || msg.key?.fromMe || !msg.message) continue;
        const event = this.toMessageEvent(msg, sock);
        if (!event) continue;
        this.messageStore.remember(msg);
        await this.emit(event);
      } catch (err) {
        console.error(
          `[WhatsApp] failed to process message ${msg?.key?.id || "unknown"}:`,
          err
        );
      }
    }
  }

  private toMessageEvent(msg: any, sock: any): MessageEvent | null {
    const jid = String(msg.key?.remoteJid || "");
    if (!jid || this.isBroadcastJid(jid)) return null;
    const isGroup = jid.endsWith("@g.us");

    if (
      !isGroup &&
      !matchesWhatsAppAllowlist(
        [
          msg.key?.participant,
          msg.key?.participantAlt,
          msg.key?.remoteJid,
          msg.key?.remoteJidAlt,
        ],
        this.config.allowFrom,
        this.authDir()
      )
    ) {
      return null;
    }
    if (
      isGroup &&
      this.config.allowGroups?.length &&
      !this.config.allowGroups.includes("*") &&
      !this.config.allowGroups.includes(jid)
    ) {
      return null;
    }

    const messageContent = getWhatsAppMessageContent(msg);
    const contextInfo = getWhatsAppContextInfo(messageContent);
    let text = this.extractText(messageContent);
    if (!text) return null;

    if (
      isGroup &&
      this.config.requireMention &&
      !this.isGroupMessageForBot(text, contextInfo, sock)
    ) {
      return null;
    }
    if (isGroup) text = this.cleanBotMention(text, sock);

    const timestampSeconds = Number(msg.messageTimestamp);
    return {
      id: msg.key?.id || "",
      platform: "whatsapp",
      chatId: jid,
      senderId:
        msg.key?.participantAlt ||
        msg.key?.participant ||
        msg.key?.remoteJidAlt ||
        jid,
      senderName: msg.pushName || "Unknown",
      text,
      timestamp: new Date(
        Number.isFinite(timestampSeconds)
          ? timestampSeconds * 1000
          : Date.now()
      ),
      isGroup,
      replyTo: contextInfo.stanzaId,
    };
  }

  private extractText(messageContent: Record<string, any>): string {
    return (
      messageContent.conversation ||
      messageContent.extendedTextMessage?.text ||
      messageContent.imageMessage?.caption ||
      messageContent.videoMessage?.caption ||
      messageContent.documentMessage?.caption ||
      messageContent.buttonsResponseMessage?.selectedDisplayText ||
      messageContent.buttonsResponseMessage?.selectedButtonId ||
      messageContent.listResponseMessage?.title ||
      messageContent.listResponseMessage?.singleSelectReply?.selectedRowId ||
      messageContent.templateButtonReplyMessage?.selectedDisplayText ||
      messageContent.templateButtonReplyMessage?.selectedId ||
      ""
    );
  }

  private isGroupMessageForBot(
    text: string,
    contextInfo: Record<string, any>,
    sock: any
  ): boolean {
    if (text.trim().startsWith("/")) return true;

    const botIds = this.botIdentifiers(sock);
    const mentioned = new Set(
      (contextInfo.mentionedJid || [])
        .map(normalizeWhatsAppIdentifier)
        .filter(Boolean)
    );
    if ([...botIds].some((id) => mentioned.has(id))) return true;

    const quotedParticipant = normalizeWhatsAppIdentifier(
      contextInfo.participant
    );
    if (quotedParticipant && botIds.has(quotedParticipant)) return true;

    const lowerText = text.toLowerCase();
    return [...botIds].some(
      (id) => id && lowerText.includes(`@${id.toLowerCase()}`)
    );
  }

  private cleanBotMention(text: string, sock: any): string {
    let cleaned = text;
    for (const id of this.botIdentifiers(sock)) {
      cleaned = cleaned.replace(
        new RegExp(`@${this.escapeRegExp(id)}\\b[,;:\\-]*\\s*`, "gi"),
        ""
      );
    }
    return cleaned.trim() || text;
  }

  private botIdentifiers(sock: any): Set<string> {
    return new Set(
      [sock.user?.id, sock.user?.lid]
        .map(normalizeWhatsAppIdentifier)
        .filter(Boolean)
    );
  }

  private isBroadcastJid(jid: string): boolean {
    return (
      jid === "status@broadcast" ||
      jid.endsWith("@broadcast") ||
      jid.endsWith("@newsletter")
    );
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private authDir(): string {
    return this.config.authDir || ".whatsapp-auth";
  }

  private detachSocket(sock: any): void {
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("messages.upsert");
  }

  async disconnect(): Promise<void> {
    console.log("[WhatsApp] disconnecting...");
    this.stopped = true;
    this.lifecycleId += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sock) {
      const sock = this.sock;
      this.sock = null;
      this.detachSocket(sock);
      sock.end();
    }
    this.connected = false;
    this.connectionState = "disconnected";
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendOptions
  ): Promise<void> {
    const chunks = splitWhatsAppMessage(text, 4096);
    const quoted = this.messageStore.get(options?.replyTo);
    for (let index = 0; index < chunks.length; index += 1) {
      const sent = await this.sendPayload(
        chatId,
        { text: chunks[index] },
        index === 0 && quoted ? { quoted } : undefined
      );
      this.messageStore.remember(sent);
      if (index < chunks.length - 1) await this.sleep(this.chunkDelayMs());
    }
  }

  async sendDocument(
    chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      await super.sendDocument(chatId, filePath, {
        ...options,
        caption: "The generated file could not be attached.",
      });
      return;
    }

    const fileName = options?.fileName || path.basename(filePath);
    const quoted = this.messageStore.get(options?.replyTo);
    const sent = await this.sendPayload(
      chatId,
      {
        document: fs.readFileSync(filePath),
        fileName,
        mimetype: options?.mimeType || "application/pdf",
        caption: options?.caption,
      },
      quoted ? { quoted } : undefined
    );
    this.messageStore.remember(sent);
  }

  async sendChatAction(chatId: string, action = "typing"): Promise<void> {
    if (!this.sock || !this.connected) return;
    await this.sock.sendPresenceUpdate(
      action === "typing" ? "composing" : "available",
      chatId
    );
  }

  private async sendPayload(
    chatId: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<any> {
    const sock = this.sock;
    if (!sock || !this.connected) {
      throw new Error("WhatsApp not connected");
    }

    return this.sendQueue.enqueue(async () => {
      if (this.sock !== sock || !this.connected) {
        throw new Error("WhatsApp connection changed before send");
      }

      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          sock.sendMessage(chatId, payload, options || {}),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `WhatsApp send timed out after ${
                      this.sendTimeoutMs() / 1000
                    }s`
                  )
                ),
              this.sendTimeoutMs()
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }

  private sendTimeoutMs(): number {
    const configured = this.config.sendTimeoutMs ?? 60_000;
    return Number.isFinite(configured) && configured > 0
      ? configured
      : 60_000;
  }

  private chunkDelayMs(): number {
    const configured = this.config.chunkDelayMs ?? 300;
    return Number.isFinite(configured) && configured >= 0 ? configured : 300;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): string {
    return this.connectionState;
  }
}
