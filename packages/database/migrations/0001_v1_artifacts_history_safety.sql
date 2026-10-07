CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"ref" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"question" text NOT NULL,
	"description" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finding_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text,
	"priority" integer DEFAULT 3 NOT NULL,
	"placement" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"prompt_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fixtures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totals" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owned_processes" (
	"id" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"process_started_at" timestamp with time zone,
	"image" text,
	"tool" text NOT NULL,
	"audit_id" text,
	"owner_id" text NOT NULL,
	"parent_pid" integer NOT NULL,
	"command" text NOT NULL,
	"cwd" text,
	"container_name" text,
	"status" text NOT NULL,
	"exit_code" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "termination_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "site_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "report_plan" jsonb;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "benchmark" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "artifact_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "issue_key" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "page_type" text;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_processes" ADD CONSTRAINT "owned_processes_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_audit_ref_idx" ON "artifacts" USING btree ("audit_id","ref");--> statement-breakpoint
CREATE INDEX "artifacts_audit_idx" ON "artifacts" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "owned_processes_status_idx" ON "owned_processes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "owned_processes_audit_idx" ON "owned_processes" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "audits_site_idx" ON "audits" USING btree ("site_key","created_at");--> statement-breakpoint
UPDATE "audits" SET "site_key" = lower(regexp_replace("domain", '^www[.]', '')) WHERE "site_key" = '';--> statement-breakpoint
INSERT INTO "audit_steps" ("audit_id", "stage", "status", "attempts", "message")
SELECT "id", 'presenting',
       CASE WHEN "status" IN ('completed', 'partial', 'failed', 'cancelled') THEN 'skipped' ELSE 'pending' END,
       0,
       CASE WHEN "status" IN ('completed', 'partial', 'failed', 'cancelled') THEN 'Audit predates visual reports' ELSE NULL END
FROM "audits"
ON CONFLICT DO NOTHING;