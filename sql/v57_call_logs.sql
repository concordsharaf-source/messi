-- =============================================================
-- v57: سجل المكالمات — لكي يرى من كان «مقفل النت» المكالمات الفائتة عند فتحه
-- =============================================================
create table if not exists public.call_logs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  caller_id       uuid references public.profiles(id) on delete set null,
  callee_id       uuid references public.profiles(id) on delete set null,
  status          text not null default 'ringing',  -- ringing|answered|missed|declined|busy|canceled
  duration_seconds integer,
  seen_by_callee  boolean not null default false,
  created_at      timestamptz not null default now(),
  answered_at     timestamptz
);

create index if not exists call_logs_callee_idx on public.call_logs (callee_id, status, created_at desc);
create index if not exists call_logs_caller_idx on public.call_logs (caller_id, created_at desc);

alter table public.call_logs enable row level security;

drop policy if exists call_logs_select_participants on public.call_logs;
create policy call_logs_select_participants on public.call_logs
  for select using (auth.uid() = caller_id or auth.uid() = callee_id);

drop policy if exists call_logs_insert_caller on public.call_logs;
create policy call_logs_insert_caller on public.call_logs
  for insert with check (auth.uid() = caller_id);

drop policy if exists call_logs_update_participants on public.call_logs;
create policy call_logs_update_participants on public.call_logs
  for update using (auth.uid() = caller_id or auth.uid() = callee_id)
  with check (auth.uid() = caller_id or auth.uid() = callee_id);
