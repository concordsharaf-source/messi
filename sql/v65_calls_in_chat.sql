-- =============================================================
-- v65 — خانة المكالمة غير المُجاب عنها داخل المحادثة (زي واتساب)
-- الرسالة العادية تبقى كما هي (kind='text'). أما المكالمة التي لم
-- يُرَد عليها فتُسجَّل رسالةً من نوع 'call' بوقتها داخل المحادثة.
-- =============================================================

alter table public.messages
  add column if not exists kind text not null default 'text';

alter table public.messages
  add column if not exists call_status text;

alter table public.messages
  add column if not exists call_id uuid;

-- القيم المسموحة: نص عادي أو خانة مكالمة
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'call'));

-- حالات المكالمة غير المُجاب عنها (بلا رد / رفض / أُلغي / مشغول)
alter table public.messages drop constraint if exists messages_call_status_check;
alter table public.messages add constraint messages_call_status_check
  check (call_status is null or call_status in ('missed', 'declined', 'canceled', 'busy', 'unanswered'));

-- فهرس خفيف يخصّ خانات المكالمات فقط
create index if not exists messages_call_kind_idx
  on public.messages (conversation_id, created_at desc)
  where kind = 'call';

-- =============================================================
-- ملخّص المحادثة في الرئيسية: إن كانت الرسالة خانة مكالمة نستعمل نصاً
-- محايداً (العميل يكتب النص الخاص بكل طرف: «فائتة» للمستقبِل، «لم يتم
-- الرد» للمتصل) — وبدون هذا كان الملخّص يظهر «رسالة».
-- =============================================================
create or replace function public.bump_conversation_summary()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview text;
  v_at      timestamptz := coalesce(new.created_at, now());
begin
  v_preview := case
    when new.kind = 'call' then 'مكالمة صوتية'
    else coalesce(
      nullif(btrim(coalesce(new.content, '')), ''),
      case coalesce(new.attachment_type, '')
        when 'image' then '📷 صورة'
        when 'audio' then '🎤 رسالة صوتية'
        when 'video' then '🎬 فيديو'
        when 'file'  then '📎 ملف'
        else 'رسالة'
      end
    )
  end;

  update public.conversations c
     set last_message        = left(v_preview, 300),
         last_message_at     = v_at,
         last_sender_id      = new.sender_id,
         last_message_status = coalesce(new.status, 'sent')
   where c.id = new.conversation_id
     and (c.last_message_at is null or v_at >= c.last_message_at - interval '5 minutes');

  return new;
end;
$$;
