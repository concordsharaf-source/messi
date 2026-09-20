# من الصفر إلى تطبيق محادثات كامل — بنفس آلية هذا المشروع

> هدف هذا الدليل: أن تبني تطبيقاً مثل هذا **بنفسك**، وتفهم **لماذا** كل قرار اتُّخذ.
> لن تحتاج إلى نسخ الكود — ستفهم النمط فتستطيع إعادة إنتاجه في أي مشروع.
>
> للربط بحساباتك أنت: [`docs/SWITCH_TO_YOUR_ACCOUNTS.md`](./SWITCH_TO_YOUR_ACCOUNTS.md)

**الزمن التقريبي:** 6–10 ساعات عمل فعلي موزعة على المراحل الاثنتي عشرة.

---

## المرحلة 0 — افهم النمط قبل أن تكتب سطراً

### لماذا Vanilla JS + Supabase بدون Backend؟

التقليد في تطبيق دردشة: خادم Node/Express + قاعدة بيانات + WebSocket server + خدمة رفع ملفات
+ نظام مصادقة + نشر الإشعارات. هذا **ست خدمات** تديرها أنت.

Supabase يعطيك الخمسة الأولى من خدمة واحدة:

| تحتاج | البديل التقليدي | في Supabase |
|---|---|---|
| مصادقة | Passport/JWT/Auth0 | `supabase.auth` (GoTrue) |
| قاعدة بيانات | Postgres تديره | Postgres مُدار |
| فوري (Realtime) | Socket.io server | `supabase.channel` (Phoenix) |
| رفع ملفات | S3 + presigned URLs | `supabase.storage` |
| منطق خادمي | Express endpoints | Edge Functions (Deno) |
| الحماية | middleware في كل route | **RLS داخل قاعدة البيانات** |

والنتيجة: الواجهة كلها تعمل من المتصفح مباشرة، و«الخادم» هو قاعدة البيانات نفسها.

### الفكرة الأهم في المشروع كله: RLS

في خادم تقليدي تكتب:
```js
app.get('/messages', auth, (req, res) => {
  // تتحقق يدوياً أن المستخدم مشارك في المحادثة
  if (!isParticipant(req.user.id, req.query.conversation)) return res.status(403).end();
  db.query(...)
})
```
لو نسيت هذا التحقق في endpoint واحد → ثغرة.

في Supabase تكتب السياسة **مرة واحدة** في قاعدة البيانات:
```sql
create policy "messages_select_participant" on public.messages for select
  using (public.is_conversation_participant(conversation_id));
```
والآن **كل** استعلام — من المتصفح، من Edge Function، من أي عميل مستقبلي — محكوم بها.
لا يمكن نسيانها. هذا هو جوهر «Backend-less آمن».

> **القاعدة الذهبية:** كل منطق أمني حقيقي يجب أن يكون في SQL، لا في JavaScript.
> JavaScript في المتصفح يمكن لأي مستخدم تعديله من Console خلال ثوانٍ.

### لماذا Firebase مع أن Supabase يكفي؟

Supabase Realtime يوصل الرسالة فوراً **طالما الصفحة مفتوحة**. لو أغلق المستخدم التبويب،
انقطع الاتصال — فلا إشعار. المتصفح لا يسمح بإيقاظ صفحة مغلقة إلا عبر **Push**.

Web Push العادي يحتاج VAPID keys + خدمة إرسال. Firebase Cloud Messaging يوفّر هذه
البنية جاهزة ومجانية، ويعمل على iOS Safari (16.4+ بشرط تثبيت PWA) وهو ما كان صعباً تاريخياً.

**فالفصل الوظيفي:** Supabase = الحقيقة والبيانات. Firebase = جرس الباب فقط.

---

## المرحلة 1 — جهّز بيئة العمل

```bash
# الأدوات
node --version          # 18 أو أحدث
npm install -g supabase # CLI لنشر Edge Functions
python3 --version       # خادم استاتيكي محلي للاختبار

# أنشئ مجلد المشروع
mkdir my-chat && cd my-chat
git init
```

أنشئ الهيكل الفارغ (سيُملأ تدريجياً):

```
my-chat/
├── index.html
├── manifest.json
├── sw.js
├── firebase-messaging-sw.js
├── css/style.css
├── js/
│   ├── config.js
│   ├── supabaseClient.js
│   ├── auth.js
│   ├── db.js
│   ├── push.js
│   ├── i18n.js
│   └── app.js
├── partials/chat-panel.html
├── icons/
├── sql/
│   ├── schema.sql
│   └── fcm_and_rls.sql
├── supabase/functions/
│   ├── send-push/index.ts
│   └── admin-delete-user/index.ts
└── .github/workflows/static.yml
```

```bash
mkdir -p css js partials icons sql supabase/functions/send-push supabase/functions/admin-delete-user .github/workflows
```

**قاعدة مهمة:** ES Modules (`<script type="module">`) **لا تعمل من `file://`**.
يجب خادم HTTP. لهذا من أول يوم:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

---

## المرحلة 2 — أنشئ مشروعي Supabase وFirebase

### Supabase
1. https://supabase.com → **New project**
2. سجّل: اسم المشروع، **كلمة مرور قاعدة البيانات** (احفظها في مدير كلمات مرور)، المنطقة
3. من **Settings → API** انسخ: `Project URL`, `anon public`, `service_role secret`
4. ضعهما في مكان آمن مؤقتاً — سنستخدمهما في المرحلة 3

