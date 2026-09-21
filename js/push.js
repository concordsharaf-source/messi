// ===============================================================
// Firebase Cloud Messaging - Push Notifications
// ===============================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getMessaging,
  getToken,
  deleteToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// ---------------------------------------------------------------
// Firebase Configuration
// ---------------------------------------------------------------
// ⚠️ استبدل القيم التالية بإعدادات مشروع Firebase الفعلية
// Firebase Console → Project settings → Your apps → Web app
// ---------------------------------------------------------------

const firebaseConfig = {
  apiKey: "AIzaSyBwKUp6U1TdatxX20rPQSFdGUyPUHAksYw",
  authDomain: "messenger-4f50d.firebaseapp.com",
  projectId: "messenger-4f50d",
  storageBucket: "messenger-4f50d.firebasestorage.app",
  messagingSenderId: "553556100673",
  appId: "1:553556100673:web:ebf30e8bbcc35870b9a8c0"
};

// ---------------------------------------------------------------
// VAPID PUBLIC KEY
// ---------------------------------------------------------------

const VAPID_KEY =
  "BBzoS91LbqCEcVJ7IekA-K4C6hOHugdeXSfrnameZwG5zdgqaTjXDNM95vpkv4zkyldlF9wSekB8zcBh4FtElk4";

// ⚠️ مسارات مطلقة هنا كانت تُفشل الإشعارات على GitHub Pages تماماً:
//    التطبيق يُنشر تحت /messi/ لا في الجذر، فـ "/firebase-messaging-sw.js"
//    يشير إلى نطاق حسابك الجذري (ملف غير موجود) → 404، ثم طلب نطاق
//    "/firebase-cloud-messaging-push-scope/" خارج المسموح → SecurityError
//    → فشل التسجيل كلياً: لا رمز FCM ولا إشعارات.
//    الحل: اشتقاق المسارين من قاعدة النشر نفسها فيعملان في الحالتين.
const APP_BASE = new URL("./", window.location.href);
const FIREBASE_SW_PATH = new URL("firebase-messaging-sw.js", APP_BASE).href;
const FIREBASE_SW_SCOPE = new URL("firebase-cloud-messaging-push-scope/", APP_BASE).href;

// ---------------------------------------------------------------
// Firebase Initialization
// ---------------------------------------------------------------

let firebaseApp = null;
let messaging = null;

try {
  firebaseApp = getApps().length
    ? getApps()[0]
    : initializeApp(firebaseConfig);

  messaging = getMessaging(firebaseApp);
} catch (error) {
  console.error("[FCM] Firebase initialization failed:", error);
}

// ---------------------------------------------------------------
// Service Worker Registration
// ---------------------------------------------------------------

let firebaseServiceWorkerRegistration = null;

async function registerFirebaseServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker غير مدعوم في هذا المتصفح.");
  }

  if (!window.isSecureContext) {
    throw new Error(
      "إشعارات Firebase Web تتطلب HTTPS أو localhost."
    );
  }

  // نثبت worker الخاص بـ Firebase في نطاق مخصص ومباشر لتفادي تعارضه مع sw.js
  // الرئيسي في root. هذا أمر حاسم لأن المتصفح يسمح فقط بعمل worker واحد لكل scope.
  const registration =
    (await navigator.serviceWorker.getRegistrations()).find(
      (candidate) => candidate.scope === FIREBASE_SW_SCOPE
    ) ||
    (await navigator.serviceWorker.register(FIREBASE_SW_PATH, {
      scope: FIREBASE_SW_SCOPE,
      updateViaCache: "none",
    }));

  firebaseServiceWorkerRegistration = registration;

  // فحص التحديثات بنفسه في كل تشغيل حتى تصل تعديلات الإشعارات للجهاز فوراً
  registration.update?.().catch(() => {});

  await navigator.serviceWorker.ready;

  return firebaseServiceWorkerRegistration;
}

// ---------------------------------------------------------------
// Token retrieval and persistence
// ---------------------------------------------------------------

