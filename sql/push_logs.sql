-- ============================================================================
--  push_logs — سجل تشخيصي لإشعارات الجهاز (send-push)
--  الغرض: معرفة هل أُرسل الإشعار، ولمن، وكم جهازاً، وما ردّ FCM لكل توكن.
--  القراءة: service_role فقط (RLS مُفعّل بلا سياسات) — لا يظهر لأي مستخدم.
-- ============================================================================

create table if not exists public.push_logs (
  id                bigserial primary key,
  created_at        timestamptz not null default now(),
  kind              text        not null default 'message',   -- message | test
  conversation_id   uuid,
  sender_id         uuid,
  receiver_id       uuid,
  receiver_is_admin boolean     not null default false,
  tokens            int         not null default 0,
  ok_count          int         not null default 0,
  results           jsonb       not null default '[]'::jsonb,
  error             text,
  body              text
);

create index if not exists push_logs_created_at_idx on public.push_logs (created_at desc);
create index if not exists push_logs_receiver_idx   on public.push_logs (receiver_id, created_at desc);

alter table public.push_logs enable row level security;
