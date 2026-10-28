-- Fix Admin delete when the confirm box works but the note stays on the card.
-- Safe to re-run. Does not drop public.messages or delete rows.
--
-- Visitors (anon) still cannot delete. Any signed-in Auth user can.
-- If you later want one email only, replace the USING clause with:
--   using (lower(auth.jwt() ->> 'email') = lower('you@example.com'))
-- using the exact address from Authentication → Users.

grant delete on table public.messages to authenticated;
revoke delete on table public.messages from anon;
revoke update on table public.messages from anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'messages'
      and cmd = 'DELETE'
  loop
    execute format('drop policy if exists %I on public.messages', r.policyname);
  end loop;
end $$;

create policy "authenticated can delete messages"
  on public.messages
  for delete
  to authenticated
  using (auth.role() = 'authenticated');
