# دليل تحويل التطبيق إلى حساباتك + خريطة تدفق البيانات

> هذا الملف يشرح: (1) بنية النظام وارتباطاته، (2) كل نقطة اتصال خارجية وما الذي يُرسل إليها،
> (3) **بالضبط** ما الذي تغيّره لتنقل التطبيق إلى مشروع Supabase وحساب Firebase الخاصين بك.
>
> للتعليم خطوة بخطوة من الصفر راجع: [`docs/BUILD_FROM_SCRATCH.md`](./BUILD_FROM_SCRATCH.md)

---

## 1. البنية العامة (Architecture)

التطبيق **Vanilla JS بدون أي build step** — لا webpack ولا vite. ملفات ES Modules تُحمَّل
مباشرة من المتصفح. هذا يعني أن «البناء» هو مجرد خادم استاتيكي.

```
┌────────────────────────────────────────────────────────────────────────┐
│                            المتصفح (العميل)                             │
│                                                                        │
│  index.html ──► js/app.js (4618 سطر، كل منطق الواجهة)                   │
│                   ├── js/supabaseClient.js  ◄── js/config.js (المفاتيح) │
│                   ├── js/auth.js      تسجيل/دخول/خروج                   │
│                   ├── js/push.js      Firebase SDK (modular)            │
│                   ├── js/db.js        IndexedDB (كاش + Outbox)          │
│                   └── js/i18n.js      عربي/إنجليزي                      │
│                                                                        │
│  sw.js                      App Shell cache (تسجيل في /)                │
│  firebase-messaging-sw.js   إشعارات الخلفية (تسجيل في scope منفصل)       │
└───────────┬──────────────────────────────────┬─────────────────────────┘
            │                                  │
            │ Supabase JS (من CDN)             │ Firebase JS (من gstatic)
            ▼                                  ▼
┌───────────────────────────────┐   ┌──────────────────────────────────┐
│         SUPABASE              │   │           FIREBASE               │
│                               │   │                                  │
│  Auth      (بريد/كلمة مرور)    │   │  Cloud Messaging (FCM v1)        │
│  Postgres  7 جداول + RLS      │   │    └─ توكنات الأجهزة              │
│  Realtime  postgres_changes   │   │                                  │
│  Storage   3 buckets عامة      │   │  ⚠️ لا Auth ولا Firestore ولا     │
│  Edge Fn   send-push          │   │     Storage مستخدم منها إطلاقاً    │
│            admin-delete-user  │   │                                  │
└───────────────────────────────┘   └──────────────────────────────────┘
```

**الفكرة المحورية:** كل البيانات والجلسات في Supabase. Firebase مستخدم **فقط** كقناة توصيل
إشعارات (بديل عن Web Push/VAPID). لا يوجد أي تخزين في Firebase.

---

## 2. خريطة تدفق البيانات — من يرى ماذا؟

### 2.1 إلى Supabase (مشروعك أنت — تحت سيطرتك الكاملة)

| العنصر | الاسم الحرفي في الكود | أين يُستخدم |
|---|---|---|
| **جداول** | `profiles` | الاسم، الصورة، آخر ظهور، `is_admin`, `is_super_admin` |
| | `conversations` | `user_id` + `admin_id` + `last_message` |
| | `messages` | النص، المرفق، الرد، الحالة (sent/delivered/read) |
| | `message_reactions` | تفاعلات الإيموجي |
| | `typing_status` | مؤشر «يكتب الآن…» |
| | `chat_members` | أدوار الأعضاء داخل المحادثة |
| | `fcm_tokens` | توكن جهاز كل مستخدم |
| **دوال RPC** | `claim_fcm_token(user_id, token, platform)` | ربط التوكن ذرّياً |
| | `delete_message_as_moderator(message_id)` | حذف رسالة كمشرف |
| | `remove_chat_member(...)` | إزالة عضو |
| **Storage buckets** | `avatars`, `attachments`, `wallpapers` | يجب أن تكون **public** |
| **Edge Functions** | `send-push`, `admin-delete-user` | تُستدعى بـ `functions.invoke()` |
| **Realtime channels** | `messages:{id}`, `typing:{id}`, `reactions:{id}`, `inbox-updates`, `global-messages-watch`, `presence:global` | قنوات فورية |

