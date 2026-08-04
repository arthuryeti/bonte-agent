/**
 * WhatsApp platform adapter using Baileys.
 *
 * Connection and delivery behavior follows NousResearch/hermes-agent's
 * WhatsApp bridge. Hermes needs a Node sidecar because its gateway is Python;
 * this project is already Node.js, so the same behavior stays in-process.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { BasePlatformAdapter } from "./base.js";
import {
  clearWhatsAppAuthState,
  createBoundedIdTracker,
  createBoundedMessageStore,
  createHandoverTracker,
  createSerialQueue,
  createWhatsAppVersionResolver,
  formatWhatsAppText,
  getWhatsAppContextInfo,
  getWhatsAppMessageContent,
  isWhatsAppSelfChat,
  matchesWhatsAppAllowlist,
  normalizeWhatsAppIdentifier,
  resolveWhatsAppChatId,
  sanitizeWhatsAppText,
  splitWhatsAppMessage,
} from "./whatsapp-helpers.js";
import type { HandoverTracker } from "./whatsapp-helpers.js";
import type {
  MessageEvent,
  OutboundMediaType,
  SendDocumentOptions,
  SendLocationOptions,
  SendMediaOptions,
  SendOptions,
  SentMessageRef,
} from "../types.js";

export { clearWhatsAppAuthState } from "./whatsapp-helpers.js";

type WhatsAppConnectionState =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "waiting for QR scan"
  | "connected";

export type WhatsAppMode = "bot" | "self-chat";

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
  /** `bot` serves other chats; `self-chat` turns your own chat into the agent UI */
  mode?: WhatsAppMode;
  /** Prefix added to agent replies in self-chat mode */
  replyPrefix?: string;
  /** Forward owner-typed bot-mode messages to session history and start handover */
  forwardOwnerMessages?: boolean;
  /** Suppress bot replies for this many minutes after an owner message (default: 60) */
  handoverMinutes?: number;
  /** Send read receipts only for messages accepted by access policy */
  sendReadReceipts?: boolean;
  /** Edit one live response while the model streams (default: true) */
  streamUpdates?: boolean;
  /** Maximum text message size (default: 4096) */
  maxMessageLength?: number;
}

interface MessageEventOptions {
  fromOwner?: boolean;
  handoverActive?: boolean;
  skipAccessCheck?: boolean;
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
  private readonly outboundIds = createBoundedIdTracker(1024);
  private readonly processedIds = createBoundedIdTracker(2048);
  private readonly sendQueue = createSerialQueue();
  private readonly handovers: HandoverTracker;
  private ownerModeHintLogged = false;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = config;
    this.handovers = createHandoverTracker(
      this.handoverMinutes() * 60 * 1000
    );
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
      console.log(
        `[WhatsApp] connection established (mode: ${this.mode()})`
      );
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
    if (upsert.type !== "notify" && upsert.type !== "append") return;

