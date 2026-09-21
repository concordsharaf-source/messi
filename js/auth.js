import { supabase } from "./supabaseClient.js";
import { removeFcmToken } from "./push.js";
import {
  deriveCredentials,
  buildFingerprint,
  saveLocalIdentity,
  getLocalIdentity,
  normalizePhone,
  isValidPhone,
} from "./identity.js";

export async function signUp({ email, password, displayName, phone }) {
  const normalizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: { display_name: displayName, phone: phone || null },
    },
  });
  if (error) throw error;

  // احتياطاً: تأكد من وجود صف profiles حتى لو تأخر الـ trigger (مثلاً عند تفعيل تأكيد البريد)
  if (data?.user) {
    try {
      await supabase
        .from("profiles")
        .upsert(
          {
            id: data.user.id,
            email: normalizedEmail,
            display_name: displayName,
            phone: phone || null,
            // لا تُرسل is_admin من الواجهة: الصلاحية تُحدَّد في قاعدة البيانات
            // (handle_new_user + is_admin_email) وهي المصدر الوحيد الموثوق.
          },
          { onConflict: "id" }
        );
    } catch (err) {
      console.warn("Failed to upsert profile during signup:", err);
    }
  }
  return data;
}

export async function signIn({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });
  if (error) throw error;

  if (data?.user) {
    try {
      await supabase
        .from("profiles")
        .update({ is_online: true, last_seen: new Date().toISOString() })
        .eq("id", data.user.id);
    } catch (err) {
      console.warn("Failed to update profile online status on signIn:", err);
    }
  }
  return data;
}

export async function signOut(userId) {
  // تُحذف ملكية الرمز قبل signOut حتى تسمح RLS للمستخدم الحالي بالحذف.
  await removeFcmToken(userId);

  if (userId) {
    try {
      await supabase
        .from("profiles")
        .update({ is_online: false, last_seen: new Date().toISOString() })
        .eq("id", userId);
    } catch (err) {
      console.warn("Failed to update status on signOut:", err);
    }
  }
  
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.error("Supabase auth signOut error:", err);
  }
}

export async function getCurrentProfile() {
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return null;

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return null;

    const normalizedEmail = (profile.email || user.email || "").trim().toLowerCase();

    return {
      ...profile,
      // الصلاحيات من قاعدة البيانات فقط — لا قوائم ثابتة في الواجهة
      is_admin: Boolean(profile.is_admin),
      is_super_admin: Boolean(profile.is_super_admin),
    };
  } catch (err) {
    console.error("getCurrentProfile error:", err);
    return null;
  }
}

// =============================================================
// التسجيل برقم الهاتف — بلا كلمة مرور
// التطبيق يربط: الرقم + الاسم + معلومات الجهاز ⇒ بصمة مستخدم،
// ويشتق بيانات الاعتماد تلقائياً (لا يكتب المستخدم كلمة مرور).
// =============================================================

export async function signUpWithPhone({ displayName, phone, email }) {
  const name = (displayName || "").trim();

  if (!name) throw new Error("الاسم مطلوب");
  if (!isValidPhone(phone)) throw new Error("رقم الهاتف غير صحيح — أدخل الرقم مع مفتاح الدولة أو بدونه");

  const creds = await deriveCredentials({ name, phone });
  const fp = await buildFingerprint({ name, phone });
  const contactEmail = (email || "").trim().toLowerCase();

  const metadata = {
    display_name: name,
    phone: creds.phonePretty,
    phone_number: creds.phonePretty,
    contact_email: contactEmail || null,
    signup_method: "phone",
    device_fingerprint: fp.fingerprint,
    device_label: fp.device_label,
    device_id: fp.device_id,
  };

  let data = null;
  let error = null;

  ({ data, error } = await supabase.auth.signUp({
    email: creds.email,
    password: creds.password,
    options: { data: metadata },
  }));

  // الرقم مسجّل مسبقاً على هذا الاسم: ندخله مباشرة بدل إظهار خطأ
  const already =
    error &&
    /already|registered|exists/i.test(error.message || "");

  if (already) {
    const retry = await supabase.auth.signInWithPassword({
      email: creds.email,
      password: creds.password,
    });

    if (retry.error) {
      const e = new Error(
        "هذا الرقم مسجّل مسبقاً. سجّل الدخول بنفس الاسم الذي استخدمته أول مرة، أو راجع المشرف."
      );

      e.code = "PHONE_TAKEN";

      throw e;
    }

    data = retry.data;
  } else if (error) {
    throw error;
  }

  if (data?.user) {
    try {
      await supabase.from("profiles").upsert(
        {
          id: data.user.id,
          email: contactEmail || null,
          display_name: name,
          phone: creds.phonePretty,
        },
        { onConflict: "id" }
      );
    } catch (err) {
      console.warn("Failed to upsert phone profile:", err);
    }

    saveLocalIdentity({
      ...fp,
      name,
      phone: creds.phone,
      phonePretty: creds.phonePretty,
      email: contactEmail,
      user_id: data.user.id,
    });
  }

  return data;
}

export async function signInWithPhone({ displayName, phone }) {
  const name = (displayName || "").trim();

  if (!name) throw new Error("أدخل الاسم الذي سجّلت به");
  if (!isValidPhone(phone)) throw new Error("رقم الهاتف غير صحيح");

  const creds = await deriveCredentials({ name, phone });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });

  if (error) {
    const e = new Error(
      "لم نجد حساباً مطابقاً لهذا الرقم والاسم. تأكد من الاسم كما كتبته أول مرة، أو راجع المشرف."
    );

    e.code = "PHONE_LOGIN_FAILED";

    throw e;
  }

  if (data?.user) {
    const fp = await buildFingerprint({ name, phone });

    try {
      await supabase
        .from("profiles")
        .update({ is_online: true, last_seen: new Date().toISOString(), phone: creds.phonePretty })
        .eq("id", data.user.id);
    } catch (err) {
      console.warn("Failed to mark online on phone signIn:", err);
    }

    const previous = getLocalIdentity();

    saveLocalIdentity({
      ...fp,
      name,
      phone: creds.phone,
      phonePretty: creds.phonePretty,
      email: previous?.email || "",
      user_id: data.user.id,
    });
  }

  return data;
}

export { getLocalIdentity, normalizePhone, isValidPhone };
