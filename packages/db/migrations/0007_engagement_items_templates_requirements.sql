CREATE TYPE "public"."engagement_item_kind" AS ENUM('document_check', 'survey_reference', 'site_finding', 'query', 'red_flag', 'condition', 'closing_task', 'handover_document', 'lease_milestone');--> statement-breakpoint
CREATE TYPE "public"."engagement_item_severity" AS ENUM('info', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."engagement_item_status" AS ENUM('open', 'in_progress', 'satisfied', 'waived', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "document_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"stage" "engagement_status",
	"required" boolean DEFAULT true NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_request_id" uuid NOT NULL,
	"kind" "engagement_item_kind" NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"reference" text,
	"status" "engagement_item_status" DEFAULT 'open' NOT NULL,
	"severity" "engagement_item_severity",
	"visibility" "visibility" DEFAULT 'customer' NOT NULL,
	"assignee_user_id" text,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "report_kind" NOT NULL,
	"name" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limitations_markdown" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_requirements" ADD CONSTRAINT "document_requirements_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_requirements_service_idx" ON "document_requirements" USING btree ("service_id","active");--> statement-breakpoint
CREATE INDEX "engagement_items_sr_idx" ON "engagement_items" USING btree ("service_request_id","kind");--> statement-breakpoint
CREATE INDEX "engagement_items_assignee_idx" ON "engagement_items" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "report_templates_kind_idx" ON "report_templates" USING btree ("kind","active");--> statement-breakpoint
-- Row-level security. Engagement items: staff see everything; customer
-- organisation members see customer-visible items; assignees see their own;
-- partners assigned to the service request see partner-visible items. The
-- application layer applies the finer permission checks on top.
SELECT app.apply_row_policy('engagement_items',
  $r$ app.privileged()
      OR (organization_id = app.org_id() AND visibility IN ('customer','all'))
      OR (assignee_user_id IS NOT NULL AND assignee_user_id = app.user_id())
      OR (visibility IN ('partner','all') AND EXISTS (
            SELECT 1 FROM public.assignments a
            WHERE a.service_request_id = engagement_items.service_request_id
              AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active'))) $r$,
  $w$ app.privileged()
      OR (assignee_user_id IS NOT NULL AND assignee_user_id = app.user_id())
      OR (organization_id = app.org_id() AND visibility IN ('customer','all')) $w$);
--> statement-breakpoint
-- Document requirements are published guidance; report templates are read by
-- signed-in authors (staff and partners). Both are edited by staff only.
SELECT app.apply_split_policy('document_requirements', 'true', 'app.privileged()');
--> statement-breakpoint
SELECT app.apply_split_policy('report_templates', $p$ app.privileged() OR app.user_id() IS NOT NULL $p$, 'app.privileged()');
