-- ============================================================================
--  admin_tools.sql — دوال لوحة المشرف (الرد التلقائي · إدارة المشرفين · إحصائيات)
-- ----------------------------------------------------------------------------
--  ▶ لماذا دوال security definer بدل تحديث مباشر من العميل؟
--     لأن سياسات RLS تمنع المستخدم من تعديل ملف غيره (منعاً لتصعيد الصلاحيات)،
--     وهذه الدوال تتحقق من هوية المنادي *داخل* القاعدة قبل أي تغيير — فلا
--     يمكن تجاوزها من الواجهة ولا من الـ API المباشر.
--
--  ▶ طريقة الاستخدام:
--      Supabase → SQL Editor → الصق الملف كاملاً → Run
--     آمن للتشغيل المتكرر.
-- ============================================================================


-- ============================================================================
-- 1) تحديث إعدادات الرد التلقائي (للمشرفين)
--    تحقق كامل من شكل الأزرار قبل الحفظ، فلا تفسد الواجهة بمصفوفة خاطئة.
-- ============================================================================
create or replace function public.update_auto_reply(
  p_greeting text,
  p_buttons  jsonb   default '[]'::jsonb,
  p_enabled  boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_btn      jsonb;
  v_id       uuid;
begin
  select coalesce(p.is_admin, false) into v_is_admin
    from public.profiles p where p.id = auth.uid();

  if not coalesce(v_is_admin, false) then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  if p_greeting is null or length(btrim(p_greeting)) = 0 then
    raise exception 'نص الترحيب لا يمكن أن يكون فارغاً';
  end if;

  if length(btrim(p_greeting)) > 400 then
    raise exception 'نص الترحيب طويل جداً (الحد 400 حرف)';
  end if;

  if p_buttons is null or jsonb_typeof(p_buttons) <> 'array' then
    raise exception 'الأزرار يجب أن تكون مصفوفة';
  end if;

  if jsonb_array_length(p_buttons) > 6 then
    raise exception 'لا يمكن إضافة أكثر من 6 أزرار';
  end if;

  for v_btn in select * from jsonb_array_elements(p_buttons) loop
    if jsonb_typeof(v_btn) <> 'object'
       or not (v_btn ? 'label') or not (v_btn ? 'value')
       or length(btrim(coalesce(v_btn ->> 'label', ''))) = 0
       or length(btrim(coalesce(v_btn ->> 'value', ''))) = 0 then
      raise exception 'كل زر يحتاج "label" و "value" غير فارغين';
    end if;
    if length(btrim(v_btn ->> 'label')) > 40 or length(btrim(v_btn ->> 'value')) > 200 then
      raise exception 'نص الزر طويل جداً (الحد 40 للعنوان و200 للقيمة)';
    end if;
  end loop;

  select id into v_id from public.auto_reply_settings
   order by updated_at desc limit 1;

  if v_id is null then
    insert into public.auto_reply_settings (greeting, buttons, is_enabled)
    values (btrim(p_greeting), p_buttons, coalesce(p_enabled, true));
  else
    update public.auto_reply_settings
       set greeting   = btrim(p_greeting),
           buttons    = p_buttons,
           is_enabled = coalesce(p_enabled, true),
           updated_at = now()
     where id = v_id;
  end if;
end;
$$;

revoke all on function public.update_auto_reply(text, jsonb, boolean) from public;
grant execute on function public.update_auto_reply(text, jsonb, boolean) to authenticated;


-- ============================================================================
-- 2) تغيير صفة الإدارة لمستخدم (المشرف العام فقط)
--    الحمايات: لا تغيير لحسابك · لا إزالة لآخر مشرف عام · المشرف العام مشرفٌ بالضرورة
-- ============================================================================
create or replace function public.set_admin_status(
  p_user_id        uuid,
  p_is_admin       boolean,
  p_is_super_admin boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_super boolean;
  v_target_super boolean;
  v_super_count  int;
  v_new_super    boolean;
begin
  select coalesce(is_super_admin, false) into v_caller_super
    from public.profiles where id = auth.uid();

  if not coalesce(v_caller_super, false) then
    raise exception 'هذه العملية للمشرف العام فقط';
  end if;

  if p_user_id is null then
    raise exception 'معرّف المستخدم مطلوب';
  end if;

  select coalesce(is_super_admin, false) into v_target_super
    from public.profiles where id = p_user_id;

  if not found then
    raise exception 'المستخدم غير موجود';
  end if;

  -- لا تُغيّر صلاحيات حسابك — منعاً لفقدان السيطرة على اللوحة
  if p_user_id = auth.uid() then
    raise exception 'لا يمكنك تغيير صلاحيات حسابك الحالي';
  end if;

  v_new_super := coalesce(p_is_super_admin, v_target_super);

  -- حماية: لا تُزيل آخر مشرف عام في النظام
  if v_target_super and not v_new_super then
    select count(*) into v_super_count
      from public.profiles where is_super_admin = true;
    if v_super_count <= 1 then
      raise exception 'لا يمكن إزالة آخر مشرف عام في النظام';
    end if;
  end if;

  update public.profiles
     set is_admin       = case when v_new_super then true else coalesce(p_is_admin, is_admin) end,
         is_super_admin = v_new_super
   where id = p_user_id;
end;
$$;

revoke all on function public.set_admin_status(uuid, boolean, boolean) from public;
grant execute on function public.set_admin_status(uuid, boolean, boolean) to authenticated;


-- ============================================================================
-- 3) إحصائيات سريعة (المشرف العام)
-- ============================================================================
create or replace function public.admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_super boolean;
begin
  select coalesce(is_super_admin, false) into v_super
    from public.profiles where id = auth.uid();

  if not coalesce(v_super, false) then
    raise exception 'هذه العملية للمشرف العام فقط';
  end if;

  return jsonb_build_object(
    'users',          (select count(*) from public.profiles),
    'admins',         (select count(*) from public.profiles where is_admin = true),
    'conversations',  (select count(*) from public.conversations),
    'messages',       (select count(*) from public.messages),
    'today_messages', (select count(*) from public.messages
                        where created_at >= date_trunc('day', now())),
    'devices',        (select count(*) from public.fcm_tokens)
  );
end;
$$;

revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;


-- ============================================================================
-- 4) تقرير
-- ============================================================================
select p.proname as "الدالة",
       pg_get_function_arguments(p.oid) as "الوسائط",
       p.prosecdef as "security definer"
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('update_auto_reply','set_admin_status','admin_stats')
 order by 1;
