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
--   * A signed-in Auth user (the organiser) can DELETE one message at a time
--     from the Admin footer control, including the matching voice file.
--   * Voice files live in a PRIVATE bucket. The database stores the object
--     path in audio_path only — never Base64 audio and never a signed URL.
--   * Playback of a public voice note: the app requests a short-lived signed URL.
--   * A private voice note stores its file under private/ and its PIN hash in
--     message_pins (pgcrypto). Anonymous reads cannot sign that object until
--     unlock_voice_message accepts the 4-digit PIN or the master passcode.
--     See the private-voice section at the end of this script.
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
  is_private boolean not null default false,
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
alter table public.messages add column if not exists is_private boolean not null default false;
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
drop policy if exists "authenticated can delete messages" on public.messages;

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

create policy "authenticated can delete messages"
  on public.messages
  for delete
  to authenticated
  using (true);

-- Anon still cannot update or delete. Authenticated (Admin sign-in) can delete.

grant usage on schema public to anon, authenticated;
grant select, insert on table public.messages to anon, authenticated;
grant delete on table public.messages to authenticated;
revoke update on table public.messages from anon, authenticated;
revoke delete on table public.messages from anon;

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
drop policy if exists "authenticated can delete voice messages" on storage.objects;

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

create policy "authenticated can delete voice messages"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'voice-messages');

-- -----------------------------------------------------------------------------
-- Private voice notes. Same statements as supabase/private-voice.sql so an
-- existing project can run that file on its own.
-- -----------------------------------------------------------------------------

-- Private voice notes for Tracey’s Leaving Card.
-- Safe to re-run. Does not delete messages or voice files.
--
-- After this script:
--   1. A contributor can tick “Make this message private” and set a 4-digit PIN.
--   2. The PIN is hashed in the database with pgcrypto. The website never stores pin_hash.
--   3. Visitors see a lock. Playback calls unlock_voice_message(message_id, provided_pin).
--   4. Admin (a signed-in Supabase Auth user) can play and delete without the PIN.
--
-- Optional master passcode. Choose your own. Do not commit the passphrase.
-- Run this once in the SQL Editor (crypt/gen_salt come from pgcrypto):
--
--   insert into public.card_secrets (id, master_pin_hash)
--   values (1, crypt('REPLACE_WITH_YOUR_PASSPHRASE', gen_salt('bf', 8)))
--   on conflict (id) do update set master_pin_hash = excluded.master_pin_hash;

create extension if not exists pgcrypto;

alter table public.messages add column if not exists is_private boolean not null default false;

alter table public.messages drop constraint if exists messages_private_path;
alter table public.messages add constraint messages_private_path check (
  (
    coalesce(is_private, false) = false
    and coalesce(audio_path, '') not like 'private/%'
  )
  or (
    is_private = true
    and audio_path like 'private/%'
  )
);

-- Secrets are not readable or writable with the anon key.
create table if not exists public.message_pins (
  message_id uuid primary key references public.messages(id) on delete cascade,
  pin_hash text not null
);

create table if not exists public.card_secrets (
  id integer primary key check (id = 1),
  master_pin_hash text
);

create table if not exists public.voice_playback_grants (
  object_name text primary key,
  expires_at timestamptz not null
);

