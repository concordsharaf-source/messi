importScripts(
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
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

  // The sender uses data-only FCM messages. The notification fallback is kept
  // only for older queued messages during rollout.
  const data = payload?.data || {};
  const notification = payload?.notification || {};
  const messageId = data.messageId || data.message_id || payload?.messageId || "";
  if (wasRecentlyHandled(messageId)) return;

  const conversationId = data.conversationId || data.conversation_id || "";
  const title = data.title || notification.title || "رسالة جديدة";
  const body = data.body || notification.body || "لديك رسالة جديدة";

  const notificationOptions = {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: data.badge || "./icons/icon.png",
    tag: messageId || conversationId || "whatsapp-message",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { ...data, conversationId },
    vibrate: [100, 50, 100],
    // أزرار الرد السريع (تظهر في أندرويد وسطح المكتب)
    actions: [
      { action: "reply-done", title: "✅ تمّت المعالجة" },
      { action: "reply-ack", title: "👋 رد سريع" },
    ],
  };

  return self.registration.showNotification(title, notificationOptions);
});

// ===============================================================
// الرد السريع من الإشعار (للمشرفين)
// ===============================================================

const SUPABASE_URL = "https://jjamwoidjxrdovsoftbq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_q_XwYPM5rgWw6c8t6BlEGg_jj2oApZY";

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

  const data = event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const action = event.action || "";
  const quickText = QUICK_REPLIES[action];

  // ---- الرد السريع مباشرةً من الإشعار بلا فتح التطبيق ----
  if (quickText && conversationId) {
    event.waitUntil(
      sendQuickReply(conversationId, quickText).then((result) => {
        if (result.ok) {
          return self.registration.showNotification("تم الإرسال ✅", {
            body: quickText,
            icon: "./icons/icon.png",
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
