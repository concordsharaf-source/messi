# Deployment and production notes

## 1) Use secure hosting
- Deploy to HTTPS-enabled host.
- Prefer Vercel, Netlify, Cloudflare Pages, or a custom HTTPS server.

## 2) Firebase config
- Set the real Firebase config values in both `js/push.js` and `firebase-messaging-sw.js`.
- Keep them identical.

## 3) Web notifications
- App must request notifications permission from the browser.
- Service worker must be registered correctly.
- `firebase-messaging-sw.js` must be in the root of the project.

## 4) Supabase
- Run SQL from `sql/fcm_and_rls.sql`.
- Confirm RLS is enabled and correct policies are active.

## 5) Production checklist
- HTTPS enabled
- Firebase project active
- valid VAPID key
- valid FCM token generated
- push test succeeds
- notification click opens correct view
- no `importScripts` error in console

## 6) General recommendations
- Keep push payloads compact.
- Send only meaningful alerts.
- Use `conversationId` in `data` for targeted opening behavior.
- Keep app shell cached but not stale.
- Use lightweight animations and avoid heavy re-renders.
