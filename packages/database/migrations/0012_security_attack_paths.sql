CREATE TABLE "security_attack_paths" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"path_key" text NOT NULL,
	"title" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"start" jsonb NOT NULL,
	"end_impact" jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_entity_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"comparison_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invariant_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"state_reason" text DEFAULT '' NOT NULL,
	"missing_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impact_class" text NOT NULL,
	"impact_priority" text NOT NULL,
	"boundaries_crossed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text DEFAULT 'deterministic' NOT NULL,
	"provider_id" text,
	"explanation" text DEFAULT '' NOT NULL,
	"dominated_by" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_attack_paths" ADD CONSTRAINT "security_attack_paths_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_attack_paths_key_idx" ON "security_attack_paths" USING btree ("engagement_id","path_key");--> statement-breakpoint
CREATE INDEX "security_attack_paths_engagement_idx" ON "security_attack_paths" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_attack_paths_state_idx" ON "security_attack_paths" USING btree ("engagement_id","state");