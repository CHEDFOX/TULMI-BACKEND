-- Tulmi — per-user profile: language preference + onboarding state.
-- Run in your Supabase SQL editor after 0001 + 0002 (or use schema.sql for all).

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  language     text not null default 'auto',     -- 'auto' | 'en' | 'hi' | 'hinglish' | ...
  onboarded    boolean not null default false,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Row-level security: a user may read + write ONLY their own profile.
-- (The backend can use the user's JWT — RLS scopes it — or the service-role
-- key, which bypasses RLS. Both work.)
alter table public.profiles enable row level security;

drop policy if exists "users manage own profile" on public.profiles;
create policy "users manage own profile"
  on public.profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-create a profile row when a new auth user signs up, so the row always
-- exists (the backend also upserts defensively).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Allow users to insert their OWN usage rows (so metering works with the user's
-- JWT, not only the service-role key). The existing select policy still applies.
drop policy if exists "users insert own usage" on public.usage_events;
create policy "users insert own usage"
  on public.usage_events
  for insert
  with check (auth.uid() = user_id);
