import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// مكتبة supabase-js محمَّلة محلياً من vendor/supabase-js.js (window.supabase)
// بلا إنترنت: نُفشل الطلب فوراً بدل أن يتعلّق التطبيق ثوانٍ في انتظار الشبكة.
// كل الكود يتعامل مع الفشل أصلاً (يقرأ من الكاش المحلي)، فالنتيجة: إقلاع فوري.
function offlineAwareFetch(input, init) {
  if (navigator.onLine === false) {
    return Promise.reject(new TypeError("offline"));
  }
  return fetch(input, init);
}

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
  global: { fetch: offlineAwareFetch },
});
