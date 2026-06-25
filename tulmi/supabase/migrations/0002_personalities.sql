-- Tulmi — per-user personality / style profile.
-- Run in your Supabase project's SQL editor (after 0001_usage_events.sql).

create table if not exists public.personalities (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row-level security: a user may read and write ONLY their own profile.
-- (The backend uses the service-role key, which bypasses RLS; these policies
-- protect direct client access.)
alter table public.personalities enable row level security;

drop policy if exists "users manage own personality" on public.personalities;
create policy "users manage own personality"
  on public.personalities
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