async function getCurrentFirebaseToken({ requestPermission = false } = {}) {
  if (!messaging) {
    throw new Error("Firebase Messaging غير مهيأ.");
  }

  if (!("Notification" in window)) {
    throw new Error("هذا المتصفح لا يدعم الإشعارات.");
  }

  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker غير مدعوم.");
  }

  if (!window.isSecureContext) {
    throw new Error("إشعارات Firebase Web تتطلب HTTPS أو localhost.");
  }

  let permission = Notification.permission;
  if (permission !== "granted" && requestPermission) {
    permission = await Notification.requestPermission();
  }

  // لا نطلب الإذن تلقائياً من listener عند تحميل الجلسة؛ يمكن للمستخدم
  // منح الإذن من زر "تفعيل إشعارات الجهاز". إذا كان الإذن ممنوحاً بالفعل،
  // يُعاد جلب الرمز عند كل تسجيل دخول لضمان تحديثه.
  if (permission !== "granted") {
    console.warn("[FCM] Notification permission is not granted.");
    return null;
  }

  const registration = await registerFirebaseServiceWorker();
  const token = await getToken(messaging, {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: registration,
  });

  if (!token) {
    console.warn("[FCM] لم يتم الحصول على FCM Token.");
    return null;
  }

  return token;
}