### Firebase
1. https://console.firebase.google.com → **Add project** (Google Analytics اختيارية — أطفئها، لا نحتاجها)
2. **⚙️ Project settings → General → Your apps → `</>`** → سجّل Web app → انسخ `firebaseConfig`
3. **Project settings → Cloud Messaging** → تأكد أن **FCM V1** مفعّلة →
   **Web Push certificates → Generate key pair** → انسخ مفتاح VAPID
4. **Project settings → Service accounts → Generate new private key** → ينزّل JSON.
   احفظه خارج مجلد المشروع تماماً (مثلاً `~/secrets/`)، وخذ منه `project_id`, `client_email`, `private_key`

---

## المرحلة 3 — صمّم قاعدة البيانات أولاً (وليس الواجهة!)

ابدأ من السؤال: **ما البيانات؟** ثم اشتقّ الواجهة.

### 3.1 ارسم الجداول

```
auth.users (يديرها Supabase — لا تلمسها)
      │ id
      ▼
  profiles ──────────┬──────────────────────┐
      │ id           │ user_id              │ admin_id
      │              ▼                      │
      └────────► conversations ◄────────────┘
                     │ id
                     ▼
                 messages ──► message_reactions
                     │
                     └──► reply_to_id (مرجع ذاتي)

  typing_status (conversation_id + user_id)
  chat_members  (conversation_id + user_id + role)
  fcm_tokens    (user_id + token)
```

**قرار تصميمي جوهري:** المحادثة هنا **ثنائية الطرف فقط** (`user_id` + `admin_id`)،
وليست مجموعة عامة. لهذا `chat_members` أُضيف لاحقاً كطبقة أدوار وليس كأساس.
لو تريد مجموعات حقيقية من البداية، صمّم `conversations` بلا `user_id/admin_id`
واعتمد على `chat_members` وحده — وهذا تغيير جوهري يمس كل استعلام في التطبيق.

### 3.2 اكتب `sql/schema.sql`

ابدأ بالامتدادات والجداول:

```sql
create extension if not exists pgcrypto;   -- لـ gen_random_uuid()

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  display_name text,
  phone text,
  avatar_url text,
  wallpaper_url text,
  is_online boolean not null default false,
  last_seen timestamptz,
  is_admin boolean not null default false,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now()
);
```

> **لماذا `id` هو نفسه `auth.users.id` وليس `uuid default gen_random_uuid()`؟**
> لأن `auth.uid()` في سياسات RLS يعيد معرّف مستخدم Auth. لو كان `profiles.id` مستقلاً
> لاحتجت join إضافي في **كل سياسة** — أبطأ وأكثر عرضة للخطأ.

ثم `conversations` **مع أسماء FK مقصودة**:

```sql
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    constraint conversations_user_id_fkey references public.profiles(id) on delete cascade,
  admin_id uuid not null
    constraint conversations_admin_id_fkey references public.profiles(id) on delete cascade,
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index conversations_user_admin_key on public.conversations(user_id, admin_id);
```

**هذه النقطة يفوتها الجميع:** PostgREST (الذي يترجم `select("*, user:profiles!conversations_user_id_fkey(*)")`)
يحتاج **اسم القيد صريحاً** عندما يكون هناك **أكثر من FK من نفس الجدول إلى نفس الجدول الهدف**.
هنا `user_id` و`admin_id` كلاهما يشير إلى `profiles` → بدون تسمية، يعيد PostgREST خطأ
`Could not choose a best candidate relationship`. سمّها صراحة منذ اليوم الأول.

و`create unique index` على `(user_id, admin_id)` يمنع محادثتين مكررتين — لأن الكود يستخدم
`.maybeSingle()` وسينهار لو وجد صفين.

### 3.3 Trigger لإنشاء الملف الشخصي تلقائياً

بدون هذا، كل مستخدم جديد يسجّل ولن يجد صفاً في `profiles` → التطبيق ينهار.

```sql
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  v_email := lower(coalesce(new.email, ''));
  insert into public.profiles (id, email, display_name, phone, is_admin, is_super_admin)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'display_name', split_part(v_email,'@',1)),
          new.raw_user_meta_data->>'phone',
          public.is_admin_email(v_email),
          public.is_super_admin_email(v_email))
  on conflict (id) do update
    set email = excluded.email,
        is_admin = public.is_admin_email(v_email),
        is_super_admin = public.is_super_admin_email(v_email);
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

**تعلّم من هذا المقطع ثلاثة أمور:**

1. `security definer` — الـ trigger ينفَّذ داخل `auth.users` حيث `auth.uid()` فارغ،
   فبدون `security definer` سترفض RLS الإدراج. **لكن** `security definer` تعني
   «نفّذ بصلاحيات المالك» = تجاوز RLS، لذا:
2. `set search_path = public` — **إلزامي أمني**. بدونه يمكن لمهاجم إنشاء دالة
   `public.is_admin_email` خبيثة… في مخطط يبحث عنه أولاً. تثبيت `search_path` يغلق هذا الباب.
3. `on conflict do update` — لأن العميل يعمل `upsert` احتياطياً أيضاً (`js/auth.js:22`)،
   فالتسجيل قد يحدث مرتين. `on conflict` يجعل العملية **idempotent**.

> ملاحظة: `is_admin_email()` يجب أن تُنشأ **قبل** `handle_new_user()`. راجع الترتيب في `sql/schema.sql`.

### 3.4 RLS — اكتبها بهذه المنهجية

لا تكتب السياسات عشوائياً. اسأل لكل جدول أربعة أسئلة:

```
SELECT: من يقرأ؟  → المشاركان فقط (+ المشرف العام)
INSERT: من ينشئ؟  → مشارك فعلي، و sender_id = auth.uid()
UPDATE: من يعدّل؟ → المشارك، ومع منع تصعيد الصلاحيات
DELETE: من يحذف؟  → المشرف فقط، وعلى مستخدم عادي فقط
```

مثال على أخطر سياسة (منع تصعيد الصلاحيات):

```sql
create policy "profiles_update_self_no_escalation" on public.profiles for update
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (
      -- إما أن حقلي الصلاحية لم يتغيرا…
      (is_admin, is_super_admin) = (select p.is_admin, p.is_super_admin
                                      from public.profiles p where p.id = auth.uid())
      -- …أو أن المستخدم مشرف أصلاً فله التعديل
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
    )
  );
