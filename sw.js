const CACHE_NAME = "wa-clone-shell-v40";
// هيكل التطبيق: كل ما يلزم للإقلاع بلا إنترنت (بما فيه المكتبات المحلية)
const APP_SHELL = [
  "./",
  "./index.html",
  "./partials/chat-panel.html",
  "./css/style.css",
  "./js/app.js",
  "./js/auth.js",
  "./js/config.js",
  "./js/identity.js",
  "./js/i18n.js",
  "./js/supabaseClient.js",
  "./js/db.js",
  "./js/push.js",
  "./js/google-signin.js",
  "./vendor/supabase-js.js",
  "./vendor/firebase/firebase-app.js",
  "./vendor/firebase/firebase-auth.js",
  "./vendor/firebase/firebase-messaging.js",
  "./vendor/firebase/firebase-app-compat.js",
  "./vendor/firebase/firebase-messaging-compat.js",
  "./firebase-messaging-sw.js",
  "./manifest.json",
  "./version.json",
  "./icons/icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/favicon-16.png",
  "./icons/org-logo-512.png",
  "./icons/notify.mp3",
];

// تثبيت: ننزّل الهيكل كاملاً. كل ملف على حدة (allSettled) حتى لا يُسقط ملفٌ
// واحد تعذّر تنزيله بقية الكاش — كان هذا أحد أسباب الإقلاع الناقص بلا إنترنت.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// مطابقة الكاش مع تجاهل رقم النسخة (?v=37). سابقاً كانت المطابقة بالرابط الكامل،
// فتفشل بلا إنترنت لأن المخزَّن بلا `?v=` والمطلوب معه ⇒ كان المتصفح يستلم
// index.html مكان app.js فيتوقف التطبيق عند الإقلاع.
function matchCached(request) {
  return caches
    .match(request, { ignoreSearch: true })
    .then((hit) => hit || caches.match(request));
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8" };

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // 1) التنقّل بين الصفحات: الشبكة أولاً، ثم نسخة الهيكل المخزّنة
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)).catch(() => {});
        }
        return response;
      } catch (err) {
        return (
          (await matchCached("./index.html")) ||
          new Response("لا يوجد اتصال ولا نسخة مخزّنة من التطبيق.", { status: 503, headers: TEXT })
        );
      }
    })());
    return;
  }

  // 2) ملفات التطبيق: الشبكة أولاً (لتصل التحديثات فوراً) ثم الكاش بلا إنترنت
  if (isSameOrigin) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      } catch (err) {
        const cached = await matchCached(request);
        if (cached) return cached;
        return new Response("", { status: 504, statusText: "offline", headers: TEXT });
      }
    })());
    return;
  }

  // 3) طلبات خارجية (Firebase/Supabase): تُترك للشبكة، وبلا اتصال نُعيد رداً واضحاً
  event.respondWith(
    fetch(request).catch(() => new Response("", { status: 503, headers: TEXT }))
  );
});
