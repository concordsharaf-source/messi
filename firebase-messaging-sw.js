importScripts(
  "./vendor/firebase/firebase-app-compat.js",
  "./vendor/firebase/firebase-messaging-compat.js"
);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const firebaseConfig = {
  apiKey: "AIzaSyBwKUp6U1TdatxX20rPQSFdGUyPUHAksYw",
  authDomain: "messenger-4f50d.firebaseapp.com",
  projectId: "messenger-4f50d",
  storageBucket: "messenger-4f50d.firebasestorage.app",
  messagingSenderId: "553556100673",
  appId: "1:553556100673:web:ebf30e8bbcc35870b9a8c0",
};

firebase.initializeApp(firebaseConfig);

// ===============================================================
// v47: فتح «التطبيق» لا المتصفح عند النقر على الإشعار
// ---------------------------------------------------------------
// نُسجّل معالجنا قبل تهيئة Firebase حتى ينفّذ أولاً: نُركّز نافذة التطبيق
// القائمة إن وُجدت، وإلا نفتح رابط الإشعار (داخل نطاق التطبيق ⇒ يفتح
// التطبيق المثبَّت على أندرويد/آيفون بدل تبويب متصفح).
// ===============================================================
function fcmPayloadData(notification) {
  const raw = notification?.data?.FCM_MSG || null;
  const data = raw?.data || notification?.data || {};
  return {
    conversationId: data.conversationId || data.conversation_id || "",
    url: data.click_action || notification?.data?.url || "",
  };
}

self.addEventListener("notificationclick", (event) => {
  const { conversationId } = fcmPayloadData(event.notification);

  if (!conversationId) return;   // نترك المعالجة الافتراضية

  event.stopImmediatePropagation();
  event.notification.close();

  // نُفضّل فتح التطبيق المثبَّت (نطاق الجذر) على أي تبويب آخر
  const targetUrl = new URL(
    `./index.html?conversation=${encodeURIComponent(conversationId)}`,
    self.location.href
  ).href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    for (const client of clientList) {
      const clientUrl = new URL(client.url, self.location.href);
      if (clientUrl.origin === self.location.origin) {
        if ("focus" in client) {
          try { await client.focus(); } catch (_) {}
          client.postMessage({ type: "OPEN_CONVERSATION", conversationId });
          return;
        }
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

const messaging = firebase.messaging();

// FCM may retry delivery. Keep a short-lived in-memory id cache so a retry
// cannot create two system notifications while this worker is alive.
const recentMessageIds = new Map();
const MESSAGE_DEDUP_WINDOW_MS = 60_000;

function wasRecentlyHandled(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, timestamp] of recentMessageIds) {
    if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) recentMessageIds.delete(id);
  }
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.set(messageId, now);
  return false;
}

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Background message:", payload);

  const data = payload?.data || {};
  const notification = payload?.notification || {};

  // v44: صارت الرسائل تحمل حقل notification (من webpush.notification)، وFirebase
  // يعرض الإشعار تلقائياً في هذه الحالة — فلا نُظهر إشعاراً ثانياً للرسالة نفسها.
  if (notification.title || notification.body) {
    return;
  }
  const messageId = data.messageId || data.message_id || payload?.messageId || "";
  if (wasRecentlyHandled(messageId)) return;

  const conversationId = data.conversationId || data.conversation_id || "";
  const title = data.title || notification.title || "رسالة جديدة";
  const body = data.body || notification.body || "لديك رسالة جديدة";

  const notificationOptions = {
    body,
    icon: data.icon || "./icons/icon-192.png",
    badge: data.badge || "./icons/icon-192.png",
    tag: messageId || conversationId || "whatsapp-message",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { ...data, conversationId },
    vibrate: [100, 50, 100],
  };

  // أزرار الرد السريع تُعرض للمشرف فقط (هو من يردّ على المستخدم).
  // المستخدم العادي لا تُعرض له — حتى لا يظهر كأنه يرد على المشرف.
  if (isAdminRecipient(data)) {
    notificationOptions.actions = [
      { action: "reply-done", title: "✅ تمّت المعالجة" },
      { action: "reply-ack", title: "👋 وصلنا طلبك" },
    ];
  }

  return self.registration.showNotification(title, notificationOptions);
});