```

**لماذا `with check` وليس `using` فقط؟** `using` تتحكم بالصفوف **الموجودة** التي يسمح بقراءتها
للعملية، أما `with check` فتتحقق من **الشكل الجديد** للصف. بدونه، أي مستخدم يستطيع من Console:

```js
await supabase.from('profiles').update({ is_admin: true }).eq('id', myId)
```

ويصبح مشرفاً. `with check` يجعل هذا التحديث مرفوضاً.

### 3.5 الدوال المساعدة (SECURITY DEFINER بحذر)

```sql
create or replace function public.is_conversation_participant(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations c
                  where c.id = p_conversation_id
                    and (c.user_id = auth.uid() or c.admin_id = auth.uid()));
$$;
```

`security definer` هنا **مقصود وضروري**: السياسة على `messages` تحتاج قراءة `conversations`،
ولو كانت سياسة `conversations` مقيّدة لحدثت حلقة. `stable` (وليست `volatile`) تسمح
للمخطِّط بتخزين النتيجة مؤقتاً داخل الاستعلام — أسرع.

### 3.6 Storage + Realtime

```sql
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars','avatars',true,5242880),
       ('attachments','attachments',true,52428800),
       ('wallpapers','wallpapers',true,5242880)
on conflict (id) do update set public = excluded.public;

-- كل مستخدم يكتب داخل مجلده هو فقط
create policy "own_folder_insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','attachments','wallpapers')
              and (storage.foldername(name))[1] = auth.uid()::text);
```

`(storage.foldername(name))[1] = auth.uid()::text` هو ما يمنع مستخدماً من الكتابة في مجلد غيره.
الكود يلتزم بذلك: `folder = state.me.id` في `js/app.js:2597`.

```sql
alter publication supabase_realtime add table public.messages;  -- ولكل جدول تريده فورياً
```

بدون هذا السطر تعمل الاستعلامات عادي، لكن `postgres_changes` **لن يبث أي شيء** — وهو عطل
محير جداً لأنه لا يعيد خطأً، فقط صمت.

---

## المرحلة 4 — طبقة الاتصال في الواجهة

### 4.1 `js/config.js` — نقطة الحقيقة الوحيدة

```js
export const SUPABASE_URL = "https://<ref>.supabase.co";
export const SUPABASE_ANON_KEY = "<anon key>";
export const ADMINS = [{ email: "you@example.com", name: "اسمك" }];
export const isAdminEmail = (email) =>
  ADMINS.some(a => a.email.toLowerCase() === (email || "").toLowerCase());
```

**مبدأ:** اجعل كل قيمة قابلة للتغيير في ملف واحد. أسوأ ما في المشروع الأصلي أن
`firebaseConfig` مكرر في ملفين و`VAPID` في مكانين و`ADMINS` في ثلاثة (config.js،
auth.js، schema.sql). عندما تغيّر، ستنسى أحدها.

### 4.2 `js/supabaseClient.js`

```js
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
});
```

- `window.supabase` لأن المكتبة محمّلة من CDN كـ UMD في `index.html` (لا يوجد bundler)
- `persistSession: true` → يخزّن الجلسة في `localStorage` ويعيد المستخدم تلقائياً
- `eventsPerSecond: 10` → خنق Realtime. الافتراضي أعلى، وتخفيضه يحمي من استهلاك الحصة عند الكتابة السريعة (مؤشر «يكتب الآن…»)

> **بديل أنظف:** نزّل `supabase.min.js` إلى `js/vendor/` واستورده محلياً. تستبدل اعتماد CDN
> بملف في مستودعك — أضمن وأسرع.

### 4.3 `index.html` — هيكل الصفحتين

```html
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <link rel="manifest" href="./manifest.json">
  <meta name="theme-color" content="#111b21" />
  <link rel="stylesheet" href="./css/style.css" />
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
</head>
<body data-theme="dark">
  <div id="boot-loading" class="boot-loading"><div class="boot-spinner"></div></div>

  <div id="auth-screen" class="auth-screen hidden"><!-- تسجيل/دخول --></div>
  <div id="app-screen" class="app-screen hidden">
    <aside><!-- قائمة المحادثات --></aside>
    <div id="chat-panel-container"></div>  <!-- يُحقن من partials -->
  </div>

  <audio id="notification-sound" src="./icons/notify.mp3" preload="auto"></audio>
  <script type="module" src="./js/app.js"></script>
