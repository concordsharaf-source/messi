-- ============================================================================
--  auto_reply.sql — الرد التلقائي (رسالة ترحيب بأزرار جاهزة)
-- ----------------------------------------------------------------------------
--  ▶ ما هذه الميزة؟
--     عندما يفتح مستخدم عادي محادثة مع مشرف، يُرسل النظام تلقائياً رسالة
--     ترحيب من المشرف، وتحتها أزرار جاهزة (مثل «طلب دعم فني») يضغطها المستخدم
--     فتُرسل كنص رسالة. هذا يقلّل كتابة المستخدم ويوجّه المحادثة.
--
--  ▶ لماذا كُتب هذا الملف؟
--     الواجهة تدعم هذه الأزرار كاملةً منذ الأصل:
--       js/app.js:1893  ← تقرأ m.buttons وتعرضها كأزرار .msg-btn
--       js/app.js:1981  ← عند الضغط ترسل b.value كرسالة وتُعطّل الأزرار
--       css/style.css:1757-1807 ← تنسيقات .msg-buttons / .msg-btn جاهزة
--     لكن كان ناقصاً:
--       ① عمود public.messages.buttons → فـ m.buttons يبقى undefined دائماً
--       ② آلية الإرسال التلقائي عند إنشاء المحادثة
--     هذا الملف يضيف الناقصين بنفس آلية المشروع (Trigger بصلاحيات definer).
--
--  ▶ طريقة الاستخدام:
--      Supabase → SQL Editor → الصق هذا الملف → Run
--     آمن للتشغيل المتكرر (idempotent).
-- ============================================================================

-- ============================================================================
-- 1) عمود الأزرار على جدول الرسائل
--    يُقرأ تلقائياً لأن الواجهة تجلب الرسائل بـ select("*") — js/app.js:1604
-- ============================================================================
alter table public.messages
  add column if not exists buttons jsonb;

comment on column public.messages.buttons is
  'أزرار جاهزة أسفل الرسالة: [{"label":"نص الزر","value":"ما يُرسل عند الضغط"}]';

-- ============================================================================
-- 2) إعدادات الرد التلقائي — صف واحد يتحكّم بالنص والأزرار
--    من هنا تُعدَّل الرسالة بلا لمس الكود ولا إعادة نشر.
-- ============================================================================
create table if not exists public.auto_reply_settings (
  id          uuid primary key default gen_random_uuid(),
  is_enabled  boolean     not null default true,
  greeting    text        not null,
  buttons     jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),

  -- الأزرار: مصفوفة، وكل عنصر فيه label و value نصّيان
  constraint auto_reply_buttons_is_array check (jsonb_typeof(buttons) = 'array')
);

alter table public.auto_reply_settings enable row level security;

-- القراءة للمصادَق عليهم (لتُبنى واجهة إعدادات لاحقاً بلا تعديل قاعدة)
drop policy if exists "auto_reply_read_authenticated" on public.auto_reply_settings;
create policy "auto_reply_read_authenticated"
  on public.auto_reply_settings for select to authenticated
  using (true);

-- التعديل للمشرفين فقط
drop policy if exists "auto_reply_update_admin" on public.auto_reply_settings;
create policy "auto_reply_update_admin"
  on public.auto_reply_settings for update to authenticated
  using (exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p
                       where p.id = auth.uid() and p.is_admin = true));

drop policy if exists "auto_reply_insert_admin" on public.auto_reply_settings;
create policy "auto_reply_insert_admin"
  on public.auto_reply_settings for insert to authenticated
  with check (exists (select 1 from public.profiles p
                       where p.id = auth.uid() and p.is_admin = true));

-- الصف الافتراضي — ✏️ عدّل النص والأزرار كما تريد (انظر آخر الملف)
insert into public.auto_reply_settings (is_enabled, greeting, buttons)
select
  true,
  'مرحباً 👋 كيف يمكننا مساعدتك؟ اختر أحد الخيارات أو اكتب رسالتك مباشرةً.',
  '[
    {"label":"🛠️ طلب دعم فني","value":"طلب دعم فني"},
    {"label":"💬 استفسار عن خدمة","value":"استفسار عن خدمة"},
    {"label":"📄 شكوى","value":"لدي شكوى"}
  ]'::jsonb
