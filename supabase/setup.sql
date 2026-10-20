-- =============================================================================
-- Tracey’s Leaving Card — Supabase setup
-- =============================================================================
-- Access model (read this before applying policies)
-- -----------------------------------------------------------------------------
-- This card has no logins. Colleagues open one public website and add a note.
--
-- The frontend uses the browser-safe anon/publishable key only. Anyone who
-- can load the JavaScript can use that key. An unlisted website address is
-- NOT access control. A private Storage bucket plus short-lived signed URLs
-- is NOT visitor authentication: the same people who can read the card can
-- request playback URLs.
--
-- Intended permissions:
--   * Anyone with the key can READ every message (the published card).
--   * Anyone with the key can INSERT one new message of their own.
--   * Nobody using the anon key can UPDATE or DELETE another person’s row.
--   * Nobody using the anon key can wipe the card or delete storage objects.
--   * Voice files live in a PRIVATE bucket. The database stores the object
--     path in audio_path only — never Base64 audio and never a signed URL.
--   * Playback: the app requests a short-lived signed URL at play time.
--
-- This script is safe to re-run. It does not DROP public.messages, delete
-- rows, or disable RLS. If the table already exists with dashboard names
-- (contributor_name, message_type, message_text, font_name, audio_key),
-- those columns are renamed to the names the application uses. Existing
-- values, including audio object keys, are preserved. It does not add a
-- second audio-reference column.
--
-- font is nullable and has no default. An older font_name column that was
-- NOT NULL DEFAULT 'Caveat' is stripped of that default after rename so
-- voice rows can store font IS NULL as messages_text_shape requires.
--
-- font is nullable and has no default. An older font_name column that was
-- NOT NULL DEFAULT 'Caveat' is stripped of that default after rename so
-- voice rows can store font IS NULL as messages_text_shape requires.
--
-- Run this entire script in the Supabase SQL Editor (as the project owner).
-- Enabling RLS without these policies would hide every row from the API.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Messages table (created only when missing)
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('text', 'voice')),
  name text not null check (char_length(trim(name)) between 1 and 40),
  text text,
  font text,
  duration integer,
  mime_type text,
  audio_path text,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Align an existing dashboard-created table with the application schema
-- -----------------------------------------------------------------------------
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
alter table public.messages add column if not exists type text;
alter table public.messages add column if not exists name text;
alter table public.messages add column if not exists text text;
alter table public.messages add column if not exists font text;
alter table public.messages add column if not exists audio_path text;
alter table public.messages add column if not exists created_at timestamptz default now();

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'messages_text_shape'
      and conrelid = 'public.messages'::regclass
  ) then
    return;
  end if;
  if exists (
    select 1 from public.messages
    where not (
      (type = 'text' and text is not null and char_length(trim(text)) between 1 and 400
        and font in ('caveat', 'dancing', 'greatvibes', 'patrick', 'indie', 'homemade')
        and duration is null and mime_type is null and audio_path is null)
      or
      (type = 'voice' and text is null and font is null
        and duration is not null and duration between 1 and 180
        and audio_path is not null and char_length(audio_path) > 0)
    )
  ) then
    raise notice 'Skipped messages_text_shape because existing rows do not yet match the application shape.';
    return;
  end if;
  alter table public.messages
    add constraint messages_text_shape check (
      (type = 'text' and text is not null and char_length(trim(text)) between 1 and 400
        and font in ('caveat', 'dancing', 'greatvibes', 'patrick', 'indie', 'homemade')
        and duration is null and mime_type is null and audio_path is null)
      or
      (type = 'voice' and text is null and font is null
        and duration is not null and duration between 1 and 180
        and audio_path is not null and char_length(audio_path) > 0)
    );
end $$;

create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists messages_audio_path_idx on public.messages (audio_path);

alter table public.messages enable row level security;

drop policy if exists "anyone can read messages" on public.messages;
drop policy if exists "anyone can add a message" on public.messages;

create policy "anyone can read messages"
  on public.messages
  for select
  to anon, authenticated
  using (true);

create policy "anyone can add a message"
  on public.messages
  for insert
  to anon, authenticated
  with check (true);

-- Intentionally no UPDATE or DELETE policies for anon/authenticated.

grant usage on schema public to anon, authenticated;
grant select, insert on table public.messages to anon, authenticated;
revoke update, delete on table public.messages from anon, authenticated;

drop function if exists public.cleanup_orphan_audio(text);
drop function if exists public.admin_reset_card(text);

-- -----------------------------------------------------------------------------
-- Private voice bucket
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voice-messages',
  'voice-messages',
  false,
  5242880,
  array[
    'audio/webm',
    'audio/mp4',
    'audio/ogg',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "anon can upload voice messages" on storage.objects;
drop policy if exists "anon can read voice messages" on storage.objects;
drop policy if exists "anon can delete voice messages" on storage.objects;
drop policy if exists "anon can update voice messages" on storage.objects;

create policy "anon can upload voice messages"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'voice-messages');

create policy "anon can read voice messages"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'voice-messages');