</body>
</html>
```

**ثلاثة قرارات تستحق الفهم:**

1. `viewport-fit=cover` — ضروري لاحترام notch في iPhone مع `env(safe-area-inset-*)` في CSS
2. `#boot-loading` — بدونها، يرى المستخدم شاشة الدخول للحظة قبل التحقق من الجلسة المخزنة (وميض مزعج)
3. `partials/chat-panel.html` يُحقن بـ `fetch()` — يفصل واجهة الدردشة الضخمة عن `index.html`.
   **لكن انتبه:** `fetch('./partials/chat-panel.html')` سيفشل من `file://`، ويعتمد على
   أن الخادم يعيد الملف (بعض إعدادات GitHub Pages مع `.nojekyll` مطلوبة)

---

## المرحلة 5 — المصادقة

### 5.1 `js/auth.js`

```js
export async function signUp({ email, password, displayName, phone }) {
  const normalizedEmail = email.trim().toLowerCase();   // ← مهم جداً
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail, password,
    options: { data: { display_name: displayName, phone: phone || null } },
  });
  if (error) throw error;

  // upsert احتياطي — لأن Trigger قد يتأخر عند تفعيل تأكيد البريد
  if (data?.user) {
    try {
      await supabase.from("profiles").upsert({
        id: data.user.id, email: normalizedEmail,
        display_name: displayName, phone: phone || null,
        is_admin: isAdminEmail(normalizedEmail),
      }, { onConflict: "id" });
    } catch (err) { console.warn(err); }
  }
  return data;
}
```

**الدروس الثلاثة:**

1. `toLowerCase()` قبل الإرسال — `is_admin_email()` في SQL تقارن بحروف صغيرة.
   لو سجّل المستخدم `Admin@X.com` وفحصت `admin@x.com` لن تتطابق. **التطبيع يجب أن يحدث
   في نفس المكان في كل المسارات**: `signUp`, `signIn`, `isAdminEmail`, والـ Trigger.
2. `options.data` → تُخزَّن في `auth.users.raw_user_meta_data` → يقرأها الـ Trigger.
   هذه هي القناة الوحيدة لتمرير بيانات إضافية عند التسجيل.
3. الـ `upsert` الاحتياطي: مع **تأكيد البريد مفعّل**، `signUp` يعيد `user` لكن بلا جلسة،
   وقد لا يعمل الـ Trigger كما تتوقع. `on conflict` في SQL يجعل التكرار آمناً.

### 5.2 الخروج بالترتيب الصحيح

```js
export async function signOut(userId) {
  await removeFcmToken(userId);      // ← أولاً، والجلسة ما زالت صالحة
  await supabase.from("profiles").update({ is_online: false, last_seen: new Date().toISOString() }).eq("id", userId);
  await supabase.auth.signOut();     // ← أخيراً
}
```

**لماذا الترتيب مهم؟** `removeFcmToken` يحذف صفاً من `fcm_tokens`، وسياسة RLS تسمح بالحذف
فقط لـ `auth.uid()` المطابق. لو نفّذت `signOut()` أولاً، أصبح `auth.uid()` فارغاً →
الحذف مرفوض → **يبقى توكن الجهاز مرتبطاً بالحساب** → تصل إشعارات لجهاز مستخدم سجّل خروجه.
هذا عطل حقيقي يصعب تشخيصه.

---

## المرحلة 6 — Realtime: ست قنوات، ست وظائف

| القناة | الجدول | الغرض |
|---|---|---|
| `messages:{conversationId}` | `messages` (INSERT، مع filter) | وصول رسالة جديدة في المحادثة المفتوحة |
| `typing:{conversationId}` | `typing_status` (`*`) | مؤشر «يكتب الآن…» |
| `reactions:{conversationId}` | `message_reactions` (`*`) | تحديث التفاعلات |
| `inbox-updates` | `conversations` (`*`) | تحديث preview القائمة بدون إعادة تحميل |
| `global-messages-watch` | `messages` (INSERT) | شارة غير المقروء + صوت عند وصول رسالة لمحادثة غير مفتوحة |
| `presence:global` | — (Presence، ليس جدول) | من متصل الآن |

### 6.1 نمط الاشتراك

```js
state.msgChannel = supabase
  .channel(`messages:${conversationId}`)
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages",
        filter: `conversation_id=eq.${conversationId}` },
      async (payload) => { /* payload.new = الصف الجديد */ })
  .subscribe((status) => { scheduleRealtimeReconnect(status); });
```

**ثلاث نقاط يفوتها المبتدئون:**

1. **`filter` ينقل التصفية إلى الخادم.** بدونه، ستستقبل **كل** رسالة في **كل** محادثة
   في النظام ثم تفلتر في JS — كارثة أداء وخصوصية (RLS ستمنع القراءة أصلاً، لكن
   ستهدر اتصالاً). `filter` يترجَم إلى شرط في بث Realtime.
2. **`scheduleRealtimeReconnect(status)`** — اتصالات Realtime تنقطع (شبكات الجوال، sleep).
   بدون إعادة اتصال تلقائية، يتوقف التطبيق عن التحديث «بصمت» ويظن المستخدم أنه لا رسائل.
3. **احذف القناة القديمة قبل إنشاء جديدة.** عند التنقل بين المحادثات، لو لم تعمل
   `removeChannel()` ستتراكم القنوات حتى تصل حد Supabase (افتراضياً ~200 لكل اتصال) ثم يفشل الاشتراك.

### 6.2 Presence (بدون جدول)

