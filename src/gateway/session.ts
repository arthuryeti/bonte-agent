/**
 * Durable per-chat session storage.
 *
 * PostgreSQL is the canonical runtime store. Drizzle owns its schema and
 * migrations; an explicit in-memory mode keeps isolated unit tests lightweight
 * without allowing a real gateway to start ephemerally by accident.
 */

import { Pool, type PoolClient } from "pg";
import type { MessageEvent } from "./types.js";

const DEFAULT_CHAT_TITLE = "New conversation";
const DEFAULT_RECENT_LIMIT = 50;

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  platformMessageId?: string;
  dataParts?: ChatMessageDataPart[];
}

export interface ChatMessageDataPart {
  type: "lead-list";
  id: string;
  data: unknown;
}

export interface ChatSession {
  chatId: string;
  platform: string;
  title: string;
  createdAt: Date;
  messages: ChatMessage[];
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

export interface RecentChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStoreOptions {
  databaseUrl?: string;
  databaseHost?: string;
  databasePort?: number;
  databaseName?: string;
  databaseUser?: string;
  databasePassword?: string;
  databaseSsl?: boolean;
  databaseSslRejectUnauthorized?: boolean;
  maxConnections?: number;
  /** Test-only escape hatch. Runtime gateways must use durable storage. */
  allowInMemory?: boolean;
}

interface SessionRow {
  chat_id: string;
  platform: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  role: ChatMessage["role"];
  content: string;
  platform_message_id: string | null;
  data_parts: unknown;
  created_at: Date;
}

function titleFromMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return DEFAULT_CHAT_TITLE;
  if (singleLine.length <= 64) return singleLine;
  return `${singleLine.slice(0, 61).trimEnd()}…`;
}

