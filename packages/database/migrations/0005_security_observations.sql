CREATE TABLE "security_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"type" text NOT NULL,
	"asset" text NOT NULL,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"scope_class" text,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_type" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contributions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_observations" ADD CONSTRAINT "security_observations_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_observations_dedupe_idx" ON "security_observations" USING btree ("engagement_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "security_observations_type_idx" ON "security_observations" USING btree ("engagement_id","type");