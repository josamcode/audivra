CREATE TABLE "change_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"previous_audit_id" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"ref" text NOT NULL,
	"rank" integer NOT NULL,
	"journey_key" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"description" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"confidence" real NOT NULL,
	"steps" jsonb NOT NULL,
	"health" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"agent_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "journey_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "change_reports" ADD CONSTRAINT "change_reports_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_reports" ADD CONSTRAINT "change_reports_previous_audit_id_audits_id_fk" FOREIGN KEY ("previous_audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_reports" ADD CONSTRAINT "change_reports_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_briefs" ADD CONSTRAINT "client_briefs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_briefs" ADD CONSTRAINT "client_briefs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_reports_pair_idx" ON "change_reports" USING btree ("audit_id","previous_audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_briefs_audit_idx" ON "client_briefs" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journeys_audit_ref_idx" ON "journeys" USING btree ("audit_id","ref");