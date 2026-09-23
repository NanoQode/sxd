-- Active participants may update their conversation row (posting a message
-- bumps last_message_at). Inserts are still limited to staff and the creator,
-- because participant rows are written after the conversation exists.
SELECT app.apply_row_policy('conversations',
  $r$ app.privileged() OR created_by = app.user_id() OR EXISTS (
        SELECT 1 FROM public.conversation_participants cp
        WHERE cp.conversation_id = conversations.id AND cp.user_id = app.user_id() AND cp.left_at IS NULL) $r$,
  $w$ app.privileged() OR created_by = app.user_id() OR EXISTS (
        SELECT 1 FROM public.conversation_participants cp
        WHERE cp.conversation_id = conversations.id AND cp.user_id = app.user_id() AND cp.left_at IS NULL) $w$);
