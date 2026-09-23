-- Inline row policies for the primary organisation-scoped tables.
--
-- The 0001 policies evaluated `app.can_access_<table>(id)` for every command.
-- Those helpers look the row up in a subquery, which cannot see a row that the
-- same statement is inserting, so INSERT (and INSERT ... RETURNING) was refused
-- for every context. The policies below express the same rules directly on the
-- row's columns, so inserts are checked on the new tuple; the helper functions
-- remain for child tables that reference these rows by id.
CREATE OR REPLACE FUNCTION app.apply_row_policy(tbl text, read_expr text, write_expr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_access', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_read', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (%s)', tbl || '_read', tbl, read_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s)', tbl || '_insert', tbl, write_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl || '_update', tbl, read_expr, write_expr);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (%s)', tbl || '_delete', tbl, write_expr);
END $$;
--> statement-breakpoint
SELECT app.apply_row_policy('service_requests',
  $r$ app.org_match(organization_id) OR app.has_grant('service_request', id)
      OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.service_request_id = service_requests.id
                 AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active')) $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('projects',
  $r$ app.org_match(organization_id) OR app.has_grant('project', id)
      OR EXISTS (SELECT 1 FROM public.assignments a WHERE a.project_id = projects.id
                 AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active')) $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('properties',
  $r$ app.org_match(organization_id) OR app.has_grant('property', id)
      OR EXISTS (SELECT 1 FROM public.leases l JOIN public.lease_parties lp ON lp.lease_id = l.id
                 WHERE l.property_id = properties.id AND lp.user_id = app.user_id() AND lp.access_status = 'active') $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('leases',
  $r$ app.org_match(organization_id) OR app.has_grant('lease', id)
      OR EXISTS (SELECT 1 FROM public.lease_parties lp WHERE lp.lease_id = leases.id
                 AND lp.user_id = app.user_id() AND lp.access_status = 'active') $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('reports',
  $r$ app.privileged() OR created_by = app.user_id() OR named_reviewer_user_id = app.user_id()
      OR (customer_visible AND organization_id = app.org_id())
      OR (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.assignments a WHERE a.project_id = reports.project_id
            AND a.assignee_user_id = app.user_id() AND a.status IN ('accepted','active'))) $r$,
  $w$ app.privileged() OR created_by = app.user_id() OR named_reviewer_user_id = app.user_id() $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('tenders',
  $r$ app.org_match(organization_id)
      OR (status <> 'draft' AND EXISTS (SELECT 1 FROM public.tender_invitations ti
            WHERE ti.tender_id = tenders.id AND ti.partner_user_id = app.user_id())) $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('bids',
  $r$ app.is_bypass() OR partner_user_id = app.user_id()
      OR (app.is_staff() AND (opened_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = bids.tender_id
            AND t.submission_deadline_at IS NOT NULL AND t.submission_deadline_at <= now()
            AND t.status IN ('closed','evaluating','awarded')))) $r$,
  $w$ app.is_bypass() OR partner_user_id = app.user_id() OR app.is_staff() $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('rfqs',
  $r$ app.org_match(organization_id)
      OR EXISTS (SELECT 1 FROM public.rfq_responses rr WHERE rr.rfq_id = rfqs.id AND rr.supplier_user_id = app.user_id()) $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('purchase_orders',
  $r$ app.org_match(organization_id) OR supplier_user_id = app.user_id() $r$,
  $w$ app.org_match(organization_id) OR supplier_user_id = app.user_id() $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('invoices',
  $r$ app.org_match(organization_id) OR (customer_user_id IS NOT NULL AND customer_user_id = app.user_id()) $r$,
  $w$ app.org_match(organization_id) $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('conversations',
  $r$ app.privileged() OR created_by = app.user_id() OR EXISTS (
        SELECT 1 FROM public.conversation_participants cp
        WHERE cp.conversation_id = conversations.id AND cp.user_id = app.user_id() AND cp.left_at IS NULL) $r$,
  $w$ app.privileged() OR created_by = app.user_id() $w$);
--> statement-breakpoint
SELECT app.apply_row_policy('file_objects',
  $r$ app.privileged()
      OR (owner_user_id IS NOT NULL AND owner_user_id = app.user_id())
      OR (organization_id IS NOT NULL AND organization_id = app.org_id())
      OR EXISTS (SELECT 1 FROM public.file_access_grants g WHERE g.file_id = file_objects.id AND g.revoked_at IS NULL
                 AND (g.expires_at IS NULL OR g.expires_at > now())
                 AND ((g.user_id IS NOT NULL AND g.user_id = app.user_id()) OR (g.organization_id IS NOT NULL AND g.organization_id = app.org_id()))) $r$,
  $w$ app.privileged() OR (owner_user_id IS NOT NULL AND owner_user_id = app.user_id())
      OR (organization_id IS NOT NULL AND organization_id = app.org_id()) $w$);