    for (const msg of upsert.messages || []) {
      try {
        const messageId = msg.key?.id;
        const chatId = String(msg.key?.remoteJid || "");
        if (
          this.sock !== sock ||
          !msg.message ||
          this.processedIds.has(messageId) ||
          this.isBroadcastJid(chatId)
        ) {
          continue;
        }

        const fromMe = Boolean(msg.key?.fromMe);
        let event: MessageEvent | null = null;

        if (this.outboundIds.has(messageId)) continue;

        if (this.mode() === "self-chat") {
          if (!isWhatsAppSelfChat(chatId, sock, this.authDir())) {
            if (this.config.debug) {
              console.debug(
                `[WhatsApp] ignored non-self chat ${chatId} in self-chat mode`
              );
            }
            continue;
          }
          event = this.toMessageEvent(msg, sock, {
            skipAccessCheck: true,
          });
        } else if (fromMe) {
          if (!this.config.forwardOwnerMessages || chatId.endsWith("@g.us")) {
            if (!this.ownerModeHintLogged) {
              this.ownerModeHintLogged = true;
              console.warn(
                "[WhatsApp] ignored a linked-account message in bot mode; use WHATSAPP_MODE=self-chat to ask the agent from that account"
              );
            }
            continue;
          }
          event = this.toMessageEvent(msg, sock, { fromOwner: true });
          if (event) {
            this.handovers.activate(event.chatId);
            event.handoverActive = this.handovers.isActive(event.chatId);
          }
        } else {
          event = this.toMessageEvent(msg, sock);
          if (event) {
            event.handoverActive = this.handovers.isActive(event.chatId);
          }
        }

        if (!event) continue;
        this.processedIds.remember(messageId);
        this.messageStore.remember(msg);
        if (!fromMe) void this.markRead(sock, msg);
        await this.emit(event);
      } catch (err) {
        console.error(
          `[WhatsApp] failed to process message ${msg?.key?.id || "unknown"}:`,
          err
        );
      }
    }
  }

  private toMessageEvent(
    msg: any,
    sock: any,
    options: MessageEventOptions = {}
  ): MessageEvent | null {
    const sourceJid = String(msg.key?.remoteJid || "");
    if (!sourceJid || this.isBroadcastJid(sourceJid)) return null;
    const isGroup = sourceJid.endsWith("@g.us");
    const jid = resolveWhatsAppChatId(msg, this.authDir());

    if (this.config.debug && jid !== sourceJid) {
      console.debug(
        `[WhatsApp] routing direct-chat replies via ${jid} instead of ${sourceJid}`
      );
    }

    if (
      !options.skipAccessCheck &&
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
      !this.config.allowGroups.includes(sourceJid)
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
        (options.fromOwner
          ? sock.user?.lid || sock.user?.id
          : msg.key?.participantAlt ||
            msg.key?.participant ||
            msg.key?.remoteJidAlt ||
            jid),
      senderName: options.fromOwner ? "Owner" : msg.pushName || "Unknown",
      text,
      timestamp: new Date(
        Number.isFinite(timestampSeconds)
          ? timestampSeconds * 1000
          : Date.now()
      ),
      isGroup,
      replyTo: contextInfo.stanzaId,
      fromOwner: options.fromOwner,
      handoverActive: options.handoverActive,
    };
  }

  private async markRead(sock: any, msg: any): Promise<void> {
    if (
      !this.config.sendReadReceipts ||
      typeof sock.readMessages !== "function"
    ) {
      return;
    }
    try {
      await sock.readMessages([
        {
          remoteJid: msg.key?.remoteJid,
          id: msg.key?.id,
          participant: msg.key?.participant,
          fromMe: false,
        },
      ]);
    } catch (err) {
      console.warn("[WhatsApp] failed to send read receipt:", err);
    }
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
    const formattedText = this.formatOutgoingText(text, options?.parseMode);
    const chunks = splitWhatsAppMessage(
      formattedText,
      this.maxMessageLength()
    );
    const quoted = this.quotedMessageForChat(options?.replyTo, chatId);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.sendPayload(
        chatId,
        { text: chunks[index] },
        index === 0 && quoted ? { quoted } : undefined
      );
      if (index < chunks.length - 1) await this.sleep(this.chunkDelayMs());
    }
  }

  supportsMessageUpdates(): boolean {
    return this.config.streamUpdates !== false;
  }

  async sendMessageUpdate(
    chatId: string,
    text: string,
    options?: SendOptions,
    ref?: SentMessageRef
  ): Promise<SentMessageRef | undefined> {
    if (!this.supportsMessageUpdates()) {
      return super.sendMessageUpdate(chatId, text, options, ref);
    }

    const messageText = this.formatOutgoingText(text, options?.parseMode).slice(
      0,
      this.maxMessageLength()
    );
    if (!messageText) return ref;

    if (!ref) {
      const quoted = this.quotedMessageForChat(options?.replyTo, chatId);
      const sent = await this.sendPayload(
        chatId,
        { text: messageText },
        quoted ? { quoted } : undefined
      );
      return this.sentMessageRef(chatId, sent);
    }

    try {
      await this.sendPayload(chatId, {
        text: messageText,
        edit: {
          id: ref.messageId,
          remoteJid: ref.chatId || chatId,
          fromMe: true,
        },
      });
      return ref;
    } catch (err) {
      if (this.isUnchangedMessageError(err)) return ref;
      console.warn(
        "[WhatsApp] live message edit failed; continuing in a new message:",
        err
      );
      const sent = await this.sendPayload(chatId, { text: messageText });
      return this.sentMessageRef(chatId, sent);
    }
  }

  async sendDocument(
    chatId: string,
    filePath: string,
    options?: SendDocumentOptions
  ): Promise<void> {
    await this.sendMedia(chatId, filePath, "document", options);
  }

  async sendMedia(
    chatId: string,
    filePath: string,
    mediaType: OutboundMediaType,
    options?: SendMediaOptions
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      const fileName = options?.fileName || path.basename(filePath);
      await this.sendMessage(
        chatId,
        [options?.caption, `File unavailable: ${fileName}`]
          .filter(Boolean)
          .join("\n"),
        options
      );
      return;
    }

    const fileName = options?.fileName || path.basename(filePath);
    const quoted = this.quotedMessageForChat(options?.replyTo, chatId);
    let preparedPath = filePath;
    let cleanupDir: string | undefined;
    let preparedType = mediaType;
    let voice = options?.voice === true;
    let gifPlayback = options?.gifPlayback === true;

    try {
      const extension = path.extname(filePath).toLowerCase();
      if (mediaType === "image" && extension === ".gif") {
        const converted = await this.transcodeMedia(filePath, ".mp4", [
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-vf",
          "scale=max(2\\,trunc(min(640\\,iw)/2)*2):-2:flags=lanczos",
        ]);
        preparedPath = converted.filePath;
        cleanupDir = converted.cleanupDir;
        preparedType = "video";
        gifPlayback = true;
      } else if (
        mediaType === "audio" &&
        voice &&
        ![".ogg", ".opus"].includes(extension)
      ) {
        const converted = await this.transcodeMedia(filePath, ".ogg", [
          "-vn",
          "-c:a",
          "libopus",
          "-b:a",
          "64k",
          "-ar",
          "48000",
          "-ac",
          "1",
        ]);
        preparedPath = converted.filePath;
        cleanupDir = converted.cleanupDir;
      }
    } catch (err) {
      console.warn(
        `[WhatsApp] media conversion failed for ${fileName}; sending the original attachment:`,
        err
      );
      preparedPath = filePath;
      preparedType = mediaType;
      voice = mediaType === "audio" && [".ogg", ".opus"].includes(
        path.extname(filePath).toLowerCase()
      );
      gifPlayback = false;
    }

    let media: Buffer;
    try {
      media = fs.readFileSync(preparedPath);
    } catch (err) {
      if (cleanupDir) {
        await fs.promises.rm(cleanupDir, { recursive: true, force: true });
      }
      throw err;
    }
    const caption = options?.caption
      ? formatWhatsAppText(options.caption)
      : undefined;
    let payload: Record<string, unknown>;

    switch (preparedType) {
      case "image":
        payload = {
          image: media,
          caption,
          mimetype: options?.mimeType || this.mimeTypeForFile(preparedPath),
        };
        break;
      case "video":
        payload = {
          video: media,
          caption,
          mimetype:
            preparedPath === filePath && options?.mimeType
              ? options.mimeType
              : this.mimeTypeForFile(preparedPath),
          gifPlayback: gifPlayback || undefined,
        };
        break;
      case "audio":
        payload = {
          audio: media,
          mimetype:
            preparedPath === filePath && options?.mimeType
              ? options.mimeType
              : this.mimeTypeForFile(preparedPath),
          ptt: voice || undefined,
        };
        break;
      default:
        payload = {
          document: media,
          fileName,
          mimetype:
            options?.mimeType ||
            this.mimeTypeForFile(filePath) ||
            "application/octet-stream",
          caption,
        };
    }

    try {
      await this.sendPayload(
        chatId,
        payload,
        quoted ? { quoted } : undefined
      );
    } finally {
      if (cleanupDir) {
        await fs.promises.rm(cleanupDir, { recursive: true, force: true });
      }
    }
  }

  async sendLocation(
    chatId: string,
    latitude: number,
    longitude: number,
    options?: SendLocationOptions
  ): Promise<void> {
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error("WhatsApp location coordinates are out of range");
    }
    const quoted = this.quotedMessageForChat(options?.replyTo, chatId);
    await this.sendPayload(
      chatId,
      {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          name: options?.name,
          address: options?.address,
        },
      },
      quoted ? { quoted } : undefined
    );
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
        const sent = await Promise.race([
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
        this.messageStore.remember(sent);
        this.outboundIds.remember(sent?.key?.id);
        return sent;
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

  private mode(): WhatsAppMode {
    return this.config.mode === "self-chat" ? "self-chat" : "bot";
  }

  private handoverMinutes(): number {
    const configured = this.config.handoverMinutes ?? 60;
    return Number.isFinite(configured) && configured >= 0 ? configured : 60;
  }

  private maxMessageLength(): number {
    const configured = this.config.maxMessageLength ?? 4096;
    return Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : 4096;
  }

  private formatOutgoingText(
    text: string,
    parseMode: SendOptions["parseMode"]
  ): string {
    const formatted =
      parseMode === "plain"
        ? sanitizeWhatsAppText(text)
        : formatWhatsAppText(text);
    if (this.mode() !== "self-chat") return formatted;

    const prefix =
      this.config.replyPrefix === undefined
        ? "🤖 *Bonte CRM Agent*\n────────────\n"
        : this.config.replyPrefix;
    return prefix ? `${prefix}${formatted}` : formatted;
  }

  private sentMessageRef(
    chatId: string,
    sent: any
  ): SentMessageRef | undefined {
    const messageId = sent?.key?.id;
    return messageId ? { chatId, messageId } : undefined;
  }

  private quotedMessageForChat(
    messageId: string | undefined,
    chatId: string
  ): any | undefined {
    const quoted = this.messageStore.get(messageId);
    if (!quoted) return undefined;

    const quotedChatId = String(quoted.key?.remoteJid || "");
    if (!quotedChatId || quotedChatId === chatId) return quoted;

    // Do not attach an @lid-keyed quote to a PN-routed response. The answer is
    // still delivered, and avoiding the mixed addressing modes protects the
    // E2EE session that motivated the PN route in the first place.
    if (
      !quotedChatId.endsWith("@g.us") &&
      !chatId.endsWith("@g.us")
    ) {
      return undefined;
    }
    return quoted;
  }

  private isUnchangedMessageError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /not modified|unchanged|same message/i.test(message);
  }

  private mimeTypeForFile(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".png":
        return "image/png";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".mp4":
        return "video/mp4";
      case ".webm":
        return "video/webm";
      case ".mov":
        return "video/quicktime";
      case ".ogg":
      case ".opus":
        return "audio/ogg; codecs=opus";
      case ".mp3":
        return "audio/mpeg";
      case ".wav":
        return "audio/wav";
      case ".m4a":
        return "audio/mp4";
      case ".pdf":
        return "application/pdf";
      case ".docx":
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case ".xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case ".pptx":
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case ".csv":
        return "text/csv";
      case ".zip":
        return "application/zip";
      default:
        return "application/octet-stream";
    }
  }

  private async transcodeMedia(
    sourcePath: string,
    outputExtension: string,
    ffmpegArgs: string[]
  ): Promise<{ filePath: string; cleanupDir: string }> {
    const cleanupDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "bonte-whatsapp-")
    );
    const outputPath = path.join(cleanupDir, `converted${outputExtension}`);

    try {
      await new Promise<void>((resolve, reject) => {
        const process = spawn(
          "ffmpeg",
          ["-nostdin", "-y", "-i", sourcePath, ...ffmpegArgs, outputPath],
          { stdio: ["ignore", "ignore", "pipe"] }
        );
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          process.kill("SIGKILL");
        }, 60_000);
        process.stderr.on("data", (chunk) => {
          if (stderr.length < 4_000) stderr += String(chunk);
        });
        process.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        process.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                timedOut
                  ? "ffmpeg timed out after 60 seconds"
                  : `ffmpeg exited with code ${code}: ${stderr.trim().slice(-1000)}`
              )
            );
          }
        });
      });
      return { filePath: outputPath, cleanupDir };
    } catch (err) {
      await fs.promises.rm(cleanupDir, { recursive: true, force: true });
      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isConnected(): boolean {
    return this.connected;
  }

  status(): string {
    return this.connected
      ? `${this.connectionState} (${this.mode()})`
      : this.connectionState;
  }
}