### 2.2 إلى Firebase / Google (طرف ثالث ⚠️)

هذا هو **أهم قسم للخصوصية**:

| ما يُرسل | إلى أين | من أين في الكود |
|---|---|---|
| **نص الرسالة الكامل** (`record.content`) | `fcm.googleapis.com/v1/projects/{id}/messages:send` | `supabase/functions/send-push/index.ts:69` |
| معرّفات: `conversationId`, `senderId`, `messageId` | نفسها | `send-push/index.ts:78-84` |
| طلب تسجيل توكن الجهاز | `fcmregistrations.googleapis.com` عبر SDK | `js/push.js:125` |
| تحميل مكتبات Firebase | `www.gstatic.com/firebasejs/10.8.0/...` | `js/push.js:5,6` و`firebase-messaging-sw.js:1` |

> **الخلاصة الأمنية:** أي رسالة تُرسل ومستلمها **في الخلفية** يمر نصها الصريح عبر خوادم Google.
> الرسائل في وضع foreground لا تمر عبر FCM (تصل عبر Supabase Realtime مباشرة).
> لو هذا غير مقبول لك، البديل في القسم 7 أدناه.

### 2.3 CDN خارجية (تحميل كود فقط — لا بيانات مستخدم)

| الرابط | الوظيفة | الملف |
|---|---|---|
| `cdn.jsdelivr.net/npm/@supabase/supabase-js@2` | مكتبة Supabase (تُنشئ `window.supabase`) | `index.html:20` |
| `www.gstatic.com/firebasejs/10.8.0/*` | مكتبات Firebase (modular + compat) | `js/push.js`, `firebase-messaging-sw.js` |
| `deno.land/std@0.168.0`, `esm.sh/*` | استيراد Deno داخل Edge Functions (تعمل على خوادم Supabase) | `supabase/functions/*/index.ts` |

> ⚠️ **مخاطرة:** الإصدارات غير مثبّتة (`@supabase/supabase-js@2` بدون رقم دقيق). لو تعطل CDN
> أو تغيّر API سيتعطل التطبيق. التحصين في القسم 7.

### 2.4 تخزين محلي داخل جهاز المستخدم (لا يغادر الجهاز)

| المخزن | المحتوى | الملف |
|---|---|---|
| `localStorage` | `fcm_token`, `fcm_user_id`, اللغة، الثيم، جلسة Supabase (تلقائياً) | `js/push.js` |
| `IndexedDB` (`wa_clone_db`) | `messages`, `conversations`, `contacts`, `outbox` — للعمل دون اتصال | `js/db.js` |
| Cache Storage (`wa-clone-shell-v4`) | App Shell: HTML/CSS/JS/أيقونات/صوت | `sw.js` |

### 2.5 روابط قديمة متبقية من المشروع الأصلي (يجب تغييرها)

| الرابط | الملف | الأثر |
|---|---|---|
| `https://whatsapp-web-app-gules.vercel.app/icons/icon.png` | `index.html:12` (`og:image`) | معاينة المشاركة عند نشر الرابط تُظهر صورة من نطاق شخص آخر |
| `https://whatsapp-web-app-gules.vercel.app/` | `index.html:13` (`og:url`) | نفس المشكلة |

---

## 3. 🎯 قائمة التغيير — انقل التطبيق إلى حساباتك

### 3.1 جدول الملخص (كل القيم المطلوب استبدالها)

