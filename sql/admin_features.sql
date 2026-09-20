-- ===============================================================
-- admin_features.sql
-- حزمة مزايا إدارة المحادثات:
--   1) تصنيف المحادثة: جديد / بانتظار رد / تمّت المعالجة
--   2) وسوم وملاحظات داخلية لا يراها المستخدم
--   3) كتم وأرشفة لكل مشرف على حدة
--   4) سجل نشاط المشرفين (فتح، رد، تغيير حالة، ملاحظة)
--   5) توقيع تلقائي أسفل ردود المشرف
--   6) أرقام الملخص اليومي
--
-- الملف آمن للتشغيل أكثر من مرة (idempotent).
-- كل الدوال حامية للمصادقة (security definer) وتتحقق من صفة المشرف
-- داخل قاعدة البيانات، فلا يمكن تجاوزها من المتصفح.
-- ===============================================================


-- ===============================================================
-- 0) دالة مساعدة: هل المنادي مشرف؟
-- ===============================================================
create or replace function public.current_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and is_admin = true
  );
$$;


-- ===============================================================
-- 1) تصنيف المحادثة (مشترك بين كل المشرفين)
-- ===============================================================
alter table public.conversations
  add column if not exists status text not null default 'new';

do $$
begin
  alter table public.conversations
    add constraint conversations_status_check
    check (status in ('new', 'pending', 'done'));
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;


-- ===============================================================
-- 2) الوسوم والملاحظات الداخلية (للمشرفين فقط)
-- ===============================================================
create table if not exists public.conversation_internal (
  conversation_id uuid primary key
    references public.conversations(id) on delete cascade,
  tags            text[] not null default '{}',
  note            text,
  updated_by      uuid references public.profiles(id) on delete set null,
  updated_at      timestamptz not null default now()
);


-- ===============================================================
-- 3) تفضيلات كل مشرف: كتم / أرشفة
-- ===============================================================
create table if not exists public.admin_conversation_prefs (
  conversation_id uuid not null
    references public.conversations(id) on delete cascade,
  admin_id        uuid not null
    references public.profiles(id) on delete cascade,
  muted           boolean not null default false,
  archived        boolean not null default false,
  updated_at      timestamptz not null default now(),
  primary key (conversation_id, admin_id)
);


-- ===============================================================
-- 4) سجل نشاط المشرفين
-- ===============================================================
create table if not exists public.admin_activity (
  id              bigserial primary key,
  admin_id        uuid references public.profiles(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete cascade,
  action          text not null,
  detail          text,
  created_at      timestamptz not null default now()
);

create index if not exists admin_activity_created_idx
  on public.admin_activity (created_at desc);

create index if not exists admin_activity_admin_idx
  on public.admin_activity (admin_id, created_at desc);


-- ===============================================================
-- 5) التوقيع التلقائي للمشرف
-- ===============================================================
alter table public.profiles
  add column if not exists signature text;


-- ===============================================================
-- 6) تفعيل RLS + السياسات
-- ===============================================================
alter table public.conversation_internal      enable row level security;
alter table public.admin_conversation_prefs   enable row level security;
alter table public.admin_activity             enable row level security;

-- الوسوم والملاحظات: قراءة للمشرفين، والكتابة عبر الدالة فقط
drop policy if exists "internal_select_admin" on public.conversation_internal;
create policy "internal_select_admin"
  on public.conversation_internal for select to authenticated
  using (public.current_is_admin());

-- تفضيلات المشرف: كل مشرف يقرأ ويكتب صفوفه هو
drop policy if exists "prefs_select_own" on public.admin_conversation_prefs;
create policy "prefs_select_own"
  on public.admin_conversation_prefs for select to authenticated
  using (admin_id = auth.uid());

drop policy if exists "prefs_insert_own" on public.admin_conversation_prefs;
create policy "prefs_insert_own"
  on public.admin_conversation_prefs for insert to authenticated
  with check (admin_id = auth.uid() and public.current_is_admin());

drop policy if exists "prefs_update_own" on public.admin_conversation_prefs;
create policy "prefs_update_own"
  on public.admin_conversation_prefs for update to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

drop policy if exists "prefs_delete_own" on public.admin_conversation_prefs;
create policy "prefs_delete_own"
  on public.admin_conversation_prefs for delete to authenticated
  using (admin_id = auth.uid());

-- سجل النشاط: قراءة للمشرفين فقط
drop policy if exists "activity_select_admin" on public.admin_activity;
create policy "activity_select_admin"
  on public.admin_activity for select to authenticated
  using (public.current_is_admin());


-- ===============================================================
-- 7) تسجيل النشاط تلقائياً
-- ===============================================================

-- 7.أ) رد مشرف على محادثة
create or replace function public.log_activity_on_admin_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.profiles p
     where p.id = new.sender_id and p.is_admin = true
  ) then
    insert into public.admin_activity (admin_id, conversation_id, action, detail)
    values (new.sender_id, new.conversation_id, 'replied', left(coalesce(new.content, ''), 120));
  end if;

  return new;
