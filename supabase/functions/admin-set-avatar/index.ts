// ===============================================================
// admin-set-avatar
// يسمح للمشرف العام بتغيير أو حذف الصورة الشخصية لأي مستخدم
// (مشرفاً كان أو مستخدماً عادياً).
//
// لماذا دالة حافة؟
//   سياسات التخزين في القاعدة تسمح لكل مستخدم بالكتابة داخل مجلده هو
//   فقط: (storage.foldername(name))[1] = auth.uid()
//   فالمشرف العام لا يستطيع — من المتصفح — رفع ملف داخل مجلد غيره.
//   هنا نستخدم مفتاح الخدمة (service role) الذي يتجاوز هذه السياسات،
//   بعد التحقق الصارم من أن المنادي مشرف عام.
//
// الأمان:
//   • المنادي مسجَّل + is_super_admin = true
//   • نوع الصورة من قائمة بيضاء (jpeg/png/webp)
//   • حد أقصى للحجم (3 ميجابايت بعد الفكّ)
//   • تُحذف الصورة القديمة من نفس المجلد فقط (لا تُلمس ملفات أخرى)
// ===============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_BYTES = 3 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// استخراج مسار الملف من رابطه العام — لمجلد المستخدم نفسه فقط
function storagePathFromUrl(url: string | null, userId: string): string | null {
  if (!url) return null;

  const marker = "/object/public/avatars/";
  const index = url.indexOf(marker);
  if (index === -1) return null;

  const path = decodeURIComponent(url.slice(index + marker.length).split("?")[0]);

  // حماية: لا نحذف إلا داخل مجلد هذا المستخدم
  if (!path.startsWith(`${userId}/`)) return null;

  return path;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // --- 1) من ينادي؟ ---
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });

    const { data: { user: actor } } = await userClient.auth.getUser();
    if (!actor) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);

    const { data: actorProfile } = await adminClient
      .from("profiles")
      .select("is_super_admin")
      .eq("id", actor.id)
      .maybeSingle();

    if (!actorProfile?.is_super_admin) {
      return json({ error: "Super admin only" }, 403);
    }

    // --- 2) الطلب ---
    const { userId, dataUrl, remove } = await req.json();
    if (!userId) return json({ error: "userId مطلوب" }, 400);

    const { data: target } = await adminClient
      .from("profiles")
      .select("id, email, display_name, avatar_url")
      .eq("id", userId)
      .maybeSingle();

    if (!target) return json({ error: "المستخدم غير موجود" }, 404);

    const oldPath = storagePathFromUrl(target.avatar_url, userId);

    // --- 3) حذف الصورة ---
    if (remove) {
      const { error: clearError } = await adminClient
        .from("profiles")
        .update({ avatar_url: null })
        .eq("id", userId);

      if (clearError) throw clearError;

      if (oldPath) {
        await adminClient.storage.from("avatars").remove([oldPath]);
      }

      return json({ success: true, url: null, message: "تم حذف الصورة" });
    }

    // --- 4) رفع صورة جديدة ---
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return json({ error: "الصيغة غير مدعومة" }, 400);
    }

    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return json({ error: "تعذّر قراءة الصورة" }, 400);

    const contentType = match[1].toLowerCase();
    if (!ALLOWED.includes(contentType)) {
      return json({ error: "الأنواع المسموحة: JPEG أو PNG أو WebP" }, 400);
    }

    const binary = Uint8Array.from(atob(match[2]), (ch) => ch.charCodeAt(0));
    if (!binary.byteLength) return json({ error: "صورة فارغة" }, 400);
    if (binary.byteLength > MAX_BYTES) {
      return json({ error: "حجم الصورة كبير — الحد 3 ميجابايت" }, 400);
    }

    const extension = contentType === "image/png" ? "png"
      : contentType === "image/webp" ? "webp"
      : "jpg";

    const path = `${userId}/avatar-${Date.now()}.${extension}`;

    const { error: uploadError } = await adminClient.storage
      .from("avatars")
      .upload(path, binary, { contentType, upsert: true, cacheControl: "3600" });

    if (uploadError) throw uploadError;

    const { data: publicData } = adminClient.storage.from("avatars").getPublicUrl(path);
    const publicUrl = publicData?.publicUrl;

    if (!publicUrl) throw new Error("تعذّر الحصول على رابط الصورة");

    const { error: updateError } = await adminClient
      .from("profiles")
      .update({ avatar_url: publicUrl })
      .eq("id", userId);

    if (updateError) throw updateError;

    // حذف الصورة السابقة بعد نجاح التحديث
    if (oldPath && oldPath !== path) {
      await adminClient.storage.from("avatars").remove([oldPath]);
    }

    return json({ success: true, url: publicUrl, message: "تم تحديث الصورة" });
  } catch (error) {
    console.error("admin-set-avatar error", error);
    return json({ error: (error as Error)?.message || "فشل تحديث الصورة" }, 500);
  }
});
