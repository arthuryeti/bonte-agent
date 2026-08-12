import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const gatewaySessions = pgTable(
  "gateway_sessions",
  {
    platform: text("platform").notNull(),
    chatId: text("chat_id").notNull(),
    title: text("title").default("New conversation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "gateway_sessions_pkey",
      columns: [table.platform, table.chatId],
    }),
    index("gateway_sessions_recent_idx").on(table.platform, table.updatedAt.desc()),
  ],
);

export const gatewayMessages = pgTable(
  "gateway_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    platform: text("platform").notNull(),
    chatId: text("chat_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    platformMessageId: text("platform_message_id"),
    dataParts: jsonb("data_parts").default(sql`'[]'::jsonb`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "gateway_messages_role_check",
      sql`${table.role} IN ('user', 'assistant', 'system')`,
    ),
    foreignKey({
      columns: [table.platform, table.chatId],
      foreignColumns: [gatewaySessions.platform, gatewaySessions.chatId],
      name: "gateway_messages_session_fk",
    }).onDelete("cascade"),
    unique("gateway_messages_platform_id_unique").on(
      table.platform,
      table.chatId,
      table.platformMessageId,
    ),
    index("gateway_messages_session_order_idx").on(
      table.platform,
      table.chatId,
      table.id,
    ),
  ],
);
