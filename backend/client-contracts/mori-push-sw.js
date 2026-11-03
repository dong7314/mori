/* Serve this file on the web application's origin and register with scope '/'. */
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || typeof payload.title !== 'string' || typeof payload.tag !== 'string') return;
  const target = new URL(payload.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.registration.showNotification(payload.title.slice(0, 180), {
    tag: payload.tag, renotify: false,
    data: { url: target.href, reminderId: payload.reminder_id },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target.href); return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
