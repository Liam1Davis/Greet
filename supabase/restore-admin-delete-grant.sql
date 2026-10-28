-- Restore Admin DELETE privilege on public.messages.
-- Safe to re-run. Does not drop the table, delete rows, or change RLS policies.
--
-- "permission denied for table messages" means the authenticated role lost
-- GRANT DELETE (for example after migrate-remove-unsafe-rpcs.sql). Your
-- email-locked delete policy can stay as it is.

grant delete on table public.messages to authenticated;
revoke delete on table public.messages from anon;
revoke update on table public.messages from anon, authenticated;
