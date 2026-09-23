-- Append-only logs written from customer, partner and anonymous request paths.
--
-- audit_events, outbox_events and analytics_events were privileged-only, which
-- forced request code to elevate the whole transaction (bypass) just to append
-- an audit row or an outbox event. Appending is now allowed for every actor;
-- reading, updating and deleting stay privileged (updates and deletes on
-- audit_events are additionally blocked by the append-only trigger).
CREATE OR REPLACE FUNCTION app.apply_append_only_log(tbl text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_access', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_read', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (app.privileged())', tbl || '_read', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (true)', tbl || '_insert', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (app.privileged()) WITH CHECK (app.privileged())', tbl || '_update', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (app.privileged())', tbl || '_delete', tbl);
END $$;
--> statement-breakpoint
SELECT app.apply_append_only_log(t) FROM unnest(ARRAY['audit_events','outbox_events','analytics_events']) AS t;
--> statement-breakpoint
-- Public forms create leads and consent records for visitors who have no
-- account. Anonymous rows (user_id IS NULL) may be inserted by anyone but are
-- only readable by staff; signed-in users keep their own rows.
CREATE OR REPLACE FUNCTION app.apply_owner_or_anonymous_insert(tbl text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_access', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_read', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_insert', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_update', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_delete', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (app.privileged() OR (user_id IS NOT NULL AND user_id = app.user_id()))', tbl || '_read', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (app.privileged() OR user_id IS NULL OR user_id = app.user_id())', tbl || '_insert', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (app.privileged() OR (user_id IS NOT NULL AND user_id = app.user_id())) WITH CHECK (app.privileged() OR (user_id IS NOT NULL AND user_id = app.user_id()))', tbl || '_update', tbl);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (app.privileged())', tbl || '_delete', tbl);
END $$;
--> statement-breakpoint
SELECT app.apply_owner_or_anonymous_insert(t) FROM unnest(ARRAY['leads','consents']) AS t;