// ===============================================================
// الرد السريع من الإشعار (للمشرفين)
// ===============================================================

const SUPABASE_URL = "https://jjamwoidjxrdovsoftbq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_q_XwYPM5rgWw6c8t6BlEGg_jj2oApZY";

// هل صاحب هذا الإشعار مشرف؟ (يأتي العلم من دالّة send-push)
function isAdminRecipient(data) {
  return String(data?.isAdmin ?? "").toLowerCase() === "true";
}

const QUICK_REPLIES = {
  "reply-done": "✅ تمّت معالجة طلبك، شكراً لتواصلك معنا.",
  "reply-ack": "👋 وصلنا رسالتك، وسيتم الرد عليك في أقرب وقت.",
};

// جلسة المستخدم تُنسخ من التطبيق إلى IndexedDB (لا يمكن للمُشغِّل قراءة localStorage)
function readMirroredSession() {
  return new Promise((resolve) => {
    const request = indexedDB.open("messi-auth", 1);

    request.onerror = () => resolve(null);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("session")) {
        db.createObjectStore("session", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("session")) {
        resolve(null);
        return;
      }
      const tx = db.transaction("session", "readonly");
      const get = tx.objectStore("session").get("current");
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
  });
}

async function sendQuickReply(conversationId, text) {
  const session = await readMirroredSession();

  if (!session?.access_token || !session?.user_id) return { ok: false, reason: "no-session" };

  const expiresAt = Number(session.expires_at || 0);
  if (expiresAt && expiresAt * 1000 < Date.now() - 60000) {
    return { ok: false, reason: "expired" };
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      conversation_id: conversationId,
      sender_id: session.user_id,
      content: text,
      status: "sent",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.warn("[quick-reply] فشل الإرسال:", response.status, detail);
    return { ok: false, reason: `http-${response.status}` };
  }

  return { ok: true };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // v44: عند العرض التلقائي من Firebase تُخزَّن الحمولة كاملةً داخل مفتاح FCM_MSG،
  // أما إذا عرضها هذا المُشغِّل بنفسه فالحقول في data مباشرة. ندعم الحالتين.
  const rawPayload = event.notification?.data?.FCM_MSG || null;
  const data = rawPayload?.data || event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const action = event.action || "";
  // الرد السريع متاح للمشرف فقط — أي إشعار آخر يُفتح في التطبيق بلا إرسال.
  const quickText = isAdminRecipient(data) ? QUICK_REPLIES[action] : null;

  // ---- الرد السريع مباشرةً من الإشعار بلا فتح التطبيق ----
  if (quickText && conversationId) {
    event.waitUntil(
      sendQuickReply(conversationId, quickText).then((result) => {
        if (result.ok) {
          return self.registration.showNotification("تم الإرسال ✅", {
            body: quickText,
            icon: "./icons/icon-192.png",
            tag: `quick-${Date.now()}`,
            silent: true,
            requireInteraction: false,
          });
        }

        // تعذّر الإرسال (جلسة منتهية أو غير متوفرة) ⇒ نفتح التطبيق ليُرسلها
        return clients.openWindow(
          `./index.html?conversation=${encodeURIComponent(conversationId)}&quickreply=${encodeURIComponent(action)}`
        );
      })
    );
    return;
  }

  const targetUrl = conversationId
    ? `./index.html?conversation=${encodeURIComponent(conversationId)}`
    : "./index.html";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            if (conversationId) {
              client.postMessage({
                type: "OPEN_CONVERSATION",
                conversationId,
              });
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
        return null;
      })
  );
});

self.addEventListener("notificationclose", () => {
  // no-op
});
