// ===============================================================
// admin-switch-user
// يسمح للمشرف العام (Super Admin) بالدخول إلى أي حساب مشرف آخر
// بضغطة واحدة من الإعدادات — بدون كتابة بريد أو كلمة مرور.
//
// الأمان:
//   • المنادي يجب أن يكون مسجّلاً (Authorization: Bearer <access_token>)
//   • ويجب أن تكون صفته is_super_admin = true في جدول profiles
//   • لا يمكن الدخول إلى حساب غير مشرف من هنا (قائمة محصورة)
//   • لا يمكن الدخول إلى حساب المستخدم العادي إطلاقاً
// ===============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // --- 1) التحقق من هوية المنادي ---
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });

    const { data: { user: actor } } = await userClient.auth.getUser();
    if (!actor) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: actorProfile } = await admin
      .from("profiles")
      .select("is_admin, is_super_admin")
      .eq("id", actor.id)
      .maybeSingle();

    // المشرف العام وحده يستطيع تبديل الحساب
    if (!actorProfile?.is_super_admin) {
      return json({ error: "Super admin only" }, 403);
    }

    // --- 2) الحساب المطلوب ---
    const { userId } = await req.json();
    if (!userId) return json({ error: "userId مطلوب" }, 400);

    if (String(userId) === String(actor.id)) {
      return json({ error: "أنت داخل هذا الحساب بالفعل" }, 400);
    }

    const { data: targetProfile } = await admin
      .from("profiles")
      .select("id, display_name, is_admin, is_super_admin")
      .eq("id", userId)
      .maybeSingle();

    if (!targetProfile) return json({ error: "الحساب غير موجود" }, 404);
    if (!targetProfile.is_admin && !targetProfile.is_super_admin) {
      return json({ error: "الدخول السريع مقصور على حسابات المشرفين" }, 403);
    }

    // --- 3) بريد الحساب الهدف (من auth) ---
    const { data: targetUser, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !targetUser?.user?.email) {
      return json({ error: "تعذّر قراءة بريد الحساب" }, 400);
    }

    const email = targetUser.user.email;

    // --- 4) توليد رمز دخول لمرة واحدة (يُبادَل بجلسة في التطبيق) ---
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = link.data?.properties?.hashed_token;

    if (!tokenHash) {
      console.error("[admin-switch-user] generateLink failed:", link.error?.message);
      return json({ error: "تعذّر توليد رمز الدخول", reason: link.error?.message || "" }, 400);
    }

    return json({
      ok: true,
      token_hash: tokenHash,
      email,
      display_name: targetProfile.display_name || email,
      is_super_admin: Boolean(targetProfile.is_super_admin),
    });
  } catch (error) {
    console.error("admin-switch-user error", error);
    return json({ error: (error as Error)?.message || "فشل تبديل الحساب" }, 500);
  }
});
