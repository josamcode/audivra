CREATE TABLE "security_research_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"iteration" integer NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"objective_ref" text,
	"capability_id" text,
	"input_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"cost_class" text NOT NULL,
	"expected_information_gain" real DEFAULT 0 NOT NULL,
	"rank" real DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"rejection" text,
	"usefulness" text,
	"outcome" text DEFAULT '' NOT NULL,
	"produced_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_research_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"parent_run_id" text,
	"mode" text NOT NULL,
	"objective" text NOT NULL,
	"objective_note" text,
	"objective_detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"stage" text DEFAULT 'assess' NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"coverage_before" jsonb NOT NULL,
	"coverage_after" jsonb,
	"residual" jsonb NOT NULL,
	"termination_reason" text,
	"last_decision" text DEFAULT '' NOT NULL,
	"starting_graph_revision" integer,
	"provider_available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_research_actions" ADD CONSTRAINT "security_research_actions_run_id_security_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."security_research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_research_runs" ADD CONSTRAINT "security_research_runs_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_research_actions_run_idx" ON "security_research_actions" USING btree ("run_id","iteration");--> statement-breakpoint
CREATE INDEX "security_research_actions_fingerprint_idx" ON "security_research_actions" USING btree ("run_id","fingerprint");--> statement-breakpoint
CREATE INDEX "security_research_runs_engagement_idx" ON "security_research_runs" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_research_runs_state_idx" ON "security_research_runs" USING btree ("state");