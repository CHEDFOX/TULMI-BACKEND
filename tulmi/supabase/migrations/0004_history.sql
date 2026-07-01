-- Tulmi — cleanup history (opt-in per user via personality.learnFromSent or
-- personality.retainHistory). Rows are append-only from the client's POV; the
-- API exposes a soft-delete via a deleted_at column so a user can remove an
-- individual entry without breaking any downstream aggregates.
--
-- Retention: a periodic cleanup should hard-prune anything older than 90 days
-- per user. That job is intentionally out-of-tree here — document in ops.
--
-- Run in your Supabase SQL editor after 0001–0003 (or use schema.sql for all).

create table if not exists public.cleanup_history (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('voice', 'typing', 'draft')),
  target_app   text,
  language     text,
  input        text not null,   -- transcript or raw typed
  output       text not null,   -- cleaned / drafted
  duration_ms  integer,
  words_in     integer,
  words_out    integer,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists cleanup_history_user_created_idx
  on public.cleanup_history (user_id, created_at desc);

-- Fast lookup for the soft-deleted filter used by every list query.
create index if not exists cleanup_history_user_live_idx
  on public.cleanup_history (user_id, created_at desc)
  where deleted_at is null;

alter table public.cleanup_history enable row level security;

-- SELECT — only the user's own rows, and only ones they haven't soft-deleted.
drop policy if exists "users read own history" on public.cleanup_history;
create policy "users read own history"
  on public.cleanup_history
  for select
  using (auth.uid() = user_id and deleted_at is null);

-- INSERT — a user may only insert rows attributed to themselves.
drop policy if exists "users insert own history" on public.cleanup_history;
create policy "users insert own history"
  on public.cleanup_history
  for insert
  with check (auth.uid() = user_id);

-- UPDATE — narrowly scoped to soft-delete (setting deleted_at). We still gate
-- rows to the caller's own, and refuse rewrites of the input/output columns
-- via a trigger below. Update-based soft-delete is the simplest way to keep the
-- table append-only from the API surface while giving the user a "remove"
-- button.
drop policy if exists "users soft-delete own history" on public.cleanup_history;
create policy "users soft-delete own history"
  on public.cleanup_history
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Guard: refuse edits to the payload columns. Only deleted_at may change.
create or replace function public.cleanup_history_no_edit()
returns trigger
language plpgsql
as $$
begin
  if new.input       is distinct from old.input       then raise exception 'cleanup_history.input is immutable'; end if;
  if new.output      is distinct from old.output      then raise exception 'cleanup_history.output is immutable'; end if;
  if new.kind        is distinct from old.kind        then raise exception 'cleanup_history.kind is immutable'; end if;
  if new.user_id     is distinct from old.user_id     then raise exception 'cleanup_history.user_id is immutable'; end if;
  if new.created_at  is distinct from old.created_at  then raise exception 'cleanup_history.created_at is immutable'; end if;
  return new;
end;
$$;

drop trigger if exists cleanup_history_no_edit_trg on public.cleanup_history;
create trigger cleanup_history_no_edit_trg
  before update on public.cleanup_history
  for each row execute function public.cleanup_history_no_edit();

-- No DELETE policy on purpose — rows are removed via soft-delete only. The
-- service-role key bypasses RLS for the periodic 90-day retention purge.
