-- =============================================================================
-- Non-destructive alignment for an existing public.messages table
-- =============================================================================
-- Use this only if you want to inspect the rename step on its own.
-- For a normal setup, run supabase/setup.sql instead — it includes this
-- alignment and then creates indexes, RLS, and the voice bucket.
--
-- Does NOT drop the table, delete rows, disable RLS, or add a second
-- audio-reference column. Values in audio_key become audio_path.
-- =============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'audio_key'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'audio_path'
  ) then
    alter table public.messages rename column audio_key to audio_path;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'contributor_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'name'
  ) then
    alter table public.messages rename column contributor_name to name;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'message_type'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'type'
  ) then
    alter table public.messages rename column message_type to type;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'message_text'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'text'
  ) then
    alter table public.messages rename column message_text to text;
  end if;

  -- Older dashboard tables used font_name NOT NULL DEFAULT 'Caveat'.
  -- Rename keeps that default; voice rows need font IS NULL.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'font_name'
  ) then
    alter table public.messages alter column font_name drop not null;
    alter table public.messages alter column font_name drop default;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'font_name'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'font'
  ) then
    alter table public.messages rename column font_name to font;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'font'
  ) then
    alter table public.messages alter column font drop not null;
    alter table public.messages alter column font drop default;
  end if;
end $$;

alter table public.messages add column if not exists duration integer;
alter table public.messages add column if not exists mime_type text;
