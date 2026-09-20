# تشغيل Push والإدارة

بعد رفع هذا الإصدار، يجب نشر وظيفتي Supabase Edge Functions وتشغيل SQL مرة واحدة. لا تضع أي مفتاح خاص داخل Git أو داخل ملفات JavaScript.

## أسرار وظيفة Push

اضبط الأسرار في مشروع Supabase:

```bash
supabase secrets set \
  FIREBASE_PROJECT_ID="<firebase-project-id>" \
  FIREBASE_CLIENT_EMAIL="<firebase-service-account-email>" \
  FIREBASE_PRIVATE_KEY="<firebase-private-key-with-\\n-or-real-newlines>"
```

تحتاج وظيفة حذف المستخدم أيضًا إلى الأسرار القياسية التي يوفرها Supabase للوظائف، وبالأخص `SUPABASE_URL`, `SUPABASE_ANON_KEY`, و`SUPABASE_SERVICE_ROLE_KEY`.

## نشر الوظائف

```bash
supabase functions deploy send-push
supabase functions deploy admin-delete-user
```

يتم استدعاء `send-push` من التطبيق بعد نجاح `INSERT` على `messages`. لذلك لا يلزم Webhook إضافي لهذا المسار، وتبقى صلاحية Service Role داخل الوظيفة فقط.

## قاعدة البيانات

شغّل `sql/fcm_and_rls.sql` في SQL Editor. هذا ينشئ جدول توكنات FCM ويضيف سياسة حذف الرسائل للمشرفين. حذف حساب المستخدم الكامل يتم داخل `admin-delete-user` بعد التحقق من هوية المشرف، ولا ينبغي تنفيذه من المتصفح مباشرة.

## اختبار الهاتف

يجب فتح الموقع عبر HTTPS، تسجيل الدخول من الهاتف، الضغط على «تفعيل إشعارات الجهاز» ومنح إذن الإشعارات، ثم التأكد من وجود التوكن في `fcm_tokens`. أرسل رسالة من جهاز آخر مع تصغير التطبيق أو إغلاق الصفحة. يجب ظهور إشعار نظام مع صوت الإشعار الافتراضي للنظام واهتزاز الجهاز بحسب إعدادات الهاتف. عند الضغط على الإشعار، يجب فتح المحادثة المرتبطة به.

في وضع foreground يستخدم التطبيق الملف `icons/notify.mp3` للصوت المحلي. أما في الخلفية، فالصوت يحدده نظام التشغيل والمتصفح ولا تسمح Web Notifications بفرض ملف صوت مخصص بصورة متوافقة مع جميع الهواتف؛ لذلك يجب عدم كتم قناة الإشعارات على الجهاز.

## تنبيه أمني

المفتاح الخاص الذي كان موجودًا في النسخ السابقة يجب إلغاؤه وتدويره في Google Cloud/Firebase، لأن إزالة القيمة من الملف الحالي لا تلغي نسخ Git التاريخية. لا تستخدم المفتاح القديم بعد نشر هذا الإصدار.