where not exists (select 1 from public.auto_reply_settings);

-- ============================================================================
-- 3) دالة الإرسال التلقائي + الـ Trigger
--    تعمل بنفس آلية handle_new_user / sync_conversation_members في المشروع:
--    security definer + search_path ثابت، فتعمل تلقائياً لأي عميل.
-- ============================================================================
create or replace function public.send_welcome_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.auto_reply_settings;
  v_user_is_admin boolean;
begin
  -- الإعدادات (أحدث صف مُفعَّل — والصف مُفرد عادةً)
  select * into v_settings
    from public.auto_reply_settings
   where is_enabled = true
   order by updated_at desc
   limit 1;

  if not found then
    return new;   -- الرد التلقائي معطّل
  end if;

  -- لا نرسل ترحيباً في محادثة بين مشرفين — الرد موجَّه للمستخدم العادي وحده
  select coalesce(p.is_admin, false) into v_user_is_admin
    from public.profiles p
   where p.id = new.user_id;

  if coalesce(v_user_is_admin, false) then
    return new;
  end if;

  -- رسالة من المشرف صاحب المحادثة، تحمل الأزرار
  insert into public.messages (conversation_id, sender_id, content, buttons, status)
  values (
    new.id,
    new.admin_id,
    v_settings.greeting,
    case when jsonb_array_length(v_settings.buttons) > 0 then v_settings.buttons else null end,
    'sent'
  );

  -- حدّث ملخّص المحادثة ليظهر الترحيب في القائمة الجانبية فوراً
  update public.conversations
     set last_message    = v_settings.greeting,
         last_message_at = now()
   where id = new.id;

  return new;
end;
$$;

drop trigger if exists trg_send_welcome_message on public.conversations;
create trigger trg_send_welcome_message
  after insert on public.conversations
  for each row execute function public.send_welcome_message();

-- ============================================================================
-- 4) تشديد أمني: لا يستطيع العميل إرفاق أزرار برسالته
-- ----------------------------------------------------------------------------
--  بدونه يستطيع أي مستخدم إرسال رسالة تحمل buttons، فتظهر أزرار في واجهة
--  المستخدم الآخر (لأن العرض يشترط !mine) — أي دعوة اجتماعية للضغط على زر
--  يرسل نصاً مُعدّاً مسبقاً. الأزرار حقّ النظام وحده، والـ Trigger أعلاه
--  يعمل بصلاحيات المالك فيتجاوز هذه السياسة.
--  ⚠️ إن أردت لاحقاً أن يرسل المشرفون أزراراً من الواجهة، احذف هذا الشرط.
-- ============================================================================
drop policy if exists "messages_insert_participant" on public.messages;
create policy "messages_insert_participant"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and buttons is null
    and public.is_conversation_participant(conversation_id)
  );

-- السياسة المكرّرة من schema.sql — تُوحَّد على نفس الديناميكية
drop policy if exists "Users can insert messages in their conversations" on public.messages;
create policy "Users can insert messages in their conversations"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and buttons is null
    and exists (
      select 1 from public.chat_members cm
       where cm.conversation_id = messages.conversation_id
         and cm.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 5) تقرير الحالة
-- ============================================================================
select is_enabled   as "مُفعَّل",
       greeting     as "نص الترحيب",
       jsonb_array_length(buttons) as "عدد الأزرار",
       buttons      as "الأزرار"
  from public.auto_reply_settings
 order by updated_at desc;

-- ============================================================================
--  ✏️ للتعديل السريع لاحقاً (استبدل النصوص بما تريد وشغّل السطرين)
-- ============================================================================
-- update public.auto_reply_settings
--    set greeting = 'أهلاً بك 👋 كيف نساعدك؟',
--        buttons  = '[{"label":"دعم فني","value":"طلب دعم فني"},{"label":"استفسار","value":"استفسار عام"}]'::jsonb,
--        updated_at = now();
--
-- لإيقاف الرد التلقائي مؤقتاً:
-- update public.auto_reply_settings set is_enabled = false, updated_at = now();
