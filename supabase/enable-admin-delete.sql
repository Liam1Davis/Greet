-- Enable Admin deletion for an existing leaving-card project.
-- Safe to re-run. Does not drop the messages table or delete rows.
--
-- After this script:
--   1. Authentication → Users → Add user (email + password).
--   2. Use the footer Admin control on the website with that email/password.
--
-- Anon visitors still cannot delete. Voice files stay in the private
-- voice-messages bucket (the app’s audio store).

drop policy if exists "authenticated can delete messages" on public.messages;
create policy "authenticated can delete messages"
  on public.messages
  for delete
  to authenticated
  using (true);

grant delete on table public.messages to authenticated;
revoke delete on table public.messages from anon;
revoke update on table public.messages from anon, authenticated;

drop policy if exists "authenticated can delete voice messages" on storage.objects;
drop policy if exists "anon can delete voice messages" on storage.objects;
create policy "authenticated can delete voice messages"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'voice-messages');
