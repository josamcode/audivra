CREATE TABLE "security_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"capability_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"environment" text NOT NULL,
	"config_version" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"requested_by" jsonb NOT NULL,
	"decision_event_id" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"job_id" text,
	"runner" jsonb,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" jsonb,
	"result" jsonb,
	"exit" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_executions" ADD CONSTRAINT "security_executions_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_executions_engagement_idx" ON "security_executions" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_executions_status_idx" ON "security_executions" USING btree ("status");--> statement-breakpoint
CREATE FUNCTION "security_executions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('succeeded', 'failed', 'timed-out', 'cancelled', 'interrupted') THEN
		RAISE EXCEPTION 'security_executions: execution % is % and final (UPDATE rejected)', OLD.id, OLD.status;
	END IF;
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
		OR NEW.capability_id IS DISTINCT FROM OLD.capability_id
		OR NEW.capability_version IS DISTINCT FROM OLD.capability_version
		OR NEW.environment IS DISTINCT FROM OLD.environment
		OR NEW.config_version IS DISTINCT FROM OLD.config_version
		OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
		OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
		OR NEW.decision_event_id IS DISTINCT FROM OLD.decision_event_id
		OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
		OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'security_executions: the trusted snapshot and identity of execution % are immutable', OLD.id;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "security_executions_guard" BEFORE UPDATE ON "security_executions" FOR EACH ROW EXECUTE FUNCTION "security_executions_guard"();
