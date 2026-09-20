# Test push request example

Use this example to send a Firebase push test after the project is running over HTTPS or localhost.

## 1) Get Firebase server key
From Firebase Console:
- Project Settings
- Cloud Messaging
- Service accounts
- Generate new private key

Then use the server key or a custom backend that sends the request to:
`https://fcm.googleapis.com/fcm/send`

## 2) Example curl request
```bash
curl -X POST "https://fcm.googleapis.com/fcm/send" \
  -H "Authorization: key=YOUR_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "DEVICE_FCM_TOKEN",
    "notification": {
      "title": "رسالة جديدة",
      "body": "لديك رسالة جديدة"
    },
    "data": {
      "title": "رسالة جديدة",
      "body": "لديك رسالة جديدة",
      "conversationId": "123e4567-e89b-12d3-a456-426614174000",
      "icon": "./icons/icon.png",
      "badge": "./icons/icon.png"
    }
  }'
```

## 3) Example using Node.js server
```js
fetch('https://fcm.googleapis.com/fcm/send', {
  method: 'POST',
  headers: {
    'Authorization': 'key=YOUR_SERVER_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    to: 'DEVICE_FCM_TOKEN',
    notification: {
      title: 'رسالة جديدة',
      body: 'لديك رسالة جديدة'
    },
    data: {
      title: 'رسالة جديدة',
      body: 'لديك رسالة جديدة',
      conversationId: '123e4567-e89b-12d3-a456-426614174000',
      icon: './icons/icon.png',
      badge: './icons/icon.png'
    }
  })
});
```

## 4) Expected behavior
- Notification appears in the device notification tray.
- Clicking it opens the app or the correct conversation.
- Background worker should process the payload in `firebase-messaging-sw.js`.
