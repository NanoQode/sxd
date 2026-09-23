-- Break the policy recursion between file_objects and file_access_grants:
-- the grants policy no longer queries file_objects (whose read policy queries
-- grants). Grants are visible to the grantee, the grantor, the grantee
-- organisation and privileged staff; only privileged staff or the grantor may
-- write them (the application checks file ownership before granting).
SELECT app.apply_row_policy('file_access_grants',
  $r$ app.privileged() OR user_id = app.user_id() OR granted_by = app.user_id()
      OR (organization_id IS NOT NULL AND organization_id = app.org_id()) $r$,
  $w$ app.privileged() OR granted_by = app.user_id() $w$);
