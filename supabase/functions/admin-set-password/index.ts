// ===============================================================
// admin-set-password
// يسمح للمشرف العام (Super Admin) بتعيين كلمة مرور جديدة لأي حساب،
// أو توليد رابط استعادة يُرسل إلى بريد المستخدم.
//
// الأمان:
//   • المنادي يجب أن يكون مسجّلاً (Authorization: Bearer <access_token>)
//   • وأن تكون صفته في جدول profiles: is_super_admin = true
//   • لا يمكن تغيير كلمة مرور حساب المشرف العام نفسه من هنا
//     (يستخدم إعدادات «الأمان» داخل التطبيق)
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

    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: actorProfile } = await adminClient
      .from("profiles")
      .select("is_admin, is_super_admin")
      .eq("id", actor.id)
      .maybeSingle();

    if (!actorProfile?.is_super_admin) {
      return json({ error: "Super admin only" }, 403);
    }

    // --- 2) قراءة الطلب ---
    const { userId, password, action } = await req.json();

    if (!userId) return json({ error: "userId مطلوب" }, 400);
    if (userId === actor.id) {
      return json({ error: "غيّر كلمة مرورك من إعدادات التطبيق" }, 400);
    }

    // --- 3) رابط استعادة بالبريد ---
    if (action === "reset-link") {
      const { data: targetProfile } = await adminClient
        .from("profiles")
        .select("email")
        .eq("id", userId)
        .maybeSingle();

      if (!targetProfile?.email) {
        return json({ error: "لا يوجد بريد لهذا الحساب" }, 400);
      }

      const { error } = await adminClient.auth.resetPasswordForEmail(targetProfile.email);
      if (error) throw error;

      return json({ success: true, message: `أُرسل رابط الاستعادة إلى ${targetProfile.email}` });
    }

    // --- 4) تعيين كلمة مرور مباشرةً ---
    if (!password || String(password).length < 6) {
      return json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }, 400);
    }

    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      password: String(password),
    });
    if (error) throw error;

    return json({ success: true, message: "تم تعيين كلمة المرور الجديدة" });
  } catch (error) {
    console.error("admin-set-password error", error);
    return json({ error: (error as Error)?.message || "فشل تغيير كلمة المرور" }, 500);
  }
});
