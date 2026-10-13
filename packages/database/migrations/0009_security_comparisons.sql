CREATE TABLE "security_comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"hypothesis_id" text,
	"dimension" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"resource_ref" text NOT NULL,
	"action" text NOT NULL,
	"resource_relationship" text DEFAULT 'unknown' NOT NULL,
	"invariant_ref" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"arms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"controls" jsonb DEFAULT '{"positive":false,"negative":false}'::jsonb NOT NULL,
	"semantic_differences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb,
	"result" text DEFAULT 'not-tested' NOT NULL,
	"result_reason" text DEFAULT '' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"invariant_evaluation" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup_action" jsonb,
	"state_probe" jsonb,
	"cleanup" jsonb DEFAULT '{"required":false,"attempted":false,"succeeded":null,"detail":null}'::jsonb NOT NULL,
	"coverage_sampled" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_comparisons" ADD CONSTRAINT "security_comparisons_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_comparisons_dedupe_idx" ON "security_comparisons" USING btree ("engagement_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "security_comparisons_engagement_idx" ON "security_comparisons" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_comparisons_hypothesis_idx" ON "security_comparisons" USING btree ("engagement_id","hypothesis_id");--> statement-breakpoint
CREATE INDEX "security_comparisons_dimension_idx" ON "security_comparisons" USING btree ("engagement_id","dimension");--> statement-breakpoint
CREATE INDEX "security_comparisons_invariant_idx" ON "security_comparisons" USING btree ("engagement_id","invariant_ref");