CREATE TABLE "security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"severity_reason" text DEFAULT '' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"verification_state" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"affected_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claim" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradicting_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impact" text DEFAULT '' NOT NULL,
	"remediation" text DEFAULT '' NOT NULL,
	"reproduction" jsonb,
	"severity_inputs" jsonb NOT NULL,
	"confidence_factors" jsonb NOT NULL,
	"candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hypothesis_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparison_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invariant_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"review_note" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_verification_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"claim" text NOT NULL,
	"category" text NOT NULL,
	"affected_entity_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supporting_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradicting_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"required_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"status_reason" text DEFAULT '' NOT NULL,
	"verifier" jsonb DEFAULT '{"verdict":"not-run","note":null,"providerId":null}'::jsonb NOT NULL,
	"finding_id" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_verification_candidates" ADD CONSTRAINT "security_verification_candidates_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_findings_issue_idx" ON "security_findings" USING btree ("engagement_id","issue_key");--> statement-breakpoint
CREATE INDEX "security_findings_engagement_idx" ON "security_findings" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_findings_severity_idx" ON "security_findings" USING btree ("engagement_id","severity");--> statement-breakpoint
CREATE INDEX "security_findings_category_idx" ON "security_findings" USING btree ("engagement_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "security_verification_candidates_issue_idx" ON "security_verification_candidates" USING btree ("engagement_id","issue_key");--> statement-breakpoint
CREATE INDEX "security_verification_candidates_status_idx" ON "security_verification_candidates" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE INDEX "security_verification_candidates_finding_idx" ON "security_verification_candidates" USING btree ("engagement_id","finding_id");