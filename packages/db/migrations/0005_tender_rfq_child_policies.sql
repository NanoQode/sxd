-- Proposed fix for the 0003 recursion (tenders <-> tender_invitations, rfqs <-> rfq_responses):
-- resolve the parent's organisation through a SECURITY DEFINER helper so the child policy
-- never re-enters the parent's row policy.
CREATE OR REPLACE FUNCTION app.tender_org_match(tid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = tid AND app.org_match(t.organization_id))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.rfq_org_match(rid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.rfqs r WHERE r.id = rid AND app.org_match(r.organization_id))
$$;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simplexd_app') THEN GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO simplexd_app; END IF; END $$;
--> statement-breakpoint
SELECT app.apply_policy('tender_invitations', $p$ partner_user_id = app.user_id() OR app.tender_org_match(tender_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('tender_questions', $p$ asked_by_user_id = app.user_id() OR (published AND app.can_access_tender(tender_id)) OR app.tender_org_match(tender_id) $p$);
--> statement-breakpoint
SELECT app.apply_policy('rfq_responses', $p$ supplier_user_id = app.user_id() OR app.rfq_org_match(rfq_id) $p$);
