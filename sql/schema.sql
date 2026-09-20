-- ============================================================================
--  schema.sql — المخطط الأساسي لتطبيق المحادثات (WhatsApp-style PWA)
-- ----------------------------------------------------------------------------
--  هذا الملف مُعاد بناؤه من تحليل كود التطبيق (js/app.js, js/auth.js,
--  js/push.js, supabase/functions/*) لأنه كان مفقوداً من الأرشيف.
--
--  ▶ طريقة الاستخدام:
--      1) Supabase Dashboard → SQL Editor → الصق هذا الملف كاملاً → Run
--      2) ثم شغّل sql/fcm_and_rls.sql (يضيف fcm_tokens/typing_status/
--         chat_members + دوال FCM + سياسات RLS التفصيلية)
--
--  ▶ الترتيب مهم: chat_members في الملف الثاني يعمل FOREIGN KEY على
--    public.profiles، لذا يجب أن يُنشأ profiles هنا أولاً.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1) جدول الملفات الشخصية profiles
--    الأعمدة مستنتجة من كل استعلام select/update في js/app.js و js/auth.js
-- ============================================================================
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text unique,
  display_name    text,
  phone           text,
  avatar_url      text,
  wallpaper_url   text,
  is_online       boolean     not null default false,
  last_seen       timestamptz,
  is_admin        boolean     not null default false,
  is_super_admin  boolean     not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists profiles_is_admin_idx on public.profiles(is_admin);

-- ============================================================================
-- 2) جدول المحادثات conversations
--    ⚠️ أسماء قيود FK إلزامية حرفياً: js/app.js:956 يستخدم
--       profiles!conversations_user_id_fkey و profiles!conversations_admin_id_fkey
--       في استعلامات embed. لو اختلف الاسم يفشل Join في PostgREST.
-- ============================================================================
create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null
                     constraint conversations_user_id_fkey
                     references public.profiles(id) on delete cascade,
  admin_id         uuid not null
                     constraint conversations_admin_id_fkey
                     references public.profiles(id) on delete cascade,
  last_message     text,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now()
);

-- محادثة واحدة فقط بين كل (مستخدم، مشرف) — التطبيق يعتمد maybeSingle()
create unique index if not exists conversations_user_admin_key
  on public.conversations(user_id, admin_id);

create index if not exists conversations_last_message_at_idx
  on public.conversations(last_message_at desc nulls last);

-- ============================================================================
-- 3) جدول الرسائل messages
--    sender_id بدون ON DELETE CASCADE عمداً: وظيفة admin-delete-user تحذف
--    الرسائل يدوياً قبل حذف الحساب، حتى لا يفشل الحذف بترتيب FK.
-- ============================================================================
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender_id        uuid not null references public.profiles(id),
  content          text,
  attachment_url   text,
  attachment_type  text check (attachment_type is null
                     or attachment_type in ('image','video','audio','file')),
  reply_to_id      uuid references public.messages(id) on delete set null,
  status           text not null default 'sent'
                     check (status in ('sending','sent','delivered','read')),
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at);

create index if not exists messages_conversation_status_idx
  on public.messages(conversation_id, status);

-- ============================================================================
-- 4) التفاعلات بالإيموجي message_reactions
-- ============================================================================
create table if not exists public.message_reactions (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create index if not exists message_reactions_message_idx
  on public.message_reactions(message_id);

-- ============================================================================
-- 5) قائمة المشرفين الثابتة — يجب أن تطابق ADMINS في js/config.js
--    ⚠️ عدّل هذه القائمة إلى إيميلاتك أنت قبل التشغيل.
-- ============================================================================
create or replace function public.is_admin_email(p_email text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_email, '')) in (
    'aabntlal680@gmail.com',
    'almgawell17@gmail.com',
    'almgawell@gmail.com',
    'almgawell1992@gmail.com',
    'almgawell1121@gmail.com',
    'almgawell1212@gmail.com'
  );
$$;

-- المشرف العام (Super Admin) — يطابق الشرط المكتوب في js/auth.js
create or replace function public.is_super_admin_email(p_email text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_email, '')) in (
    'almgawell17@gmail.com'
  );
$$;

-- ============================================================================
-- 6) Trigger: إنشاء صف profiles تلقائياً عند كل تسجيل حساب جديد
--    (js/auth.js يعمل upsert احتياطياً أيضاً، فلا تعارض بينهما)
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  v_email := lower(coalesce(new.email, ''));

  insert into public.profiles (id, email, display_name, phone, is_admin, is_super_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(v_email, '@', 1)),
    new.raw_user_meta_data ->> 'phone',
    public.is_admin_email(v_email),
    public.is_super_admin_email(v_email)
  )
  on conflict (id) do update
    set email          = excluded.email,
        is_admin       = public.is_admin_email(v_email),
        is_super_admin = public.is_super_admin_email(v_email);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- مزامنة الاسم والبريد عند تعديل المستخدم من لوحة Auth
create or replace function public.sync_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email        = coalesce(new.email, email),
         display_name = coalesce(new.raw_user_meta_data ->> 'display_name', display_name)
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.sync_user_profile();

-- ============================================================================
-- 7) Row Level Security على profiles و conversations و messages و reactions
--    (سياسات fcm_tokens / typing_status / chat_members في fcm_and_rls.sql)
-- ============================================================================
alter table public.profiles         enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.message_reactions enable row level security;

-- مساعد: هل المستخدم الحالي مشارك في هذه المحادثة؟
create or replace function public.is_conversation_participant(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversations c
     where c.id = p_conversation_id
       and (c.user_id = auth.uid() or c.admin_id = auth.uid())
  );
$$;

create or replace function public.current_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and is_super_admin = true
  );
$$;

-- ---------- profiles ----------
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (
    id = auth.uid()
    or is_admin = true
    or public.current_is_super_admin()
  );

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
  on public.profiles for insert
  with check (id = auth.uid());

-- تحديث بياناتك فقط + منع تصعيد الصلاحيات ذاتياً
drop policy if exists "profiles_update_self_no_escalation" on public.profiles;
create policy "profiles_update_self_no_escalation"
  on public.profiles for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (
      (is_admin, is_super_admin) = (
        select p.is_admin, p.is_super_admin
          from public.profiles p where p.id = auth.uid()
      )
      or exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.is_admin = true)
    )
  );

drop policy if exists "profiles_delete_admin_only" on public.profiles;
create policy "profiles_delete_admin_only"
  on public.profiles for delete
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.is_admin = true)
    and is_admin = false
  );

-- ---------- conversations ----------
drop policy if exists "conversations_select_participant" on public.conversations;
create policy "conversations_select_participant"
  on public.conversations for select
  using (
    user_id = auth.uid()
    or admin_id = auth.uid()
    or public.current_is_super_admin()
  );

drop policy if exists "conversations_insert_participant" on public.conversations;
create policy "conversations_insert_participant"
  on public.conversations for insert
  with check (user_id = auth.uid() or admin_id = auth.uid());

drop policy if exists "conversations_update_participant" on public.conversations;
create policy "conversations_update_participant"
  on public.conversations for update
  using (
    user_id = auth.uid()
    or admin_id = auth.uid()
    or public.current_is_super_admin()
  );

-- حذف محادثات المستخدمين العاديين من قبل المشرفين موجود في fcm_and_rls.sql

-- ---------- messages ----------
drop policy if exists "messages_select_participant" on public.messages;
create policy "messages_select_participant"
  on public.messages for select
  using (
    public.is_conversation_participant(conversation_id)
    or public.current_is_super_admin()
  );

drop policy if exists "messages_insert_participant" on public.messages;
create policy "messages_insert_participant"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id)
  );

-- التطبيق يحدّث status فقط (delivered/read)
drop policy if exists "messages_update_participant" on public.messages;
create policy "messages_update_participant"
  on public.messages for update
  using (public.is_conversation_participant(conversation_id))
  with check (public.is_conversation_participant(conversation_id));

-- ---------- message_reactions ----------
drop policy if exists "reactions_select_participant" on public.message_reactions;
create policy "reactions_select_participant"
  on public.message_reactions for select
  using (
    public.is_conversation_participant(
      (select m.conversation_id from public.messages m where m.id = message_id)
    )
    or public.current_is_super_admin()
  );

drop policy if exists "reactions_insert_participant" on public.message_reactions;
create policy "reactions_insert_participant"
  on public.message_reactions for insert
  with check (
    user_id = auth.uid()
    and public.is_conversation_participant(
      (select m.conversation_id from public.messages m where m.id = message_id)
    )
  );

drop policy if exists "reactions_delete_own" on public.message_reactions;
create policy "reactions_delete_own"
  on public.message_reactions for delete
  using (user_id = auth.uid());

-- ============================================================================
-- 8) Storage Buckets — الأسماء إلزامية حرفياً (js/app.js: 2594, 3124, 3186)
--    getPublicUrl() يتطلب public = true، وإلا لن تظهر الصور/المرفقات.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('avatars',     'avatars',     true,  5242880),   -- 5 MB
  ('attachments', 'attachments', true, 52428800),   -- 50 MB
  ('wallpapers',  'wallpapers',  true,  5242880)
on conflict (id) do update
  set public          = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- سياسة موحّدة: كل مستخدم يكتب داخل مجلده هو فقط (folder = auth.uid()::text)
-- وهذا مطابق لـ js/app.js: folder = state.me.id
drop policy if exists "own_folder_insert" on storage.objects;
create policy "own_folder_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('avatars','attachments','wallpapers')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own_folder_update" on storage.objects;
create policy "own_folder_update"
  on storage.objects for update to authenticated
  using (
    bucket_id in ('avatars','attachments','wallpapers')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "own_folder_delete" on storage.objects;
create policy "own_folder_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('avatars','attachments','wallpapers')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- القراءة عامة (لأن getPublicUrl يعتمد على bucket عام)
drop policy if exists "public_read_media" on storage.objects;
create policy "public_read_media"
  on storage.objects for select to public
  using (bucket_id in ('avatars','attachments','wallpapers'));

-- ============================================================================
-- 9) Realtime — إضافة الجداول إلى publication حتى تعمل قنوات postgres_changes
--    (js/app.js يشترك في: messages, conversations, typing_status,
--     message_reactions)
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['profiles','conversations','messages','message_reactions','typing_status']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;  -- مضافة مسبقاً
    end;
  end loop;
end $$;

-- ============================================================================
-- 10) منح الصلاحيات الأساسية لدور anon/authenticated (Supabase PostgREST)
-- ============================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ============================================================================
-- 11) تهيئة سريعة للمشرفين (شغّلها مرة واحدة بعد تسجيل الحسابات)
--     أو اترك الـ Trigger يعملها تلقائياً عند التسجيل.
-- ============================================================================
-- update public.profiles
--    set is_admin = true, is_super_admin = true
--  where lower(email) = 'بريدك@مثال.com';
