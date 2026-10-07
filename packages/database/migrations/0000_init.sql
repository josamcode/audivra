CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"session_id" text,
	"status" text NOT NULL,
	"num_turns" integer,
	"cost_usd" real,
	"duration_ms" integer,
	"error" text,
	"output" jsonb,
	"validation" jsonb,
	"usage" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_steps" (
	"audit_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"message" text,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "audit_steps_audit_id_stage_pk" PRIMARY KEY("audit_id","stage")
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"domain" text NOT NULL,
	"client_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'preparing' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb,
	"baseline" jsonb,
	"error" jsonb,
	"evidence_seq" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"ref" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"url" text,
	"artifact_path" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_run_id" text,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"finding_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	CONSTRAINT "finding_evidence_finding_id_evidence_id_pk" PRIMARY KEY("finding_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"ref" text NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"observed" text NOT NULL,
	"affected_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"verification_status" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"business_impact" text NOT NULL,
	"business_impact_level" text NOT NULL,
	"recommendation" text NOT NULL,
	"effort" text NOT NULL,
	"opportunity" jsonb,
	"created_by" text NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"title" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"inspected_in_browser" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"tool" text NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"command" text,
	"exit_code" integer,
	"duration_ms" integer,
	"error" text,
	"artifact_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_steps" ADD CONSTRAINT "audit_steps_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tool_run_id_tool_runs_id_fk" FOREIGN KEY ("tool_run_id") REFERENCES "public"."tool_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_audit_idx" ON "agent_runs" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "audit_events_audit_idx" ON "audit_events" USING btree ("audit_id","id");--> statement-breakpoint
CREATE INDEX "audits_created_idx" ON "audits" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_audit_ref_idx" ON "evidence" USING btree ("audit_id","ref");--> statement-breakpoint
CREATE INDEX "evidence_audit_idx" ON "evidence" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_audit_ref_idx" ON "findings" USING btree ("audit_id","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_audit_url_idx" ON "pages" USING btree ("audit_id","url");--> statement-breakpoint
CREATE INDEX "tool_runs_audit_idx" ON "tool_runs" USING btree ("audit_id");