function asDataParts(value: unknown): ChatMessageDataPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((part): part is ChatMessageDataPart => {
    if (!part || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return (
      record.type === "lead-list" &&
      typeof record.id === "string" &&
      "data" in record
    );
  });
  return parts.length > 0 ? parts : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export class SessionStore {
  private sessions = new Map<string, ChatSession>();
  private loadingSessions = new Map<string, Promise<ChatSession>>();
  private pool?: Pool;
  private readonly options: Required<SessionStoreOptions>;

  constructor(options: SessionStoreOptions = {}) {
    this.options = {
      databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL ?? "",
      databaseHost: options.databaseHost ?? process.env.DATABASE_HOST ?? "",
      databasePort:
        options.databasePort ?? positiveInteger(process.env.DATABASE_PORT, 5432),
      databaseName:
        options.databaseName ?? process.env.DATABASE_NAME ?? "crm_agent",
      databaseUser:
        options.databaseUser ?? process.env.DATABASE_USER ?? "crm_agent",
      databasePassword:
        options.databasePassword ?? process.env.DATABASE_PASSWORD ?? "",
      databaseSsl:
        options.databaseSsl ?? process.env.DATABASE_SSL === "true",
      databaseSslRejectUnauthorized:
        options.databaseSslRejectUnauthorized ??
        process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
      maxConnections:
        options.maxConnections ??
        positiveInteger(process.env.DATABASE_POOL_MAX, 10),
      allowInMemory: options.allowInMemory ?? false,
    };
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }
    if (!this.options.databaseUrl && !this.options.databaseHost) {
      if (this.options.allowInMemory) return;
      throw new Error(
        "DATABASE_URL or DATABASE_HOST is required so chats and messages are durable",
      );
    }
    this.pool = new Pool({
      ...(this.options.databaseUrl
        ? { connectionString: this.options.databaseUrl }
        : {
            host: this.options.databaseHost,
            port: this.options.databasePort,
            database: this.options.databaseName,
            user: this.options.databaseUser,
            password: this.options.databasePassword,
          }),
      max: this.options.maxConnections,
      ssl: this.options.databaseSsl
        ? { rejectUnauthorized: this.options.databaseSslRejectUnauthorized }
        : undefined,
    });

    try {
      await Promise.all([
        this.pool.query("SELECT 1 FROM gateway_sessions LIMIT 0"),
        this.pool.query("SELECT 1 FROM gateway_messages LIMIT 0"),
      ]);
      this.pool.on("error", (error) => {
        console.error("[Gateway] PostgreSQL session pool error:", error);
      });
      console.log("[Gateway] PostgreSQL session store connected");
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    this.sessions.clear();
    this.loadingSessions.clear();
    await pool?.end();
  }

  private key(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  async ensureSession(platform: string, chatId: string): Promise<ChatSession> {
    return this.getSession(platform, chatId);
  }

  async getSession(platform: string, chatId: string): Promise<ChatSession> {
    const key = this.key(platform, chatId);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const loading = this.loadingSessions.get(key);
    if (loading) return loading;

    const promise = this.loadSession(platform, chatId);
    this.loadingSessions.set(key, promise);
    try {
      const session = await promise;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.loadingSessions.delete(key);
    }
  }

  private async loadSession(platform: string, chatId: string): Promise<ChatSession> {
    if (!this.pool) {
      const now = new Date();
      return {
        chatId,
        platform,
        title: DEFAULT_CHAT_TITLE,
        createdAt: now,
        messages: [],
        lastActivity: now,
        metadata: {},
      };
    }

    await this.pool.query(
      `INSERT INTO gateway_sessions (platform, chat_id)
       VALUES ($1, $2)
       ON CONFLICT (platform, chat_id) DO NOTHING`,
      [platform, chatId]
    );

    const [sessionResult, messageResult] = await Promise.all([
      this.pool.query<SessionRow>(
        `SELECT platform, chat_id, title, created_at, updated_at
         FROM gateway_sessions
         WHERE platform = $1 AND chat_id = $2`,
        [platform, chatId]
      ),
      this.pool.query<MessageRow>(
        `SELECT role, content, platform_message_id, data_parts, created_at
         FROM gateway_messages
         WHERE platform = $1 AND chat_id = $2
         ORDER BY id ASC`,
        [platform, chatId]
      ),
    ]);

    const row = sessionResult.rows[0];
    if (!row) throw new Error("failed to create gateway session");

    return {
      chatId: row.chat_id,
      platform: row.platform,
      title: row.title,
      createdAt: row.created_at,
      lastActivity: row.updated_at,
      messages: messageResult.rows.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.created_at,
        platformMessageId: message.platform_message_id ?? undefined,
        dataParts: asDataParts(message.data_parts),
      })),
      metadata: {},
    };
  }

  async addUserMessage(event: MessageEvent): Promise<ChatMessage> {
    const session = await this.getSession(event.platform, event.chatId);
    const existing = event.id
      ? session.messages.find(
          (message) => message.platformMessageId === event.id
        )
      : undefined;
    if (existing) return existing;

    const message: ChatMessage = {
      role: "user",
      content: event.text,
      timestamp: event.timestamp,
      platformMessageId: event.id,
    };
    const nextTitle =
      session.title === DEFAULT_CHAT_TITLE
        ? titleFromMessage(event.text)
        : session.title;
    const inserted = await this.persistMessage(
      event.platform,
      event.chatId,
      message,
      nextTitle
    );

    if (inserted) session.messages.push(message);
    session.title = nextTitle;
    session.lastActivity = new Date();
    return message;
  }

  async addAssistantMessage(
    platform: string,
    chatId: string,
    content: string,
    platformMessageId?: string,
    dataParts?: ChatMessageDataPart[]
  ): Promise<ChatMessage> {
    const session = await this.getSession(platform, chatId);
    const existing = platformMessageId
      ? session.messages.find(
          (message) => message.platformMessageId === platformMessageId
        )
      : undefined;
    if (existing) return existing;

    const message: ChatMessage = {
      role: "assistant",
      content,
      timestamp: new Date(),
      platformMessageId,
      dataParts,
    };
    const inserted = await this.persistMessage(
      platform,
      chatId,
      message,
      session.title
    );
    if (inserted) session.messages.push(message);
    session.lastActivity = new Date();
    return message;
  }

  private async persistMessage(
    platform: string,
    chatId: string,
    message: ChatMessage,
    title: string
  ): Promise<boolean> {
    if (!this.pool) return true;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO gateway_messages (
           platform, chat_id, role, content, platform_message_id, data_parts, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (platform, chat_id, platform_message_id) DO NOTHING`,
        [
          platform,
          chatId,
          message.role,
          message.content,
          message.platformMessageId ?? null,
          JSON.stringify(message.dataParts ?? []),
          message.timestamp,
        ]
      );
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE gateway_sessions
           SET title = $3, updated_at = NOW()
           WHERE platform = $1 AND chat_id = $2`,
          [platform, chatId, title]
        );
      }
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async rollback(client: PoolClient): Promise<void> {
    await client.query("ROLLBACK").catch(() => undefined);
  }

  async getMessages(platform: string, chatId: string): Promise<ChatMessage[]> {
    return (await this.getSession(platform, chatId)).messages;
  }

  async hasMessage(
    platform: string,
    chatId: string,
    platformMessageId: string
  ): Promise<boolean> {
    if (!platformMessageId) return false;
    return (await this.getSession(platform, chatId)).messages.some(
      (message) => message.platformMessageId === platformMessageId
    );
  }

  async listSessions(
    platform: string,
    limit = DEFAULT_RECENT_LIMIT,
    chatIdPrefix = ""
  ): Promise<RecentChatSession[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    if (this.pool) {
      const result = await this.pool.query<SessionRow>(
        `SELECT platform, chat_id, title, created_at, updated_at
         FROM gateway_sessions
         WHERE platform = $1
           AND ($3 = '' OR LEFT(chat_id, LENGTH($3)) = $3)
         ORDER BY updated_at DESC
         LIMIT $2`,
        [platform, boundedLimit, chatIdPrefix]
      );
      return result.rows.map((row) => ({
        id: row.chat_id,
        title: row.title,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    }

    return [...this.sessions.values()]
      .filter((session) => session.platform === platform)
      .filter((session) => session.chatId.startsWith(chatIdPrefix))
      .sort((left, right) => right.lastActivity.getTime() - left.lastActivity.getTime())
      .slice(0, boundedLimit)
      .map((session) => ({
        id: session.chatId,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.lastActivity.toISOString(),
      }));
  }

  async clearSession(platform: string, chatId: string): Promise<void> {
    const key = this.key(platform, chatId);
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM gateway_messages WHERE platform = $1 AND chat_id = $2`,
          [platform, chatId]
        );
        await client.query(
          `UPDATE gateway_sessions
           SET title = $3, updated_at = NOW()
           WHERE platform = $1 AND chat_id = $2`,
          [platform, chatId, DEFAULT_CHAT_TITLE]
        );
        await client.query("COMMIT");
      } catch (error) {
        await this.rollback(client);
        throw error;
      } finally {
        client.release();
      }
    }

    const session = this.sessions.get(key);
    if (session) {
      session.messages = [];
      session.title = DEFAULT_CHAT_TITLE;
      session.lastActivity = new Date();
    }
  }

  /** Delete sessions idle longer than the explicitly configured retention. */
  async purgeIdle(maxAgeMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    let purged = 0;

    if (this.pool) {
      const result = await this.pool.query<{ platform: string; chat_id: string }>(
        `DELETE FROM gateway_sessions
         WHERE updated_at < $1
         RETURNING platform, chat_id`,
        [cutoff]
      );
      purged = result.rowCount ?? 0;
      for (const row of result.rows) {
        this.sessions.delete(this.key(row.platform, row.chat_id));
      }
      return purged;
    }

    for (const [key, session] of this.sessions.entries()) {
      if (session.lastActivity < cutoff) {
        this.sessions.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  get isPersistent(): boolean {
    return Boolean(this.pool);
  }

  /** Number of sessions currently loaded into this gateway process. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
