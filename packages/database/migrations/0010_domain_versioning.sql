DROP INDEX "security_domain_declarations_ref_idx";--> statement-breakpoint
ALTER TABLE "security_domain_declarations" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "security_domain_declarations" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "security_domain_declarations" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "security_domain_declarations_active_ref_idx" ON "security_domain_declarations" USING btree ("engagement_id","kind","ref") WHERE status = 'active';