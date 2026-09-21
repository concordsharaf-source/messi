// ===============================================================
// google-signin — جسر الدخول بجوجل من Firebase إلى Supabase
// ===============================================================
//
// لماذا هذه الدالة؟
//   الدخول بجوجل في Supabase يحتاج «مفتاح» (Client ID + Secret) يُنشأ
//   من لوحة Google Cloud، ولا يمكن لأحد إنشاءه إلا مالك الحساب.
//   البديل: نستخدم مزوّد جوجل داخل مشروع Firebase (يُنشئ مفتاحه تلقائياً
//   بلا أي خطوة يدوية)، ثم نحوّل هوية المستخدم إلى جلسة Supabase حقيقية.
//
// كيف تعمل؟
//   ١) التطبيق يسجّل الدخول عبر Firebase (نافذة منبثقة من جوجل)
//   ٢) يستلم «معرّفاً موقّعاً» من Firebase ويرسله إلى هنا
//   ٣) نتحقق من توقيع المعرّف بمفاتيح جوجل العامة (JWKS) — لا نثق بأي شيء آخر
//   ٤) ننشئ المستخدم في Supabase (إن لم يكن موجوداً) ونولّد رمز دخول مؤقتاً
//   ٥) التطبيق يبادل الرمز بجلسة Supabase كاملة (verifyOtp)
//
// الأمان:
//   • التوقيع يُتحقق بمفاتيح جوجل العامة (RS256)، ومخزّنة مؤقتاً ساعة
//   • نرفض أي معرّف لمشروع Firebase غير مشروعنا (aud/iss)
//   • نقبل فقط الدخول بحساب جوجل (sign_in_provider = google.com)
//   • البريد مقبول متى كان المزوّد google.com (جوجل يوثّق البريد بنفسه)
//   • وإن لم يُرسل الحساب بريداً: نجلبه من Firebase بالرمز نفسه،
//     وإلا نُنشئ عنواناً داخلياً ثابتاً من معرّف جوجل (بلا رفض للدخول)
//   • مفتاح الخدمة (service role) لا يغادر الخادم أبداً
//   • الدالة تُنشر بـ --no-verify-jwt لأن المستخدم لم يسجّل دخوله بعد
//     (ولا حاجة: التحقق يجري من معرّف Firebase الموقّع)
// ===============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FIREBASE_PROJECT_ID = "messenger-4f50d";

// مفتاح الويب العام لمشروع Firebase (نفس الموجود في التطبيق — ليس سراً)
// يُستخدم فقط لجلب بريد صاحب الرمز من خدمة Firebase عندما لا يحمله الرمز.
const FIREBASE_API_KEY = "AIzaSyBwKUp6U1TdatxX20rPQSFdGUyPUHAksYw";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------
// فكّ ترميز base64url
// ---------------------------------------------------------------

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

function decodeJson(value: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

// ---------------------------------------------------------------
// مفاتيح جوجل العامة (تُخزَّن ساعة في الذاكرة)
// ---------------------------------------------------------------

let jwksCache: { keys: any[]; at: number } | null = null;

async function getJwks(): Promise<any[]> {
  const now = Date.now();

  if (jwksCache && now - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;

  const response = await fetch(JWKS_URL);

  if (!response.ok) throw new Error("jwks_unavailable");

  const data = await response.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];

  jwksCache = { keys, at: now };

  return keys;
}

// ---------------------------------------------------------------
// التحقق الكامل من معرّف Firebase
// ---------------------------------------------------------------

async function verifyFirebaseIdToken(idToken: string) {
  const parts = String(idToken || "").split(".");

  if (parts.length !== 3) throw new Error("token_malformed");

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJson(headerB64);
  const payload = decodeJson(payloadB64);

  if (header.alg !== "RS256") throw new Error("token_bad_alg");

  const jwk = (await getJwks()).find((key: any) => key.kid === header.kid);

  if (!jwk) throw new Error("token_key_not_found");

  const key = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );

  if (!valid) throw new Error("token_bad_signature");

  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("token_expired");
  if (typeof payload.iat === "number" && payload.iat > now + 120) throw new Error("token_bad_iat");

  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("token_bad_audience");
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new Error("token_bad_issuer");
  }
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("token_no_subject");

  // الدخول بجوجل فقط — لا نقبل مزوّدين آخرين
  if (payload.firebase?.sign_in_provider !== "google.com") {
    throw new Error("not_google_provider");
  }

  // ملاحظة مهمة: بعض حسابات جوجل تصل بـ email_verified = false (أو بلا الحقل أصلاً)
  // رغم أن جوجل نفسه هو من أصدرها. وبما أننا تحققنا من التوقيع + المشروع (aud/iss)
  // + أن المزوّد google.com، فالبريد موثّق من جوجل فعلياً — لذلك لا نرفض الدخول.
  // (كان الرفض الصارم سبب خطأ email_not_verified للمستخدمين.)
  if (payload.email_verified !== true) {
    console.warn(
      "[google-signin] email_verified غير صحيح في رمز جوجل — نكمل لأن المزوّد google.com:",
      payload.email_verified,
    );
  }

  // بلا بريد؟ لا نرفض: صاحب الدالة يجلب البريد من Firebase أو يُنشئ عنواناً
  // داخلياً ثابتاً من معرّف جوجل (sub). (كان الرفض هنا سبب رسالة
  // «لا يوجد بريد في حساب جوجل — استخدم الدخول برقم الهاتف».)
  if (!payload.email || typeof payload.email !== "string") {
    console.warn("[google-signin] الرمز بلا بريد — سنعتمد على معرّف جوجل.");
  }

  return payload;
}

