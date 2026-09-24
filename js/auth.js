import { supabase } from "./supabaseClient.js";
import { removeFcmToken } from "./push.js";
import {
  buildFullPhone,
  isValidPhone,
  prettyPhone,
  internalEmail,
  digitsOnly,
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

export async function getCurrentProfile(preferredUserId = null) {
  try {
    // v49: كنا نطلب /auth/v1/user (دور شبكة كامل) في كل إقلاع. صاحب الجلسة
    // معروف محلياً، وقراءة الملف محمية بسياسات القاعدة ⇒ نستغني عن الدور.
    let userId = preferredUserId || null;

    if (!userId) {
      try {
        const { data } = await supabase.auth.getSession();
        userId = data?.session?.user?.id || null;
      } catch (_) {}
    }

    if (!userId) {
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) return null;
      userId = user.id;
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;
    if (!profile) return null;

    const normalizedEmail = (profile.email || "").trim().toLowerCase();

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
// التسجيل والدخول برقم الهاتف + كلمة مرور
//   · رقم الهاتف: مطلوب (مع مفتاح الدولة)
//   · كلمة المرور: مطلوبة
//   · الاسم: اختياري   · البريد: اختياري
//   · لا بصمة جهاز: الحساب يعمل من أي جهاز بنفس الرقم وكلمة المرور
// =============================================================

export async function signUpWithPhone({ phone, dial, password, displayName, email }) {
  const full = buildFullPhone(phone, dial);
  const pretty = prettyPhone(full);

  if (!isValidPhone(phone, dial)) {
    throw new Error("رقم الهاتف غير صحيح — اكتب رقمك بعد مفتاح الدولة");
  }

  if (!password || password.length < 6) {
    throw new Error("كلمة المرور مطلوبة (٦ أحرف على الأقل)");
  }

  const name = (displayName || "").trim();
  const contactEmail = (email || "").trim().toLowerCase();
  const account = internalEmail(full);

  const metadata = {
    display_name: name || null,
    phone: pretty,
    contact_email: contactEmail || null,
    signup_method: "phone",
  };

  const { data, error } = await supabase.auth.signUp({
    email: account,
    password,
    options: { data: metadata },
  });

  // الرقم مسجَّل مسبقاً: نجرّب الدخول بنفس كلمة المرور (يعني أنه نفس المستخدم)
  const already = error && /already|registered|exists/i.test(error.message || "");

  if (already) {
    const retry = await supabase.auth.signInWithPassword({ email: account, password });

    if (retry.error) {
      const e = new Error(
        "هذا الرقم مسجَّل مسبقاً بكلمة مرور مختلفة. اكتب كلمة المرور الصحيحة، أو راجع المشرف لإعادة تعيينها."
      );

      e.code = "PHONE_TAKEN";

      throw e;
    }

    await touchProfile(retry.data?.user, pretty);

    return retry.data;
  }

  if (error) throw error;

  await touchProfile(data?.user, pretty, {
    displayName: name || null,
    contactEmail: contactEmail || null,
  });

  return data;
}

export async function signInWithPhone({ phone, dial, password }) {
  const full = buildFullPhone(phone, dial);
  const pretty = prettyPhone(full);

  if (!isValidPhone(phone, dial)) {
    throw new Error("أدخل رقم هاتف صحيح");
  }

  if (!password) {
    throw new Error("أدخل كلمة المرور");
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: internalEmail(full),
    password,
  });

  if (error) {
    const e = new Error("رقم الهاتف أو كلمة المرور غير صحيحة");

    e.code = "PHONE_LOGIN_FAILED";

    throw e;
  }

  await touchProfile(data?.user, pretty);

  return data;
}

/** ضبط كلمة مرور للحساب الحالي (يُستخدم للحسابات القديمة أو لتغيير الكلمة) */
export async function setMyPassword(newPassword) {
  if (!newPassword || newPassword.length < 6) {
    throw new Error("كلمة المرور قصيرة — ٦ أحرف على الأقل");
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });

  if (error) throw new Error(error.message || "تعذّر ضبط كلمة المرور");

  return true;
}

/** تحديث بسيط للملف الشخصي بعد الدخول (رقم الهاتف وحالة الاتصال) */
async function touchProfile(user, pretty, extra = {}) {
  if (!user?.id) return;

  const patch = {
    is_online: true,
    last_seen: new Date().toISOString(),
  };

  if (pretty) patch.phone = pretty;
  if (extra.displayName) patch.display_name = extra.displayName;
  if (extra.contactEmail) patch.email = extra.contactEmail;

  try {
    await supabase.from("profiles").update(patch).eq("id", user.id);
  } catch (err) {
    console.warn("Failed to update profile after phone auth:", err);
  }
}

export { digitsOnly, prettyPhone, isValidPhone, buildFullPhone };
