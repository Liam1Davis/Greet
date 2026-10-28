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
