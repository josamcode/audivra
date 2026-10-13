CREATE TABLE "security_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"identity_ref" text,
	"ref" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"enc_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"identity_ref" text NOT NULL,
	"environment" text NOT NULL,
	"auth_method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sealed" text,
	"key_id" text,
	"enc_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_credentials" ADD CONSTRAINT "security_credentials_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_sessions" ADD CONSTRAINT "security_sessions_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_credentials_ref_idx" ON "security_credentials" USING btree ("engagement_id","ref");--> statement-breakpoint
CREATE INDEX "security_credentials_identity_idx" ON "security_credentials" USING btree ("engagement_id","identity_ref");--> statement-breakpoint
CREATE INDEX "security_credentials_status_idx" ON "security_credentials" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE INDEX "security_credentials_expiry_idx" ON "security_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "security_sessions_engagement_idx" ON "security_sessions" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_sessions_identity_idx" ON "security_sessions" USING btree ("engagement_id","identity_ref","status");--> statement-breakpoint
CREATE INDEX "security_sessions_expiry_idx" ON "security_sessions" USING btree ("expires_at");