-- Tulmi — usage metering schema.
-- Run this in your Supabase project's SQL editor (or via the Supabase CLI).

create table if not exists public.usage_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  audio_seconds double precision not null default 0,
  word_count   integer not null default 0,
  model        text,
  source       text check (source in ('rest', 'stream')),
  created_at   timestamptz not null default now()
);

-- Fast lookups for "usage since <date>" per user.
create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

-- Row-level security: users may read ONLY their own usage. The backend writes
-- with the service-role key, which bypasses RLS, so no insert policy is needed.
alter table public.usage_events enable row level security;

drop policy if exists "users read own usage" on public.usage_events;
create policy "users read own usage"
  on public.usage_events
  for select
  using (auth.uid() = user_id);

-- Optional convenience view: per-user monthly rollup for free-tier checks.
create or replace view public.usage_monthly as
select
  user_id,
  date_trunc('month', created_at) as month,
  sum(audio_seconds)             as audio_seconds,
  sum(word_count)                as words,
  count(*)                       as requests
from public.usage_events
group by user_id, date_trunc('month', created_at);