end;
$$;

drop trigger if exists on_message_log_admin_reply on public.messages;
create trigger on_message_log_admin_reply
  after insert on public.messages
  for each row execute function public.log_activity_on_admin_reply();

-- 7.ب) تغيير حالة المحادثة
create or replace function public.log_activity_on_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.admin_activity (admin_id, conversation_id, action, detail)
    values (auth.uid(), new.id, 'status', new.status);
  end if;

  return new;
end;
$$;

drop trigger if exists on_conversation_status_log on public.conversations;
create trigger on_conversation_status_log
  after update of status on public.conversations
  for each row execute function public.log_activity_on_status_change();


-- ===============================================================
-- 8) الدوال التي تناديها الواجهة
-- ===============================================================

-- 8.أ) تغيير تصنيف المحادثة
create or replace function public.set_conversation_status(
  p_conversation_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_is_admin() then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  if p_status not in ('new', 'pending', 'done') then
    raise exception 'حالة غير صحيحة: %', p_status;
  end if;

  if not exists (select 1 from public.conversations where id = p_conversation_id) then
    raise exception 'المحادثة غير موجودة';
  end if;

  update public.conversations
     set status = p_status
   where id = p_conversation_id;

  return jsonb_build_object('success', true, 'status', p_status);
end;
$$;


-- 8.ب) حفظ الوسوم والملاحظة الداخلية
create or replace function public.save_conversation_internal(
  p_conversation_id uuid,
  p_tags text[],
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tags text[];
  v_note text;
begin
  if not public.current_is_admin() then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  -- تنظيف الوسوم: بلا فراغات، بلا تكرار، بحد 8 وسوم وبطول 24 حرفاً
  select coalesce(array_agg(distinct btrim(t)), '{}')
    into v_tags
    from unnest(coalesce(p_tags, '{}')) as t
   where btrim(coalesce(t, '')) <> '';

  v_tags := (select coalesce(array_agg(left(x, 24)), '{}') from (
               select x from unnest(v_tags) as x limit 8
             ) s);

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if v_note is not null and length(v_note) > 2000 then
    raise exception 'الملاحظة طويلة جداً (الحد 2000 حرف)';
  end if;

  insert into public.conversation_internal
         (conversation_id, tags, note, updated_by, updated_at)
  values (p_conversation_id, v_tags, v_note, auth.uid(), now())
  on conflict (conversation_id) do update
     set tags       = excluded.tags,
         note       = excluded.note,
         updated_by = excluded.updated_by,
         updated_at = now();

  insert into public.admin_activity (admin_id, conversation_id, action, detail)
  values (auth.uid(), p_conversation_id, 'note', array_to_string(v_tags, ', '));

  return jsonb_build_object('success', true, 'tags', to_jsonb(v_tags), 'note', v_note);
end;
$$;


-- 8.ج) كتم / أرشفة (لكل مشرف على حدة)
create or replace function public.set_conversation_prefs(
  p_conversation_id uuid,
  p_muted boolean,
  p_archived boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_is_admin() then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  insert into public.admin_conversation_prefs
         (conversation_id, admin_id, muted, archived, updated_at)
  values (p_conversation_id, auth.uid(),
          coalesce(p_muted, false), coalesce(p_archived, false), now())
  on conflict (conversation_id, admin_id) do update
     set muted      = coalesce(p_muted, public.admin_conversation_prefs.muted),
         archived   = coalesce(p_archived, public.admin_conversation_prefs.archived),
         updated_at = now();

  return jsonb_build_object('success', true);
end;
$$;


-- 8.د) تسجيل فتح المحادثة (مرة كل 30 دقيقة لكل مشرف)
create or replace function public.log_conversation_view(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_is_admin() then
    return;
  end if;

  if exists (
    select 1 from public.admin_activity
     where admin_id = auth.uid()
       and conversation_id = p_conversation_id
       and action = 'viewed'
       and created_at > now() - interval '30 minutes'
  ) then
    return;
  end if;

  insert into public.admin_activity (admin_id, conversation_id, action)
  values (auth.uid(), p_conversation_id, 'viewed');
end;
$$;


-- 8.هـ) توقيع المشرف التلقائي
create or replace function public.set_my_signature(p_signature text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signature text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول';
  end if;

  v_signature := nullif(btrim(coalesce(p_signature, '')), '');

  if v_signature is not null and length(v_signature) > 200 then
    raise exception 'التوقيع طويل جداً (الحد 200 حرف)';
  end if;

  update public.profiles
     set signature = v_signature
   where id = auth.uid();

  return jsonb_build_object('success', true, 'signature', v_signature);
end;
$$;


-- 8.و) نظرة شاملة للمشرف على كل المحادثات (حالة + وسوم + كتم + أرشفة)
create or replace function public.admin_conversations_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    from (
      select c.id                              as conversation_id,
             c.status                          as status,
             coalesce(ci.tags, '{}')           as tags,
             ci.note                           as note,
             coalesce(p.muted, false)          as muted,
             coalesce(p.archived, false)       as archived
        from public.conversations c
        left join public.conversation_internal ci on ci.conversation_id = c.id
        left join public.admin_conversation_prefs p
               on p.conversation_id = c.id and p.admin_id = auth.uid()
       where public.current_is_admin()
    ) t;