| # | القيمة الحالية (القديمة) | الموقع | البديل |
|---|---|---|---|
| 1 | `https://eqzmvhwyfpoopqascgox.supabase.co` | `js/config.js:4` | Project URL من مشروعك |
| 2 | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVxem12aHd5...` | `js/config.js:5` | `anon public` key من مشروعك |
| 3 | 6 إيميلات مشرفين | `js/config.js:9-16` | إيميلاتك |
| 4 | `BAxTu3HSXPEgeTyTRPoXvpkLQWu8llJQfsPEoUr0MDjHKRJ0VSzPFcJw5RFv-s6BTnZYeWEHW8NSQzAjfOxoJfo` | `js/config.js:7` | **احذفه** — متغير ميت غير مستخدم |
| 5 | `firebaseConfig` (6 حقول) | `js/push.js:18-25` | إعدادات تطبيق الويب في مشروعك |
| 6 | `VAPID_KEY` = `BGKcsJH4YH7vV384UCmx_FKD0xGiWTNuMA7skLLUWzIodKXTSFLRleq1K0ttPMnXZfzQO42bQig8nSKTSIw1jts` | `js/push.js:33-34` | مفتاح Web Push من Firebase console |
| 7 | `firebaseConfig` **نسخة مكررة** | `firebase-messaging-sw.js:13-20` | **يجب أن تتطابق حرفياً مع #5** |
| 8 | `almgawell17@gmail.com` (مشرف عام مكتوب في الكود) | `js/auth.js:97` | بريدك |
| 9 | روابط Vercel القديمة | `index.html:12,13` | نطاقك |
| 10 | قائمة المشرفين داخل SQL | `sql/schema.sql` (دالة `is_admin_email`) | نفس إيميلات #3 |
| 11 | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | **أسرار Supabase** (ليست في Git) | من Service Account في مشروعك |

> 🔴 **#5 و #7 يجب أن يكونا متطابقين تماماً.** هذا كان سبب عطل
> `ServiceWorker script evaluation failed` المذكور في README.

### 3.2 الخطوة 1 — أنشئ مشروع Supabase

1. https://supabase.com → **New project** → اختر Organization، اسم المشروع، **كلمة مرور قوية لقاعدة البيانات** (احفظها)، والمنطقة الأقرب لمستخدميك.
2. انتظر دقيقة حتى يكتمل التجهيز.
3. **Settings → API** — انسخ ثلاثة أشياء:
   - `Project URL` → هذا هو `SUPABASE_URL`
   - `anon` `public` key → هذا هو `SUPABASE_ANON_KEY`
   - `service_role` `secret` key → **لا تضعه في أي ملف JS أبداً**، يُستخدم فقط كأسر في Edge Functions

> ملاحظة: في مشاريع Supabase الجديدة قد تجد قسم **API Keys** يعرض مفاتيح بصيغة `sb_publishable_...`
> و`sb_secret_...` بدلاً من JWT الطويل. كلا الشكلين يعمل مع `createClient()` — ضع الـ *publishable*
> مكان `SUPABASE_ANON_KEY` والـ *secret* مكان `SUPABASE_SERVICE_ROLE_KEY`.

### 3.3 الخطوة 2 — نفّذ SQL بالترتيب

في **SQL Editor**:

```
1) الصق محتوى  sql/schema.sql        → Run
   (ينشئ profiles + conversations + messages + reactions
    + FKs بالأسماء المطلوبة + Trigger + Buckets + RLS + Realtime)

2) الصق محتوى  sql/fcm_and_rls.sql   → Run
   (ينشئ fcm_tokens + typing_status + chat_members
    + claim_fcm_token + سياسات RLS التفصيلية)
```

**لماذا الترتيب مهم؟** `chat_members` في الملف الثاني يعمل `references public.profiles(id)`،
و`profiles` يُنشأ في الملف الأول. لو عكست الترتيب يفشل التنفيذ.

> 🔴 **قبل التشغيل أو بعده مباشرةً — لا تترك قائمة المشرفين القديمة.**
> الملف يحتوي على **إيميلات المالك السابق** داخل `is_admin_email` و
> `is_super_admin_email`، ومنها `almgawell17@gmail.com` كـ **مشرف عام**.
> من يسجّل بأحد هذه الإيميلات في مشروعك يصبح مشرفاً تلقائياً. استبدلها بإيميلاتك:

```sql
-- استبدل القائمة بإيميلاتك أنت
create or replace function public.is_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_email, '')) in (
    'admin1@example.com',
    'admin2@example.com'
  );
$$;

create or replace function public.is_super_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_email, '')) = 'admin1@example.com';
$$;
```

وإن سبق أن سجّلت حسابات، ثبّت الصلاحيات على صفوفها مباشرةً:

```sql
update public.profiles set is_admin = true where lower(email) in ('admin1@example.com');
update public.profiles set is_admin = true, is_super_admin = true
 where lower(email) = 'admin1@example.com';