async function persistFcmToken(userId, currentToken) {
  if (!userId || !currentToken) return false;

  const { supabase } = await import("./supabaseClient.js");

  // المسار المفضل ذري وآمن: دالة SQL ذات صلاحيات محدودة تحذف ملكية الرمز
  // السابقة ثم تملكه للمستخدم الحالي. تُضاف هذه الدالة في sql/fcm_and_rls.sql.
  const { error: claimError } = await supabase.rpc("claim_fcm_token", {
    p_user_id: userId,
    p_token: currentToken,
    p_platform: "web",
  });

  if (!claimError) {
    localStorage.setItem("fcm_token", currentToken);
    localStorage.setItem("fcm_user_id", String(userId));
    console.log("[FCM] تم ربط الرمز بالمستخدم:", userId);
    return true;
  }

  // توافق مع قواعد البيانات التي لم تُطبَّق عليها الدالة بعد. هذا المسار
  // ينفذ الحذف ثم upsert المطلوبين مباشرةً، مع تسجيل الخطأ لتسهيل الترحيل.
  console.warn("[FCM] claim_fcm_token غير متاح؛ استخدام مسار الحذف/upsert المباشر:", claimError);

  // قد ينتقل جهاز واحد بين حسابات متعددة. احذف أي ملكية قديمة للرمز قبل
  // upsert حتى لا تصل الإشعارات إلى المستخدم السابق.
  const { error: foreignTokenError } = await supabase
    .from("fcm_tokens")
    .delete()
    .eq("token", currentToken)
    .neq("user_id", userId);

  if (foreignTokenError) {
    console.warn("[FCM] تعذّر حذف ملكية الرمز القديمة:", foreignTokenError);
  }

  // لا يشمل neq صفوف user_id = null في PostgreSQL، لذلك نعالجها صراحةً.
  const { error: anonymousTokenError } = await supabase
    .from("fcm_tokens")
    .delete()
    .eq("token", currentToken)
    .is("user_id", null);

  if (anonymousTokenError) {
    console.warn("[FCM] تعذّر حذف الرمز غير المرتبط بحساب:", anonymousTokenError);
  }

  const { error } = await supabase.from("fcm_tokens").upsert(
    {
      user_id: userId,
      token: currentToken,
      platform: "web",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,token" }
  );

  if (error) {
    console.error("[FCM] فشل حفظ التوكن في Supabase:", error);
    return false;
  }

  localStorage.setItem("fcm_token", currentToken);
  localStorage.setItem("fcm_user_id", String(userId));
  console.log("[FCM] تم ربط الرمز بالمستخدم:", userId);
  return true;
}

// تُستدعى من دورة Supabase Auth عند SIGNED_IN أو عند وجود جلسة محفوظة.
export async function registerFcmToken(userId) {
  if (!userId) return false;

  try {
    const currentToken = await getCurrentFirebaseToken();
    if (!currentToken) return false;
    return await persistFcmToken(userId, currentToken);
  } catch (error) {
    console.error("[FCM] registerFcmToken:", error);
    return false;
  }
}

// زر التفعيل اليدوي يطلب إذن الإشعارات ثم يستخدم نفس مسار التسجيل الموحد.
export async function enablePushNotifications(userId = null) {
  if (!userId) return false;

  try {
    const currentToken = await getCurrentFirebaseToken({ requestPermission: true });
    if (!currentToken) return false;
    return await persistFcmToken(userId, currentToken);
  } catch (error) {
    console.error("[FCM] enablePushNotifications:", error);
    return false;
  }
}

// إزالة رمز الجهاز من الحساب قبل تسجيل الخروج، مع تنظيف الحالة المحلية دائماً.
export async function removeFcmToken(userId = null) {
  const token = localStorage.getItem("fcm_token");
  const storedUserId = localStorage.getItem("fcm_user_id");
  const ownerId = userId || storedUserId;

  try {
    if (token) {
      const { supabase } = await import("./supabaseClient.js");
      let query = supabase.from("fcm_tokens").delete().eq("token", token);
      if (ownerId) query = query.eq("user_id", ownerId);

      const { error } = await query;
      if (error) {
        console.error("[FCM] فشل حذف التوكن من Supabase:", error);
      }
    }

    if (messaging) {
      try {
        await deleteToken(messaging);
      } catch (firebaseError) {
        console.warn("[FCM] تعذّر إبطال التوكن عبر Firebase:", firebaseError);
      }
    }
  } catch (error) {
    console.error("[FCM] removeFcmToken:", error);
  } finally {
    localStorage.removeItem("fcm_token");
    localStorage.removeItem("fcm_user_id");
  }

  return true;
}

export async function disablePushNotifications(userId = null) {
  return removeFcmToken(userId);
}

// ---------------------------------------------------------------
// Foreground Messages
// ---------------------------------------------------------------

export function listenForForegroundMessages({
  onNotification = null,
  soundUrl = "./icons/notify.mp3",
  shouldPlaySound = null,
} = {}) {

  if (!messaging) {
    console.warn(
      "[FCM] Messaging غير مهيأ."
    );
    return () => {};
  }

  return onMessage(
    messaging,
    async (payload) => {

      console.log(
        "[FCM] Foreground message:",
        payload
      );

      // ---------------------------------------------------------
      // Notification Data
      // ---------------------------------------------------------

      const notification =
        payload.notification || {};

      const data =
        payload.data || {};

      const title =
        notification.title ||
        data.title ||
        "رسالة جديدة";

      const body =
        notification.body ||
        data.body ||
        "لديك رسالة جديدة";

      // في حالة foreground لا نستدعي showNotification من Service Worker؛
      // ذلك سيحوّل التنبيه إلى إشعار نظام. بدلاً منه يحدّث callback واجهة
      // التطبيق ويشغّل الصوت، بينما يتولى firebase-messaging-sw.js إشعار
      // النظام فقط عندما تكون الصفحة في الخلفية.
      if (document.visibilityState !== "visible") {
        return;
      }

      // لا صوت إن كان المستخدم يشاهد نفس المحادثة التي وصلتها الرسالة
      const allowed = typeof shouldPlaySound === "function" ? shouldPlaySound(data) !== false : true;

      if (allowed) {
        try {
          const audio = new Audio(soundUrl);
          audio.volume = 1;
          await audio.play().catch(() => {
            console.warn("[FCM] تشغيل الصوت التلقائي محظور من المتصفح.");
          });
        } catch (error) {
          console.warn("[FCM] Audio error:", error);
        }
      }

      // ---------------------------------------------------------
      // Callback
      // ---------------------------------------------------------

      if (typeof onNotification === "function") {
        onNotification({
          payload,
          title,
          body,
          data,
        });
      }
    }
  );
}

// ---------------------------------------------------------------
// Get Current Token
// ---------------------------------------------------------------

export function getCurrentFcmToken() {
  return localStorage.getItem("fcm_token");
}

// ---------------------------------------------------------------
// Export Messaging Instance
// ---------------------------------------------------------------

export { messaging };
