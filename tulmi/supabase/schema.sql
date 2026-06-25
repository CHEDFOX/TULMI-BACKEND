-- =====================================================================
-- Tulmi — complete database schema (idempotent).
-- Paste this whole file into the Supabase SQL editor and Run. It is safe
-- to run more than once. This is the union of the migrations in
-- ./migrations/ — use this for a fresh project, the migrations for history.
-- =====================================================================

-- ---------------------------------------------------------------------
-- usage_events — per-request metering (audio seconds + word count).
-- ---------------------------------------------------------------------
create table if not exists public.usage_events (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  audio_seconds double precision not null default 0,
  word_count    integer not null default 0,
  model         text,
  source        text check (source in ('rest', 'stream')),
  created_at    timestamptz not null default now()
);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

alter table public.usage_events enable row level security;

drop policy if exists "users read own usage" on public.usage_events;
create policy "users read own usage"
  on public.usage_events for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own usage" on public.usage_events;
create policy "users insert own usage"
  on public.usage_events for insert
  with check (auth.uid() = user_id);

create or replace view public.usage_monthly as
select
  user_id,
  date_trunc('month', created_at) as month,
  sum(audio_seconds)             as audio_seconds,
  sum(word_count)                as words,
  count(*)                       as requests
from public.usage_events
group by user_id, date_trunc('month', created_at);

-- ---------------------------------------------------------------------
-- personalities — one style profile per user (kept as JSON).
-- ---------------------------------------------------------------------
create table if not exists public.personalities (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.personalities enable row level security;

drop policy if exists "users manage own personality" on public.personalities;
create policy "users manage own personality"
  on public.personalities for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- profiles — language preference + onboarding state.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  language     text not null default 'auto',
  onboarded    boolean not null default false,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "users manage own profile" on public.profiles;
create policy "users manage own profile"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-create a profile row on signup (backend also upserts defensively).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
