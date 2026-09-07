import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const workflowRecords = pgTable("workflow_records", {
  workspaceId: text("workspace_id").notNull(),
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  data: jsonb("data").notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", {withTimezone:true}).defaultNow().notNull(),
}, table => [primaryKey({columns:[table.workspaceId,table.kind,table.id]}),
  index("workflow_records_scope_kind_idx").on(table.workspaceId,table.kind,table.updatedAt),
  index("workflow_records_kind_idx").on(table.kind)]);
