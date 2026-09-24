-- ============================================================================
--  v46_updates.sql — تحديثات الإشعارات وحالات الرسائل (آمن للتشغيل المتكرر)
--  1) حالة «استمع للرسالة الصوتية» (played_at) لتلوين المقطع عند المستلم مثل واتساب
--  2) مؤشّر «جارٍ التسجيل» للرسائل الصوتية (is_recording في typing_status)
--  3) تسريع علامات الصح: replica identity كامل + تحديث الحالة من الخادم
--  4) الرسالة الترحيبية تُرسل بعد أول رسالة من المستخدم (لا عند إنشاء المحادثة)
-- ============================================================================

-- ---------- 1) الرسائل الصوتية: هل استمع المستلم؟ ----------
alter table public.messages add column if not exists played_at timestamptz;

-- ---------- 2) مؤشّر التسجيل الصوتي ----------
alter table public.typing_status add column if not exists is_recording boolean not null default false;

-- ---------- 3) علامات الصح تصل فوراً ----------
--    بلا replica identity كامل تُسقط Realtime أحداث UPDATE على الجداول
--    المحميّة بـ RLS (تغيّر حالة الرسالة sent → delivered → read).
alter table public.messages      replica identity full;
alter table public.conversations replica identity full;
alter table public.typing_status replica identity full;

-- ---------- 4) الترحيب بعد أول رسالة من المستخدم ----------
drop trigger if exists trg_send_welcome_message on public.conversations;

create or replace function public.send_welcome_on_first_user_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings   public.auto_reply_settings;
  v_admin_id   uuid;
  v_user_id    uuid;
  v_user_admin boolean;
  v_sent_count int;
  v_already    boolean;
begin
  -- الرسائل التي تحمل أزراراً هي رسائل النظام (الترحيب) — لا تُحفّز ترحيباً جديداً
  if new.buttons is not null then
    return new;
  end if;

  select c.admin_id, c.user_id into v_admin_id, v_user_id
    from public.conversations c
   where c.id = new.conversation_id;

  if v_admin_id is null then
    return new;
  end if;

  -- الترحيب موجَّه لرسائل المستخدم العادي وحده
  if new.sender_id is distinct from v_user_id then
    return new;
  end if;

  select coalesce(p.is_admin, false) into v_user_admin
    from public.profiles p
   where p.id = v_user_id;

  if coalesce(v_user_admin, false) then
    return new;
  end if;

  -- أُرسل ترحيب في هذه المحادثة من قبل؟
  select exists (
    select 1 from public.messages m
     where m.conversation_id = new.conversation_id
       and m.buttons is not null
  ) into v_already;

  if v_already then
    return new;
  end if;

  -- أول رسالة فقط من هذا المستخدم
  select count(*) into v_sent_count
    from public.messages m
   where m.conversation_id = new.conversation_id
     and m.sender_id = v_user_id;

  if v_sent_count > 1 then
    return new;
  end if;

  select * into v_settings
    from public.auto_reply_settings
   where is_enabled = true
   order by updated_at desc
   limit 1;

  if not found then
    return new;
  end if;

  insert into public.messages (conversation_id, sender_id, content, buttons, status)
  values (
    new.conversation_id,
    v_admin_id,
    v_settings.greeting,
    case when jsonb_array_length(v_settings.buttons) > 0 then v_settings.buttons else null end,
    'sent'
  );

  update public.conversations
     set last_message        = v_settings.greeting,
         last_message_at     = now(),
         last_sender_id      = v_admin_id,
         last_message_status = 'sent'
   where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists aab_send_welcome_on_first_user_message on public.messages;
create trigger aab_send_welcome_on_first_user_message
  after insert on public.messages
  for each row execute function public.send_welcome_on_first_user_message();

-- ---------- v47: سجل الإشعارات يحتفظ بنتيجة «وصلت» ----------
alter table public.push_logs add column if not exists delivered boolean not null default false;

-- ---------- v47: ملخّص المحادثة = آخر رسالة دائماً (بلا شرط زمني) ----------
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
  v_preview := coalesce(
    nullif(btrim(coalesce(new.content, '')), ''),
    case coalesce(new.attachment_type, '')
      when 'image' then '📷 صورة'
      when 'audio' then '🎤 رسالة صوتية'
      when 'video' then '🎬 فيديو'
      when 'file'  then '📎 ملف'
      else 'رسالة'
    end
  );

  -- بلا شرط زمني: أي رسالة جديدة تصبح هي ملخّص المحادثة في الرئيسية.
  -- (كان الشرط الزمني يمنع التحديث إذا كان ساعة جهاز المُرسل متأخرة قليلاً)
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
