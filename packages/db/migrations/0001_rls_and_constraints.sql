-- Custom migration: request-context helpers, row-level security, append-only
-- protections, ledger balancing, booking-slot exclusion and runtime grants.
-- Applied by the owner role; the application connects as simplexd_app.

CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.user_id() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.org_id() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.anon_token() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.anon_token', true), '')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.staff', true), '') = 'on'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_bypass() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(current_setting('app.bypass', true), '') = 'on'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.privileged() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.is_staff() OR app.is_bypass()
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.org_match(org text) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT app.privileged() OR (org IS NOT NULL AND org = app.org_id())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.has_grant(rtype text, rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.user_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.resource_grants g
    WHERE g.user_id = app.user_id() AND g.resource_type = rtype AND g.resource_id = rid
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_service_request(sid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.service_requests s
    WHERE s.id = sid AND (
      app.org_match(s.organization_id)
      OR app.has_grant('service_request', s.id)
      OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.service_request_id = s.id
                 AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active'))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_project(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = pid AND (
      app.org_match(p.organization_id)
      OR app.has_grant('project', p.id)
      OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.project_id = p.id
                 AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active'))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_property(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = pid AND (
      app.org_match(p.organization_id)
      OR app.has_grant('property', p.id)
      OR EXISTS (SELECT 1 FROM public.leases l JOIN public.lease_parties lp ON lp.lease_id = l.id
                 WHERE l.property_id = p.id AND lp.user_id = app.user_id() AND lp.access_status = 'active')
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_lease(lid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lid AND (
      app.org_match(l.organization_id)
      OR app.has_grant('lease', l.id)
      OR EXISTS (SELECT 1 FROM public.lease_parties lp WHERE lp.lease_id = l.id
                 AND lp.user_id = app.user_id() AND lp.access_status = 'active')
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_tender(tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenders t
    WHERE t.id = tid AND (
      app.org_match(t.organization_id)
      OR (t.status <> 'draft' AND EXISTS (SELECT 1 FROM public.tender_invitations ti
            WHERE ti.tender_id = t.id AND ti.partner_user_id = app.user_id()))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_bid(bid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bids b JOIN public.tenders t ON t.id = b.tender_id
    WHERE b.id = bid AND (
      app.is_bypass()
      OR b.partner_user_id = app.user_id()
      OR (app.is_staff() AND (b.opened_at IS NOT NULL OR (t.submission_deadline_at IS NOT NULL
            AND t.submission_deadline_at <= now() AND t.status IN ('closed','evaluating','awarded'))))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_invoice(iid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = iid AND (app.org_match(i.organization_id) OR (i.customer_user_id IS NOT NULL AND i.customer_user_id = app.user_id()))
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_conversation(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT app.privileged() OR EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = cid AND cp.user_id = app.user_id() AND cp.left_at IS NULL
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_scenario(sid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.scenarios s
    WHERE s.id = sid AND (
      app.privileged()
      OR (s.owner_user_id IS NOT NULL AND s.owner_user_id = app.user_id())
      OR (s.organization_id IS NOT NULL AND s.organization_id = app.org_id())
      OR (s.anonymous_token IS NOT NULL AND s.anonymous_token = app.anon_token())
      OR (s.share_token IS NOT NULL AND s.share_token = app.anon_token())
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_rfq(rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rfqs r
    WHERE r.id = rid AND (
      app.org_match(r.organization_id)
      OR EXISTS (SELECT 1 FROM public.rfq_responses rr WHERE rr.rfq_id = r.id AND rr.supplier_user_id = app.user_id())
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_purchase_order(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.purchase_orders po
    WHERE po.id = pid AND (app.org_match(po.organization_id) OR po.supplier_user_id = app.user_id())
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_report(rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reports r
    WHERE r.id = rid AND (
      app.privileged()
      OR r.created_by = app.user_id()
      OR r.named_reviewer_user_id = app.user_id()
      OR (r.customer_visible AND r.organization_id = app.org_id())
      OR (r.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.project_id = r.project_id
            AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active')))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_access_file(fid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.file_objects f
    WHERE f.id = fid AND (
      app.privileged()
      OR (f.owner_user_id IS NOT NULL AND f.owner_user_id = app.user_id())
      OR (f.organization_id IS NOT NULL AND f.organization_id = app.org_id())
      OR EXISTS (SELECT 1 FROM public.file_access_grants g WHERE g.file_id = f.id AND g.revoked_at IS NULL
                 AND (g.expires_at IS NULL OR g.expires_at > now())
                 AND ((g.user_id IS NOT NULL AND g.user_id = app.user_id()) OR (g.organization_id IS NOT NULL AND g.organization_id = app.org_id())))
    )
  )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.apply_policy(tbl text, expr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_access', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (%s) WITH CHECK (%s)', tbl || '_access', tbl, expr, expr);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.apply_split_policy(tbl text, read_expr text, write_expr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_read', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (%s)', tbl || '_read', tbl, read_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s)', tbl || '_insert', tbl, write_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl || '_update', tbl, write_expr, write_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (%s)', tbl || '_delete', tbl, write_expr);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.apply_public_read_staff_write(tbl text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.apply_split_policy(tbl, 'true', 'app.privileged()');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.apply_privileged_only(tbl text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.apply_policy(tbl, 'app.privileged()');
END $$;
--> statement-breakpoint
-- Identity extensions
SELECT app.apply_policy('user_profiles', $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('organization_profiles', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_split_policy('staff_roles', $p$ app.privileged() OR user_id = app.user_id() $p$, $p$ app.privileged() $p$);
--> statement-breakpoint
SELECT app.apply_split_policy('partner_profiles', $p$ app.privileged() OR user_id = app.user_id() OR verification_status = 'verified' $p$, $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('resource_grants', $p$ app.privileged() OR user_id = app.user_id() OR granted_by = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('consents', $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('idempotency_keys', $p$ app.privileged() OR requester_id = app.user_id() OR requester_id = app.anon_token() $p$);
--> statement-breakpoint
SELECT app.apply_privileged_only('impersonation_sessions');
--> statement-breakpoint
SELECT app.apply_privileged_only('setup_tokens');
--> statement-breakpoint
-- Geography and intelligence: public read, staff write
SELECT app.apply_public_read_staff_write(t) FROM unnest(ARRAY[
  'countries','states','sources','markets','market_revisions','neighborhoods','market_flags',
  'observations','observation_interpretations','observation_reviews','supply_facilities','supplier_coverage',
  'supplier_quotes','ranking_policies','freshness_policies','data_policy_settings','research_tasks',
  'services','service_packages','service_package_revisions','service_coverage','sla_policies','quote_templates',
  'content_pages','content_revisions','media_assets','redirects','feature_flags','settings','templates',
  'timeline_templates','approval_duration_observations','ledger_accounts','tax_treatments','booking_settings',
  'staff_availability'
]) AS t;
--> statement-breakpoint
SELECT app.apply_privileged_only('market_imports');
--> statement-breakpoint
SELECT app.apply_policy('scenarios', $p$ app.privileged()
  OR (owner_user_id IS NOT NULL AND owner_user_id = app.user_id())
  OR (organization_id IS NOT NULL AND organization_id = app.org_id())
  OR (anonymous_token IS NOT NULL AND anonymous_token = app.anon_token())
  OR (share_token IS NOT NULL AND share_token = app.anon_token()) $p$);
--> statement-breakpoint
SELECT app.apply_policy('recommendation_snapshots', $p$ app.can_access_scenario(scenario_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('comparison_reports', $p$ app.can_access_scenario(scenario_id) $p$);
--> statement-breakpoint
-- CRM and engagements
SELECT app.apply_policy('leads', $p$ app.privileged() OR (user_id IS NOT NULL AND user_id = app.user_id()) $p$);
--> statement-breakpoint
SELECT app.apply_policy('service_requests', $p$ app.can_access_service_request(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('engagement_transitions', $p$ app.can_access_service_request(service_request_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('quotes', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('quote_versions', $p$ EXISTS (SELECT 1 FROM public.quotes q WHERE q.id = quote_id AND app.org_match(q.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('acceptances', $p$ app.privileged() OR accepted_by_user_id = app.user_id() OR EXISTS (SELECT 1 FROM public.quote_versions qv JOIN public.quotes q ON q.id = qv.quote_id WHERE qv.id = quote_version_id AND app.org_match(q.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('assignments', $p$ app.org_match(organization_id) OR assignee_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('tasks', $p$ (app.org_match(organization_id) AND (app.privileged() OR visibility IN ('customer','all'))) OR assignee_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('notes', $p$ app.privileged() OR author_user_id = app.user_id() OR (organization_id IS NOT NULL AND organization_id = app.org_id() AND visibility IN ('customer','all')) $p$);
--> statement-breakpoint
-- Property
SELECT app.apply_policy('properties', $p$ app.can_access_property(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('parcels', $p$ app.can_access_property(property_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('units', $p$ app.can_access_property(property_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('owner_authorities', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_split_policy('listings', $p$ app.org_match(organization_id) OR status = 'published' $p$, $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_split_policy('listing_revisions',
  $p$ EXISTS (SELECT 1 FROM public.listings l WHERE l.id = listing_id AND (app.org_match(l.organization_id) OR (l.status = 'published' AND l.published_version = listing_revisions.version))) $p$,
  $p$ EXISTS (SELECT 1 FROM public.listings l WHERE l.id = listing_id AND app.org_match(l.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('offers', $p$ app.org_match(organization_id) OR app.org_match(counterparty_organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('viewings', $p$ app.org_match(organization_id) OR requested_by_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('saved_searches', $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('shortlists', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('shortlist_items', $p$ EXISTS (SELECT 1 FROM public.shortlists s WHERE s.id = shortlist_id AND app.org_match(s.organization_id)) $p$);
--> statement-breakpoint
-- Projects
SELECT app.apply_policy('projects', $p$ app.can_access_project(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('budget_versions', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('boq_items', $p$ EXISTS (SELECT 1 FROM public.budget_versions b WHERE b.id = budget_version_id AND app.can_access_project(b.project_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('budget_commitments', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('schedule_tasks', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('task_dependencies', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('schedule_baselines', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('milestones', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('site_visits', $p$ app.org_match(organization_id) OR inspector_user_id = app.user_id() OR (project_id IS NOT NULL AND app.can_access_project(project_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('reports', $p$ app.can_access_report(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('report_revisions', $p$ app.can_access_report(report_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('evidence', $p$ app.privileged() OR uploader_user_id = app.user_id()
  OR (organization_id = app.org_id() AND publication IN ('approved','redacted_public'))
  OR (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.project_id = evidence.project_id AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active'))) $p$);
--> statement-breakpoint
SELECT app.apply_policy('defects', $p$ app.org_match(organization_id) OR created_by = app.user_id() OR (project_id IS NOT NULL AND app.can_access_project(project_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('change_orders', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('approvals', $p$ app.org_match(organization_id) OR approver_user_id = app.user_id() OR requested_by = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('design_options', $p$ app.can_access_project(project_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('design_comments', $p$ EXISTS (SELECT 1 FROM public.design_options d WHERE d.id = design_option_id AND app.can_access_project(d.project_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('permit_applications', $p$ app.org_match(organization_id) OR (project_id IS NOT NULL AND app.can_access_project(project_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('permit_events', $p$ EXISTS (SELECT 1 FROM public.permit_applications pa WHERE pa.id = permit_application_id AND (app.org_match(pa.organization_id) OR (pa.project_id IS NOT NULL AND app.can_access_project(pa.project_id)))) $p$);
--> statement-breakpoint
-- Commercial
SELECT app.apply_policy('tenders', $p$ app.can_access_tender(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('tender_revisions', $p$ app.can_access_tender(tender_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('tender_invitations', $p$ partner_user_id = app.user_id() OR EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = tender_id AND app.org_match(t.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('tender_questions', $p$ asked_by_user_id = app.user_id() OR (published AND app.can_access_tender(tender_id)) OR EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = tender_id AND app.org_match(t.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('bids', $p$ app.can_access_bid(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('bid_revisions', $p$ app.can_access_bid(bid_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('bid_evaluations', $p$ app.privileged() OR evaluator_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('awards', $p$ app.privileged() OR (published_at IS NOT NULL AND (app.can_access_tender(tender_id) OR EXISTS (SELECT 1 FROM public.bids b WHERE b.id = bid_id AND b.partner_user_id = app.user_id()))) $p$);
--> statement-breakpoint
SELECT app.apply_privileged_only('bid_access_log');
--> statement-breakpoint
SELECT app.apply_policy('rfqs', $p$ app.can_access_rfq(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rfq_items', $p$ app.can_access_rfq(rfq_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rfq_responses', $p$ supplier_user_id = app.user_id() OR EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rfq_id AND app.org_match(r.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('purchase_orders', $p$ app.can_access_purchase_order(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('deliveries', $p$ app.can_access_purchase_order(purchase_order_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('discrepancies', $p$ EXISTS (SELECT 1 FROM public.deliveries d WHERE d.id = delivery_id AND app.can_access_purchase_order(d.purchase_order_id)) $p$);
--> statement-breakpoint
-- Rental
SELECT app.apply_policy('estates', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('leases', $p$ app.can_access_lease(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('lease_parties', $p$ app.can_access_lease(lease_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rent_schedules', $p$ app.can_access_lease(lease_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rent_charges', $p$ app.can_access_lease(lease_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rent_allocations', $p$ app.can_access_lease(lease_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('assets', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('warranties', $p$ EXISTS (SELECT 1 FROM public.assets a WHERE a.id = asset_id AND app.org_match(a.organization_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('work_orders', $p$ app.org_match(organization_id) OR reported_by_user_id = app.user_id() OR assignee_user_id = app.user_id() OR (lease_id IS NOT NULL AND app.can_access_lease(lease_id)) $p$);
--> statement-breakpoint
SELECT app.apply_policy('owner_statements', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('stay_bookings', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
-- Finance
SELECT app.apply_policy('invoices', $p$ app.can_access_invoice(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('invoice_lines', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('payment_attempts', $p$ app.can_access_invoice(invoice_id) OR initiated_by_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('bank_transfer_receipts', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('credit_notes', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('allocations', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('receipts', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('refunds', $p$ app.can_access_invoice(invoice_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('payouts', $p$ app.org_match(organization_id) $p$);
--> statement-breakpoint
SELECT app.apply_privileged_only(t) FROM unnest(ARRAY['journals','journal_lines','chargebacks','reconciliations','provider_events']) AS t;
--> statement-breakpoint
-- Communications
SELECT app.apply_policy('appointments', $p$ app.privileged() OR staff_user_id = app.user_id() OR (customer_user_id IS NOT NULL AND customer_user_id = app.user_id()) OR (organization_id IS NOT NULL AND organization_id = app.org_id()) OR (manage_token IS NOT NULL AND manage_token = app.anon_token()) $p$);
--> statement-breakpoint
SELECT app.apply_policy('slot_reservations', $p$ app.privileged() OR staff_user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_privileged_only(t) FROM unnest(ARRAY['calendar_connections','event_syncs','calendar_watch_channels','delivery_attempts','sms_consents','suppressions','otp_challenges']) AS t;
--> statement-breakpoint
SELECT app.apply_policy('conversations', $p$ app.can_access_conversation(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('conversation_participants', $p$ app.can_access_conversation(conversation_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('messages', $p$ app.can_access_conversation(conversation_id) AND (NOT internal_only OR app.privileged()) $p$);
--> statement-breakpoint
SELECT app.apply_policy('notifications', $p$ app.is_bypass() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_policy('notification_preferences', $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
-- Platform
SELECT app.apply_policy('file_objects', $p$ app.can_access_file(id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('file_access_grants', $p$ app.privileged() OR user_id = app.user_id() OR granted_by = app.user_id() OR EXISTS (SELECT 1 FROM public.file_objects f WHERE f.id = file_id AND f.owner_user_id = app.user_id()) $p$);
--> statement-breakpoint
SELECT app.apply_policy('file_download_log', $p$ app.privileged() OR user_id = app.user_id() $p$);
--> statement-breakpoint
SELECT app.apply_privileged_only(t) FROM unnest(ARRAY['secret_references','integration_configs','integration_logs','audit_events','outbox_events','jobs','job_failures','analytics_events','rate_limit_buckets']) AS t;
--> statement-breakpoint
-- Append-only protections
CREATE OR REPLACE FUNCTION app.prevent_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_events','journals','journal_lines','engagement_transitions','consents','allocations',
    'observations','observation_reviews','bid_access_log','file_download_log','receipts','acceptances','market_revisions',
    'tender_revisions','bid_revisions','service_package_revisions','schedule_baselines','recommendation_snapshots','permit_events']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_modification()', t || '_append_only', t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.protect_provider_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_events rows cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.raw_body IS DISTINCT FROM OLD.raw_body OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.signature_valid IS DISTINCT FROM OLD.signature_valid OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'provider_events payload columns are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_events_protect ON public.provider_events;
--> statement-breakpoint
CREATE TRIGGER provider_events_protect BEFORE UPDATE OR DELETE ON public.provider_events FOR EACH ROW EXECUTE FUNCTION app.protect_provider_event();
--> statement-breakpoint
-- Ledger: every journal must balance and carry at least two lines in one currency.
CREATE OR REPLACE FUNCTION app.assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
  d bigint; c bigint; n integer; ncur integer;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN jid := NEW.id; ELSE jid := NEW.journal_id; END IF;
  SELECT COALESCE(SUM(debit_kobo),0), COALESCE(SUM(credit_kobo),0), COUNT(*), COUNT(DISTINCT currency)
    INTO d, c, n, ncur FROM public.journal_lines WHERE journal_id = jid;
  IF n < 2 THEN RAISE EXCEPTION 'journal % must have at least two lines', jid USING ERRCODE = 'P0002'; END IF;
  IF d <> c THEN RAISE EXCEPTION 'journal % is not balanced (debit %, credit %)', jid, d, c USING ERRCODE = 'P0002'; END IF;
  IF ncur > 1 THEN RAISE EXCEPTION 'journal % mixes currencies', jid USING ERRCODE = 'P0002'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journals_balanced ON public.journals;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journals_balanced AFTER INSERT ON public.journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_journal_balanced();
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_lines_balanced ON public.journal_lines;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON public.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_journal_balanced();
--> statement-breakpoint
-- Booking slots: no two reservations for one staff member may overlap.
ALTER TABLE public.slot_reservations ADD CONSTRAINT slot_reservations_bounded CHECK (NOT lower_inf(slot) AND NOT upper_inf(slot) AND lower(slot) < upper(slot));
--> statement-breakpoint
ALTER TABLE public.slot_reservations ADD CONSTRAINT slot_reservations_no_overlap EXCLUDE USING gist (staff_user_id WITH =, slot WITH &&);
--> statement-breakpoint
-- Runtime role grants (only when the dedicated role exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simplexd_app') THEN
    GRANT USAGE ON SCHEMA public TO simplexd_app;
    GRANT USAGE ON SCHEMA app TO simplexd_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO simplexd_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO simplexd_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO simplexd_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO simplexd_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO simplexd_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO simplexd_app;
  END IF;
END $$;
