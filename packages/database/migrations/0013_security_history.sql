CREATE TABLE "security_analyst_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"related_ref" text,
	"note" text DEFAULT '' NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_assessment_comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"previous_engagement_id" text NOT NULL,
	"current_engagement_id" text NOT NULL,
	"summary" jsonb NOT NULL,
	"finding_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"path_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"graph_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_retest_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"reproduction_format" text NOT NULL,
	"affected_entity_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_ref" text,
	"action" text,
	"invariant_ref" text,
	"source_comparison_id" text,
	"reproduction" jsonb,
	"required_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"controls_required" jsonb DEFAULT '{"positive":false,"negative":false}'::jsonb NOT NULL,
	"preconditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capability_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup_required" boolean DEFAULT false NOT NULL,
	"original_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"original_severity" text NOT NULL,
	"eligibility" jsonb NOT NULL,
	"planned" boolean DEFAULT false NOT NULL,
	"planned_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_retest_results" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"retest_case_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"source_engagement_id" text NOT NULL,
	"state" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"fresh_comparison_id" text,
	"fresh_result" text,
	"control_valid" boolean DEFAULT false NOT NULL,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capability_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adaptation" jsonb,
	"severity_now" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_analyst_decisions" ADD CONSTRAINT "security_analyst_decisions_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_assessment_comparisons" ADD CONSTRAINT "security_assessment_comparisons_previous_engagement_id_security_engagements_id_fk" FOREIGN KEY ("previous_engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_assessment_comparisons" ADD CONSTRAINT "security_assessment_comparisons_current_engagement_id_security_engagements_id_fk" FOREIGN KEY ("current_engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_retest_cases" ADD CONSTRAINT "security_retest_cases_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_retest_results" ADD CONSTRAINT "security_retest_results_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_analyst_decisions_engagement_idx" ON "security_analyst_decisions" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "security_assessment_comparisons_pair_idx" ON "security_assessment_comparisons" USING btree ("previous_engagement_id","current_engagement_id");--> statement-breakpoint
CREATE INDEX "security_assessment_comparisons_current_idx" ON "security_assessment_comparisons" USING btree ("current_engagement_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "security_retest_cases_finding_idx" ON "security_retest_cases" USING btree ("engagement_id","finding_id");--> statement-breakpoint
CREATE INDEX "security_retest_cases_issue_idx" ON "security_retest_cases" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "security_retest_results_engagement_idx" ON "security_retest_results" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_retest_results_issue_idx" ON "security_retest_results" USING btree ("issue_key");--> statement-breakpoint
CREATE INDEX "security_retest_results_source_idx" ON "security_retest_results" USING btree ("source_engagement_id");--> statement-breakpoint
CREATE INDEX "security_retest_results_case_idx" ON "security_retest_results" USING btree ("retest_case_id");