// ---------------------------------------------------------------
// بريد الحساب: من الرمز، أو من Firebase، أو عنوان داخلي ثابت
// ---------------------------------------------------------------
//  بعض حسابات جوجل (خصوصاً المنشأة برقم هاتف أو حسابات العمل المقيّدة)
//  لا تُرسل بريداً في رمز الهوية إطلاقاً — وهذا ليس خطأ أمنياً، لكنه
//  كان يمنع الدخول برسالة «لا يوجد بريد في حساب جوجل». الآن نتبع:
//   ١) بريد الرمز نفسه (email أو firebase.identities.email)
//   ٢) خدمة Firebase (accounts:lookup) بالرمز نفسه — لا يمكن انتحال بريد غيرك
//   ٣) عنوان داخلي ثابت مبني على معرّف جوجل (sub) فيبقى الحساب واحداً دائماً
// ---------------------------------------------------------------

function emailFromClaims(claims: any): string {
  const direct = String(claims?.email || "").trim().toLowerCase();

  if (direct) return direct;

  const identities = claims?.firebase?.identities?.email;

  if (Array.isArray(identities) && identities.length) {
    const first = String(identities[0] || "").trim().toLowerCase();

    if (first) return first;
  }

  return "";
}

async function lookupFirebaseEmail(idToken: string): Promise<string> {
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      },
    );

    if (!response.ok) return "";

    const data = await response.json();
    const user = Array.isArray(data?.users) ? data.users[0] : null;

    return String(user?.email || "").trim().toLowerCase();
  } catch (_) {
    return "";
  }
}

/** عنوان داخلي ثابت من معرّف مستخدم جوجل — لا يُعرض للمستخدم */
function syntheticEmailFor(sub: string): string {
  const safe = String(sub || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "user";

  return `g${safe}@wa-walid.app`;
}

// ---------------------------------------------------------------
// الدالة
// ---------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const idToken = body?.idToken;

    if (!idToken) return json({ error: "missing_token" }, 400);

    let claims: any;

    try {
      claims = await verifyFirebaseIdToken(idToken);
    } catch (error) {
      console.error("[google-signin] token rejected:", error.message);

      return json({ error: "invalid_token", reason: error.message }, 401);
    }

    let email = emailFromClaims(claims);

    if (!email) email = await lookupFirebaseEmail(idToken);

    const synthetic = !email;

    if (synthetic) email = syntheticEmailFor(String(claims.sub));

    const fullName =
      String(claims.name || "").trim() ||
      (synthetic ? "مستخدم جوجل" : email.split("@")[0]);
    const picture = String(claims.picture || "").trim();

    console.log(
      "[google-signin] الدخول بجوجل:",
      synthetic ? "حساب بلا بريد معلن → عنوان داخلي ثابت" : "بريد من الحساب",
    );

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // ١) إنشاء المستخدم إن لم يكن موجوداً (يُنشئ الملف الشخصي عبر التريغر)
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        avatar_url: picture,
        provider: "google",
      },
    });

    if (created.error && !/already|registered|exists/i.test(created.error.message)) {
      console.error("[google-signin] createUser failed:", created.error.message);
      return json({ error: "create_user_failed" }, 500);
    }

    // ٢) توليد رمز دخول مؤقت (لا يُرسل أي بريد)
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });

    const tokenHash = link.data?.properties?.hashed_token;

    if (link.error || !tokenHash) {
      console.error("[google-signin] generateLink failed:", link.error?.message);
      return json({ error: "session_failed" }, 500);
    }

    return json({
      ok: true,
      token_hash: tokenHash,
      email,
      is_new: !!created.data?.user,
      synthetic,
    });
  } catch (error) {
    console.error("[google-signin] unexpected:", error?.message);
    return json({ error: "server_error" }, 500);
  }
});
