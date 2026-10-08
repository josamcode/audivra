CREATE TABLE "security_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"subject" jsonb NOT NULL,
	"reason" text,
	"challenge" text,
	"reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_engagements" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_url" text NOT NULL,
	"site_key" text NOT NULL,
	"environment" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"policy_profile_key" text NOT NULL,
	"policy_profile_version" integer NOT NULL,
	"scope" jsonb NOT NULL,
	"scope_version" integer DEFAULT 1 NOT NULL,
	"scope_hash" text NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"evidence_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"actor" jsonb NOT NULL,
	"execution_id" text,
	"capability_id" text,
	"config_version" integer NOT NULL,
	"decision" jsonb,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "audit_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "engagement_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "security_execution_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "security_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "owned_processes" ADD COLUMN "security_execution_id" text;--> statement-breakpoint
ALTER TABLE "security_authorizations" ADD CONSTRAINT "security_authorizations_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_authorizations_engagement_idx" ON "security_authorizations" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_engagements_updated_idx" ON "security_engagements" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "security_engagements_site_idx" ON "security_engagements" USING btree ("site_key");--> statement-breakpoint
CREATE INDEX "security_events_engagement_idx" ON "security_events" USING btree ("engagement_id","id");--> statement-breakpoint
CREATE INDEX "security_events_execution_idx" ON "security_events" USING btree ("execution_id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_engagement_ref_idx" ON "evidence" USING btree ("engagement_id","ref");--> statement-breakpoint
CREATE INDEX "evidence_security_execution_idx" ON "evidence" USING btree ("security_execution_id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_single_owner" CHECK (("evidence"."audit_id" is null) <> ("evidence"."engagement_id" is null));--> statement-breakpoint
CREATE FUNCTION "security_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'security_events is append-only (% rejected)', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "security_events_append_only" BEFORE UPDATE OR DELETE ON "security_events" FOR EACH ROW EXECUTE FUNCTION "security_events_append_only"();