```js
state.presenceChannel = supabase.channel("presence:global", {
  config: { presence: { key: state.me.id } }
});
state.presenceChannel
  .on("presence", { event: "sync" }, () => {
    const s = state.presenceChannel.presenceState();   // { userId: [{...}] }
    // حدّث نقاط «متصل الآن» الخضراء
  })
  .subscribe(async () => {
    await state.presenceChannel.track({ user_id: state.me.id, online_at: Date.now() });
  });
```

Presence يعيش في الذاكرة ( Phoenix ) وليس في Postgres — لذا هو **أسرع** ولا يكلّف كتابة
في القاعدة، لكنه **لا يصمد** بعد إعادة تحميل الصفحة (وهذا مطلوب بالضبط لحالة «متصل الآن»).

> لاحظ وجود **آليتين** للحالة في المشروع: Presence (فوري، عابر) + عمودا
> `is_online`/`last_seen` في `profiles` (دائم، مع heartbeat كل فترة + `visibilitychange`).
> Presence يعطي «متصل الآن» الحي، والأعمدة تعطي «آخر ظهور 3:45 م» بعد الإغلاق. تحتاج الاثنين.

---

## المرحلة 7 — رفع الملفات

```js
async function uploadFile(file, options = {}) {
  const bucket = options.bucket || "attachments";
  const folder = options.folder || state.me.id;         // ← يطابق سياسة RLS
  const storagePath = `${folder}/${createUploadUUID()}.${getSafeFileExtension(file)}`;

  const { error } = await supabase.storage.from(bucket).upload(storagePath, file, {
    cacheControl: "3600",
    contentType: file.type || "application/octet-stream",
    upsert: false,                                        // ← مهم: لا يستبدل ملفاً قائماً
  });
  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return { path: storagePath, publicUrl: data.publicUrl };
}
```

**القرارات:**
- `upsert: false` — مع UUID في الاسم لا يجب أن يحدث تعارض؛ لو حدث، فشل أفضل من استبدال صامت
- `getPublicUrl` يتطلب bucket عاماً. **البديل الأكثر خصوصية:** `createSignedUrl(path, 3600)`
  مع bucket خاص — يعطي رابطاً صالحاً لساعة. التكلفة: لا يمكن تخزين الرابط في `messages.attachment_url`
  لأنه سينتهي؛ تخزّن `path` وتولّد الرابط عند العرض.
- `getStoragePath(bucket, publicUrl)` في `js/app.js:3064` يعكس الرابط إلى مسار — لازم للحذف

**للرسائل الصوتية:** `MediaRecorder` → `Blob` → نفس `uploadFile` مع `bucket:"attachments"`,
`attachment_type:"audio"`. انتبه أن Safari ينتج `audio/mp4` بينما Chrome ينتج `audio/webm` —
احفظ `contentType` الفعلي ولا تفترض.

---

## المرحلة 8 — Push: الجزء الأصعب، افهمه بعناية

### 8.1 لماذا Service Worker **اثنان** وليس واحداً؟

المتصفح يسمح بـ **Service Worker واحد لكل scope**. لو سجّلت `sw.js` و`firebase-messaging-sw.js`
كلاهما في `/` → الثاني يزيح الأول.

الحل في `js/push.js:36-37`:

```js
const FIREBASE_SW_PATH  = "/firebase-messaging-sw.js";
const FIREBASE_SW_SCOPE = "/firebase-cloud-messaging-push-scope/";
```

scope مخصص (وهمي — لا يوجد مجلد بهذا الاسم) فيسجلان معاً بسلام. **هذا سبب وجود الملفين.**

### 8.2 تدفق التسجيل

```
المستخدم يضغط «تفعيل إشعارات الجهاز»
  └─► enablePushNotifications(userId)
       ├─► Notification.requestPermission()
       ├─► registerFirebaseServiceWorker()  (scope مخصص)
       ├─► getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration })
       └─► persistFcmToken(userId, token)
            └─► supabase.rpc("claim_fcm_token", { p_user_id, p_token, p_platform:"web" })
                 (دالة SECURITY DEFINER: تحذف أي ملكية قديمة للرمز ثم تملكه لك — ذرّياً)
            └─► localStorage.setItem("fcm_token", token)
```

**لماذا `claim_fcm_token` كدالة SQL وليس كود JS؟** انظر `js/push.js:163-200`: المسار
الاحتياطي في JS يحتاج **ثلاث عمليات** (delete للرموز الغريبة، delete للرموز المرتبطة بـ null،
ثم upsert). بين أي عمليتين قد يصل إشعار → ازدواجية أو تسريب للمستخدم السابق. الدالة
تنفذ الثلاث عمليات في **معاملة واحدة ذرّية**. هذا مثال ممتاز على «انقل المنطق إلى حيث البيانات».

### 8.3 `firebase-messaging-sw.js` (الخلفية)

```js
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
              "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

firebase.initializeApp(firebaseConfig);   // ← نفس الكائن حرفياً كما في push.js
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  if (wasRecentlyHandled(data.messageId)) return;   // ← منع التكرار
  return self.registration.showNotification(data.title, {
    body: data.body,
    icon: "/icons/icon.png",
    tag: data.messageId,
    renotify: true,
    requireInteraction: true,
    data: { ...data },
    vibrate: [100, 50, 100],
  });
});
```

**ثلاثة أسرار هنا:**

