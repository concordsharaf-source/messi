# ✅ حالة التطبيق — جاهز للاختبار على الجهاز

> المشروع: `jjamwoidjxrdovsoftbq` (Supabase) · `messenger-4f50d` (Firebase)
> الكود مدفوع: `3629dd1`

---

## 📊 كل ما تم إنجازه

### قاعدة البيانات (على مشروعك مباشرةً)

| البند | الحالة |
|---|---|
| `schema.sql` + `fcm_and_rls.sql` | ✅ نُفِّذا بلا أخطاء |
| 7 جداول · 37 سياسة RLS | ✅ كلها مفعّلة |
| 3 buckets (`avatars` · `attachments` · `wallpapers`) | ✅ |
| بث Realtime | ✅ 5 جداول |
| Trigger على `auth.users` | ✅ إنشاء `profiles` تلقائياً |
| تأكيد البريد | ✅ مُطفأ (شرط عمل التسجيل) |
| إيميلات المالك السابق | ✅ مُزالة |
| قائمة مشرفيك | ✅ محفوظة في مشروعك (لا في المستودع العام) |

### الكود

| الملف | الحالة |
|---|---|
| `js/config.js` | ✅ مشروعك + مفتاحك · قائمة المشرفين أُزيلت |
| `js/push.js` | ✅ `firebaseConfig` + `VAPID_KEY` + مسارات SW مصلحة |
| `firebase-messaging-sw.js` | ✅ نفس `firebaseConfig` حرفياً (مُتحقَّق آلياً) |
| `js/app.js` · `js/auth.js` | ✅ الصلاحيات من قاعدة البيانات فقط |
| `sw.js` | ✅ `CACHE_NAME = v8` |
| `index.html` | ✅ روابط المعاينة إلى نطاقك |

### Edge Functions — منشورة وتعمل

```
send-push          | ACTIVE | v2
admin-delete-user  | ACTIVE | v1
```

### اختبار حقيقي من الطرف إلى الطرف (نُفِّذ ثم نُظّف)

| الاختبار | النتيجة |
|---|---|
| تسجيل حساب + دخول فوري | ✅ |
| الـ Trigger أنشأ `profiles` | ✅ |
| الصلاحيات بعد التسجيل | ✅ `false` — الثقب مُغلق |
| إنشاء محادثة + عضوية تلقائية | ✅ |
| إرسال رسالة | ✅ |
| استدعاء `send-push` فعلياً | ✅ `{"sent":0}` = المصادقة والتحقق يعملان |
| انتحال مرسل آخر | ✅ مرفوض `401` |
| القاعدة بعد التنظيف | ✅ صفر صفوف |

**اختبارات المخطط: 66 ناجح / 0 فاشل** (`bash sql/tests/rls_tests.sh`)

---

## 🛡️ تسعة إصلاحات مُكتشفة ومُختبرة

| # | المشكلة | الأثر لولا الإصلاح |
|---|---|---|
| 1 | `typing_status` يُضاف للبث قبل إنشائه | ❌ **فشل السكربت بالكامل** |
| 2 | سياسة `profiles` تكشف بيانات المشرفين للزوار | تسريب بريد/هاتف |
| 3 | سياسات `fcm_tokens` مفتوحة للزوار | تسريب رموز |
| 4 | `chat_members` بلا قيد على الدور | 🔴 ترقية صلاحيات ذاتية |
| 5 | `profiles_insert_self` بلا قيد على الأعلام | ادّعاء `is_admin` |
| 6 | الواجهة تمنح الإشراف من `js/config.js` | أي إيميل في الكود يرى لوحة المشرف |
| 7 | الـ Trigger يمنح الإشراف تلقائياً بالبريد | 🔴🔴 **الاستيلاء على المشرف العام** |
| 8 | `messages.sender_id` بلا `CASCADE` | فشل حذف أي مستخدم أرسل رسالة |
| 9 | مسارات SW مطلقة (`/...`) في `push.js` | 🔴 **فشل الإشعارات كلياً على GitHub Pages** |

### تفصيل الإصلاح 9 (الأحدث)

```js
// قبل — يفشل تحت /messi/:
const FIREBASE_SW_PATH  = "/firebase-messaging-sw.js";
// يشير إلى https://concordsharaf-source.github.io/firebase-messaging-sw.js ← 404
const FIREBASE_SW_SCOPE = "/firebase-cloud-messaging-push-scope/";
// نطاق خارج ما يسمح به المتصفح ← SecurityError ← فشل التسجيل كلياً

// بعد — يعمل في الجذر والمسار الفرعي:
const APP_BASE = new URL("./", window.location.href);
const FIREBASE_SW_PATH  = new URL("firebase-messaging-sw.js", APP_BASE).href;
const FIREBASE_SW_SCOPE = new URL("firebase-cloud-messaging-push-scope/", APP_BASE).href;
```

---

## 🔴 المتبقي — خطوتان منك

### ① أسرار Firebase Admin في Supabase (شرط الإشعارات)

من Firebase: `⚙️ Project settings → Service accounts → Firebase Admin SDK → Generate new private key`
افتح ملف JSON الناتج بمفكرة النصوص، ثم في Supabase:

```
Dashboard → Edge Functions → Secrets → أضف ثلاثة أسرار:

  FIREBASE_PROJECT_ID    =  messenger-4f50d
  FIREBASE_CLIENT_EMAIL  =  ← قيمة client_email من الملف
  FIREBASE_PRIVATE_KEY   =  ← قيمة private_key كما هي بالضبط، بلا Enter داخلها
```

> 🔑 الكود يحوّل `\n` النصية بنفسه (`send-push/index.ts:11`) — الصقها كما تظهر.
> ⛔ لا ترسل ملف JSON أو محتواه في أي محادثة.

**بعد إضافتها أخبرني، وسأُجري اختباراً يُثبت أن مفاتيح Firebase صحيحة** — قبل أن تفتح التطبيق أصلاً.

### ② سجّل حسابات المشرفين

كل شخص يسجّل بنفس الإيميل المكتوب في قائمة مشرفيك (لا إيميل آخر):

```
admin@sharaf.com        ← المشرف العام (سجّله أولاً)
111@admin.com · 222@admin.com · 333@admin.com · 444@admin.com · 555@admin.com
```

ثم تُشغَّل الترقية (أنا أُشغّلها أو `sql/promote_admins.sql`).

> ⚠️ أي بريد في القائمة لا تملك صاحبه فعلاً = لا استعادة كلمة مرور له. إن كانت
> `111@admin.com`…`555@admin.com` أسماء مؤقتة، أزلها ودع كل شخص يسجّل ببريده الحقيقي.

---

## 🧪 اختبار الإشعارات (بعد الخطوتين)

1. افتح التطبيق على **الجوال** (HTTPS فقط — GitHub Pages كذلك)
2. سجّل الدخول → الإعدادات ⚙️ → **تفعيل إشعارات الجهاز** → اسمح بالإذن
3. تأكد بظهور صفك في `fcm_tokens` (أستطيع فحصه لك)
4. أرسل رسالة من حساب آخر → يجب أن يصل التنبيه

> 📱 على iPhone: لا تعمل الإشعارات في Safari إلا بعد **إضافة التطبيق إلى الشاشة
> الرئيسية** (iOS 16.4+). أندرويد وكروم تعمل مباشرة.
