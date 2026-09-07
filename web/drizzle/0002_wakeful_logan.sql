CREATE TABLE "workflow_records" (
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_records_workspace_id_kind_id_pk" PRIMARY KEY("workspace_id","kind","id")
);
--> statement-breakpoint
CREATE INDEX "workflow_records_scope_kind_idx" ON "workflow_records" USING btree ("workspace_id","kind","updated_at");--> statement-breakpoint
CREATE INDEX "workflow_records_kind_idx" ON "workflow_records" USING btree ("kind");