```

> ⚠️ ولا تنسَ تعديل نفس الإيميل في الكود: `js/auth.js` السطر **97**
> (الثابت `SUPER_ADMIN_EMAIL`) — وإلا بقيت واجهتك تعتبر إيميلاً آخر مشرفاً عاماً.

### ✅ الملفات مُختبرة فعلياً

`sql/schema.sql` و`sql/fcm_and_rls.sql` شُغِّلا ونُفِّذا على PostgreSQL 17 مع
محاكاة كاملة لبيئة Supabase، واجتازا **43 اختباراً سلوكياً** (عزل المحادثات،
منع تصعيد الصلاحيات، عزل التخزين، حماية الرموز، سلوك الزوار). التفاصيل
وطريقة إعادة التشغيل في `sql/tests/README.md`.

> 🛡️ **ثغرة ترقية صلاحيات كانت مكتشفة ومُغلقة:** سياسة `chat_members` الأصلية
> كانت تسمح لأي مستخدم مصادَق عليه بإدخال نفسه في أي محادثة **بدور `admin`**
> بمجرد معرفة معرّفها (`with check (auth.uid() = user_id)` فقط، والعمود `role`
> بلا قيد). النتيجة: `is_chat_moderator()` ترجع true → حذف رسائل المحادثة
> وقراءتها. الإصلاح في `sql/fcm_and_rls.sql` يشترط `role = 'member'` وكون
> المستخدم طرفاً في المحادثة.

### 3.4 الخطوة 3 — اضبط Authentication

**Authentication → Sign In / Providers → Email** :
- ✅ فعّل **Email** provider
- 🔴 **أطفئ «Confirm email» — إلزامي لهذا التطبيق بالذات.**
  السبب في الكود: `js/app.js:476` ينفّذ `signUp` ثم `signIn` **فوراً**.
  وبما أن التأكيد مفعّل افتراضياً في أي مشروع جديد، يفشل `signIn` بخطأ
  `Email not confirmed` → **كل مستخدم جديد يرى التطبيق معطوباً.**
  والأسوأ: بريد Supabase المدمج محدود ببضع رسائل في الساعة، فلا يصلح لتأكيد
  حسابات مجموعة. (البديل إن أردت التأكيد: SMTP مخصّص عبر Resend/Brevo المجاني،
  مع تعديل الكود ليعرض «راجع بريدك» بدل تسجيل الدخول الفوري.)
- أثناء التطوير فقط: عطّل **Rate limits** إن ظهرت أخطاء عند التجربة المتكررة
- **Authentication → URL Configuration**: ضع `Site URL` = نطاق نشرك النهائي
  (مثلاً `https://username.github.io/messi/`)، وأضف Redirect URLs إن لزم

### 3.5 الخطوة 4 — أنشئ مشروع Firebase

1. https://console.firebase.google.com → **Add project**
2. داخل المشروع: **⚙️ Project settings → General → Your apps → `</>` (Web)**
   → سجّل تطبيق ويب → انسخ كائن `firebaseConfig` كاملاً
3. **Project settings → Cloud Messaging**:
   - تأكد أن **Firebase Cloud Messaging API (V1)** مفعّلة
   - في **Web Push certificates** → اضغط **Generate key pair** → انسخ المفتاح
     → هذا هو `VAPID_KEY`
4. **لأسرار Edge Function** (Service Account):
   - **Project settings → Service accounts → Generate new private key**
   - ينزّل ملف JSON — منه خذ:
     - `project_id` → `FIREBASE_PROJECT_ID`
     - `client_email` → `FIREBASE_CLIENT_EMAIL`
     - `private_key` → `FIREBASE_PRIVATE_KEY`
   - 🔒 **هذا الملف هو أخطر شيء في المشروع كله.** لا ترفعه على Git أبداً. احذفه من جهازك بعد الاستخدام.

### 3.6 الخطوة 5 — انشر Edge Functions وضبط الأسرار

ثبّت CLI وسجّل الدخول:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <ref>       # الـ ref هو الجزء من الرابط:
                                        # https://<ref>.supabase.co
```

اضبط الأسرار:

```bash
supabase secrets set \
  FIREBASE_PROJECT_ID="your-project-id" \
  FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com" \
  FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```

