import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { JWT } from "https://esm.sh/google-auth-library@8.7.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") || "";
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") || "";
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getAccessToken() {
  const client = new JWT({
    email: FIREBASE_CLIENT_EMAIL,
    key: FIREBASE_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const tokens = await client.authorize();
  return tokens.access_token;
}

// سجل تشخيصي: كل نداء يُسجَّل (للمشرف العام) لمعرفة هل أُرسل الإشعار ولمن ونتيجة FCM.
async function writeLog(admin, entry) {
  try {
    await admin.from("push_logs").insert(entry);
  } catch (_) {
    // السجل تشخيصي فقط — لا يُفشل الإرسال أبداً.
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const admin = createClient(supabaseUrl, serviceKey);
  try {
    const payload = await req.json();
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user: actor } } = await userClient.auth.getUser();
    if (!actor) return json({ error: "Unauthorized" }, 401);

    const isSelfTest = payload?.test === true;
    const isCall = Boolean(payload?.call?.conversationId);   // v61: إشعار مكالمة
    const delaySeconds = Math.min(Math.max(Number(payload?.delaySeconds) || 0, 0), 25);

    let receiverId;
    let conversationId = null;
    let messageId = "";
    let senderId = actor.id;
    let receiverIsAdmin = false;
    let body = "";
    let kind = "message";

    if (isSelfTest) {
      // اختبار ذاتي: يُرسَل إلى أجهزة الطالب نفسه للتأكد من وصول الإشعارات.
      kind = "test";
      body = payload?.body || "اختبار الإشعارات ✅ إن كنت ترى هذا الإشعار فالإشعارات تعمل على جهازك.";
      receiverId = actor.id;
    } else if (isCall) {
      // v61: مكالمة (رنين وهمي بلا صوت) — إشعار «مكالمة واردة» أو «مكالمة لم يرد عليها»
      const call = payload.call;
      kind = "call";
      body = String(call.event) === "missed" ? "📞 مكالمة لم يرد عليها" : "📞 مكالمة واردة…";

      const { data: conversation, error: conversationError } = await admin
        .from("conversations")
        .select("user_id, admin_id")
        .eq("id", call.conversationId)
        .single();
      if (conversationError) throw conversationError;
      if (![conversation.user_id, conversation.admin_id].some((id) => String(id) === String(actor.id))) {
        return json({ error: "Caller is not a participant" }, 403);
      }

      conversationId = call.conversationId;
      messageId = String(call.callId || "");
      senderId = actor.id;
      receiverId = String(actor.id) === String(conversation.user_id)
        ? conversation.admin_id
        : conversation.user_id;

      const { data: receiverProfile } = await admin
        .from("profiles")
        .select("is_admin, is_super_admin")
        .eq("id", receiverId)
        .maybeSingle();
      receiverIsAdmin = Boolean(receiverProfile?.is_admin || receiverProfile?.is_super_admin);
    } else {
      const record = payload?.record || payload?.new_record || payload;
      if (String(actor.id) !== String(record?.sender_id)) return json({ error: "Unauthorized sender" }, 401);
      if (!record?.conversation_id || !record?.sender_id) return json({ error: "Invalid message payload" }, 400);

      const { data: conversation, error: conversationError } = await admin
        .from("conversations")
        .select("user_id, admin_id")
        .eq("id", record.conversation_id)
        .single();
      if (conversationError) throw conversationError;
      if (![conversation.user_id, conversation.admin_id].some((id) => String(id) === String(actor.id))) {
        return json({ error: "Sender is not a participant" }, 403);
      }

      conversationId = record.conversation_id;
      messageId = String(record.id || "");
      senderId = record.sender_id;
      receiverId = String(record.sender_id) === String(conversation.user_id)
        ? conversation.admin_id
        : conversation.user_id;

      const { data: receiverProfile } = await admin
        .from("profiles")
        .select("is_admin, is_super_admin")
        .eq("id", receiverId)
        .maybeSingle();
      receiverIsAdmin = Boolean(receiverProfile?.is_admin || receiverProfile?.is_super_admin);

      body = record.content || (
        record.attachment_type === "image"
          ? "📷 صورة"
          : record.attachment_type === "video"
          ? "🎬 فيديو"
          : record.attachment_type === "audio"
          ? "🎤 رسالة صوتية"
          : "📎 ملف"
      );
    }

    // v47: عنوان الإشعار = اسم المرسل (مثل واتساب) بدل «رسالة جديدة»
    let senderName = "رسالة جديدة";
    if (!isSelfTest && senderId) {
      const { data: senderProfile } = await admin
        .from("profiles")
        .select("display_name, phone")
        .eq("id", senderId)
        .maybeSingle();
      senderName = senderProfile?.display_name || senderProfile?.phone || "رسالة جديدة";
    }

    if (isCall) senderName = `📞 ${senderName}`;

    const { data: tokens, error: tokenError } = await admin
      .from("fcm_tokens")
      .select("token")
      .eq("user_id", receiverId);
    if (tokenError) throw tokenError;

    if (!tokens?.length) {
      await writeLog(admin, {
        kind,
        conversation_id: conversationId,
        sender_id: senderId,
        receiver_id: receiverId,
        receiver_is_admin: receiverIsAdmin,
        tokens: 0,
        ok_count: 0,
        results: [],
        error: "no-tokens",
      });
      return json({ sent: 0, receiverIsAdmin, reason: "no-tokens" });
    }

    // مهلة إضافية للاختبار الذاتي: يمنح المستخدم وقتاً لإغلاق التطبيق قبل وصول الإشعار.
    if (delaySeconds > 0) await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));

    const accessToken = await getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;

    // v11: نُرسل حقل notification مع webpush.notification حتى يعرض المتصفح الإشعار
    // بنفسه (مسار مستقل عن كود service worker)، مع الحفاظ على data للأزرار والفتح.
    // ⚠️ حقول الويب (icon/badge/tag/actions…) لا يقبلها message.notification في FCM v1،
    //    بل تُوضع في webpush.notification. الحقل العلوي يحتوي العنوان والنص فقط.
    const webNotification = {
      title: senderName,
      body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: messageId || conversationId || `wa-${Date.now()}`,
      renotify: true,
      requireInteraction: true,
      vibrate: [100, 50, 100],
    };
    if (receiverIsAdmin && !isSelfTest && !isCall) {
      webNotification.actions = [
        { action: "reply-done", title: "✅ تمّت المعالجة" },
        { action: "reply-ack", title: "👋 وصلنا طلبك" },
      ];
    }
    const link = conversationId ? `./index.html?conversation=${conversationId}` : "./index.html";

    const results = await Promise.all(tokens.map(async ({ token }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: senderName, body },
            data: {
              title: senderName,
              body,
              conversationId: String(conversationId || ""),
              senderId: String(senderId || ""),
              messageId: String(messageId || ""),
              icon: "./icons/icon-192.png",
              click_action: link,
              isAdmin: receiverIsAdmin ? "true" : "false",
            },
            android: { priority: "high" },
            webpush: {
              headers: { Urgency: "high" },
              notification: webNotification,
              fcm_options: { link },
            },
          },
        }),
      });

      const payloadJson = await response.json().catch(() => null);

      // v10: تنقية تلقائية — إن رفض FCM التوكن (جهاز حُذف/متصفح أُعيد تثبيته)
      // نحذفه من الجدول حتى لا يُكرَّر الإرسال إليه في كل رسالة.
      const errorStatus = String(payloadJson?.error?.status || "");
      const details = Array.isArray(payloadJson?.error?.details) ? payloadJson.error.details : [];
      const tokenFieldInvalid = details.some((d) =>
        Array.isArray(d?.fieldViolations) &&
        d.fieldViolations.some((v) => String(v?.field || "").includes("token"))
      );
      const shouldDelete =
        response.status === 404 ||
        errorStatus === "UNREGISTERED" ||
        errorStatus === "NOT_FOUND" ||
        tokenFieldInvalid;

      let cleaned = false;
      if (shouldDelete) {
        const { error: delError } = await admin.from("fcm_tokens").delete().eq("token", token);
        cleaned = !delError;
      }

      return {
        status: response.status,
        error: errorStatus || null,
        message: payloadJson?.error?.message || null,
        cleaned,
        tokenTail: String(token).slice(-8),
        body: payloadJson,
      };
    }));

    const okCount = results.filter((r) => r.status === 200).length;

    // v12: تسريع علامات الصح — قبول FCM للرسالة يعني أنها في طريقها لجهاز
    // المستلم، فنحدّث حالتها إلى «وصلت» من الخادم مباشرةً بدل انتظار فتح
    // التطبيق عند المستلم (كانت العلامة الثانية تتأخر أو تحتاج إعادة فتح).
    let delivered = false;
    if (!isSelfTest && messageId && okCount > 0) {
      const { error: markError } = await admin
        .from("messages")
        .update({ status: "delivered" })
        .eq("id", messageId)
        .eq("status", "sent");
      delivered = !markError;

      if (conversationId) {
        await admin
          .from("conversations")
          .update({ last_message_status: "delivered" })
          .eq("id", conversationId)
          .eq("last_sender_id", senderId)
          .eq("last_message_status", "sent");
      }
    }

    await writeLog(admin, {
      kind,
      conversation_id: conversationId,
      sender_id: senderId,
      receiver_id: receiverId,
      receiver_is_admin: receiverIsAdmin,
      tokens: tokens.length,
      ok_count: okCount,
      results: results.map((r) => ({ status: r.status, error: r.error, cleaned: r.cleaned, token: r.tokenTail })),
      error: null,
      body: String(body).slice(0, 120),
      delivered,
    });

    return json({ sent: tokens.length, okCount, receiverIsAdmin, results });
  } catch (error) {
    return json({ error: String(error?.message || error) }, 500);
  }
});
