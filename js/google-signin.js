// ===============================================================
// الدخول بواسطة جوجل — عبر Firebase ثم جسر إلى Supabase
// ===============================================================
//
// الفكرة:
//   Firebase يُنشئ مفتاح جوجل تلقائياً لحظة تشغيل المزوّد من لوحته،
//   بلا أي خطوة يدوية على لوحة Google Cloud. لذلك:
//     ١) نفتح نافذة جوجل عبر Firebase (نافذة منبثقة)
//     ٢) نستلم معرّف المستخدم الموقّع من Firebase
//     ٣) نبادله بجلسة Supabase حقيقية عبر دالة الحافة google-signin
//
//   وإن تعذّرت النافذة المنبثقة (سفاري/آيفون) ننتقل تلقائياً إلى
//   مسار التوجيه الكامل، ثم نُكمل عند العودة عبر completeGoogleRedirect().
//
//   إن أضفت مستقبلاً مفتاح جوجل في إعدادات Supabase، فالتطبيق يستخدم
//   الطريق الأصلي تلقائياً ويتجاهل هذا الجسر (انظر signInWithGoogle في app.js).
// ===============================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// نفس إعدادات مشروع Firebase المستخدم في الإشعارات (js/push.js)
const firebaseConfig = {
  apiKey: "AIzaSyBwKUp6U1TdatxX20rPQSFdGUyPUHAksYw",
  authDomain: "messenger-4f50d.firebaseapp.com",
  projectId: "messenger-4f50d",
  storageBucket: "messenger-4f50d.firebasestorage.app",
  messagingSenderId: "553556100673",
  appId: "1:553556100673:web:ebf30e8bbcc35870b9a8c0",
};

const BRIDGE_URL = `${SUPABASE_URL}/functions/v1/google-signin`;

// علامة تُوضع قبل التوجيه الكامل إلى جوجل، ويقرأها app.js عند العودة
const REDIRECT_FLAG = "wa_google_redirect";

// ---------------------------------------------------------------
// تحويل أخطاء Firebase/الشبكة إلى رسائل عربية واضحة
// ---------------------------------------------------------------

export function googleErrorMessage(error) {
  const code = String(error?.code || "");
  const raw = String(error?.message || "");

  const map = {
    "auth/popup-blocked": "المتصفح منع النافذة المنبثقة — اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.",
    "auth/popup-closed-by-user": "أُغلقِت نافذة الدخول قبل الإتمام. أعد المحاولة.",
    "auth/cancelled-popup-request": "أُلغيت محاولة الدخول السابقة. أعد المحاولة.",
    "auth/unauthorized-domain":
      "هذا النطاق غير مسموح في مشروع Firebase — أضِفه في: Authentication ← Settings ← Authorized domains.",
    "auth/unauthorized-continue-uri":
      "هذا النطاق غير مسموح في مشروع Firebase — أضِفه في: Authentication ← Settings ← Authorized domains.",
    "auth/operation-not-allowed":
      "دخول جوجل غير مُشغَّل بعد في مشروع Firebase — شغّله من: Authentication ← Sign-in method ← Google.",
    "auth/network-request-failed": "تعذّر الاتصال بالإنترنت — تحقّق من الشبكة ثم أعد المحاولة.",
    "auth/account-exists-with-different-credential": "هذا البريد مسجَّل بطريقة دخول أخرى.",
    "auth/internal-error": "خلل مؤقت في خدمة جوجل — أعد المحاولة بعد قليل.",
    "auth/too-many-requests": "محاولات كثيرة متتابعة — انتظر قليلاً ثم أعد المحاولة.",
  };

  if (map[code]) return map[code];

  // أسباب يرسلها جسر google-signin — نترجمها إلى عبارات واضحة
  const reasons = {
    invalid_token: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    token_malformed: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    token_bad_alg: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    token_bad_signature: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    token_key_not_found: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    token_expired: "انتهت صلاحية جلسة جوجل — أعد المحاولة.",
    token_bad_iat: "ساعة الجهاز غير مضبوطة — اضبط التاريخ والوقت ثم أعد المحاولة.",
    token_bad_audience: "حساب جوجل هذا من مشروع آخر — تواصل مع الدعم.",
    token_bad_issuer: "حساب جوجل هذا من مشروع آخر — تواصل مع الدعم.",
    token_no_subject: "تعذّر التحقق من حساب جوجل — أعد المحاولة.",
    not_google_provider: "هذا الحساب ليس حساب جوجل — استخدم الدخول بجوجل أو بالرقم.",
    email_missing: "لا يوجد بريد في حساب جوجل — استخدم الدخول برقم الهاتف.",
    email_not_verified: "تعذّر تأكيد بريد حساب جوجل — أعد المحاولة.",
    create_user_failed: "تعذّر إنشاء الحساب — أعد المحاولة بعد قليل.",
    session_failed: "تعذّر تجهيز الجلسة — أعد المحاولة بعد قليل.",
    bridge_failed: "تعذّر تجهيز الجلسة — أعد المحاولة بعد قليل.",
    jwks_unavailable: "تعذّر الوصول إلى جوجل — تحقّق من الاتصال ثم أعد المحاولة.",
  };

  if (reasons[raw]) return reasons[raw];

  if (/invalid_token|token_|session_failed|create_user_failed/.test(raw)) {
    return "تعذّر الدخول بجوجل — أعد المحاولة.";
  }

  if (/Failed to fetch|NetworkError|dynamically imported module/i.test(raw)) {
    return "تعذّر الوصول إلى خدمة الدخول — تحقّق من الاتصال بالإنترنت.";
  }

  return raw ? `تعذّر الدخول بجوجل: ${raw}` : "تعذّر الدخول بجوجل — أعد المحاولة.";
}

