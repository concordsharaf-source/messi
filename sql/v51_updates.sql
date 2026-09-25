-- =============================================================
-- v51: الرئيسية = المحادثة بالضبط (حالة آخر رسالة)
-- -------------------------------------------------------------
-- الخلل: كانت حالة القراءة (read) تُكتب في messages فقط. عمود
-- conversations.last_message_status كان يُحدَّث عند INSERT فقط، فيبقى
-- «delivered/sent» بعد أن يقرأ المستلم ⇒ تظهر العلامتان رماديتين في
-- الشاشة الرئيسية بعد إعادة فتح التطبيق (رغم أنها زرقاء أثناء الجلسة).
-- =============================================================

-- 1) مزامنة حالة آخر رسالة عند أي تغيير في حالتها (أو محتواها/وقتها)
create or replace function public.sync_conversation_last_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_last boolean;
begin
  -- هل الصف المُحدَّث هو آخر رسالة في المحادثة؟
  select not exists (
    select 1 from public.messages m
     where m.conversation_id = new.conversation_id
       and m.id <> new.id
       and (m.created_at, m.id) > (new.created_at, new.id)
  ) into v_is_last;

  if not v_is_last then
    return new;
  end if;

  update public.conversations c
     set last_message_status = coalesce(new.status, 'sent'),
         last_sender_id      = new.sender_id
   where c.id = new.conversation_id
     and c.last_message_status is distinct from coalesce(new.status, 'sent');

  return new;
end;
$$;

drop trigger if exists aab_sync_conversation_last_status on public.messages;
create trigger aab_sync_conversation_last_status
  after update of status, played_at on public.messages
  for each row execute function public.sync_conversation_last_status();

-- 2) حذف آخر رسالة ⇒ نُعيد الملخّص من الرسالة الأحدث المتبقية
create or replace function public.recompute_conversation_summary_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.messages;
  v_preview text;
begin
  select * into v_row
    from public.messages m
   where m.conversation_id = old.conversation_id
   order by m.created_at desc, m.id desc
   limit 1;

  if not found then
    update public.conversations
       set last_message = null, last_message_at = null,
           last_sender_id = null, last_message_status = null
     where id = old.conversation_id;
    return old;
  end if;

  v_preview := coalesce(
    nullif(btrim(coalesce(v_row.content, '')), ''),
    case coalesce(v_row.attachment_type, '')
      when 'image' then '📷 صورة'
      when 'audio' then '🎤 رسالة صوتية'
      when 'video' then '🎬 فيديو'
      when 'file'  then '📎 ملف'
      else 'رسالة'
    end
  );

  update public.conversations
     set last_message        = left(v_preview, 300),
         last_message_at     = v_row.created_at,
         last_sender_id      = v_row.sender_id,
         last_message_status = coalesce(v_row.status, 'sent')
   where id = old.conversation_id;

  return old;
end;
$$;

drop trigger if exists aab_recompute_summary_on_delete on public.messages;
create trigger aab_recompute_summary_on_delete
  after delete on public.messages
  for each row execute function public.recompute_conversation_summary_after_delete();

-- 3) إصلاح الصفوف القديمة المتأخرة (كانت read في messages و delivered في conversations)
update public.conversations c
   set last_message = coalesce(c.last_message, left(coalesce(m.content, 'رسالة'), 300)),
       last_message_at = m.created_at,
       last_sender_id = m.sender_id,
       last_message_status = coalesce(m.status, 'sent')
  from (
    select distinct on (conversation_id) conversation_id, content, created_at, sender_id, status
      from public.messages
     order by conversation_id, created_at desc, id desc
  ) m
 where m.conversation_id = c.id
   and (c.last_message_at is distinct from m.created_at
        or c.last_message_status is distinct from coalesce(m.status, 'sent'));
