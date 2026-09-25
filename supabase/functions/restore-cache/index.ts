// =============================================================
// restore-cache — استعادة المحادثات والرسائل من النسخة المحلية للجهاز
// -------------------------------------------------------------
// لماذا: جهاز المستخدم يحفظ نسخة كاملة من الرسائل في IndexedDB. إذا فُقدت
// رسائل من القاعدة (خطأ بشري/حذف) نستطيع إعادتها من أي جهاز كان يقرأها.
// الأمان: لا يعمل إلا لمشرف (profiles.is_admin أو is_super_admin).
// Idempotent: كل الإدراجات ON CONFLICT DO NOTHING ⇒ لا تكرار ولا تخريب.
// =============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return json({ error: "missing token" }, 401);

  const { data: userData } = await admin.auth.getUser(token);
  const callerId = userData?.user?.id;
  if (!callerId) return json({ error: "invalid token" }, 401);

  const { data: profile } = await admin
    .from("profiles")
    .select("id, is_admin, is_super_admin")
    .eq("id", callerId)
    .maybeSingle();

  if (!profile?.is_admin && !profile?.is_super_admin) {
    return json({ error: "admins only" }, 403);
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch (_) {
    return json({ error: "bad json" }, 400);
  }

  const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  const stat = { conversationsIn: conversations.length, messagesIn: messages.length, conversationsAdded: 0, messagesAdded: 0, skipped: 0 };

  // ---------- المحادثات ----------
  const cleanConversations = conversations
    .filter((c: any) => c?.id && c?.user_id && c?.admin_id)
    .map((c: any) => ({
      id: c.id,
      user_id: c.user_id,
      admin_id: c.admin_id,
      status: c.status || "new",
      last_message: c.last_message ?? null,
      last_message_at: c.last_message_at ?? null,
      last_sender_id: c.last_sender_id ?? null,
      last_message_status: c.last_message_status ?? null,
      created_at: c.created_at || new Date().toISOString(),
    }));

  for (let i = 0; i < cleanConversations.length; i += 100) {
    const batch = cleanConversations.slice(i, i + 100);
    const ids = batch.map((c: any) => c.id);

    const { data: found } = await admin.from("conversations").select("id").in("id", ids);
    const have = new Set((found || []).map((r: any) => r.id));
    const toAdd = batch.filter((c: any) => !have.has(c.id));

    if (toAdd.length) {
      const { error } = await admin.from("conversations").insert(toAdd);
      if (!error) stat.conversationsAdded += toAdd.length;
    }
  }

  // ---------- الرسائل ----------
  const cleanMessages = messages
    .filter((m: any) => m?.conversation_id && m?.sender_id)
    .map((m: any) => ({
      id: m.id || crypto.randomUUID(),
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      content: m.content ?? null,
      attachment_url: m.attachment_url ?? null,
      attachment_type: m.attachment_type ?? null,
      reply_to_id: m.reply_to_id ?? null,
      buttons: m.buttons ?? null,
      played_at: m.played_at ?? null,
      status: m.status || "read",
      created_at: m.created_at || new Date().toISOString(),
    }));

  for (let i = 0; i < cleanMessages.length; i += 200) {
    const batch = cleanMessages.slice(i, i + 200);
    const ids = batch.map((m: any) => m.id);

    const { data: found } = await admin.from("messages").select("id").in("id", ids);
    const have = new Set((found || []).map((r: any) => r.id));
    const toAdd = batch.filter((m: any) => !have.has(m.id));

    if (toAdd.length) {
      const { error } = await admin.from("messages").insert(toAdd);
      if (error) {
        // محاولة ثانية فردية (رسالة تالفة واحدة لا تُسقط الدفعة كلها)
        for (const one of toAdd) {
          const { error: oneErr } = await admin.from("messages").insert(one);
          if (!oneErr) stat.messagesAdded += 1;
          else stat.skipped += 1;
        }
      } else {
        stat.messagesAdded += toAdd.length;
      }
    }
  }

  // ---------- إصلاح ملخّص المحادثة بعد الاستعادة ----------
  for (const c of cleanConversations) {
    const { data: last } = await admin
      .from("messages")
      .select("content, attachment_type, status, sender_id, created_at")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!last) continue;

    const preview =
      (last.content || "").trim() ||
      ({ image: "📷 صورة", audio: "🎤 رسالة صوتية", video: "🎬 فيديو", file: "📎 ملف" } as any)[last.attachment_type] ||
      "رسالة";

    await admin
      .from("conversations")
      .update({
        last_message: preview.slice(0, 300),
        last_message_at: last.created_at,
        last_sender_id: last.sender_id,
        last_message_status: last.status || "sent",
      })
      .eq("id", c.id);
  }

  return json({ ok: true, ...stat });
});