$$;


-- 8.ز) سجل نشاط المشرفين
create or replace function public.admin_activity_feed(p_limit integer default 60)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    from (
      select a.id,
             a.action,
             a.detail,
             a.created_at,
             coalesce(pr.display_name, pr.email, 'مشرف') as admin_name,
             coalesce(u.display_name, 'مستخدم')          as user_name,
             a.conversation_id
        from public.admin_activity a
        left join public.profiles pr on pr.id = a.admin_id
        left join public.conversations c on c.id = a.conversation_id
        left join public.profiles u on u.id = c.user_id
       where public.current_is_admin()
       order by a.created_at desc
       limit greatest(1, least(coalesce(p_limit, 60), 200))
    ) t;
$$;


-- 8.ح) أرقام الملخص اليومي
create or replace function public.daily_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start timestamptz := date_trunc('day', now());
  v_result jsonb;
begin
  if not public.current_is_admin() then
    raise exception 'هذه العملية للمشرفين فقط';
  end if;

  select jsonb_build_object(
    'day',                 to_char(v_start, 'YYYY-MM-DD'),
    'new_conversations',   (select count(*) from public.conversations where created_at >= v_start),
    'messages_received',   (select count(*) from public.messages m
                             join public.conversations c on c.id = m.conversation_id
                            where m.created_at >= v_start and m.sender_id = c.user_id),
    'messages_sent',       (select count(*) from public.messages m
                             join public.conversations c on c.id = m.conversation_id
                            where m.created_at >= v_start and m.sender_id <> c.user_id),
    'waiting_reply',       (select count(*) from public.conversations where status = 'pending'),
    'unresolved',          (select count(*) from public.conversations where status <> 'done'),
    'total_conversations', (select count(*) from public.conversations),
    'active_admins',       (select count(distinct admin_id) from public.admin_activity
                             where created_at >= v_start and admin_id is not null),
    'top_admins',          (select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
                              select coalesce(p.display_name, p.email, 'مشرف') as name,
                                     count(*) as replies
                                from public.admin_activity a
                                join public.profiles p on p.id = a.admin_id
                               where a.created_at >= v_start and a.action = 'replied'
                               group by 1
                               order by replies desc
                               limit 5
                            ) x),
    'generated_at',        now()
  ) into v_result;

  return v_result;
end;
$$;


-- ===============================================================
-- 9) تقرير
-- ===============================================================
select
  (select count(*) from public.conversations)                                  as "المحادثات",
  (select count(*) from public.conversations where status = 'new')             as "جديدة",
  (select count(*) from public.conversation_internal)                          as "ملاحظات_داخلية",
  (select count(*) from public.admin_activity)                                 as "أحداث_النشاط",
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='signature') as "عمود_التوقيع";


-- ===============================================================
-- إعادة تسمية مستخدم (للمشرفين فقط)
-- ===============================================================
-- سياسة profiles_update_self_no_escalation تسمح لكل مستخدم بتعديل ملفه
-- الشخصي وحده: using (id = auth.uid()). لذلك لا يستطيع المشرف إعادة
-- تسمية غيره من المتصفح. هذه الدالة تتجاوز السياسة بأمان بعد التحقق
-- من صفة المنادي (مشرف أو مشرف عام).
-- ===============================================================

create or replace function public.admin_rename_user(p_user uuid, p_new_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_new_name, ''));
  v_allowed boolean;
  v_old     text;
begin
  if auth.uid() is null then
    raise exception 'يجب تسجيل الدخول أولاً' using errcode = '42501';
  end if;

  select (is_admin or is_super_admin) into v_allowed
    from public.profiles
   where id = auth.uid();

  if coalesce(v_allowed, false) = false then
    raise exception 'هذه العملية للمشرفين فقط' using errcode = '42501';
  end if;

  if p_user is null then
    raise exception 'حدّد المستخدم المطلوب';
  end if;

  if v_name = '' then
    raise exception 'الاسم لا يمكن أن يكون فارغاً';
  end if;

  if length(v_name) > 40 then
    raise exception 'الاسم يجب أن يكون 40 حرفاً أو أقل';
  end if;

  select display_name into v_old from public.profiles where id = p_user;

  if not found then
    raise exception 'المستخدم غير موجود';
  end if;

  update public.profiles
     set display_name = v_name
   where id = p_user;

  return v_name;
end;
$$;

grant execute on function public.admin_rename_user(uuid, text) to authenticated;
