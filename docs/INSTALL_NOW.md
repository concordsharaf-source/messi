# 🚀 الخطوات التنفيذية الآن — مشروع `jjamwoidjxrdovsoftbq`

> هذه صفحة عمل مؤقتة للخطوة الحالية. المراجع الكاملة في
> [`SWITCH_TO_YOUR_ACCOUNTS.md`](SWITCH_TO_YOUR_ACCOUNTS.md).

---

## ✅ ما تم التحقق منه في مشروعك الجديد

| الفحص | النتيجة |
|---|---|
| المشروع يستجيب وليس موقوفاً | ✔ نشط |
| مفتاح `sb_publishable_...` | ✔ صالح ويتبع نفس المشروع |
| مشروع نظيف (لا جداول ولا buckets) | ✔ لا تعارض مطلقاً |
| مزوّد الدخول بالبريد | ✔ مفعّل |
| Edge Functions | ⬜ غير منشورة (متوقع — لاحقاً) |

🔑 ملاحظة: المفتاح الذي أرسلته آمن (مصمّم للكود الأمامي). أما مفتاح `sb_secret_`
وكلمة مرور القاعدة والملف الخاص لـ Firebase = **لا تُرسل أبداً في محادثة**.

---

## 🔴 قبل أي شيء: إعدادان حرجان

### 1) أطفئ «Confirm email» — وإلا صار التطبيق معطوباً لكل مستخدم جديد

`js/app.js:476` ينفّذ `signUp` ثم `signIn` **فوراً** بعد التسجيل. وبما أن تأكيد
البريد مفعّل افتراضياً في أي مشروع جديد، يفشل تسجيل الدخول بخطأ
`Email not confirmed` → المستخدم يرى رسالة خطأ إنجليزية ويعتقد أن التطبيق مكسور.

```
Supabase → Authentication → Sign In / Providers → Email
  → Confirm email : OFF   ✅
Authentication → URL Configuration
  → Site URL : https://<اسم-حسابك>.github.io/messi/
```

### 2) استبدل إيميلات المشرفين القديمة

داخل `sql/schema.sql` توجد **إيميلات المالك السابق** في `is_admin_email`
و`is_super_admin_email`، ومنها `almgawell17@gmail.com` **كمشرف عام**. أي شخص
يسجّل بأحدها في مشروعك يصبح مشرفاً تلقائياً.

```sql
-- انسخ هذا بعد تشغيل schema.sql (استبدل الإيميلات بإيميلاتك)
create or replace function public.is_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_email, '')) in (
    'ADMIN_1@EXAMPLE.COM',
    'ADMIN_2@EXAMPLE.COM'
  );
$$;

create or replace function public.is_super_admin_email(p_email text)
returns boolean language sql immutable as $$
  select lower(coalesce(p_email, '')) = 'ADMIN_1@EXAMPLE.COM';
$$;
```

> لا تنسَ نفس الإيميل في الكود: `js/auth.js:97` الثابت `SUPER_ADMIN_EMAIL`.

---

## 🧱 تنفيذ قاعدة البيانات (خطوتان فقط)

```
Supabase → SQL Editor → New query

1) الصق كامل ملف  sql/schema.sql       → Run     (ينتظر: Success. No rows returned)
2) الصق كامل ملف  sql/fcm_and_rls.sql  → Run
```

**لماذا هذا الترتيب؟** `chat_members` في الملف الثاني يعمل
`references public.profiles(id)`، و`profiles` يُنشأ في الأول.

بعد النجاح، تحقق سريع في `Table Editor` أن هذه الجداول موجودة:

```
profiles · conversations · messages · message_reactions
typing_status · chat_members · fcm_tokens
```

وفي `Storage` ثلاثة buckets: `avatars` · `attachments` · `wallpapers`

---

## 🧪 لماذا يمكنك الوثوق بالملفين؟

شُغِّلا على PostgreSQL 17 بمحاكاة كاملة لبيئة Supabase واجتازا:

```
schema.sql      → 0 أخطاء
fcm_and_rls.sql → 0 أخطاء
الجداول في بث Realtime: 5
اختبارات RLS: 48 ناجح / 0 فاشل
```

وأثناء ذلك اكتُشفت وأُصلحت:

| # | المشكلة | الأثر لولا الإصلاح |
|---|---|---|
| 1 | `schema.sql` يحاول إضافة `typing_status` إلى البث قبل إنشائه | ❌ **فشل السكربت بالكامل** على مشروع جديد |
| 2 | سياسة `profiles` كانت تسمح للزوار (`anon`) برؤية صفوف المشرفين | كشف بريد/هاتف المشرفين لأي زائر |
| 3 | سياسات `fcm_tokens` كانت مفتوحة للزوار | قراءة رموز إشعارات غير مرتبطة بحساب |
| 4 | سياسة `chat_members` كانت `with check (auth.uid() = user_id)` فقط | 🔴 **ترقية صلاحيات**: أي مستخدم يُدخل نفسه في أي محادثة يعرف معرّفها بدور `admin` → يحصل على حذف الرسائل وقراءة المحادثة. الآن: الدور `member` حصراً، ويجب أن تكون طرفاً في المحادثة |

لإعادة الاختبار في أي وقت: `bash sql/tests/local_pg_up.sh` ثم
`rls_tests.sh` — التفاصيل في [`../sql/tests/README.md`](../sql/tests/README.md).

---

## ⬜ الخطوات التالية بعد SQL

1. مشروع Firebase + `firebaseConfig` + مفتاح VAPID
2. تعديل ملفات الكود (`config.js`, `push.js`, `firebase-messaging-sw.js`,
   `js/auth.js:97`, `index.html:12-13`) + رفع `CACHE_NAME` في `sw.js`
3. نشر Edge Functions وضبط أسرارها
4. إنشاء أول حساب وترقيته مشرفاً · ثم اختبار رسالة وإشعار
