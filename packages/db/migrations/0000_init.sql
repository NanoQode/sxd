CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE TYPE "public"."grant_level" AS ENUM('view', 'comment', 'edit', 'approve');--> statement-breakpoint
CREATE TYPE "public"."organization_kind" AS ENUM('customer', 'staff', 'partner', 'estate');--> statement-breakpoint
CREATE TYPE "public"."ownership_type" AS ENUM('individual', 'company');--> statement-breakpoint
CREATE TYPE "public"."partner_type" AS ENUM('contractor', 'inspector', 'surveyor', 'legal', 'architect', 'quantity_surveyor', 'valuer', 'vendor', 'agent', 'other');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('super_admin', 'operations_manager', 'project_manager', 'inspector', 'finance', 'data_editor', 'data_approver', 'content_editor', 'support');--> statement-breakpoint
CREATE TYPE "public"."theme_preference" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'pending', 'verified', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."geopolitical_zone" AS ENUM('NC', 'NE', 'NW', 'SE', 'SS', 'SW');--> statement-breakpoint
CREATE TYPE "public"."license_rights" AS ENUM('unknown', 'attribution_required', 'licensed_commercial', 'first_party', 'restricted_factual_reference');--> statement-breakpoint
CREATE TYPE "public"."market_flag_type" AS ENUM('geographic_exclusion', 'title_stop', 'site_restriction', 'flood_alert', 'security_advisory', 'data_dispute');--> statement-breakpoint
CREATE TYPE "public"."publication_state" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('insufficient_local_evidence', 'assumption_mode_only', 'eligible', 'gated_by_policy');--> statement-breakpoint
CREATE TYPE "public"."service_availability" AS ENUM('pending_operations_confirmation', 'available', 'limited', 'on_request', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."facility_evidence_status" AS ENUM('published_facility_location', 'unverified_lead', 'verified_supplier');--> statement-breakpoint
CREATE TYPE "public"."geography_level" AS ENUM('country', 'state_or_fct', 'city', 'neighborhood', 'site');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('previewed', 'applied', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."material" AS ENUM('cement', 'ready_mix', 'steel', 'sand', 'aggregate', 'blocks', 'timber', 'roofing', 'electrical', 'plumbing', 'other');--> statement-breakpoint
CREATE TYPE "public"."numeric_representation" AS ENUM('whole_naira_not_kobo', 'kobo', 'percent', 'days', 'count', 'text', 'other');--> statement-breakpoint
CREATE TYPE "public"."observation_review_status" AS ENUM('source_read_pending_business_review', 'verified', 'disputed', 'rejected', 'superseded', 'stale');--> statement-breakpoint
CREATE TYPE "public"."ranking_policy_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."research_task_status" AS ENUM('open', 'in_progress', 'in_review', 'done', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."scenario_mode" AS ENUM('evidence', 'assumption');--> statement-breakpoint
CREATE TYPE "public"."statistic_type" AS ENUM('median', 'mean', 'min', 'max', 'range', 'count', 'categorical', 'quote', 'single_observation');--> statement-breakpoint
CREATE TYPE "public"."stock_status" AS ENUM('unknown', 'in_stock', 'limited', 'out_of_stock');--> statement-breakpoint
CREATE TYPE "public"."supplier_relation" AS ENUM('editorial_lead', 'verified_delivery', 'dealer_appointed');--> statement-breakpoint
CREATE TYPE "public"."assignment_role" AS ENUM('project_manager', 'inspector', 'surveyor', 'legal', 'architect', 'quantity_surveyor', 'contractor', 'vendor', 'valuer', 'agent', 'support', 'coordinator', 'other');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('proposed', 'accepted', 'declined', 'active', 'completed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('inquiry', 'triage', 'quoted', 'accepted', 'awaiting_payment', 'in_progress', 'in_review', 'delivered', 'completed', 'rejected', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('website_form', 'consultation_booking', 'map_scenario', 'referral', 'manual', 'quote_request');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'converted', 'closed_lost', 'spam');--> statement-breakpoint
CREATE TYPE "public"."package_publication" AS ENUM('draft', 'in_review', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."price_basis" AS ENUM('fixed', 'from', 'per_month', 'percentage', 'quotation');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'issued', 'accepted', 'rejected', 'expired', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('core', 'expansion');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('internal', 'customer', 'partner', 'all');--> statement-breakpoint
CREATE TYPE "public"."listing_kind" AS ENUM('sale', 'lease', 'short_stay');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'in_moderation', 'published', 'paused', 'expired', 'withdrawn', 'archived', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'submitted', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."owner_authority_status" AS ENUM('pending', 'verified', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."property_kind" AS ENUM('land', 'residential', 'commercial', 'industrial', 'mixed_use', 'student_housing', 'short_stay');--> statement-breakpoint
CREATE TYPE "public"."title_status" AS ENUM('unknown', 'documents_received', 'verification_in_progress', 'verified', 'issues_found', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('vacant', 'occupied', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."viewing_status" AS ENUM('requested', 'confirmed', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."accountable_party" AS ENUM('customer', 'simplexd', 'contractor', 'authority', 'supplier', 'consultant', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."approval_role" AS ENUM('customer', 'staff', 'finance', 'inspector', 'data_approver', 'second_approver');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."budget_source" AS ENUM('area_rate', 'boq', 'quote', 'manual');--> statement-breakpoint
CREATE TYPE "public"."budget_status" AS ENUM('draft', 'approved', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."calendar_basis" AS ENUM('working_days', 'calendar_days');--> statement-breakpoint
CREATE TYPE "public"."change_order_status" AS ENUM('draft', 'submitted', 'customer_review', 'staff_review', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."commitment_kind" AS ENUM('commitment', 'actual');--> statement-breakpoint
CREATE TYPE "public"."day_basis" AS ENUM('elapsed', 'business');--> statement-breakpoint
CREATE TYPE "public"."defect_severity" AS ENUM('cosmetic', 'minor', 'major', 'critical', 'safety');--> statement-breakpoint
CREATE TYPE "public"."defect_status" AS ENUM('open', 'acknowledged', 'in_progress', 'resolved', 'verified', 'closed', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."dependency_type" AS ENUM('finish_to_start', 'start_to_start', 'finish_to_finish');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('photo', 'video', 'drone', 'document', 'audio', 'drawing', 'other');--> statement-breakpoint
CREATE TYPE "public"."evidence_publication" AS ENUM('restricted', 'approved', 'redacted_public');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('pending', 'in_progress', 'submitted', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."permit_status" AS ENUM('preparing', 'submitted', 'query_raised', 'resubmitted', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."project_kind" AS ENUM('construction_monitoring', 'architecture', 'renovation', 'snagging', 'energy_water_upgrade', 'quantity_surveying', 'other');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planning', 'active', 'on_hold', 'completed', 'cancelled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('progress', 'inspection', 'virtual_inspection', 'diligence_memo', 'design_deliverable', 'valuation', 'snagging', 'feasibility', 'existing_condition', 'closing_pack', 'search_outcome', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('draft', 'in_review', 'changes_requested', 'approved', 'released', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."schedule_phase" AS ENUM('design', 'investigations', 'approvals', 'procurement', 'site_preparation', 'foundations', 'structure', 'roof', 'services', 'finishes', 'inspection', 'handover', 'other');--> statement-breakpoint
CREATE TYPE "public"."site_visit_status" AS ENUM('scheduled', 'in_progress', 'submitted', 'reviewed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."award_status" AS ENUM('decided', 'published', 'accepted', 'declined', 'rescinded');--> statement-breakpoint
CREATE TYPE "public"."bid_status" AS ENUM('draft', 'submitted', 'withdrawn', 'disqualified', 'evaluated', 'awarded', 'unsuccessful');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'received', 'disputed', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_status" AS ENUM('open', 'supplier_notified', 'resolved', 'credited', 'returned');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'issued', 'acknowledged', 'partially_delivered', 'delivered', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rfq_response_status" AS ENUM('draft', 'submitted', 'withdrawn', 'selected', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."rfq_status" AS ENUM('draft', 'sent', 'closed', 'awarded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tender_invitation_status" AS ENUM('invited', 'viewed', 'declined', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."tender_status" AS ENUM('draft', 'published', 'clarifications', 'closed', 'evaluating', 'awarded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lease_kind" AS ENUM('residential_annual', 'residential_monthly', 'commercial', 'student_academic', 'short_stay_management');--> statement-breakpoint
CREATE TYPE "public"."lease_party_role" AS ENUM('tenant', 'guarantor', 'occupant', 'owner_representative');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('draft', 'pending_signature', 'active', 'expiring', 'ended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."management_fee_basis" AS ENUM('percentage_of_collected', 'fixed_monthly', 'none');--> statement-breakpoint
CREATE TYPE "public"."owner_statement_status" AS ENUM('draft', 'reconciled', 'issued');--> statement-breakpoint
CREATE TYPE "public"."party_access_status" AS ENUM('not_invited', 'invited', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."rent_charge_kind" AS ENUM('rent', 'service_charge', 'late_fee', 'utility', 'deposit', 'other');--> statement-breakpoint
CREATE TYPE "public"."rent_period" AS ENUM('annual', 'quarterly', 'monthly', 'term');--> statement-breakpoint
CREATE TYPE "public"."rent_schedule_status" AS ENUM('scheduled', 'invoiced', 'partially_paid', 'paid', 'overdue', 'waived');--> statement-breakpoint
CREATE TYPE "public"."stay_booking_status" AS ENUM('requested', 'confirmed', 'checked_in', 'checked_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_order_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('requested', 'triaged', 'assigned', 'in_progress', 'awaiting_approval', 'approved', 'completed', 'verified', 'closed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."bank_receipt_status" AS ENUM('submitted', 'under_review', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."chargeback_status" AS ENUM('opened', 'evidence_submitted', 'won', 'lost', 'closed');--> statement-breakpoint
CREATE TYPE "public"."credit_note_status" AS ENUM('draft', 'issued', 'applied', 'void');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('service', 'deposit', 'installment', 'management_fee', 'rent', 'service_charge', 'tender_fee', 'procurement', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('initialized', 'pending', 'successful', 'failed', 'reversed', 'uncertain', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('paystack', 'bank_transfer', 'dev');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('proposed', 'first_approved', 'approved', 'submitted', 'settled', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."provider_event_status" AS ENUM('received', 'queued', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('open', 'in_progress', 'balanced', 'exceptions', 'closed');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('requested', 'approved', 'submitted', 'pending', 'settled', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."appointment_kind" AS ENUM('consultation', 'viewing', 'site_visit', 'virtual_inspection', 'meeting', 'test_booking');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('pending_confirmation', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."calendar_connection_status" AS ENUM('disconnected', 'configured_unverified', 'connected', 'degraded', 'expired', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."calendar_sync_status" AS ENUM('not_requested', 'pending', 'synced', 'failed', 'cancelled', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."conference_status" AS ENUM('none', 'pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('opted_in', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."conversation_kind" AS ENUM('customer_team', 'tenant_support', 'partner', 'internal', 'support_ticket');--> statement-breakpoint
CREATE TYPE "public"."digest_frequency" AS ENUM('none', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."event_sync_status" AS ENUM('pending', 'created', 'updated', 'cancelled', 'failed', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."meeting_provider" AS ENUM('none', 'google_meet', 'external', 'in_person');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_status" AS ENUM('queued', 'accepted', 'sent', 'delivered', 'failed', 'suppressed', 'bounced', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('security', 'transactional', 'reminders', 'digests', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."reservation_kind" AS ENUM('hold', 'appointment', 'leave', 'buffer', 'block');--> statement-breakpoint
CREATE TYPE "public"."template_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'job', 'webhook', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."content_kind" AS ENUM('page', 'service', 'location_intro', 'resource', 'faq', 'policy', 'case_study', 'testimonial', 'banner', 'navigation', 'contact', 'goal_path', 'evidence_standard');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('draft', 'in_review', 'scheduled', 'published', 'unpublished', 'archived');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_category" AS ENUM('core', 'expansion', 'regulated_gated', 'experimental');--> statement-breakpoint
CREATE TYPE "public"."file_bucket" AS ENUM('private', 'quarantine', 'derivatives');--> statement-breakpoint
CREATE TYPE "public"."file_grant_level" AS ENUM('view', 'download');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending_upload', 'uploaded', 'scanning', 'clean', 'infected', 'scan_failed', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."integration_environment" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('paystack', 'termii', 'smtp', 'google_workspace', 'storage', 'maps', 'geocoding', 'scanner', 'analytics');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('disconnected', 'configured_unverified', 'connected', 'degraded', 'expired', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."upload_kind" AS ENUM('single', 'multipart');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"subject_email" text,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"policy_version" text NOT NULL,
	"source" text NOT NULL,
	"ip_hash" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"requester_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_requester_id_endpoint_key_pk" PRIMARY KEY("requester_id","endpoint","key")
);
--> statement-breakpoint
CREATE TABLE "impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "organization_profiles" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"kind" "organization_kind" DEFAULT 'customer' NOT NULL,
	"legal_name" text,
	"ownership_type" "ownership_type" DEFAULT 'individual' NOT NULL,
	"country_code" text DEFAULT 'NG' NOT NULL,
	"address" jsonb,
	"tax_id_masked" text,
	"brand_theme_default" "theme_preference",
	"default_time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"partner_type" "partner_type" NOT NULL,
	"display_name" text NOT NULL,
	"credentials" jsonb,
	"coverage_state_ids" uuid[],
	"availability_status" text DEFAULT 'unknown' NOT NULL,
	"conflict_disclosures" text,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"verification_expires_at" timestamp with time zone,
	"verification_scope" text,
	"rating_average" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_profiles_userId_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"level" "grant_level" DEFAULT 'view' NOT NULL,
	"granted_by" text,
	"reason" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "staff_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone_e_164" text,
	"phone_verified_at" timestamp with time zone,
	"time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"locale" text DEFAULT 'en-NG' NOT NULL,
	"theme_preference" "theme_preference" DEFAULT 'system' NOT NULL,
	"reduce_motion" boolean DEFAULT false NOT NULL,
	"ownership_type" "ownership_type",
	"goals" jsonb,
	"diaspora" boolean,
	"country_of_residence" text,
	"marketing_consent_at" timestamp with time zone,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"default_time_zone" text DEFAULT 'Africa/Lagos' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid,
	"neighborhood_id" uuid,
	"flag_type" "market_flag_type" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text NOT NULL,
	"source_id" uuid,
	"valid_from" date,
	"valid_until" date,
	"approved_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"change_reason" text,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"country_code" text NOT NULL,
	"state_id" uuid NOT NULL,
	"geopolitical_zone" "geopolitical_zone" NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"selection_basis" text,
	"location" geometry(Point,4326) NOT NULL,
	"coordinate_source_id" uuid,
	"coordinate_accuracy" text,
	"source_city_name" text,
	"parent_market_id" uuid,
	"overlap_note" text,
	"service_availability" "service_availability" DEFAULT 'pending_operations_confirmation' NOT NULL,
	"publication_state" "publication_state" DEFAULT 'draft' NOT NULL,
	"profile_markdown" text,
	"supply_mapping_method" text,
	"recommendation_status" "recommendation_status" DEFAULT 'insufficient_local_evidence' NOT NULL,
	"research_tasks" jsonb,
	"last_researched_at" date,
	"last_reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"archived_at" timestamp with time zone,
	"merged_into_market_id" uuid,
	"import_fingerprint" text,
	"imported_at" timestamp with time zone,
	"human_edited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "neighborhoods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"boundary" geometry(MultiPolygon,4326),
	"centroid" geometry(Point,4326),
	"boundary_source_id" uuid,
	"boundary_note" text,
	"publication_state" "publication_state" DEFAULT 'draft' NOT NULL,
	"profile_markdown" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"url" text,
	"data_url" text,
	"license_note" text,
	"license_rights" "license_rights" DEFAULT 'unknown' NOT NULL,
	"use_note" text,
	"retrieved_at" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"geopolitical_zone" "geopolitical_zone" NOT NULL,
	"is_federal_capital" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparison_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"file_id" uuid,
	"title" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"share_token" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "comparison_reports_shareToken_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "data_policy_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "freshness_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_type" text NOT NULL,
	"max_age_days" integer,
	"respect_source_validity" boolean DEFAULT true NOT NULL,
	"note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "freshness_policies_dataType_unique" UNIQUE("data_type")
);
--> statement-breakpoint
CREATE TABLE "market_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_by" text,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"file_id" uuid,
	"status" "import_status" DEFAULT 'previewed' NOT NULL,
	"summary" jsonb NOT NULL,
	"row_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_interpretations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"review_status" "observation_review_status" DEFAULT 'source_read_pending_business_review' NOT NULL,
	"publication_state" "publication_state" DEFAULT 'draft' NOT NULL,
	"rank_eligible" boolean DEFAULT false NOT NULL,
	"reason_not_rank_eligible" text,
	"editorial_note" text,
	"cohort_mapping" text,
	"applies_to_market_id" uuid,
	"freshness_override_until" date,
	"reviewer_id" text,
	"published_by" text,
	"published_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observation_id" uuid NOT NULL,
	"interpretation_id" uuid,
	"reviewer_id" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text,
	"source_id" uuid NOT NULL,
	"source_url" text,
	"metric" text NOT NULL,
	"value_numeric" numeric(20, 4),
	"value_low" numeric(20, 4),
	"value_high" numeric(20, 4),
	"value_text" text,
	"unit" text NOT NULL,
	"currency" text,
	"numeric_representation" numeric_representation DEFAULT 'other' NOT NULL,
	"geography_level" "geography_level" NOT NULL,
	"geography_label" text NOT NULL,
	"state_id" uuid,
	"market_id" uuid,
	"neighborhood_id" uuid,
	"property_cohort" text NOT NULL,
	"statistic" "statistic_type" NOT NULL,
	"observation_period_start" date,
	"observation_period_end" date,
	"period_complete_at_retrieval" boolean,
	"source_updated_at" date,
	"retrieved_at" date NOT NULL,
	"sample_size" integer,
	"collection_method" text,
	"license_note" text,
	"valid_until" date,
	"rank_eligible" boolean DEFAULT false NOT NULL,
	"reason_not_rank_eligible" text,
	"evidence_file_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ranking_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"status" "ranking_policy_status" DEFAULT 'draft' NOT NULL,
	"weights" jsonb NOT NULL,
	"metric_bounds" jsonb NOT NULL,
	"confidence_rubric" jsonb NOT NULL,
	"coverage_threshold" numeric(5, 4) DEFAULT '0.7000' NOT NULL,
	"min_comparables" integer DEFAULT 10 NOT NULL,
	"hard_constraints" jsonb,
	"notes" text,
	"created_by" text,
	"approved_by" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ranking_policies_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "recommendation_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	"source_versions" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"generated_by" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"status" "research_task_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"assignee_user_id" text,
	"reviewer_user_id" text,
	"budget_kobo" bigint,
	"due_date" date,
	"evidence_rights_note" text,
	"target_count" integer,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text,
	"organization_id" text,
	"anonymous_token" text,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"mode" "scenario_mode" DEFAULT 'assumption' NOT NULL,
	"filters" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"priorities" jsonb NOT NULL,
	"market_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"policy_version" integer,
	"share_token" text,
	"share_expires_at" timestamp with time zone,
	"converted_service_request_id" uuid,
	"verification_requested_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenarios_shareToken_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "supplier_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"relation" "supplier_relation" DEFAULT 'editorial_lead' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid,
	"supplier_name" text,
	"market_id" uuid NOT NULL,
	"material" "material" NOT NULL,
	"specification" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3),
	"unit_price_kobo" bigint,
	"delivery_cost_kobo" bigint,
	"taxes_kobo" bigint,
	"unloading_kobo" bigint,
	"lead_time_days" integer,
	"route_conditions" text,
	"quoted_at" date NOT NULL,
	"valid_until" date,
	"contact_permission" boolean DEFAULT false NOT NULL,
	"evidence_file_id" uuid,
	"review_status" "observation_review_status" DEFAULT 'source_read_pending_business_review' NOT NULL,
	"rank_eligible" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"operator" text,
	"state_id" uuid,
	"material" "material" NOT NULL,
	"source_id" uuid,
	"evidence_status" "facility_evidence_status" DEFAULT 'unverified_lead' NOT NULL,
	"location" geometry(Point,4326),
	"delivery_coverage_verified" boolean DEFAULT false NOT NULL,
	"stock_status" "stock_status" DEFAULT 'unknown' NOT NULL,
	"rank_eligible" boolean DEFAULT false NOT NULL,
	"contact_permission" boolean DEFAULT false NOT NULL,
	"notes" text,
	"import_fingerprint" text,
	"human_edited_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_facilities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"accepted_by_user_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"signature_name" text NOT NULL,
	"terms_version" text NOT NULL,
	CONSTRAINT "acceptances_quoteVersionId_unique" UNIQUE("quote_version_id")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_request_id" uuid,
	"project_id" uuid,
	"assignee_user_id" text NOT NULL,
	"role" "assignment_role" NOT NULL,
	"status" "assignment_status" DEFAULT 'proposed' NOT NULL,
	"instructions" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"assigned_by" text,
	"responded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_request_id" uuid NOT NULL,
	"from_status" "engagement_status",
	"to_status" "engagement_status" NOT NULL,
	"actor_user_id" text,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"user_id" text,
	"contact_name" text NOT NULL,
	"email" text NOT NULL,
	"phone_e_164" text,
	"country_of_residence" text,
	"time_zone" text,
	"source" "lead_source" NOT NULL,
	"interest_service_id" uuid,
	"goal" text,
	"message" text,
	"scenario_id" uuid,
	"context" jsonb,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"assigned_to_user_id" text,
	"converted_service_request_id" uuid,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_policy_version" text,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"body" text NOT NULL,
	"visibility" "visibility" DEFAULT 'internal' NOT NULL,
	"author_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"lines" jsonb NOT NULL,
	"scope_markdown" text,
	"exclusions" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal_kobo" bigint NOT NULL,
	"tax_kobo" bigint NOT NULL,
	"total_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"scope_markdown" text,
	"exclusions" text,
	"valid_until" timestamp with time zone,
	"fee_basis" jsonb,
	"tax_treatment_key" text,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"pdf_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_request_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"availability" "service_availability" NOT NULL,
	"note" text,
	"effective_from" date,
	"effective_to" date,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_package_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope_markdown" text,
	"price_basis" "price_basis" NOT NULL,
	"amount_kobo" bigint,
	"percentage_bps" integer,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"minimum_scope" text,
	"exclusions" text,
	"effective_from" date,
	"effective_to" date,
	"publication_state" "package_publication" DEFAULT 'draft' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"package_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "engagement_status" DEFAULT 'inquiry' NOT NULL,
	"market_id" uuid,
	"property_id" uuid,
	"project_id" uuid,
	"scenario_id" uuid,
	"lead_id" uuid,
	"priority" integer DEFAULT 3 NOT NULL,
	"assigned_pm_user_id" text,
	"sla_due_at" timestamp with time zone,
	"context" jsonb,
	"fee_basis" jsonb,
	"pause_reason" text,
	"cancel_reason" text,
	"reject_reason" text,
	"completed_at" timestamp with time zone,
	"feedback_rating" integer,
	"feedback_comment" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requests_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" "service_category" DEFAULT 'core' NOT NULL,
	"short_description" text NOT NULL,
	"description_markdown" text,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_evidence" text,
	"workflow_template_key" text NOT NULL,
	"feature_flag_key" text,
	"booking_enabled" boolean DEFAULT false NOT NULL,
	"inquiry_enabled" boolean DEFAULT true NOT NULL,
	"staffed" boolean DEFAULT false NOT NULL,
	"regulated_gated" boolean DEFAULT false NOT NULL,
	"commercial_model" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"icon_key" text,
	"publication_state" "publication_state" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid,
	"stage" "engagement_status" NOT NULL,
	"target_hours" integer NOT NULL,
	"business_hours_only" boolean DEFAULT true NOT NULL,
	"escalate_to_role" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_request_id" uuid,
	"project_id" uuid,
	"assignment_id" uuid,
	"work_order_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_id" text,
	"visibility" "visibility" DEFAULT 'internal' NOT NULL,
	"requires_customer_action" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"description_markdown" text,
	"price_kobo" bigint,
	"price_basis" text,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"area_m_2" numeric(14, 2),
	"tenure" text,
	"title_disclosure" text,
	"availability" text,
	"verification_scope" jsonb,
	"media_file_ids" jsonb,
	"public_location_precision" text DEFAULT 'market' NOT NULL,
	"seo" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "listing_kind" NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"slug" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"published_version" integer,
	"owner_authority_id" uuid,
	"published_at" timestamp with time zone,
	"published_by" text,
	"expires_at" timestamp with time zone,
	"availability_confirmed_at" timestamp with time zone,
	"moderation_note" text,
	"moderated_by" text,
	"duplicate_of_listing_id" uuid,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"listing_id" uuid,
	"property_id" uuid,
	"service_request_id" uuid,
	"counterparty_organization_id" text,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"conditions" jsonb,
	"status" "offer_status" DEFAULT 'draft' NOT NULL,
	"negotiation_log" jsonb,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"owner_name" text NOT NULL,
	"authority_document_file_id" uuid,
	"status" "owner_authority_status" DEFAULT 'pending' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"reference" text,
	"survey_plan_ref" text,
	"area_m_2" numeric(14, 2),
	"declared_value" numeric(14, 3),
	"declared_unit" text,
	"boundary" geometry(Polygon,4326),
	"title_disclosures" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "property_kind" NOT NULL,
	"address" jsonb,
	"market_id" uuid,
	"neighborhood_id" uuid,
	"estate_id" uuid,
	"location" geometry(Point,4326),
	"precise_location_public" boolean DEFAULT false NOT NULL,
	"land_area_m_2" numeric(14, 2),
	"land_area_declared_value" numeric(14, 3),
	"land_area_declared_unit" text,
	"floor_area_m_2" numeric(14, 2),
	"title_type" text,
	"title_status" "title_status" DEFAULT 'unknown' NOT NULL,
	"title_note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"alerts_enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortlist_id" uuid NOT NULL,
	"listing_id" uuid,
	"external_reference" text,
	"title" text NOT NULL,
	"price_kobo" bigint,
	"notes" text,
	"customer_rating" integer,
	"customer_feedback" text,
	"status" text DEFAULT 'candidate' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shortlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_request_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"label" text NOT NULL,
	"unit_type" text NOT NULL,
	"bedrooms" integer,
	"bathrooms" integer,
	"floor_area_m_2" numeric(12, 2),
	"bed_count" integer,
	"status" "unit_status" DEFAULT 'vacant' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"listing_id" uuid,
	"property_id" uuid,
	"appointment_id" uuid,
	"requested_by_user_id" text,
	"status" "viewing_status" DEFAULT 'requested' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_duration_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction" text NOT NULL,
	"authority" text NOT NULL,
	"permit_type" text NOT NULL,
	"market_id" uuid,
	"started_at" date NOT NULL,
	"ended_at" date NOT NULL,
	"duration_days" integer NOT NULL,
	"day_basis" "day_basis" NOT NULL,
	"source_id" uuid,
	"project_id" uuid,
	"verification_status" text DEFAULT 'source_read_pending_business_review' NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"approver_role" "approval_role" NOT NULL,
	"approver_user_id" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "boq_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_version_id" uuid NOT NULL,
	"code" text,
	"description" text NOT NULL,
	"category" text,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate_kobo" bigint NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"inclusions" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"budget_version_id" uuid,
	"boq_item_id" uuid,
	"kind" "commitment_kind" NOT NULL,
	"description" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"reference" text,
	"counterparty" text,
	"incurred_at" date,
	"evidence_file_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "budget_status" DEFAULT 'draft' NOT NULL,
	"source" "budget_source" DEFAULT 'manual' NOT NULL,
	"total_kobo" bigint NOT NULL,
	"contingency_kobo" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"build_rate_kobo_per_m_2" bigint,
	"area_m_2" numeric(12, 2),
	"inclusions" text,
	"notes" text,
	"change_order_id" uuid,
	"approved_by_customer_user_id" text,
	"approved_by_staff_user_id" text,
	"approved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"base_budget_version_id" uuid,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount_delta_kobo" bigint NOT NULL,
	"schedule_delta_days" integer DEFAULT 0 NOT NULL,
	"status" "change_order_status" DEFAULT 'draft' NOT NULL,
	"requires_customer_approval" boolean DEFAULT true NOT NULL,
	"requires_staff_approval" boolean DEFAULT true NOT NULL,
	"applied_budget_version_id" uuid,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "defects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"property_id" uuid,
	"site_visit_id" uuid,
	"report_id" uuid,
	"number" integer,
	"title" text NOT NULL,
	"description" text,
	"severity" "defect_severity" DEFAULT 'minor' NOT NULL,
	"status" "defect_status" DEFAULT 'open' NOT NULL,
	"accountable_party" "accountable_party" DEFAULT 'unknown' NOT NULL,
	"location_note" text,
	"due_date" date,
	"ai_suggested_severity" text,
	"resolved_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_option_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"anchor" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"drawing_file_ids" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_signoff_by" text,
	"customer_signoff_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"service_request_id" uuid,
	"site_visit_id" uuid,
	"report_id" uuid,
	"defect_id" uuid,
	"work_order_id" uuid,
	"delivery_id" uuid,
	"file_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"caption" text,
	"captured_at" timestamp with time zone,
	"capture_gps" geometry(Point,4326),
	"capture_metadata" jsonb,
	"uploader_user_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checksum_sha256" text NOT NULL,
	"publication" "evidence_publication" DEFAULT 'restricted' NOT NULL,
	"redacted_file_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"offline_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_offlineClientId_unique" UNIQUE("offline_client_id")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"planned_date" date,
	"forecast_date" date,
	"status" "milestone_status" DEFAULT 'pending' NOT NULL,
	"inspector_progress_pct" integer,
	"inspector_progress_by" text,
	"inspector_progress_at" timestamp with time zone,
	"customer_accepted_by" text,
	"customer_accepted_at" timestamp with time zone,
	"customer_rejected_reason" text,
	"finance_authorized_by" text,
	"finance_authorized_at" timestamp with time zone,
	"payment_invoice_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"property_id" uuid,
	"jurisdiction" text NOT NULL,
	"authority" text NOT NULL,
	"permit_type" text NOT NULL,
	"document_type" text,
	"status" "permit_status" DEFAULT 'preparing' NOT NULL,
	"completeness_date" date,
	"application_reference" text,
	"fees_kobo" bigint,
	"submitted_at" date,
	"decided_at" date,
	"statutory_target_days" integer,
	"statutory_target_basis" "day_basis",
	"statutory_source_note" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permit_application_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" date NOT NULL,
	"note" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_request_id" uuid,
	"property_id" uuid,
	"market_id" uuid,
	"name" text NOT NULL,
	"kind" "project_kind" NOT NULL,
	"status" "project_status" DEFAULT 'planning' NOT NULL,
	"description" text,
	"approved_budget_version_id" uuid,
	"current_schedule_version" integer DEFAULT 1 NOT NULL,
	"start_date" date,
	"target_completion_date" date,
	"forecast_completion_date" date,
	"pm_user_id" text,
	"customer_contact_user_id" text,
	"gross_floor_area_m_2" numeric(12, 2),
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"summary" text,
	"body_markdown" text NOT NULL,
	"findings" jsonb,
	"attachment_file_ids" jsonb,
	"scope_limitations" text,
	"reviewer_user_id" text,
	"review_decision" text,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"service_request_id" uuid,
	"site_visit_id" uuid,
	"kind" "report_kind" NOT NULL,
	"title" text NOT NULL,
	"status" "report_status" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"released_version" integer,
	"released_at" timestamp with time zone,
	"released_by" text,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"named_reviewer_user_id" text,
	"offline_client_id" text,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_offlineClientId_unique" UNIQUE("offline_client_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"critical_path" jsonb,
	"computed_finish" date,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"schedule_version" integer DEFAULT 1 NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"phase" "schedule_phase" DEFAULT 'other' NOT NULL,
	"duration_days_min" integer,
	"duration_days_likely" integer,
	"duration_days_max" integer,
	"calendar_basis" "calendar_basis" DEFAULT 'working_days' NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"planned_start" date,
	"planned_finish" date,
	"actual_start" date,
	"actual_finish" date,
	"percent_complete" integer DEFAULT 0 NOT NULL,
	"accountable_party" "accountable_party" DEFAULT 'unknown' NOT NULL,
	"assumption_notes" text,
	"source_note" text,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"property_id" uuid,
	"service_request_id" uuid,
	"appointment_id" uuid,
	"scheduled_at" timestamp with time zone,
	"inspector_user_id" text,
	"status" "site_visit_status" DEFAULT 'scheduled' NOT NULL,
	"instructions" text,
	"checklist" jsonb,
	"findings_markdown" text,
	"weather" text,
	"access_note" text,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"offline_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_visits_offlineClientId_unique" UNIQUE("offline_client_id")
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"schedule_version" integer DEFAULT 1 NOT NULL,
	"predecessor_key" text NOT NULL,
	"successor_key" text NOT NULL,
	"type" "dependency_type" DEFAULT 'finish_to_start' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'demo_only' NOT NULL,
	"tasks" jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumption_notes" text,
	"source_note" text,
	"missing_inputs" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"bid_id" uuid NOT NULL,
	"status" "award_status" DEFAULT 'decided' NOT NULL,
	"contract_value_kobo" bigint,
	"decided_by" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"notes" text,
	"responded_at" timestamp with time zone,
	CONSTRAINT "awards_tenderId_unique" UNIQUE("tender_id")
);
--> statement-breakpoint
CREATE TABLE "bid_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bid_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"bid_id" uuid NOT NULL,
	"evaluator_user_id" text NOT NULL,
	"scores" jsonb NOT NULL,
	"weighted_score" numeric(8, 4),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bid_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bid_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"line_items" jsonb,
	"duration_days" integer,
	"qualifications" jsonb,
	"attachment_file_ids" jsonb,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"partner_user_id" text NOT NULL,
	"status" "bid_status" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"opened_by" text,
	"open_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"delivered_at" timestamp with time zone,
	"received_by_user_id" text,
	"lines" jsonb NOT NULL,
	"evidence_file_ids" jsonb,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3),
	"status" "discrepancy_status" DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"rfq_id" uuid,
	"response_id" uuid,
	"number" text NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"supplier_user_id" text,
	"supplier_name" text,
	"supplier_ref" text,
	"lines" jsonb NOT NULL,
	"total_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"issued_at" timestamp with time zone,
	"expected_delivery_at" timestamp with time zone,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "rfq_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"material" "material" NOT NULL,
	"specification" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"supplier_facility_id" uuid,
	"supplier_user_id" text,
	"supplier_name" text,
	"status" "rfq_response_status" DEFAULT 'draft' NOT NULL,
	"lines" jsonb NOT NULL,
	"total_delivered_kobo" bigint,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"valid_until" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"status" "rfq_status" DEFAULT 'draft' NOT NULL,
	"deadline_at" timestamp with time zone,
	"delivery_market_id" uuid,
	"delivery_address" jsonb,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfqs_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "tender_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"partner_user_id" text NOT NULL,
	"status" "tender_invitation_status" DEFAULT 'invited' NOT NULL,
	"invited_by" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewed_at" timestamp with time zone,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tender_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"asked_by_user_id" text NOT NULL,
	"question" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"published" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tender_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"changes" jsonb NOT NULL,
	"addendum_markdown" text,
	"deadline_extended_to" timestamp with time zone,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"service_request_id" uuid,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description_markdown" text,
	"scope_file_ids" jsonb,
	"boq_budget_version_id" uuid,
	"status" "tender_status" DEFAULT 'draft' NOT NULL,
	"sealed" boolean DEFAULT true NOT NULL,
	"release_at" timestamp with time zone,
	"site_visit_at" timestamp with time zone,
	"question_cutoff_at" timestamp with time zone,
	"answers_published_at" timestamp with time zone,
	"submission_deadline_at" timestamp with time zone,
	"evaluation_complete_at" timestamp with time zone,
	"award_target_at" timestamp with time zone,
	"display_time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"evaluation_weights" jsonb,
	"partner_disclosure" text,
	"closed_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenders_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"estate_id" uuid,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"serial_number" text,
	"installed_at" date,
	"condition" text DEFAULT 'unknown' NOT NULL,
	"next_service_at" date,
	"service_interval_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"market_id" uuid,
	"service_charge_policy" jsonb,
	"visitor_policy_webhook_url" text,
	"ledger_segment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"user_id" text,
	"role" "lease_party_role" NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone_e_164" text,
	"invitation_token_hash" text,
	"access_status" "party_access_status" DEFAULT 'not_invited' NOT NULL,
	"invited_at" timestamp with time zone,
	"invitation_expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"kind" "lease_kind" NOT NULL,
	"status" "lease_status" DEFAULT 'draft' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"rent_amount_kobo" bigint NOT NULL,
	"rent_period" "rent_period" NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"deposit_kobo" bigint DEFAULT 0 NOT NULL,
	"management_fee_basis" "management_fee_basis" DEFAULT 'none' NOT NULL,
	"management_fee_bps" integer,
	"management_fee_fixed_kobo" bigint,
	"terms_file_id" uuid,
	"academic_period" text,
	"notice_period_days" integer,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid,
	"estate_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "owner_statement_status" DEFAULT 'draft' NOT NULL,
	"totals" jsonb,
	"lines" jsonb,
	"file_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_by" text,
	"reconciled_at" timestamp with time zone,
	"issued_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rent_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"rent_charge_id" uuid NOT NULL,
	"allocation_id" uuid,
	"amount_kobo" bigint NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" text,
	"journal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "rent_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"schedule_id" uuid,
	"kind" "rent_charge_kind" NOT NULL,
	"description" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"charged_at" date NOT NULL,
	"invoice_id" uuid,
	"estate_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rent_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lease_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"status" "rent_schedule_status" DEFAULT 'scheduled' NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stay_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"guest_name" text NOT NULL,
	"guest_contact" jsonb,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"nights" integer NOT NULL,
	"nightly_rate_kobo" bigint NOT NULL,
	"platform_fee_kobo" bigint DEFAULT 0 NOT NULL,
	"cleaning_kobo" bigint DEFAULT 0 NOT NULL,
	"status" "stay_booking_status" DEFAULT 'requested' NOT NULL,
	"channel" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warranties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference" text,
	"starts_at" date,
	"expires_at" date NOT NULL,
	"document_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"lease_id" uuid,
	"asset_id" uuid,
	"estate_id" uuid,
	"reported_by_user_id" text,
	"title" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'other' NOT NULL,
	"priority" "work_order_priority" DEFAULT 'normal' NOT NULL,
	"status" "work_order_status" DEFAULT 'requested' NOT NULL,
	"assignee_user_id" text,
	"estimate_kobo" bigint,
	"approved_amount_kobo" bigint,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"actual_cost_kobo" bigint,
	"expense_journal_id" uuid,
	"sla_due_at" timestamp with time zone,
	"recurring" jsonb,
	"completed_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_attempt_id" uuid,
	"bank_receipt_id" uuid,
	"credit_note_id" uuid,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"dedupe_key" text NOT NULL,
	"journal_id" uuid,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" text,
	CONSTRAINT "allocations_dedupeKey_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "allocations_positive" CHECK ("allocations"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_transfer_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"uploaded_file_id" uuid,
	"declared_amount_kobo" bigint NOT NULL,
	"declared_paid_at" date,
	"bank_reference" text,
	"status" "bank_receipt_status" DEFAULT 'submitted' NOT NULL,
	"submitted_by" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"payment_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chargebacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"provider_reference" text,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" chargeback_status DEFAULT 'opened' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"reconciliation_task_id" uuid,
	"journal_id" uuid,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"number" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"reason" text NOT NULL,
	"status" "credit_note_status" DEFAULT 'draft' NOT NULL,
	"issued_by" text,
	"issued_at" timestamp with time zone,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_amount_kobo" bigint NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"tax_kobo" bigint DEFAULT 0 NOT NULL,
	"account_code" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"number" text NOT NULL,
	"kind" "invoice_kind" DEFAULT 'service' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"service_request_id" uuid,
	"project_id" uuid,
	"milestone_id" uuid,
	"lease_id" uuid,
	"quote_version_id" uuid,
	"customer_user_id" text,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"subtotal_kobo" bigint NOT NULL,
	"tax_kobo" bigint DEFAULT 0 NOT NULL,
	"withholding_kobo" bigint DEFAULT 0 NOT NULL,
	"total_kobo" bigint NOT NULL,
	"amount_paid_kobo" bigint DEFAULT 0 NOT NULL,
	"amount_credited_kobo" bigint DEFAULT 0 NOT NULL,
	"tax_treatment_key" text,
	"tax_treatment_snapshot" jsonb,
	"due_date" date,
	"issued_at" timestamp with time zone,
	"issued_by" text,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" text,
	"notes" text,
	"is_rent_on_behalf_of_owner" boolean DEFAULT false NOT NULL,
	"owner_organization_id" text,
	"estate_segment" text,
	"installment_plan" jsonb,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_amounts_non_negative" CHECK ("invoices"."total_kobo" >= 0 AND "invoices"."amount_paid_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_kobo" bigint DEFAULT 0 NOT NULL,
	"credit_kobo" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"organization_id" text,
	"entity_type" text,
	"entity_id" uuid,
	"memo" text,
	CONSTRAINT "journal_lines_non_negative" CHECK ("journal_lines"."debit_kobo" >= 0 AND "journal_lines"."credit_kobo" >= 0),
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit_kobo" = 0 OR "journal_lines"."credit_kobo" = 0)
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"business_event_ref" text NOT NULL,
	"description" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" text,
	"reversal_of_journal_id" uuid,
	"estate_segment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_businessEventRef_unique" UNIQUE("business_event_ref")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "ledger_account_type" NOT NULL,
	"subtype" text,
	"normal_balance" "normal_balance" NOT NULL,
	"is_control" boolean DEFAULT false NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"reference" text NOT NULL,
	"provider_reference" text,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'initialized' NOT NULL,
	"channel" text,
	"authorization_url" text,
	"access_code" text,
	"initiated_by_user_id" text,
	"provider_response_sanitized" jsonb,
	"verified_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"failure_reason" text,
	"fees_kobo" bigint,
	"idempotency_key" text,
	"last_reconciled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" "payout_status" DEFAULT 'proposed' NOT NULL,
	"beneficiary" jsonb,
	"owner_statement_id" uuid,
	"reconciliation_id" uuid,
	"proposed_by" text,
	"first_approver_id" text,
	"first_approved_at" timestamp with time zone,
	"second_approver_id" text,
	"second_approved_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"failure_reason" text,
	"journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"dedupe_key" text NOT NULL,
	"provider_event_id" text,
	"event_type" text NOT NULL,
	"reference" text,
	"signature_valid" boolean NOT NULL,
	"raw_body" text NOT NULL,
	"headers_sanitized" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_status" "provider_event_status" DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "provider_events_dedupeKey_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"allocation_id" uuid NOT NULL,
	"number" text NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_id" uuid,
	CONSTRAINT "receipts_allocationId_unique" UNIQUE("allocation_id"),
	CONSTRAINT "receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "reconciliation_status" DEFAULT 'open' NOT NULL,
	"summary" jsonb,
	"exceptions" jsonb,
	"performed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"currency" text DEFAULT 'NGN' NOT NULL,
	"status" "refund_status" DEFAULT 'requested' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"provider_reference" text,
	"provider_status" text,
	"settled_at" timestamp with time zone,
	"failure_reason" text,
	"journal_id" uuid,
	"settlement_journal_id" uuid,
	"idempotency_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer DEFAULT 0 NOT NULL,
	"withholding_bps" integer DEFAULT 0 NOT NULL,
	"applies_to" text DEFAULT 'all' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_treatments_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"kind" "appointment_kind" NOT NULL,
	"status" "appointment_status" DEFAULT 'pending_confirmation' NOT NULL,
	"staff_user_id" text NOT NULL,
	"customer_user_id" text,
	"guest_name" text,
	"guest_email" text,
	"guest_phone_e_164" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"customer_time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"business_time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"topic" text,
	"notes" text,
	"location_note" text,
	"meeting_provider" "meeting_provider" DEFAULT 'none' NOT NULL,
	"meeting_url" text,
	"calendar_sync_status" "calendar_sync_status" DEFAULT 'not_requested' NOT NULL,
	"conference_status" "conference_status" DEFAULT 'none' NOT NULL,
	"cancellation_reason" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"rescheduled_from_id" uuid,
	"lead_id" uuid,
	"service_request_id" uuid,
	"site_visit_id" uuid,
	"ics_token" text NOT NULL,
	"manage_token" text,
	"reminders_sent" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_icsToken_unique" UNIQUE("ics_token"),
	CONSTRAINT "appointments_manageToken_unique" UNIQUE("manage_token")
);
--> statement-breakpoint
CREATE TABLE "booking_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"organizer_user_id" text NOT NULL,
	"account_email" text,
	"calendar_id" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "calendar_connection_status" DEFAULT 'disconnected' NOT NULL,
	"refresh_token_secret_id" uuid,
	"access_token_secret_id" uuid,
	"access_token_expires_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_error_sanitized" text,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_watch_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_connection_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"resource_id" text,
	"token_hash" text NOT NULL,
	"expiration" timestamp with time zone,
	"sync_token" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_notification_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_watch_channels_channelId_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"kind" "conversation_kind" NOT NULL,
	"subject" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"created_by" text,
	"last_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" DEFAULT 'transactional' NOT NULL,
	"template_key" text,
	"template_version" integer,
	"recipient" text NOT NULL,
	"user_id" text,
	"provider" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"status" "message_delivery_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"provider_status" text,
	"error_sanitized" text,
	"segments" integer,
	"estimated_cost_kobo" bigint,
	"dedupe_key" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"subject" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_dedupeKey_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "event_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"calendar_connection_id" uuid,
	"provider_event_id" text,
	"provider_calendar_id" text,
	"conference_request_id" text NOT NULL,
	"etag" text,
	"sequence" integer,
	"sync_version" integer DEFAULT 0 NOT NULL,
	"status" "event_sync_status" DEFAULT 'pending' NOT NULL,
	"conference_status" "conference_status" DEFAULT 'pending' NOT NULL,
	"meet_url" text,
	"last_synced_at" timestamp with time zone,
	"last_error_sanitized" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_syncs_appointmentId_unique" UNIQUE("appointment_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_user_id" text,
	"body" text NOT NULL,
	"attachment_file_ids" jsonb,
	"internal_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"digest" "digest_frequency" DEFAULT 'none' NOT NULL,
	"quiet_hours_start" time,
	"quiet_hours_end" time,
	"time_zone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"category" "notification_category" DEFAULT 'transactional' NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_path" text,
	"entity_type" text,
	"entity_id" uuid,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupeKey_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"subject" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slot_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" text NOT NULL,
	"slot" "tstzrange" NOT NULL,
	"kind" "reservation_kind" NOT NULL,
	"expires_at" timestamp with time zone,
	"hold_token" text,
	"appointment_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_reservations_holdToken_unique" UNIQUE("hold_token")
);
--> statement-breakpoint
CREATE TABLE "sms_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e_164" text NOT NULL,
	"user_id" text,
	"category" "notification_category" NOT NULL,
	"status" "consent_status" NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"time_zone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"kinds" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"variables" jsonb,
	"status" "template_status" DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_hash" text,
	"event_name" text NOT NULL,
	"path" text,
	"props" jsonb,
	"consent_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"actor_user_id" text,
	"impersonation_id" uuid,
	"organization_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_hash" text,
	"user_agent" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "content_kind" DEFAULT 'page' NOT NULL,
	"title" text NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"published_revision" integer,
	"publish_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"unpublished_at" timestamp with time zone,
	"seo" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"created_by" text,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text NOT NULL,
	"body_html_sanitized" text,
	"fields" jsonb,
	"summary" text,
	"review_status" text DEFAULT 'draft' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" "feature_flag_category" DEFAULT 'expansion' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout" jsonb,
	"requires_review" boolean DEFAULT false NOT NULL,
	"review_note" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "file_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"user_id" text,
	"organization_id" text,
	"level" "file_grant_level" DEFAULT 'view' NOT NULL,
	"granted_by" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_download_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"user_id" text,
	"ip_hash" text,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"owner_user_id" text,
	"bucket" "file_bucket" DEFAULT 'quarantine' NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"declared_mime" text NOT NULL,
	"detected_mime" text,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"status" "file_status" DEFAULT 'pending_upload' NOT NULL,
	"scan_result" jsonb,
	"scanned_at" timestamp with time zone,
	"upload_kind" "upload_kind" DEFAULT 'single' NOT NULL,
	"multipart_upload_id" text,
	"derivatives" jsonb,
	"purpose" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"is_public_approved" boolean DEFAULT false NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_objects_storageKey_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "integration_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"environment" "integration_environment" DEFAULT 'test' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"adapter" text DEFAULT 'dev' NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_check_message" text,
	"last_success_at" timestamp with time zone,
	"credential_rotated_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"event" text NOT NULL,
	"message_sanitized" text,
	"metadata_sanitized" jsonb,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"error_message_sanitized" text NOT NULL,
	"stack_sanitized" text,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text DEFAULT 'default' NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"organization_id" text,
	"actor_user_id" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"correlation_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupeKey_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"alt_text" text NOT NULL,
	"caption" text,
	"rights_note" text,
	"rights_confirmed" boolean DEFAULT false NOT NULL,
	"approved_for_public" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"organization_id" text,
	"actor_user_id" text,
	"payload" jsonb NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_fromPath_unique" UNIQUE("from_path")
);
--> statement-breakpoint
CREATE TABLE "secret_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"field_name" text NOT NULL,
	"master_key_id" text NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_iv" "bytea" NOT NULL,
	"dek_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "partner_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "partner_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "partner_profiles_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_flags" ADD CONSTRAINT "market_flags_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_flags" ADD CONSTRAINT "market_flags_neighborhood_id_neighborhoods_id_fk" FOREIGN KEY ("neighborhood_id") REFERENCES "public"."neighborhoods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_flags" ADD CONSTRAINT "market_flags_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_flags" ADD CONSTRAINT "market_flags_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_flags" ADD CONSTRAINT "market_flags_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_revisions" ADD CONSTRAINT "market_revisions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_revisions" ADD CONSTRAINT "market_revisions_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_country_code_countries_code_fk" FOREIGN KEY ("country_code") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_coordinate_source_id_sources_id_fk" FOREIGN KEY ("coordinate_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_parent_market_id_markets_id_fk" FOREIGN KEY ("parent_market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_merged_into_market_id_markets_id_fk" FOREIGN KEY ("merged_into_market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_boundary_source_id_sources_id_fk" FOREIGN KEY ("boundary_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhoods" ADD CONSTRAINT "neighborhoods_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "states" ADD CONSTRAINT "states_country_code_countries_code_fk" FOREIGN KEY ("country_code") REFERENCES "public"."countries"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_reports" ADD CONSTRAINT "comparison_reports_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_reports" ADD CONSTRAINT "comparison_reports_snapshot_id_recommendation_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."recommendation_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_policy_settings" ADD CONSTRAINT "data_policy_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "freshness_policies" ADD CONSTRAINT "freshness_policies_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_imports" ADD CONSTRAINT "market_imports_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_imports" ADD CONSTRAINT "market_imports_applied_by_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_interpretations" ADD CONSTRAINT "observation_interpretations_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_interpretations" ADD CONSTRAINT "observation_interpretations_applies_to_market_id_markets_id_fk" FOREIGN KEY ("applies_to_market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_interpretations" ADD CONSTRAINT "observation_interpretations_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_interpretations" ADD CONSTRAINT "observation_interpretations_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_interpretations" ADD CONSTRAINT "observation_interpretations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_reviews" ADD CONSTRAINT "observation_reviews_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_reviews" ADD CONSTRAINT "observation_reviews_interpretation_id_observation_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."observation_interpretations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_reviews" ADD CONSTRAINT "observation_reviews_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_neighborhood_id_neighborhoods_id_fk" FOREIGN KEY ("neighborhood_id") REFERENCES "public"."neighborhoods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_policies" ADD CONSTRAINT "ranking_policies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranking_policies" ADD CONSTRAINT "ranking_policies_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_snapshots" ADD CONSTRAINT "recommendation_snapshots_generated_by_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_coverage" ADD CONSTRAINT "supplier_coverage_facility_id_supply_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."supply_facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_coverage" ADD CONSTRAINT "supplier_coverage_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_coverage" ADD CONSTRAINT "supplier_coverage_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_facility_id_supply_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."supply_facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_facilities" ADD CONSTRAINT "supply_facilities_state_id_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."states"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_facilities" ADD CONSTRAINT "supply_facilities_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_transitions" ADD CONSTRAINT "engagement_transitions_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_transitions" ADD CONSTRAINT "engagement_transitions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_interest_service_id_services_id_fk" FOREIGN KEY ("interest_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_user_id_user_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_templates" ADD CONSTRAINT "quote_templates_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_templates" ADD CONSTRAINT "quote_templates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_coverage" ADD CONSTRAINT "service_coverage_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package_revisions" ADD CONSTRAINT "service_package_revisions_package_id_service_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."service_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package_revisions" ADD CONSTRAINT "service_package_revisions_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_package_id_service_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."service_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_assigned_pm_user_id_user_id_fk" FOREIGN KEY ("assigned_pm_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_owner_authority_id_owner_authorities_id_fk" FOREIGN KEY ("owner_authority_id") REFERENCES "public"."owner_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_moderated_by_user_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_counterparty_organization_id_organization_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_authorities" ADD CONSTRAINT "owner_authorities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_authorities" ADD CONSTRAINT "owner_authorities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_authorities" ADD CONSTRAINT "owner_authorities_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_neighborhood_id_neighborhoods_id_fk" FOREIGN KEY ("neighborhood_id") REFERENCES "public"."neighborhoods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_shortlist_id_shortlists_id_fk" FOREIGN KEY ("shortlist_id") REFERENCES "public"."shortlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_duration_observations" ADD CONSTRAINT "approval_duration_observations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_duration_observations" ADD CONSTRAINT "approval_duration_observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_duration_observations" ADD CONSTRAINT "approval_duration_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_duration_observations" ADD CONSTRAINT "approval_duration_observations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_user_id_user_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boq_items" ADD CONSTRAINT "boq_items_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_commitments" ADD CONSTRAINT "budget_commitments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_commitments" ADD CONSTRAINT "budget_commitments_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_commitments" ADD CONSTRAINT "budget_commitments_boq_item_id_boq_items_id_fk" FOREIGN KEY ("boq_item_id") REFERENCES "public"."boq_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_commitments" ADD CONSTRAINT "budget_commitments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_approved_by_customer_user_id_user_id_fk" FOREIGN KEY ("approved_by_customer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_approved_by_staff_user_id_user_id_fk" FOREIGN KEY ("approved_by_staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_base_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("base_budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_applied_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("applied_budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_site_visit_id_site_visits_id_fk" FOREIGN KEY ("site_visit_id") REFERENCES "public"."site_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_design_option_id_design_options_id_fk" FOREIGN KEY ("design_option_id") REFERENCES "public"."design_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_comments" ADD CONSTRAINT "design_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_options" ADD CONSTRAINT "design_options_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_options" ADD CONSTRAINT "design_options_customer_signoff_by_user_id_fk" FOREIGN KEY ("customer_signoff_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_options" ADD CONSTRAINT "design_options_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_site_visit_id_site_visits_id_fk" FOREIGN KEY ("site_visit_id") REFERENCES "public"."site_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploader_user_id_user_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_inspector_progress_by_user_id_fk" FOREIGN KEY ("inspector_progress_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_customer_accepted_by_user_id_fk" FOREIGN KEY ("customer_accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_finance_authorized_by_user_id_fk" FOREIGN KEY ("finance_authorized_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_applications" ADD CONSTRAINT "permit_applications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_applications" ADD CONSTRAINT "permit_applications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_applications" ADD CONSTRAINT "permit_applications_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_events" ADD CONSTRAINT "permit_events_permit_application_id_permit_applications_id_fk" FOREIGN KEY ("permit_application_id") REFERENCES "public"."permit_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permit_events" ADD CONSTRAINT "permit_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_approved_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("approved_budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_pm_user_id_user_id_fk" FOREIGN KEY ("pm_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_contact_user_id_user_id_fk" FOREIGN KEY ("customer_contact_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_site_visit_id_site_visits_id_fk" FOREIGN KEY ("site_visit_id") REFERENCES "public"."site_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_released_by_user_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_named_reviewer_user_id_user_id_fk" FOREIGN KEY ("named_reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baselines" ADD CONSTRAINT "schedule_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baselines" ADD CONSTRAINT "schedule_baselines_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_inspector_user_id_user_id_fk" FOREIGN KEY ("inspector_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_templates" ADD CONSTRAINT "timeline_templates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_access_log" ADD CONSTRAINT "bid_access_log_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_access_log" ADD CONSTRAINT "bid_access_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_evaluations" ADD CONSTRAINT "bid_evaluations_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_evaluations" ADD CONSTRAINT "bid_evaluations_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_evaluations" ADD CONSTRAINT "bid_evaluations_evaluator_user_id_user_id_fk" FOREIGN KEY ("evaluator_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_revisions" ADD CONSTRAINT "bid_revisions_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_partner_user_id_user_id_fk" FOREIGN KEY ("partner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_opened_by_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_received_by_user_id_user_id_fk" FOREIGN KEY ("received_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_response_id_rfq_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."rfq_responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_user_id_user_id_fk" FOREIGN KEY ("supplier_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_responses" ADD CONSTRAINT "rfq_responses_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_responses" ADD CONSTRAINT "rfq_responses_supplier_facility_id_supply_facilities_id_fk" FOREIGN KEY ("supplier_facility_id") REFERENCES "public"."supply_facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_responses" ADD CONSTRAINT "rfq_responses_supplier_user_id_user_id_fk" FOREIGN KEY ("supplier_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_delivery_market_id_markets_id_fk" FOREIGN KEY ("delivery_market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_invitations" ADD CONSTRAINT "tender_invitations_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_invitations" ADD CONSTRAINT "tender_invitations_partner_user_id_user_id_fk" FOREIGN KEY ("partner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_invitations" ADD CONSTRAINT "tender_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_questions" ADD CONSTRAINT "tender_questions_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_questions" ADD CONSTRAINT "tender_questions_asked_by_user_id_user_id_fk" FOREIGN KEY ("asked_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_questions" ADD CONSTRAINT "tender_questions_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_revisions" ADD CONSTRAINT "tender_revisions_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_revisions" ADD CONSTRAINT "tender_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_boq_budget_version_id_budget_versions_id_fk" FOREIGN KEY ("boq_budget_version_id") REFERENCES "public"."budget_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_estate_id_estates_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estates" ADD CONSTRAINT "estates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estates" ADD CONSTRAINT "estates_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_parties" ADD CONSTRAINT "lease_parties_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_parties" ADD CONSTRAINT "lease_parties_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_parties" ADD CONSTRAINT "lease_parties_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_estate_id_estates_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_reconciled_by_user_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_allocations" ADD CONSTRAINT "rent_allocations_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_allocations" ADD CONSTRAINT "rent_allocations_rent_charge_id_rent_charges_id_fk" FOREIGN KEY ("rent_charge_id") REFERENCES "public"."rent_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_allocations" ADD CONSTRAINT "rent_allocations_allocated_by_user_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_schedule_id_rent_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."rent_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_estate_id_estates_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_charges" ADD CONSTRAINT "rent_charges_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rent_schedules" ADD CONSTRAINT "rent_schedules_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_bookings" ADD CONSTRAINT "stay_bookings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_bookings" ADD CONSTRAINT "stay_bookings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_bookings" ADD CONSTRAINT "stay_bookings_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_estate_id_estates_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_reported_by_user_id_user_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_bank_receipt_id_bank_transfer_receipts_id_fk" FOREIGN KEY ("bank_receipt_id") REFERENCES "public"."bank_transfer_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_receipts" ADD CONSTRAINT "bank_transfer_receipts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_receipts" ADD CONSTRAINT "bank_transfer_receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_receipts" ADD CONSTRAINT "bank_transfer_receipts_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_receipts" ADD CONSTRAINT "bank_transfer_receipts_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_receipts" ADD CONSTRAINT "bank_transfer_receipts_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargebacks" ADD CONSTRAINT "chargebacks_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_user_id_user_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_owner_organization_id_organization_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_initiated_by_user_id_user_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_first_approver_id_user_id_fk" FOREIGN KEY ("first_approver_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_second_approver_id_user_id_fk" FOREIGN KEY ("second_approver_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_performed_by_user_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_treatments" ADD CONSTRAINT "tax_treatments_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_user_id_user_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_settings" ADD CONSTRAINT "booking_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_organizer_user_id_user_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_watch_channels" ADD CONSTRAINT "calendar_watch_channels_calendar_connection_id_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_syncs" ADD CONSTRAINT "event_syncs_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_syncs" ADD CONSTRAINT "event_syncs_calendar_connection_id_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_reservations" ADD CONSTRAINT "slot_reservations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consents" ADD CONSTRAINT "sms_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_availability" ADD CONSTRAINT "staff_availability_staff_user_id_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_page_id_content_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."content_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_file_id_file_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_grants" ADD CONSTRAINT "file_access_grants_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_download_log" ADD CONSTRAINT "file_download_log_file_id_file_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_download_log" ADD CONSTRAINT "file_download_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_configs" ADD CONSTRAINT "integration_configs_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_file_id_file_objects_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_references" ADD CONSTRAINT "secret_references_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consents_user_idx" ON "consents" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "impersonation_admin_idx" ON "impersonation_sessions" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "invitation_org_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_unique" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_user_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "partner_profiles_type_idx" ON "partner_profiles" USING btree ("partner_type");--> statement-breakpoint
CREATE INDEX "resource_grants_lookup_idx" ON "resource_grants" USING btree ("user_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_grants_resource_idx" ON "resource_grants" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_roles_user_idx" ON "staff_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_roles_active_unique" ON "staff_roles" USING btree ("user_id","role") WHERE "staff_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "market_flags_market_idx" ON "market_flags" USING btree ("market_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "market_revisions_unique" ON "market_revisions" USING btree ("market_id","version");--> statement-breakpoint
CREATE INDEX "markets_location_gix" ON "markets" USING gist ("location");--> statement-breakpoint
CREATE INDEX "markets_state_idx" ON "markets" USING btree ("state_id");--> statement-breakpoint
CREATE INDEX "markets_publication_idx" ON "markets" USING btree ("publication_state");--> statement-breakpoint
CREATE UNIQUE INDEX "neighborhoods_market_slug_unique" ON "neighborhoods" USING btree ("market_id","slug");--> statement-breakpoint
CREATE INDEX "neighborhoods_boundary_gix" ON "neighborhoods" USING gist ("boundary");--> statement-breakpoint
CREATE UNIQUE INDEX "states_country_name_unique" ON "states" USING btree ("country_code","name");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_interpretations_unique" ON "observation_interpretations" USING btree ("observation_id","version");--> statement-breakpoint
CREATE INDEX "observation_interpretations_current_idx" ON "observation_interpretations" USING btree ("observation_id") WHERE "observation_interpretations"."is_current";--> statement-breakpoint
CREATE INDEX "observation_reviews_obs_idx" ON "observation_reviews" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "observations_market_idx" ON "observations" USING btree ("market_id","metric");--> statement-breakpoint
CREATE INDEX "observations_state_idx" ON "observations" USING btree ("state_id","metric");--> statement-breakpoint
CREATE INDEX "observations_metric_idx" ON "observations" USING btree ("metric");--> statement-breakpoint
CREATE INDEX "recommendation_snapshots_scenario_idx" ON "recommendation_snapshots" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX "research_tasks_market_idx" ON "research_tasks" USING btree ("market_id","status");--> statement-breakpoint
CREATE INDEX "scenarios_owner_idx" ON "scenarios" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "scenarios_anon_idx" ON "scenarios" USING btree ("anonymous_token");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_coverage_unique" ON "supplier_coverage" USING btree ("facility_id","market_id");--> statement-breakpoint
CREATE INDEX "supplier_quotes_market_idx" ON "supplier_quotes" USING btree ("market_id","material");--> statement-breakpoint
CREATE INDEX "supply_facilities_state_idx" ON "supply_facilities" USING btree ("state_id","material");--> statement-breakpoint
CREATE INDEX "assignments_assignee_idx" ON "assignments" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "assignments_sr_idx" ON "assignments" USING btree ("service_request_id");--> statement-breakpoint
CREATE INDEX "assignments_project_idx" ON "assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "engagement_transitions_sr_idx" ON "engagement_transitions" USING btree ("service_request_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "notes_entity_idx" ON "notes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_unique" ON "quote_versions" USING btree ("quote_id","version");--> statement-breakpoint
CREATE INDEX "quotes_sr_idx" ON "quotes" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_coverage_unique" ON "service_coverage" USING btree ("market_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_package_revisions_unique" ON "service_package_revisions" USING btree ("package_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "service_packages_slug_unique" ON "service_packages" USING btree ("service_id","slug");--> statement-breakpoint
CREATE INDEX "service_requests_org_idx" ON "service_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_service_idx" ON "service_requests" USING btree ("service_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_pm_idx" ON "service_requests" USING btree ("assigned_pm_user_id");--> statement-breakpoint
CREATE INDEX "services_category_idx" ON "services" USING btree ("category","sort_order");--> statement-breakpoint
CREATE INDEX "tasks_org_idx" ON "tasks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_revisions_unique" ON "listing_revisions" USING btree ("listing_id","version");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "listings_property_idx" ON "listings" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "offers_listing_idx" ON "offers" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "offers_sr_idx" ON "offers" USING btree ("service_request_id");--> statement-breakpoint
CREATE INDEX "owner_authorities_property_idx" ON "owner_authorities" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "parcels_property_idx" ON "parcels" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "properties_org_idx" ON "properties" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "properties_market_idx" ON "properties" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "properties_location_gix" ON "properties" USING gist ("location");--> statement-breakpoint
CREATE INDEX "saved_searches_user_idx" ON "saved_searches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shortlist_items_shortlist_idx" ON "shortlist_items" USING btree ("shortlist_id");--> statement-breakpoint
CREATE INDEX "shortlists_sr_idx" ON "shortlists" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "units_property_label_unique" ON "units" USING btree ("property_id","label");--> statement-breakpoint
CREATE INDEX "viewings_listing_idx" ON "viewings" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "approval_duration_obs_idx" ON "approval_duration_observations" USING btree ("jurisdiction","permit_type");--> statement-breakpoint
CREATE INDEX "approvals_entity_idx" ON "approvals" USING btree ("entity_type","entity_id","status");--> statement-breakpoint
CREATE INDEX "boq_items_budget_idx" ON "boq_items" USING btree ("budget_version_id");--> statement-breakpoint
CREATE INDEX "budget_commitments_project_idx" ON "budget_commitments" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_unique" ON "budget_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "change_orders_number_unique" ON "change_orders" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "defects_project_idx" ON "defects" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "design_comments_option_idx" ON "design_comments" USING btree ("design_option_id");--> statement-breakpoint
CREATE INDEX "design_options_project_idx" ON "design_options" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_project_idx" ON "evidence" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evidence_visit_idx" ON "evidence" USING btree ("site_visit_id");--> statement-breakpoint
CREATE INDEX "evidence_report_idx" ON "evidence" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "milestones_project_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "permit_applications_project_idx" ON "permit_applications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "permit_events_application_idx" ON "permit_events" USING btree ("permit_application_id");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "projects_pm_idx" ON "projects" USING btree ("pm_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_revisions_unique" ON "report_revisions" USING btree ("report_id","version");--> statement-breakpoint
CREATE INDEX "reports_org_idx" ON "reports" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "reports_project_idx" ON "reports" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "reports_sr_idx" ON "reports" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_baselines_unique" ON "schedule_baselines" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_tasks_unique" ON "schedule_tasks" USING btree ("project_id","schedule_version","key");--> statement-breakpoint
CREATE INDEX "site_visits_project_idx" ON "site_visits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "site_visits_inspector_idx" ON "site_visits" USING btree ("inspector_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_unique" ON "task_dependencies" USING btree ("project_id","schedule_version","predecessor_key","successor_key");--> statement-breakpoint
CREATE INDEX "bid_access_log_bid_idx" ON "bid_access_log" USING btree ("bid_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_evaluations_unique" ON "bid_evaluations" USING btree ("bid_id","evaluator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_revisions_unique" ON "bid_revisions" USING btree ("bid_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_unique" ON "bids" USING btree ("tender_id","partner_user_id");--> statement-breakpoint
CREATE INDEX "bids_partner_idx" ON "bids" USING btree ("partner_user_id");--> statement-breakpoint
CREATE INDEX "deliveries_po_idx" ON "deliveries" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "discrepancies_delivery_idx" ON "discrepancies" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "rfq_items_rfq_idx" ON "rfq_items" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "rfq_responses_rfq_idx" ON "rfq_responses" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "rfq_responses_supplier_idx" ON "rfq_responses" USING btree ("supplier_user_id");--> statement-breakpoint
CREATE INDEX "rfqs_org_idx" ON "rfqs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tender_invitations_unique" ON "tender_invitations" USING btree ("tender_id","partner_user_id");--> statement-breakpoint
CREATE INDEX "tender_invitations_partner_idx" ON "tender_invitations" USING btree ("partner_user_id");--> statement-breakpoint
CREATE INDEX "tender_questions_tender_idx" ON "tender_questions" USING btree ("tender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tender_revisions_unique" ON "tender_revisions" USING btree ("tender_id","revision");--> statement-breakpoint
CREATE INDEX "tenders_org_idx" ON "tenders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tenders_deadline_idx" ON "tenders" USING btree ("submission_deadline_at");--> statement-breakpoint
CREATE INDEX "assets_property_idx" ON "assets" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "estates_org_idx" ON "estates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lease_parties_lease_idx" ON "lease_parties" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "lease_parties_user_idx" ON "lease_parties" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "leases_org_idx" ON "leases" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leases_property_idx" ON "leases" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "owner_statements_org_idx" ON "owner_statements" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "rent_allocations_lease_idx" ON "rent_allocations" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "rent_charges_lease_idx" ON "rent_charges" USING btree ("lease_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rent_schedules_unique" ON "rent_schedules" USING btree ("lease_id","period_start");--> statement-breakpoint
CREATE INDEX "stay_bookings_property_idx" ON "stay_bookings" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "warranties_asset_idx" ON "warranties" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "work_orders_org_idx" ON "work_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "work_orders_property_idx" ON "work_orders" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "work_orders_assignee_idx" ON "work_orders" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "allocations_invoice_idx" ON "allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "bank_transfer_receipts_invoice_idx" ON "bank_transfer_receipts" USING btree ("invoice_id","status");--> statement-breakpoint
CREATE INDEX "chargebacks_attempt_idx" ON "chargebacks" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invoices_due_idx" ON "invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_unique" ON "journal_lines" USING btree ("journal_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journals_source_idx" ON "journals" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_invoice_idx" ON "payment_attempts" USING btree ("invoice_id","status");--> statement-breakpoint
CREATE INDEX "payment_attempts_provider_ref_idx" ON "payment_attempts" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "payouts_org_idx" ON "payouts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "provider_events_reference_idx" ON "provider_events" USING btree ("provider","reference");--> statement-breakpoint
CREATE INDEX "receipts_invoice_idx" ON "receipts" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "refunds_attempt_idx" ON "refunds" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "appointments_staff_idx" ON "appointments" USING btree ("staff_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("customer_user_id");--> statement-breakpoint
CREATE INDEX "appointments_org_idx" ON "appointments" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_unique" ON "calendar_connections" USING btree ("provider","environment","organizer_user_id");--> statement-breakpoint
CREATE INDEX "calendar_watch_channels_conn_idx" ON "calendar_watch_channels" USING btree ("calendar_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_unique" ON "conversation_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "conversation_participants_user_idx" ON "conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_org_idx" ON "conversations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "conversations_entity_idx" ON "conversations" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "delivery_attempts_status_idx" ON "delivery_attempts" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "delivery_attempts_provider_msg_idx" ON "delivery_attempts" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "delivery_attempts_user_idx" ON "delivery_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "event_syncs_provider_event_idx" ON "event_syncs" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_unique" ON "notification_preferences" USING btree ("user_id","channel","category");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenges_subject_idx" ON "otp_challenges" USING btree ("purpose","subject");--> statement-breakpoint
CREATE INDEX "slot_reservations_staff_idx" ON "slot_reservations" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "sms_consents_phone_idx" ON "sms_consents" USING btree ("phone_e_164","category","recorded_at");--> statement-breakpoint
CREATE INDEX "staff_availability_staff_idx" ON "staff_availability" USING btree ("staff_user_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_unique" ON "suppressions" USING btree ("channel","address");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_unique" ON "templates" USING btree ("key","channel","locale","version");--> statement-breakpoint
CREATE INDEX "analytics_events_name_idx" ON "analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "content_pages_kind_idx" ON "content_pages" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "content_revisions_unique" ON "content_revisions" USING btree ("page_id","revision");--> statement-breakpoint
CREATE INDEX "file_access_grants_file_idx" ON "file_access_grants" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_access_grants_user_idx" ON "file_access_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "file_download_log_file_idx" ON "file_download_log" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "file_objects_org_idx" ON "file_objects" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "file_objects_entity_idx" ON "file_objects" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "file_objects_status_idx" ON "file_objects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_configs_unique" ON "integration_configs" USING btree ("provider","environment","version");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_configs_active_unique" ON "integration_configs" USING btree ("provider","environment") WHERE "integration_configs"."is_active";--> statement-breakpoint
CREATE INDEX "integration_logs_provider_idx" ON "integration_logs" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX "job_failures_job_idx" ON "job_failures" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("queue","priority","run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "media_assets_file_idx" ON "media_assets" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "secret_references_lookup_idx" ON "secret_references" USING btree ("provider","environment","field_name");