# Final setup checklist for WhatsApp-style PWA

## 1) Firebase setup
- Create a Firebase project.
- Enable Cloud Messaging.
- Register a Web app and copy the config values.
- Make sure `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId` match the project exactly.
- Generate a VAPID key from Firebase Console > Cloud Messaging > Web Push certificates.
- Paste the VAPID key in `js/push.js` as `VAPID_KEY`.

## 2) Site must be secure
- App must run on `https://` or `localhost`.
- Do not open directly via `file://`.

## 3) Service workers
- Keep `firebase-messaging-sw.js` at the root of the site.
- Keep `sw.js` at the root of the site.
- Do not load the Firebase worker as a regular script inside the HTML page.
- Register the Firebase worker with `navigator.serviceWorker.register(..., { scope: "/firebase-cloud-messaging-push-scope/", type: "module" })`.

## 4) Supabase setup
- Ensure the project URL and anon key are correct in `js/config.js`.
- Run the SQL in `sql/fcm_and_rls.sql` inside Supabase SQL Editor.
- Make sure `public.typing_status`, `public.fcm_tokens`, `public.messages`, and `public.conversations` have RLS enabled and policies created.

## 5) PWA configuration
- Ensure `manifest.json` exists and contains the proper app metadata.
- Ensure app icons are present in the `icons` folder.
- Ensure the notification sound file exists.

## 6) Testing checklist
- Open site over HTTPS or localhost.
- Sign in.
- Click enable push.
- Check browser console for FCM token generation.
- Confirm there is no `importScripts is not defined` error.
- Confirm the service worker is visible in DevTools > Application > Service Workers.
- Send a test push message from Firebase or a server.
- Confirm the notification appears while the app is in background.
- Click notification and verify it opens the correct chat or page.

## 7) Recommended production rules
- Keep `notifications` only for important updates.
- Avoid sending duplicate push payloads.
- Use `conversationId` in `data` and `notification` payloads for click handling.
- Ensure the server-side push sender includes `data` with the right conversation ID.

## 8) Known notes
- `Page entered Back-Forward Cache` is usually a browser warning and not necessarily a fatal app bug.
- The real blockers are usually RLS permission problems, secure context issues, or Firebase config mismatches.
