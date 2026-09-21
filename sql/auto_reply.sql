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
  'مرحباً بك 👋 كيف يمكننا مساعدتك؟ اختر أحد الخيارات أو اكتب رسالتك مباشرةً.',
  '[
    {"label":"🛠️ طلب دعم فني","value":"طلب دعم فني"},
    {"label":"💬 استفسار عن خدمة","value":"استفسار عن خدمة"},
    {"label":"📝 شكوى","value":"لدي شكوى"}
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


-- ============================================================================
-- 9) الرد التلقائي على اختيار المستخدم من قائمة الأزرار
-- ----------------------------------------------------------------------------
--  الفكرة:
--    رسالة الترحيب تحمل أزراراً (label + value). عند الضغط على زر يُرسل
--    التطبيق «value» كرسالة من المستخدم. بدون هذه الدالة يتوقف الأمر هنا.
--    الآن: إن أضاف المشرف حقل "reply" لكل زر، يرد النظام تلقائياً باسم
--    المشرف صاحب المحادثة بنص ذلك الرد.
--
--  مثال إعدادات الأزرار:
--    [{"label":"🛠️ طلب دعم فني","value":"طلب دعم فني",
--      "reply":"تم استلام طلبك ✅ سيتواصل معك الفريق قريباً."}]
--
--  الأمان: لا يستطيع العميل إرسال رسالة تحمل buttons (سياسة messages_insert)،
--  والدالة تعمل بصلاحيات المالك. ولا حلقة لا نهائية: الرد يُرسل من المشرف
--  لا من المستخدم، فتتجاهله الدالة في أول شرط.
-- ============================================================================

create or replace function public.auto_reply_on_menu_choice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.auto_reply_settings;
  v_admin_id uuid;
  v_user_id  uuid;
  v_btn      jsonb;
  v_reply    text;
begin
  if new.buttons is not null or new.content is null then
    return new;
  end if;

  -- المحادثة وطرفاها
  select c.admin_id, c.user_id
    into v_admin_id, v_user_id
    from public.conversations c
   where c.id = new.conversation_id;

  -- الرد موجَّه لرسائل المستخدم العادي وحده
  if v_admin_id is null or new.sender_id is distinct from v_user_id then
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

  -- هل نص الرسالة يطابق قيمة أحد أزرار القائمة؟
  select b
    into v_btn
    from jsonb_array_elements(v_settings.buttons) b
   where btrim(b ->> 'value') = btrim(new.content)
   limit 1;

  if v_btn is null then
    return new;
  end if;

  v_reply := btrim(coalesce(v_btn ->> 'reply', ''));

  if v_reply = '' then
    return new;   -- الزر بلا رد مُعدّ
  end if;

  if length(v_reply) > 400 then
    v_reply := left(v_reply, 400);
  end if;

  insert into public.messages (conversation_id, sender_id, content, status)
  values (new.conversation_id, v_admin_id, v_reply, 'sent');

  update public.conversations
     set last_message        = v_reply,
         last_message_at     = now(),
         last_sender_id      = v_admin_id,
         last_message_status = 'sent'
   where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists trg_auto_reply_on_menu_choice on public.messages;
create trigger trg_auto_reply_on_menu_choice
  after insert on public.messages
  for each row execute function public.auto_reply_on_menu_choice();


-- ============================================================================
-- 10) ملخّص المحادثة يتحدّث من القاعدة نفسها
-- ----------------------------------------------------------------------------
--  كان التطبيق يحدّث conversations.last_message بنفسه بعد الإرسال. مشكلة ذلك:
--  عند اختيار المستخدم زراً من القائمة يُدرج التريغر الردّ التلقائي فوراً،
--  ثم يأتي تحديث التطبيق بعده فيطمس الرد ويُظهر نص المستخدم في القائمة.
--  الحل: مصدر واحد للحقيقة — هذا التريغر.
--  (اسمه يبدأ بـ aa ليعمل قبل تريغر الرد التلقائي، فيبقى آخر ما يظهر هو الرد)
-- ============================================================================

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

  update public.conversations c
     set last_message        = left(v_preview, 300),
         last_message_at     = v_at,
         last_sender_id      = new.sender_id,
         last_message_status = coalesce(new.status, 'sent')
   where c.id = new.conversation_id
     and v_at >= coalesce(c.last_message_at, '-infinity'::timestamptz);

  return new;
end;
$$;

drop trigger if exists aa_bump_conversation_summary on public.messages;
create trigger aa_bump_conversation_summary
  after insert on public.messages
  for each row execute function public.bump_conversation_summary();


-- ============================================================================
-- 11) update_auto_reply: يقبل ويُنظّف حقل «الردّ التلقائي» لكل زر
-- ----------------------------------------------------------------------------
--  كل زر صار {label, value, reply}: label = نص الزر الظاهر، value = ما يُرسله
--  المستخدم عند الضغط، reply = ما يردّ به المشرف تلقائياً (اختياري، ≤ 400 حرف).
--  الدالة تُدقّق الثلاثة وتُخزّن نسخة منظّفة (trim + حذف reply الفارغ).
-- ============================================================================

create or replace function public.update_auto_reply(
  p_greeting text,
  p_buttons  jsonb   default '[]'::jsonb,
  p_enabled  boolean default true
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_btn      jsonb;
  v_buttons  jsonb;
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
    if length(btrim(coalesce(v_btn ->> 'reply', ''))) > 400 then
      raise exception 'الردّ التلقائي للزر طويل جداً (الحد 400 حرف)';
    end if;
  end loop;

  -- نسخة منظّفة: trim للحقول وحذف مفتاح reply إن كان فارغاً
  select coalesce(
           jsonb_agg(
             jsonb_strip_nulls(
               jsonb_build_object(
                 'label', btrim(btn ->> 'label'),
                 'value', btrim(btn ->> 'value'),
                 'reply', nullif(btrim(coalesce(btn ->> 'reply', '')), '')
               )
             )
             order by ord
           ),
           '[]'::jsonb
         )
    into v_buttons
    from jsonb_array_elements(p_buttons) with ordinality as e(btn, ord);

  select id into v_id from public.auto_reply_settings
   order by updated_at desc limit 1;

  if v_id is null then
    insert into public.auto_reply_settings (greeting, buttons, is_enabled)
    values (btrim(p_greeting), v_buttons, coalesce(p_enabled, true));
  else
    update public.auto_reply_settings
       set greeting   = btrim(p_greeting),
           buttons    = v_buttons,
           is_enabled = coalesce(p_enabled, true),
           updated_at = now()
     where id = v_id;
  end if;
end;
$$;