> `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` تُحقن تلقائياً
> من Supabase داخل كل Edge Function — لا تحتاج ضبطها.
>
> انتبه لـ `\n` داخل المفتاح الخاص: الكود يعمل `.replace(/\\\\n/g, "\\n")`
> في `send-push/index.ts:11` لتحويلها لأسطر حقيقية، فإما تمرّرها كـ `\n` حرفية
> أو كأسطر حقيقية مباشرة.

انشر الوظيفتين:

```bash
supabase functions deploy send-push --no-verify-jwt
supabase functions deploy admin-delete-user --no-verify-jwt
```

> الكود يتحقق من هوية المستخدم **داخلياً** عبر `userClient.auth.getUser()` باستخدام
> ترويسة `Authorization` التي يمررها `functions.invoke()` تلقائياً، لذا `--no-verify-jwt`
> مناسب. لو فضّلت التحقق على مستوى المنصة، احذف العلم — لكن تأكد حينها أن
> `invoke` يرسل توكن المستخدم وليس توكن الخدمة.

### 3.7 الخطوة 6 — عدّل ملفات الكود

**`js/config.js`** (الملف كاملاً بعد التعديل):

```js
export const SUPABASE_URL = "https://<ref>.supabase.co";
export const SUPABASE_ANON_KEY = "<anon أو publishable key>";

// قائمة المشرفين — يجب أن تطابق is_admin_email في sql/schema.sql
export const ADMINS = [
  { email: "you@example.com", name: "اسمك" },
];

export function isAdminEmail(email) {
  return ADMINS.some((a) => a.email.toLowerCase() === (email || "").toLowerCase());
}
```

**`js/push.js`** — السطور 18-34:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "<project-id>.firebaseapp.com",
  projectId: "<project-id>",
  storageBucket: "<project-id>.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};

const VAPID_KEY = "B...";   // من Web Push certificates
```

**`firebase-messaging-sw.js`** — السطور 13-20: الصق **نفس** `firebaseConfig` حرفياً.

**`js/auth.js`** — السطر 97 (المشرف العام المكتوب في الكود):

```js
// قبل
is_super_admin: Boolean(profile.is_super_admin || (normalizedEmail === "almgawell17@gmail.com")),
// بعد — الأفضل الاعتماد على القاعدة فقط وحذف البريد المكتوب
is_super_admin: Boolean(profile.is_super_admin),
```

**`index.html`** — السطران 12 و13:

```html
<meta property="og:image" content="https://<نطاقك>/icons/icon.png" />
<meta property="og:url" content="https://<نطاقك>/" />
```

### 3.8 الخطوة 7 — نظّف ما بعد التبديل

| الإجراء | السبب |
|---|---|
| احذف `VAPID_PUBLIC_KEY` من `js/config.js` | متغير ميت — لا يستورده أحد، ويوحي خطأً أنه المستخدم |
| بدّل `icons/icon.png` و`icon1.png` و`notify.mp3` | أصول المشروع القديم (594 KB + 144 KB + 65 KB) |
| عدّل `manifest.json` (`name`, `short_name`, `theme_color`) | ما زال «خدمة تواصل - فريق الدعم» |
| عدّل `<title>` و`og:title` في `index.html` | «محادثات» / «محادثات فريق الدعم» |
| **دوّر المفاتيح القديمة** | المفاتيح القديمة ما زالت في سجل Git (`git log -p`). إن كان المشروع الأصلي حساساً، احذف/أعد توليد `anon key` من Supabase القديم و`Web Push certificate` من Firebase القديم |
| ارفع `sql/schema.sql` للمستودع | كان مفقوداً — أُعيد بناؤه الآن |

---

## 4. اختبار سريع بعد التحويل

```bash
# 1) شغّل محلياً (ES Modules لا تعمل من file://)
python3 -m http.server 8080
# افتح http://localhost:8080

# 2) في Console تحقق من الاتصال
#    لا يجب أن ترى: "Invalid login credentials" أو "relation public.profiles does not exist"

# 3) سجّل حساباً → تحقق في Supabase → Table Editor → profiles أن صفاً أُنشئ تلقائياً

# 4) أرسل رسالة → تحقق من جدول messages