1. **`importScripts` وليس `import`** — Service Worker الكلاسيكي لا يدعم ES Modules.
   لهذا يستخدم هذا الملف نسخ **compat** (أي `firebase-app-compat.js`) بينما `push.js`
   يستخدم النسخ **modular** (`firebase-app.js`). نسختان مختلفتان من نفس المكتبة في نفس التطبيق —
   وهذا مقصود وإلزامي.
2. **`wasRecentlyHandled(messageId)`** — FCM يعيد المحاولة عند فشل التسليم. بدون كاش
   `messageId` بـ 60 ثانية، يظهر إشعاران للرسالة نفسها.
3. **رسائل `data-only`** (لا `notification` block في الـ payload) — لو أرسلت `notification`،
   يعرض المتصفح الإشعار **تلقائياً** ولا يستدعي `onBackgroundMessage` أصلاً، فيفقد
   `notificationclick` بيانات `conversationId` ولا يفتح المحادثة الصحيحة.

### 8.4 Foreground: لا تستخدم `showNotification`

```js
// js/push.js — listenForForegroundMessages
if (document.visibilityState !== "visible") return;   // الخلفية يتولاها SW
const audio = new Audio("./icons/notify.mp3"); await audio.play().catch(()=>{});
onNotification({ payload, title, body, data });        // callback يحدّث الواجهة
```

في foreground لا نعرض إشعار نظام (سيكون مزعجاً والمستخدم ينظر للشاشة أصلاً)، بل نشغّل
صوتاً ونحدّث الواجهة. وانتبه: `new Notification(...)` ترمي
`Illegal constructor` على أندرويد — استخدم `registration.showNotification()` دائماً.
و`audio.play()` سيفشل بلا تفاعل مستخدم سابق (autoplay policy) — لذا `.catch()`.

### 8.5 Edge Function `send-push`

```ts
// 1) تحقّق من هوية المرسل — لا تثق بالعميل
const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
const { data: { user: actor } } = await userClient.auth.getUser();
if (!actor || String(actor.id) !== String(record?.sender_id)) return json({ error: "Unauthorized sender" }, 401);

// 2) تحقّق أنه مشارك في المحادثة
if (![conversation.user_id, conversation.admin_id].some(id => String(id) === String(actor.id)))
  return json({ error: "Sender is not a participant" }, 403);

// 3) الآن فقط استخدم service_role
const admin = createClient(supabaseUrl, serviceKey);
const { data: tokens } = await admin.from("fcm_tokens").select("token").eq("user_id", receiverId);

// 4) استخرج access token من Google
const client = new JWT({ email: FIREBASE_CLIENT_EMAIL, key: FIREBASE_PRIVATE_KEY,
                         scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
const accessToken = (await client.authorize()).access_token;

// 5) أرسل
await fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ message: { token, data: {...}, android: { priority: "high" },
                                    webpush: { headers: { Urgency: "high" } } } }),
});
```

**النمط الذي يجب أن تحفظه:** عميلان مختلفان في نفس الدالة.
- `userClient` (anon key + Authorization من الطلب) → «من هذا فعلاً؟» — يحترم RLS
- `admin` (service_role) → يتجاوز RLS لقراءة توكنات الطرف الآخر

ولو استخدمت `service_role` للتحقق من الهوية لضاعت الهوية entirely. **تحقّق بالـ anon،
ثم ارتقِ للصلاحيات بعد التحقق.**

`android.priority: "high"` و`webpush.Urgency: "high"` — بدونها يؤجّل النظام التسليم
لتوفير البطارية، فتصل الإشعارات متأخرة دقائق.

### 8.6 لماذا يُستدعى `send-push` من العميل وليس من Database Webhook؟

`js/app.js:2273` يستدعيه بعد نجاح INSERT. البديل webhook من قاعدة البيانات يبدو أنظف،
لكن Webhook لا يحمل `Authorization` المستخدم → لا تستطيع التحقق من الهوية → تضطر للثقة
بأي INSERT. الاستدعاء من العميل + تحقق داخلي = أأمن. التكلفة: مستخدم خبيث يستطيع
استدعاء `send-push` بنفسه — لكنه مقيد بفحصي 401/403، فلا يرسل إلا في محادثاته.

---

## المرحلة 9 — العمل دون اتصال (Offline + Outbox)

### 9.1 IndexedDB (`js/db.js`) — لماذا وليس localStorage؟

`localStorage` متزامن (يحجب الـ main thread)، نصي فقط، وحدّه ~5 MB. الرسائل مع مرفقات
ومعرّفات تحتاج كائناً وفهارس. `IndexedDB` غير متزامن ومفهرس.

```js
const STORES = {
  messages: "messages",           // keyPath: id, index: by_conversation
  conversations: "conversations", // keyPath: id
  contacts: "contacts",           // keyPath: id
  outbox: "outbox",               // keyPath: local_id (autoIncrement)
};
```

**الفهرس `by_conversation` على `conversation_id` هو ما يجعل فتح محادثة من الكاش فورياً** —
بدونه ستمسح كل الرسائل في كل المحادثات ثم تفلتر.

نمط المعاملات المكرر في كل الدوال:

```js
async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
```

> **فخ IndexedDB الشهير:** يجب إنشاء كل الـ object stores داخل `onupgradeneeded` فقط.
> ولو غيّرت البنية لاحقاً، ارفع `DB_VERSION` من 1 إلى 2 وأضف منطق الترحيل — وإلا
> سيبقى المستخدمون القدامى على البنية القديمة.

