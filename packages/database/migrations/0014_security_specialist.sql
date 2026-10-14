CREATE TABLE "security_specialist_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"engine" text NOT NULL,
	"engine_version" text,
	"adapter_version" text NOT NULL,
	"mode" text NOT NULL,
	"execution_id" text,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_profile_id" text,
	"provider_model" text,
	"state" text DEFAULT 'requested' NOT NULL,
	"completion" text,
	"state_reason" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"termination_reason" text,
	"artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" real,
	"turns" integer,
	"imported" jsonb DEFAULT '{"vulnerabilities":0,"observations":0,"merged":0,"gaps":0,"outOfScope":0}'::jsonb NOT NULL,
	"imports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_specialist_runs" ADD CONSTRAINT "security_specialist_runs_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_specialist_runs_engagement_idx" ON "security_specialist_runs" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_specialist_runs_state_idx" ON "security_specialist_runs" USING btree ("engagement_id","state");