create table if not exists public.pin_attempts (
  id bigint generated always as identity primary key,
  message_id uuid not null references public.messages(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index if not exists pin_attempts_message_idx
  on public.pin_attempts (message_id, attempted_at desc);

alter table public.message_pins enable row level security;
alter table public.card_secrets enable row level security;
alter table public.voice_playback_grants enable row level security;
alter table public.pin_attempts enable row level security;

revoke all on public.message_pins from public, anon, authenticated;
revoke all on public.card_secrets from public, anon, authenticated;
revoke all on public.voice_playback_grants from public, anon, authenticated;
revoke all on public.pin_attempts from public, anon, authenticated;

-- Browser inserts stay public. Private rows are created only by the RPC below.
drop policy if exists "anyone can add a message" on public.messages;
create policy "anyone can add a message"
  on public.messages
  for insert
  to anon, authenticated
  with check (
    coalesce(is_private, false) = false
    and coalesce(audio_path, '') not like 'private/%'
  );

-- Hide private object paths from anonymous reads of the card.
-- Signed-in Admin still receives audio_path.
create or replace view public.card_messages
with (security_invoker = true) as
select
  m.id,
  m.type,
  m.name,
  m.text,
  m.font,
  m.duration,
  m.mime_type,
  m.created_at,
  m.is_private,
  case
    when m.is_private and coalesce(auth.role(), '') is distinct from 'authenticated'
      then null
    else m.audio_path
  end as audio_path
from public.messages m;

grant select on public.card_messages to anon, authenticated;
revoke insert, update, delete on public.card_messages from public, anon, authenticated;

create or replace function public.voice_grant_active(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.voice_playback_grants g
    where g.object_name = voice_grant_active.object_name
      and g.expires_at > now()
  );
$$;

revoke all on function public.voice_grant_active(text) from public;
grant execute on function public.voice_grant_active(text) to anon, authenticated;

-- Anon can read ordinary voice files. private/ objects need a short grant
-- from unlock_voice_message, or a signed-in Admin.
drop policy if exists "anon can read voice messages" on storage.objects;
drop policy if exists "read voice messages" on storage.objects;
create policy "read voice messages"
  on storage.objects
  for select
  to anon, authenticated
  using (
    bucket_id = 'voice-messages'
    and (
      name not like 'private/%'
      or coalesce(auth.role(), '') = 'authenticated'
      or public.voice_grant_active(name)
    )
  );

create or replace function public.create_private_voice_message(
  message_id uuid,
  sender_name text,
  duration_seconds integer,
  mime_type text,
  audio_path text,
  pin text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text := btrim(coalesce(sender_name, ''));
  v_pin text := btrim(coalesce(pin, ''));
  v_mime text := lower(btrim(coalesce(mime_type, '')));
begin
  if message_id is null then
    raise exception 'That recording could not be saved.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'Please enter your name.';
  end if;
  if duration_seconds is null or duration_seconds < 1 or duration_seconds > 180 then
    raise exception 'Voice messages must be between 1 second and 3 minutes.';
  end if;
  if v_pin !~ '^[0-9]{4}$' then
    raise exception 'Enter a 4-digit PIN.';
  end if;
  if audio_path is null
     or audio_path !~ '^private/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webm|m4a|ogg|mp3|wav)$'
     or split_part(audio_path, '/', 2) not like message_id::text || '.%'
  then
    raise exception 'Private recordings must use a private path.';
  end if;
  if v_mime !~ '^(audio/webm|audio/mp4|audio/ogg|audio/mpeg|audio/wav|audio/x-wav)($|;)' then
    raise exception 'That recording format is not supported.';
  end if;

  insert into public.messages (
    id, type, name, text, font, duration, mime_type, audio_path, is_private
  ) values (
    message_id, 'voice', v_name, null, null, duration_seconds, v_mime, audio_path, true
  );

  insert into public.message_pins (message_id, pin_hash)
  values (message_id, crypt(v_pin, gen_salt('bf', 8)));

  return message_id;
end;
$$;

revoke all on function public.create_private_voice_message(uuid, text, integer, text, text, text) from public;
grant execute on function public.create_private_voice_message(uuid, text, integer, text, text, text) to anon, authenticated;

-- Returns { ok, audio_path } or { ok: false, error }.
-- A wrong PIN is returned, not raised, so the attempt counter is kept.
drop function if exists public.unlock_voice_message(uuid, text);

create or replace function public.unlock_voice_message(message_id uuid, provided_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_path text;
  v_hash text;
  v_master text;
  v_ok boolean := false;
  v_recent integer;
  v_pin text := btrim(coalesce(provided_pin, ''));
begin
  if message_id is null or char_length(v_pin) < 4 or char_length(v_pin) > 64 then
    return jsonb_build_object('ok', false, 'error', 'Incorrect PIN');
  end if;

  select m.audio_path, p.pin_hash
    into v_path, v_hash
  from public.messages m
  left join public.message_pins p on p.message_id = m.id
  where m.id = unlock_voice_message.message_id
    and m.is_private
    and m.type = 'voice';

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Incorrect PIN');
  end if;

  delete from public.pin_attempts where attempted_at < now() - interval '1 day';

  select count(*) into v_recent
  from public.pin_attempts a
  where a.message_id = unlock_voice_message.message_id
    and a.attempted_at > now() - interval '15 minutes';

  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts. Wait a few minutes and try again.');
  end if;

  if v_hash is not null and v_hash = crypt(v_pin, v_hash) then
    v_ok := true;
  else
    select s.master_pin_hash into v_master from public.card_secrets s where s.id = 1;
    if v_master is not null and v_master = crypt(v_pin, v_master) then
      v_ok := true;
    end if;
  end if;

  if not v_ok or v_path is null or v_path not like 'private/%' then
    insert into public.pin_attempts (message_id) values (unlock_voice_message.message_id);
    return jsonb_build_object('ok', false, 'error', 'Incorrect PIN');
  end if;

  delete from public.pin_attempts a where a.message_id = unlock_voice_message.message_id;
  delete from public.voice_playback_grants where expires_at < now();
  insert into public.voice_playback_grants (object_name, expires_at)
  values (v_path, now() + interval '90 seconds')
  on conflict (object_name) do update set expires_at = excluded.expires_at;

  return jsonb_build_object('ok', true, 'audio_path', v_path);
end;
$$;

revoke all on function public.unlock_voice_message(uuid, text) from public;
grant execute on function public.unlock_voice_message(uuid, text) to anon, authenticated;

create or replace function public.clear_voice_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.audio_path is not null then
    delete from public.voice_playback_grants where object_name = old.audio_path;
  end if;
  return old;
end;
$$;

drop trigger if exists messages_clear_voice_grant on public.messages;
create trigger messages_clear_voice_grant
  before delete on public.messages
  for each row execute function public.clear_voice_grant();

revoke all on function public.clear_voice_grant() from public, anon, authenticated;