### 9.2 Outbox — الإرسال المؤجَّل

```
offline؟ ── نعم ──► queueOutboxMessage(msg) ──► IndexedDB (outbox)
     │                                              │
     لا                                     window 'online' event
     │                                              │
     ▼                                              ▼
INSERT إلى messages ────────◄──────── flushOutbox() بالترتيب
```

**أهم تفصيل: الترتيب.** `outbox` يستخدم `autoIncrement` على `local_id` — لذا `flushOutbox`
يجب أن يرسل **بترتيب الطابور**، لا بـ `Promise.all`. وإلا ستصل الرسائل مقلوبة.

**وثاني تفصيل: التكرار.** لو نجح INSERT لكن انقطعت الشبكة قبل الحذف من outbox،
ستُرسل الرسالة مرتين عند العودة. الحل: ولّد `client_message_id` (UUID) في العميل
واحفظه، واجعله `unique` في جدول `messages`، فالثانية تفشل بـ constraint ولا تتكرر.
(المشروع الحالي لا يفعل هذا — **فرصة تحسين**.)

### 9.3 `sw.js` — استراتيجيتا تخزين مختلفتان عن قصد

```js
if (request.mode === "navigate") {
  // Network-first: حاول الشبكة، ولو فشلت اعرض index.html المخزّن
  event.respondWith(fetch(request).then(r => { cache.put("./index.html", r.clone()); return r; })
                                .catch(() => caches.match("./index.html")));
  return;
}
if (isSupabase || !isSameOrigin) {
  // لا تخزّن أي استجابة من Supabase أو CDN — بيانات حيّة/مصادقة
  event.respondWith(fetch(request).catch(() => new Response(null, { status: 503 })));
  return;
}
if (isStaticAsset) {
  // Cache-first: الأصول لا تتغير كثيراً
  event.respondWith(caches.match(request).then(c => c || fetch(request).then(...)));
}
```

**القاعدة:** HTML = network-first (وإلا لن يرى المستخدم التحديثات أبداً).
الأصول الثابتة = cache-first (أسرع). **استجابات API = لا تخزين إطلاقاً** — تخزين
استجابة Supabase يعني أن مستخدماً قد يرى رسائل مستخدم آخر من الكاش على جهاز مشترك.

`isSupabase = url.hostname.endsWith(".supabase.co")` — لهذا بعد تغيير `SUPABASE_URL`
إلى مشروعك يبقى هذا الشرط صحيحاً تلقائياً (لأن كل مشاريع Supabase تنتهي بـ `.supabase.co`).

> 🔴 **`CACHE_NAME` هو مفتاح التحديث.** بعد أي تعديل على ملفات JS/CSS ارفع
> `"wa-clone-shell-v4"` إلى `v5`. `activate` يحذف كل الكاشات القديمة
> (`keys.filter(k => k !== CACHE_NAME)`) فيحصل المستخدمون على النسخة الجديدة.
> بدون هذا سيظلون على الكود القديم أياماً.

---

## المرحلة 10 — PWA

`manifest.json`:
```json
{
  "short_name": "محادثات",
  "name": "تطبيق المحادثات",
  "icons": [
    { "src": "icons/icon.png",  "type": "image/png", "sizes": "192x192" },
    { "src": "icons/icon1.png", "type": "image/png", "sizes": "512x512" }
  ],
  "start_url": "/index.html",
  "display": "standalone",
  "background_color": "#0d3b66",
  "theme_color": "#0d3b66"
}
```

- الأيقونة **512×512 إلزامية** للـ install prompt على أندرويد
- `display: standalone` يزيل شريط المتصفح فيبدو كتطبيق
- **`start_url` يجب أن يطابق مسار النشر.** على GitHub Pages المشروع في `/messi/`،
  فـ `"/index.html"` المطلق سيشير إلى جذر النطاق لا إلى `/messi/`. استخدم `"./index.html"`
  النسبي أو المسار الكامل الصحيح.
- نفس المشكلة في `firebase-messaging-sw.js`: `icon: "/icons/icon.png"` مطلق —
  على GitHub Pages يجب أن يكون `"./icons/icon.png"` أو `/messi/icons/icon.png`

**iOS شرط إضافي:** إشعارات FCM لا تعمل إلا بعد **تثبيت PWA على الشاشة الرئيسية**
(iOS 16.4+). فتح الموقع في Safari مباشرة = بلا إشعارات. هذه قيود Apple وليست خطأ في الكود.

---

## المرحلة 11 — النشر

### GitHub Pages (موجود مسبقاً في `.github/workflows/static.yml`)

1. **Settings → Pages → Source: `GitHub Actions`** ← خطوة يدوية إلزامية، بدونها يفشل الـ workflow
2. كل push إلى `main` ينشر تلقائياً
3. الرابط: `https://<user>.github.io/<repo>/`

**ملاحظات خاصة بـ Pages:**
- أضف ملفاً فارغاً اسمه `.nojekyll` في الجذر — وإلا يتجاهل Jekyll المجلدات التي تبدأ بـ `_`
- **HTTPS متاح تلقائياً** — وهذا إلزامي لأن Service Worker و`Notification` وFCM
  لا تعمل إلا في secure context (`js/push.js:73` يتحقق من `window.isSecureContext`)
- `partials/` يعمل بـ `fetch()` عادي