// ---------------------------------------------------------------
// مبادلة معرّف Firebase بجلسة Supabase
// ---------------------------------------------------------------

async function exchangeTokenForSession(idToken) {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ idToken }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.token_hash) {
    throw new Error(data?.reason || data?.error || "bridge_failed");
  }

  const { error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.token_hash,
  });

  if (error) throw error;

  return data.email || "";
}

function getFirebaseAuth() {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

  return getAuth(app);
}

// ---------------------------------------------------------------
// المسار الأول: نافذة منبثقة (ثم توجيه كامل عند الفشل)
// ---------------------------------------------------------------

const REDIRECT_FALLBACK_CODES = [
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
];

export async function signInWithGoogleBridge() {
  const auth = getFirebaseAuth();

  const provider = new GoogleAuthProvider();

  // نطلب البريد والملف الشخصي صراحةً (بعض الحسابات لا ترسلهما افتراضياً)
  provider.addScope("email");
  provider.addScope("profile");
  provider.setCustomParameters({ prompt: "select_account" });

  let result = null;

  try {
    result = await signInWithPopup(auth, provider);
  } catch (error) {
    if (REDIRECT_FALLBACK_CODES.includes(String(error?.code || ""))) {
      localStorage.setItem(REDIRECT_FLAG, "1");

      await signInWithRedirect(auth, provider);

      // الصفحة ستنتقل الآن إلى جوجل — لا نُكمل هنا
      return { redirected: true };
    }

    throw error;
  }

  if (!result?.user) throw new Error("auth/no-user");

  const idToken = await result.user.getIdToken();

  // لا نُبقي جلسة Firebase — الهوية الفعلية هي جلسة Supabase
  auth.signOut().catch(() => {});

  const email = await exchangeTokenForSession(idToken);

  return { email: email || result.user.email || "" };
}

// ---------------------------------------------------------------
// المسار الثاني: إكمال الدخول عند العودة من صفحة جوجل
// ---------------------------------------------------------------

export function hasPendingGoogleRedirect() {
  return localStorage.getItem(REDIRECT_FLAG) === "1";
}

export async function completeGoogleRedirect() {
  if (!hasPendingGoogleRedirect()) return null;

  localStorage.removeItem(REDIRECT_FLAG);

  const auth = getFirebaseAuth();

  let result = null;

  try {
    result = await getRedirectResult(auth);
  } catch (error) {
    return null;
  }

  if (!result?.user) return null;

  const idToken = await result.user.getIdToken();

  auth.signOut().catch(() => {});

  const email = await exchangeTokenForSession(idToken);

  return { email: email || result.user.email || "" };
}