# 5) الإعدادات ⚙️ → تفعيل إشعارات الجهاز → تحقق من جدول fcm_tokens
```

| العطل | السبب المرجّح |
|---|---|
| `relation "public.profiles" does not exist` | لم تشغّل `sql/schema.sql` |
| `Could not find the 'public.profiles.id' column` / فشل Join | أسماء FK مختلفة عن `conversations_user_id_fkey` |
| الصور لا تظهر بعد الرفع | الـ bucket ليس `public`، أو سياسة `own_folder_insert` تمنع الكتابة |
| `claim_fcm_token غير متاح` في Console | لم تشغّل `sql/fcm_and_rls.sql` (سيعمل مسار احتياطي أبطأ) |
| `ServiceWorker script evaluation failed` | `firebaseConfig` في `firebase-messaging-sw.js` مبتور أو مختلف عن `push.js` |
| الإشعارات لا تصل في الخلفية | أسرار Firebase غير مضبوطة، أو FCM V1 API غير مفعّلة |
| `new row violates row-level security` على `messages` | `sender_id` لا يساوي `auth.uid()` أو لست مشاركاً في المحادثة |
| الموقع يعمل لكن بعد التعديل لا يتغير شيء | `sw.js` يخدم نسخة مخزّنة — بدّل `CACHE_NAME` من `v4` إلى `v5` |

> ⚠️ آخر نقطة مهمة جداً: `sw.js` يخزّن `js/config.js` ضمن App Shell. بعد أي تعديل على
> المفاتيح **يجب** رفع رقم `CACHE_NAME` (السطر 1) وإلا سيبقى المستخدمون على النسخة القديمة.

---

## 5. تدفق رسالة واحدة من الطرف إلى الطرف (للفهم العميق)

```
1. المستخدم يكتب → js/app.js: sendMessage()
2. (إن كان offline) → js/db.js: queueOutboxMessage() → IndexedDB
   ويرسل لاحقاً عند حدث online
3. INSERT إلى public.messages  ← RLS يتحقق أنك مشارك في المحادثة
4. Trigger trg_sync_conversation_members (fcm_and_rls.sql:114)
   → يحدّث last_message / last_message_at في conversations
5. Supabase Realtime يبث postgres_changes إلى قناة messages:{id}
   → الطرف الآخر (foreground) يستلم فوراً ويعرضها
6. بالتوازي: js/app.js:2273 → functions.invoke("send-push")
7. send-push/index.ts:
   a. يتحقق أن auth.uid() === record.sender_id   (401 إن لم يتطابق)
   b. يتحقق أن المرسل مشارك في المحادثة          (403 إن لم يكن)
   c. يجلب توكنات الطرف الآخر من fcm_tokens (بـ service_role)
   d. يستخرج access token من Google عبر JWT + Service Account
   e. POST إلى fcm.googleapis.com/v1/.../messages:send  (رسالة data-only)
8. firebase-messaging-sw.js (جهاز الطرف الآخر، التطبيق في الخلفية)
   → messaging.onBackgroundMessage() → showNotification()
   → منعا للتكرار: wasRecentlyHandled(messageId) بـ 60 ثانية
9. الضغط على الإشعار → notificationclick → postMessage({type:"OPEN_CONVERSATION"})
   → js/app.js:156 يستمع ويفتح المحادثة
```

**نقطة تصميمية ذكية هنا:** الرسائل `data-only` (بدون `notification` block)، فلا يعرضها
المتصفح تلقائياً، بل يعرضها الـ Service Worker — وهذا يمنع ازدواجية الإشعار.

---

## 6. نموذج الصلاحيات (من يرى ماذا)

| الدور | كيف يُحدد | ماذا يرى |
|---|---|---|
| **مستخدم عادي** | `is_admin = false` | المشرفين الستة فقط + محادثاته معهم |
| **مشرف** | `is_admin = true` (من `is_admin_email()` في الـ Trigger) | بقية المشرفين + المحادثات التي `admin_id = id` الخاص به |
| **مشرف عام** | `is_super_admin = true` | **كل** المحادثات و**كل** المشرفين، مع شارة باسم المشرف الأصلي |

المنطق في `js/app.js:969-975` (فلترة القائمة) + سياسات RLS في `sql/schema.sql`
و`sql/fcm_and_rls.sql` (المنع الفعلي على مستوى قاعدة البيانات).

> **الأمان الحقيقي في RLS وليس في JavaScript.** فلترة الواجهة قابلة للتجاوز من Console؛
> سياسات RLS ليست كذلك. لهذا لا تعطّل RLS «لتسهيل التطوير».

---

## 7. تحسينات مقترحة (اختيارية)

### 7.1 إيقاف تسريب نص الرسائل إلى Google
بدّل في `send-push/index.ts:69`:

```ts
// قبل — يرسل النص الكامل
const body = record.content || (...);