### البدائل
| المنصة | ميزة | ملاحظة |
|---|---|---|
| **Vercel / Netlify** | نطاق جذر (`/`) بلا بادئة مسار | أضف `_redirects` لو احتجت SPA routing |
| **Cloudflare Pages** | سريع عالمياً | انتبه لحد حجم الملفات |
| **Supabase Edge (Deno)** | نفس النطاق الخلفي | أقل ملاءمة لتطبيق استاتيكي |

**أي استضافة تعمل** — التطبيق ملفات ثابتة. المتطلب الوحيد: **HTTPS** + تقديم
`mime type` صحيح لـ `.js` (وإلا رفض المتصفح تحميل ES Module).

---

## المرحلة 12 — قائمة التحقق النهائية

### قاعدة البيانات
- [ ] `sql/schema.sql` نُفّذ (profiles + conversations + messages + reactions)
- [ ] `sql/fcm_and_rls.sql` نُفّذ (fcm_tokens + typing_status + chat_members + claim_fcm_token)
- [ ] RLS مفعّل على **كل** الجداول (تحقق: `select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace`)
- [ ] الجداول مضافة إلى `supabase_realtime` publication
- [ ] Buckets الثلاثة موجودة و`public = true`
- [ ] أسماء FK هي `conversations_user_id_fkey` و`conversations_admin_id_fkey` حرفياً
- [ ] مشرف واحد على الأقل `is_admin = true`

### الكود
- [ ] `js/config.js` — URL + anon key + ADMINS الخاصة بك
- [ ] `js/push.js` — firebaseConfig + VAPID_KEY
- [ ] `firebase-messaging-sw.js` — **نفس** firebaseConfig حرفياً
- [ ] `js/auth.js:97` — بريد المشرف العام
- [ ] `index.html` — og:image / og:url / title
- [ ] `manifest.json` — name / icons / start_url
- [ ] `sw.js` — `CACHE_NAME` برقم جديد
- [ ] `icons/` — أيقوناتك أنت

### Firebase / Edge Functions
- [ ] FCM V1 API مفعّلة
- [ ] Web Push certificate مولَّد
- [ ] `supabase secrets set` بالثلاثة متغيرات
- [ ] `supabase functions deploy send-push`
- [ ] `supabase functions deploy admin-delete-user`

### الاختبار
- [ ] تسجيل حساب جديد → صف في `profiles` أُنشئ تلقائياً
- [ ] المشرف يرى المستخدمين، والمستخدم يرى المشرفين
- [ ] رسالة تظهر فوراً في الطرف الآخر (Realtime)
- [ ] مؤشر «يكتب الآن…» يعمل
- [ ] رفع صورة/ملف/رسالة صوتية → تظهر في الطرف الآخر
- [ ] الرد على رسالة + التفاعل بإيموجي
- [ ] airplane mode → اكتب رسالة → أعد الشبكة → تُرسل
- [ ] «تفعيل إشعارات الجهاز» → صف في `fcm_tokens`
- [ ] صفّر التبويب → أرسل من جهاز آخر → **إشعار نظام يصل**
- [ ] اضغط الإشعار → يفتح المحادثة الصحيحة
- [ ] سجّل خروج → تأكد أن صف `fcm_tokens` **حُذف**
- [ ] ثبّت PWA على أندرويد وعلى iOS

---

## خلاصة: تسعة مبادئ تصنع هذا النمط

1. **الأمان في SQL، لا في JavaScript.** كل ما في المتصفح قابل للتعديل.
2. **`with check` مثل `using` أهمية** — بدونه يرقّي المستخدم نفسه.
3. **سمِّ قيود FK صراحة** عندما يكون أكثر من FK لنفس الجدول الهدف، وإلا فشل PostgREST embed.
4. **انقل المنطق الذرّي إلى دوال SQL** (`claim_fcm_token`) بدل ثلاث عمليات من العميل.
5. **عميلان في Edge Function:** anon للتحقق من الهوية، service_role للعمل بعدها.
6. **`filter` في Realtime ينقل التصفية للخادم** — لا تفلتر في JS ما يمكن فلتره في البث.
7. **Service Worker واحد لكل scope** — لهذا يوجد SW منفصل لـ FCM.
8. **رسائل FCM `data-only`** حتى يتحكم الـ SW بالعرض والبيانات.
9. **`CACHE_NAME` هو مفتاح التحديث** — ارفعه مع كل إصدار، وإلا بقي المستخدمون على القديم.

---

## ماذا بعد؟

أفكار للتطوير (مرتبة بالصعوبة):

| الصعوبة | الفكرة |
|---|---|
| 🟢 سهل | بحث فعلي في المحادثات والرسائل (الحقل موجود شكلياً فقط) |
| 🟢 سهل | ضغط الصور قبل الرفع (`createImageBitmap` + canvas) |
| 🟡 متوسط | `client_message_id` لمنع تكرار رسائل الـ Outbox |
| 🟡 متوسط | تحويل المرفقات إلى Signed URLs (خصوصية كاملة) |
| 🟡 متوسط | مولّد إعدادات موحّد (`scripts/inject-config.mjs`) |
| 🔴 صعب | محادثات جماعية حقيقية (إعادة تصميم `conversations` حول `chat_members`) |
| 🔴 صعب | مزامنة صراعات التعديل عند تحرير نفس الرسالة من جهازين دون اتصال |
| 🔴 صعب | تشفير طرف-إلى-طرف (يحتاج إدارة مفاتيح، ويفقد البحث والفهرسة) |
