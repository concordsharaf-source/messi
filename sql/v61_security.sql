-- =============================================================
-- v61 — تحصين أمني بعد مراجعة 2026-09-25
--   ١) منع ترقية المشرف العادي لنفسه إلى «مشرف عام» (كان ممكنًا بنداء UPDATE واحد)
--   ٢) منع تعديل محتوى رسائل الغير (كان أي مشارك يعدّل كلام الطرف الآخر)
--   ٣) منع تغيير طرفي المحادثة (user_id/admin_id) إلا للمشرف العام
--   ٤) سجل المكالمات: لا يُدرج إلا بين طرفي محادثة حقيقيين
--   ٥) قيد على صيغة روابط الصور/المرفقات (يغلق حقن السمات من أصله)
-- =============================================================

-- ١) سياسة تحديث الملف الشخصي: الأعمدة الحساسة لا تتغيّر إلا لمشرف عام
drop policy if exists profiles_update_self_no_escalation on public.profiles;
create policy profiles_update_self_no_escalation on public.profiles
  for update
  to public
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (
      (
        is_admin is not distinct from (select p.is_admin from public.profiles p where p.id = auth.uid())
        and is_super_admin is not distinct from (select p.is_super_admin from public.profiles p where p.id = auth.uid())
      )
      or public.current_is_super_admin()
    )
  );

-- ٢) سلامة الرسائل: المحتوى/المرفق/المُرسل لا تتغيّر إلا من المُرسل نفسه أو مشرف المحادثة
create or replace function public.protect_message_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_chat_moderator(old.conversation_id) then
    return new;   -- مشرف المحادثة (أو المشرف العام) له صلاحية الحذف/التعديل
  end if;

  if new.content is distinct from old.content
     or new.sender_id is distinct from old.sender_id
     or new.conversation_id is distinct from old.conversation_id
     or new.attachment_url is distinct from old.attachment_url
     or new.attachment_type is distinct from old.attachment_type
     or new.reply_to_id is distinct from old.reply_to_id
     or new.buttons is distinct from old.buttons
     or new.created_at is distinct from old.created_at then
    if old.sender_id is distinct from auth.uid() then
      raise exception 'لا يمكنك تعديل هذه الرسالة' using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_protect_message_integrity on public.messages;
create trigger trg_protect_message_integrity
  before update on public.messages
  for each row execute function public.protect_message_integrity();

-- ٣) طرفا المحادثة ثابتان (منع «نقل» محادثة إلى مستخدم آخر)
create or replace function public.protect_conversation_participants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_is_super_admin() then
    return new;
  end if;

  if new.user_id is distinct from old.user_id or new.admin_id is distinct from old.admin_id then
    raise exception 'لا يمكن تغيير طرفي المحادثة' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists trg_protect_conversation_participants on public.conversations;
create trigger trg_protect_conversation_participants
  before update on public.conversations
  for each row execute function public.protect_conversation_participants();

-- ٤) سجل المكالمات: المتصل والمستقبِل يجب أن يكونا طرفي المحادثة فعلاً
drop policy if exists call_logs_insert_caller on public.call_logs;
create policy call_logs_insert_caller on public.call_logs
  for insert
  to public
  with check (
    auth.uid() = caller_id
    and exists (
      select 1 from public.conversations c
       where c.id = call_logs.conversation_id
         and (
           (c.user_id = call_logs.caller_id and c.admin_id = call_logs.callee_id)
           or (c.admin_id = call_logs.caller_id and c.user_id = call_logs.callee_id)
         )
    )
  );

-- ٥) صيغة الروابط: http/https أو مسار محلي فقط (يمنع javascript: وحقن السمات)
alter table public.messages drop constraint if exists messages_attachment_url_scheme;
alter table public.messages add constraint messages_attachment_url_scheme
  check (attachment_url is null or attachment_url ~ '^(https?://|\.{0,2}/)');

alter table public.profiles drop constraint if exists profiles_avatar_url_scheme;
alter table public.profiles add constraint profiles_avatar_url_scheme
  check (avatar_url is null or avatar_url ~ '^(https?://|\.{0,2}/)');