// بعد — يرسل تنبيهاً عاماً فقط، والنص يُجلب من Supabase عند الفتح
const body = "رسالة جديدة";
```

التكلفة: الإشعار لن يعرض معاينة الرسالة. الفائدة: لا شيء من محتوى المحادثات يغادر
خوادمك. (لاحظ أن `content` ما زال يُرسل ضمن `record` من العميل — الأفضل حذفه من
الـ payload كلياً في `js/app.js:2274`.)

### 7.2 تثبيت إصدارات الـ CDN
```html
<!-- قبل -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<!-- بعد -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
```
أو الأفضل: نزّل المكتبة محلياً في `js/vendor/` لتصبح مستقلاً تماماً عن أي CDN.

### 7.3 نقل كل المفاتيح إلى ملف واحد
حالياً `firebaseConfig` مكرر في ملفين و`VAPID` في مكانين. الحل: أنشئ
`firebase-config.js` (module) و`firebase-messaging-sw.js` يستورده… لكن Service Worker
الكلاسيكي لا يدعم ES Modules، لذا الحل العملي هو **مولّد**: سكربت `scripts/inject-config.mjs`
يقرأ `config.json` واحد ويكتب القيم في الملفين تلقائياً قبل النشر. قل لي وأكتبه لك.

### 7.4 إضافة `.env.example` وتوثيق الأسرار
لا توجد أسرار في Git حالياً (كل شيء عبر `Deno.env`) — وهذا وضع سليم يجب الحفاظ عليه.

---

## 8. ملاحظات على الجودة الأمنية للكود الحالي

| الملاحظة | الخطورة | التفصيل |
|---|---|---|
| `admin-delete-user` يقرأ `userId` **بعد** التحقق من الصلاحيات لكن **بعد** `await req.json()` مستهلك مسبقاً | 🟡 متوسطة | `supabase/functions/admin-delete-user/index.ts:24` — `req.json()` يُستدعى مرة واحدة فقط، والكود يستدعيه في السطر 24. سليم حالياً، لكن أي تعديل يضيف قراءة أخرى للـ body سيفشل |
| `send-push` يثق بـ `record` القادم من العميل | 🟢 منخفضة | محمي بفحصين: `actor.id === record.sender_id` و`actor ∈ {user_id, admin_id}` — جيد |
| CORS = `*` في الوظيفتين | 🟡 متوسطة | مقبول لأن المصادقة عبر `Authorization` وليس عبر Origin، لكن الأفضل تقييده بنطاقك |
| بريد المشرف العام مكتوب في `js/auth.js:97` | 🟡 متوسطة | ليس ثغرة بحد ذاته (RLS هو الحَكَم)، لكنه تسريب معلومات + يعطي صلاحية لو سُجّل هذا البريد |
| `profiles_update_self_no_escalation` | 🟢 | أضفتها في `schema.sql` لمنع مستخدم من ترقية نفسه بـ `update profiles set is_admin=true` |
| buckets عامة القراءة | 🟡 | أي شخص يملك الرابط العام يفتح المرفق. لو تريد خصوصية، بدّل إلى **Signed URLs** (`createSignedUrl`) و`public=false` |

---

## 9. ما الذي أستطيع تنفيذه لك الآن؟

- [ ] تغيير كل القيم في الكود إلى مفاتيحك (أرسلها لي وأنفّذ + أدفع)
- [ ] كتابة `scripts/inject-config.mjs` لتوحيد `firebaseConfig` في مصدر واحد
- [ ] تنفيذ تحسين 7.1 (إخفاء نص الرسائل عن Google)
- [ ] تحويل المرفقات إلى Signed URLs بدلاً من buckets عامة
- [ ] تشغيل التطبيق محلياً هنا في مساحة العمل لتجربته مباشرة
- [ ] تفعيل GitHub Pages والتحقق من النشر الحيّ
