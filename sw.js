const CACHE = 'orbit-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* ── REMINDER STATE ── */
const SLOT_HOURS = { '6am':6, '9am':9, '12pm':12, '3pm':15, '6pm':18, '9pm':21 };
let activeAlarms  = {};
let savedReminders = [];
let savedItemCount = 0;

function msUntilSlot(hour) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function fireNotification(slot) {
  const body = savedItemCount > 0
    ? `${savedItemCount} item${savedItemCount !== 1 ? 's' : ''} scheduled today — keep going!`
    : 'Time to study! Open Orbit to check your progress.';
  self.registration.showNotification('Orbit 📚', {
    body,
    icon:     './icon-192.png',
    badge:    './icon-192.png',
    tag:      'orbit-' + slot,   /* replaces previous same-slot notification */
    renotify: true,              /* Bug8 fix: always show even if previous exists */
    data:     { slot },
  }).catch(() => {});
  /* Reschedule for next day */
  scheduleSlot(slot);
}

function scheduleSlot(slot) {
  if (!SLOT_HOURS[slot]) return;
  /* Clear existing timer for this slot */
  if (activeAlarms[slot]) { clearTimeout(activeAlarms[slot]); delete activeAlarms[slot]; }
  /* Only schedule if still in saved reminder list */
  if (!savedReminders.includes(slot)) return;
  const ms = msUntilSlot(SLOT_HOURS[slot]);
  activeAlarms[slot] = setTimeout(() => {
    delete activeAlarms[slot];
    if (!savedReminders.includes(slot)) return;
    fireNotification(slot);
  }, ms);
}

function applyReminders(reminders, itemCount) {
  savedReminders = reminders || [];
  savedItemCount = itemCount  || 0;
  /* Cancel any slot no longer in list */
  Object.keys(activeAlarms).forEach(slot => {
    if (!savedReminders.includes(slot)) {
      clearTimeout(activeAlarms[slot]);
      delete activeAlarms[slot];
    }
  });
  /* Schedule any new slots */
  savedReminders.forEach(slot => {
    if (!activeAlarms[slot]) scheduleSlot(slot);
  });
}

/* ── INSTALL ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── FETCH (cache-first for assets, network-first for navigation) ── */
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

/* ── MESSAGES FROM PAGE ── */
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SET_REMINDERS') {
    applyReminders(e.data.reminders, e.data.itemCount);
  }
  if (e.data.type === 'PING') {
    e.source && e.source.postMessage({ type: 'PONG' });
  }
});

/* ── NOTIFICATION CLICK → open app ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes('index.html') || c.url.endsWith('/')) return c.focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});
