CREATE TABLE "security_graph_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"confidence" real NOT NULL,
	"corroboration" integer DEFAULT 0 NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"first_execution_id" text,
	"last_execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_graph_gaps" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"question" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" jsonb,
	"answered_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_class" text,
	"basis" text NOT NULL,
	"confidence" real NOT NULL,
	"corroboration" integer DEFAULT 0 NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"first_execution_id" text,
	"last_execution_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_graph_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"source" text NOT NULL,
	"trust" text NOT NULL,
	"source_ref" text NOT NULL,
	"observation_id" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"execution_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capability_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"rationale" text,
	"reasoning_run_id" text,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_hypotheses" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"claim" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"status_reason" text DEFAULT '' NOT NULL,
	"confidence" real NOT NULL,
	"impact" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ranking" jsonb,
	"priority" real DEFAULT 0 NOT NULL,
	"expected_information_gain" real,
	"estimated_cost" text,
	"execution_risk" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"origin" jsonb NOT NULL,
	"review" jsonb NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_hypothesis_links" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"hypothesis_id" text NOT NULL,
	"role" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"added_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_reasoning_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"run_id" text NOT NULL,
	"hypothesis_id" text,
	"capability_id" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_key" text NOT NULL,
	"expected_evidence" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"status_reason" text,
	"decision" jsonb,
	"execution_id" text,
	"result" jsonb,
	"cost_class" text,
	"origin" text DEFAULT 'ai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_reasoning_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"engagement_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'ingest' NOT NULL,
	"iteration" integer DEFAULT 0 NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"stop_reason" text,
	"stop_detail" text,
	"ai_coverage" text,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_runs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waiting_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" jsonb NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"lease_owner" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_graph_edges" ADD CONSTRAINT "security_graph_edges_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_graph_edges" ADD CONSTRAINT "security_graph_edges_from_node_id_security_graph_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."security_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_graph_edges" ADD CONSTRAINT "security_graph_edges_to_node_id_security_graph_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."security_graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_graph_gaps" ADD CONSTRAINT "security_graph_gaps_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_graph_nodes" ADD CONSTRAINT "security_graph_nodes_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_graph_provenance" ADD CONSTRAINT "security_graph_provenance_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_hypotheses" ADD CONSTRAINT "security_hypotheses_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_hypothesis_links" ADD CONSTRAINT "security_hypothesis_links_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_hypothesis_links" ADD CONSTRAINT "security_hypothesis_links_hypothesis_id_security_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."security_hypotheses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_reasoning_actions" ADD CONSTRAINT "security_reasoning_actions_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_reasoning_actions" ADD CONSTRAINT "security_reasoning_actions_run_id_security_reasoning_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."security_reasoning_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_reasoning_actions" ADD CONSTRAINT "security_reasoning_actions_hypothesis_id_security_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."security_hypotheses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_reasoning_runs" ADD CONSTRAINT "security_reasoning_runs_engagement_id_security_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."security_engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_graph_edges_key_idx" ON "security_graph_edges" USING btree ("engagement_id","key");--> statement-breakpoint
CREATE INDEX "security_graph_edges_from_idx" ON "security_graph_edges" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "security_graph_edges_to_idx" ON "security_graph_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "security_graph_edges_type_idx" ON "security_graph_edges" USING btree ("engagement_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "security_graph_gaps_subject_idx" ON "security_graph_gaps" USING btree ("engagement_id","kind","subject_key");--> statement-breakpoint
CREATE INDEX "security_graph_gaps_status_idx" ON "security_graph_gaps" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "security_graph_nodes_key_idx" ON "security_graph_nodes" USING btree ("engagement_id","key");--> statement-breakpoint
CREATE INDEX "security_graph_nodes_kind_idx" ON "security_graph_nodes" USING btree ("engagement_id","kind");--> statement-breakpoint
CREATE INDEX "security_graph_nodes_status_idx" ON "security_graph_nodes" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "security_graph_provenance_source_idx" ON "security_graph_provenance" USING btree ("subject_type","subject_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "security_graph_provenance_subject_idx" ON "security_graph_provenance" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "security_graph_provenance_observation_idx" ON "security_graph_provenance" USING btree ("engagement_id","observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "security_hypotheses_dedupe_idx" ON "security_hypotheses" USING btree ("engagement_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "security_hypotheses_status_idx" ON "security_hypotheses" USING btree ("engagement_id","status");--> statement-breakpoint
CREATE INDEX "security_hypotheses_priority_idx" ON "security_hypotheses" USING btree ("engagement_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "security_hypothesis_links_unique_idx" ON "security_hypothesis_links" USING btree ("hypothesis_id","role","target_type","target_id");--> statement-breakpoint
CREATE INDEX "security_hypothesis_links_target_idx" ON "security_hypothesis_links" USING btree ("engagement_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "security_reasoning_actions_engagement_idx" ON "security_reasoning_actions" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_reasoning_actions_hypothesis_idx" ON "security_reasoning_actions" USING btree ("hypothesis_id");--> statement-breakpoint
CREATE INDEX "security_reasoning_actions_execution_idx" ON "security_reasoning_actions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "security_reasoning_actions_key_idx" ON "security_reasoning_actions" USING btree ("engagement_id","action_key");--> statement-breakpoint
CREATE INDEX "security_reasoning_runs_engagement_idx" ON "security_reasoning_runs" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "security_reasoning_runs_status_idx" ON "security_reasoning_runs" USING btree ("status");