-- ===============================================================
-- google_login.sql
-- دعم الدخول بواسطة جوجل (Google OAuth) والدخول السريع (Anonymous)
--
-- المشكلة قبل هذا الملف:
--   دالة handle_new_user كانت تقرأ display_name و phone فقط من بيانات
--   المستخدم الوصفية (raw_user_meta_data)، أما جوجل فتُرسل الاسم في
--   full_name / name والصورة في picture. وكانت أيضاً تُنشئ display_name
--   فارغاً لحسابات الزوار (بلا بريد)، فيظهر المستخدم بلا اسم.
--
-- هذا الملف:
--   1) يستخرج الاسم من display_name ← full_name ← name ← بداية البريد
--      ثم «مستخدم» كحل أخير.
--   2) يستورد صورة حساب جوجل تلقائياً في avatar_url.
--   3) يتعامل مع الحسابات بلا بريد (الزوار) بلا أخطاء.
--   4) يحدّث sync_user_profile بنفس المنطق عند تعديل المستخدم.
--
-- الملف آمن للتشغيل أكثر من مرة (idempotent).
-- ===============================================================

-- ---------------------------------------------------------------
-- 1) إنشاء الملف الشخصي عند تسجيل مستخدم جديد
-- ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text;
  v_name   text;
  v_avatar text;
begin
  v_email := lower(coalesce(new.email, ''));

  -- الاسم: من التطبيق أولاً، ثم من جوجل، ثم من البريد
  v_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    nullif(split_part(v_email, '@', 1), ''),
    'مستخدم'
  );

  -- الصورة: من التطبيق أو من حساب جوجل
  v_avatar := coalesce(
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    nullif(new.raw_user_meta_data ->> 'picture', '')
  );

  insert into public.profiles (id, email, display_name, phone, avatar_url)
  values (
    new.id,
    nullif(new.email, ''),          -- الزوار بلا بريد: null لا سلسلة فارغة
    v_name,
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    v_avatar
  )
  on conflict (id) do update
    set email        = coalesce(excluded.email, public.profiles.email),
        display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
        avatar_url   = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- 2) مزامنة الاسم والصورة عند تعديل المستخدم من لوحة Auth
--    (لا نستبدل اسماً وضعه المستخدم بنفسه — نملأ الفراغ فقط)
-- ---------------------------------------------------------------
create or replace function public.sync_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email      = coalesce(new.email, email),
         display_name = coalesce(
           nullif(display_name, ''),
           nullif(new.raw_user_meta_data ->> 'display_name', ''),
           nullif(new.raw_user_meta_data ->> 'full_name', ''),
           nullif(new.raw_user_meta_data ->> 'name', ''),
           'مستخدم'
         ),
         avatar_url = coalesce(
           nullif(avatar_url, ''),
           nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
           nullif(new.raw_user_meta_data ->> 'picture', '')
         )
   where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.sync_user_profile();

-- ---------------------------------------------------------------
-- 3) تعبئة الفراغ فقط للحسابات الموجودة التي بلا اسم (تنظيف لمرة واحدة)
-- ---------------------------------------------------------------
update public.profiles
   set display_name = coalesce(
         nullif(split_part(coalesce(email, ''), '@', 1), ''),
         'مستخدم'
       )
 where display_name is null
    or btrim(display_name) = '';

-- ---------------------------------------------------------------
-- تقرير
-- ---------------------------------------------------------------
select
  (select count(*) from public.profiles)                                 as profiles_total,
  (select count(*) from public.profiles where display_name is null
      or btrim(display_name) = '')                                       as profiles_without_name,
  (select count(*) from public.profiles where email is null)             as profiles_without_email;
