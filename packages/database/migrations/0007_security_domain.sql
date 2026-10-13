CREATE TABLE "security_domain_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"source" text DEFAULT 'declared' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_domain_declarations" ADD CONSTRAINT "security_domain_declarations_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_domain_declarations_ref_idx" ON "security_domain_declarations" USING btree ("engagement_id","kind","ref");--> statement-breakpoint
CREATE INDEX "security_domain_declarations_key_idx" ON "security_domain_declarations" USING btree ("engagement_id","key");--> statement-breakpoint
CREATE INDEX "security_domain_declarations_kind_idx" ON "security_domain_declarations" USING btree ("engagement_id","kind");