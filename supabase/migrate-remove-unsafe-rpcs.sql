-- =============================================================================
-- Migration for projects that already ran the earlier setup.sql
-- =============================================================================
-- Safe to run in the SQL Editor. This does NOT delete submitted messages
-- and does NOT delete voice files.
--
-- It removes public wipe/delete RPCs and leftover storage delete/update
-- policies. Administrative deletion stays in the Supabase dashboard.
-- =============================================================================

drop function if exists public.cleanup_orphan_audio(text);
drop function if exists public.admin_reset_card(text);

drop policy if exists "anon can delete voice messages" on storage.objects;
drop policy if exists "anon can update voice messages" on storage.objects;

revoke update, delete on table public.messages from anon, authenticated;
