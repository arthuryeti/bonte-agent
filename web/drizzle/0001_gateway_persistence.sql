-- IF NOT EXISTS lets an existing deployment adopt Drizzle's migration journal
-- without replacing or truncating its already-persisted gateway history.
CREATE TABLE IF NOT EXISTS "gateway_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"chat_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"platform_message_id" text,
	"data_parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_messages_platform_id_unique" UNIQUE("platform","chat_id","platform_message_id"),
	CONSTRAINT "gateway_messages_role_check" CHECK ("gateway_messages"."role" IN ('user', 'assistant', 'system'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_sessions" (
	"platform" text NOT NULL,
	"chat_id" text NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_sessions_pkey" PRIMARY KEY("platform","chat_id")
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'gateway_messages_session_fk'
	) THEN
		ALTER TABLE "gateway_messages"
			ADD CONSTRAINT "gateway_messages_session_fk"
			FOREIGN KEY ("platform","chat_id")
			REFERENCES "public"."gateway_sessions"("platform","chat_id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_messages_session_order_idx" ON "gateway_messages" USING btree ("platform","chat_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_sessions_recent_idx" ON "gateway_sessions" USING btree ("platform","updated_at" DESC NULLS LAST);
