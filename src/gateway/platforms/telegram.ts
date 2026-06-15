/**
 * Telegram platform adapter using Grammy.
 *
 * Inspired by Hermes Agent's Telegram adapter, but simplified for
 * a TypeScript/Node.js environment.
 */

import { Bot, Context } from "grammy";
import { BasePlatformAdapter } from "./base.js";
import type { MessageEvent, SendOptions } from "../types.js";

const MARKDOWN_V2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_ESCAPE_RE, "\\$1");
}

function stripMarkdownV2(text: string): string {
  return text
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/~([^~]+)~/g, "$1")
    .replace(/\|\|([^|]+)\|\|/g, "$1");
}

export interface TelegramConfig {
  botToken: string;
  allowedUsers?: string[]; // comma-separated user IDs
  requireMention?: boolean;
}

export class TelegramAdapter extends BasePlatformAdapter {
  readonly platform = "telegram" as const;
  private bot: Bot;
  private connected = false;
  private config: TelegramConfig;

  constructor(config: TelegramConfig) {
    super();
    this.config = config;
    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Text messages
    this.bot.on("message:text", async (ctx) => {
      const event = this.toMessageEvent(ctx);
      if (!event) return;
      await this.emit(event);
    });

    // Catch errors
    this.bot.catch((err) => {
      console.error("[Telegram] bot error:", err);
    });
  }

  private toMessageEvent(ctx: Context): MessageEvent | null {
    const msg = ctx.message;
    if (!msg) return null;

    const chat = ctx.chat;
    const from = msg.from;
    if (!from || !chat) return null;

    // Allowlist check
    if (this.config.allowedUsers?.length) {
      const allowed = new Set(this.config.allowedUsers);
      if (!allowed.has(from.id.toString())) {
        return null;
      }
    }

    const chatId = chat.id.toString();
    const isGroup = chat.type === "group" || chat.type === "supergroup";

    // In groups, optionally require mention
    if (isGroup && this.config.requireMention) {
      const botUsername = ctx.me?.username;
      const text = msg.text || "";
      const mentioned = botUsername
        ? text.includes(`@${botUsername}`)
        : false;
      if (!mentioned) return null;
    }

    return {
      id: msg.message_id.toString(),
      platform: "telegram",
      chatId,
      senderId: from.id.toString(),
      senderName: from.username || from.first_name || "Unknown",
      text: msg.text || "",
      timestamp: new Date(msg.date * 1000),
      isGroup,
      replyTo: msg.reply_to_message?.message_id.toString(),
    };
  }

  async connect(): Promise<void> {
    console.log("[Telegram] starting bot...");
    await this.bot.init();
    this.connected = true;

    // Start polling in the background
    this.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (botInfo) => {
        console.log(`[Telegram] bot @${botInfo.username} is running`);
      },
    });
  }

  async disconnect(): Promise<void> {
    console.log("[Telegram] stopping bot...");
    this.connected = false;
    await this.bot.stop();
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendOptions
  ): Promise<void> {
    // Telegram has a 4096 char limit for text messages
    const parseMode = this.toTelegramParseMode(options?.parseMode);
    const formattedText =
      parseMode === "MarkdownV2" ? this.formatMarkdownV2(text) : text;
    const chunks = this.chunkText(formattedText, 4096);

    for (const chunk of chunks) {
      const payload = {
        parse_mode: parseMode,
        reply_parameters: options?.replyTo
          ? { message_id: parseInt(options.replyTo, 10) }
          : undefined,
      };

      try {
        await this.bot.api.sendMessage(chatId, chunk, payload);
      } catch (err) {
        if (parseMode !== "MarkdownV2" || !this.isMarkdownParseError(err)) {
          throw err;
        }

        console.warn(
          "[Telegram] MarkdownV2 parse failed, falling back to plain text:",
          err
        );
        await this.bot.api.sendMessage(chatId, stripMarkdownV2(chunk), {
          ...payload,
          parse_mode: undefined,
        });
      }
    }
  }

  private toTelegramParseMode(
    parseMode?: SendOptions["parseMode"]
  ): "MarkdownV2" | "HTML" | undefined {
    if (parseMode === "markdown") return "MarkdownV2";
    if (parseMode === "html") return "HTML";
    return undefined;
  }

  private formatMarkdownV2(content: string): string {
    if (!content) return content;

    const placeholders = new Map<string, string>();
    let counter = 0;
    const stash = (value: string): string => {
      const key = `\u0000PH${counter++}\u0000`;
      placeholders.set(key, value);
      return key;
    };

    let text = content;

    // Preserve fenced code blocks and inline code before escaping prose.
    text = text.replace(/```(?:[^\n]*\n)?[\s\S]*?```/g, (match) => {
      const openingEnd =
        match.indexOf("\n") >= 0 ? match.indexOf("\n") + 1 : 3;
      const opening = match.slice(0, openingEnd);
      const body = match.slice(openingEnd, -3);
      const escapedBody = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
      return stash(`${opening}${escapedBody}\`\`\``);
    });
    text = text.replace(/`[^`]+`/g, (match) =>
      stash(match.replace(/\\/g, "\\\\"))
    );

    text = text.replace(
      /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
      (_match, label: string, url: string) =>
        stash(
          `[${escapeMarkdownV2(label)}](${url
            .replace(/\\/g, "\\\\")
            .replace(/\)/g, "\\)")})`
        )
    );

    text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) =>
      stash(
        `*${escapeMarkdownV2(
          heading.replace(/\*\*(.+?)\*\*/g, "$1").trim()
        )}*`
      )
    );
    text = text.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) =>
      stash(`*${escapeMarkdownV2(inner)}*`)
    );
    text = text.replace(/\*([^*\n]+)\*/g, (_match, inner: string) =>
      stash(`_${escapeMarkdownV2(inner)}_`)
    );
    text = text.replace(/~~(.+?)~~/g, (_match, inner: string) =>
      stash(`~${escapeMarkdownV2(inner)}~`)
    );

    text = escapeMarkdownV2(text);

    for (const [key, value] of Array.from(placeholders.entries()).reverse()) {
      text = text.replaceAll(key, value);
    }

    return text;
  }

  private isMarkdownParseError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /parse|markdown|entity/i.test(message);
  }

  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      // Try to split at a newline near the limit
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
    return this.connected
      ? `connected (bot: ${this.bot.botInfo?.username ?? "?"})`
      : "disconnected";
  }
}
