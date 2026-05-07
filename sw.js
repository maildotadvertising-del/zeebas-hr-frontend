/* ══════════════════════════════════════════════
   Zeebas HR — Service Worker  (Option 1)
   Background WiFi check — works even when app
   is not open (Android Chrome / Chromium PWA)
   ══════════════════════════════════════════════ */

const SW_VERSION = 'zeebas-sw-v1';

// ── IndexedDB helpers ─────────────────────────
// Auth token + API URL are stored here by the
// main thread so the SW can read them at any time.

function openDB() {
  return new Promise((resolve, reject) => {
    var req = indexedDB.open('zeebas-sw-store', 1);
    req.onupgradeneeded = function(e) {
      e.target.result.createObjectStore('kv');
    };
    req.onsuccess  = function(e) { resolve(e.target.result); };
    req.onerror    = function(e) { reject(e.target.error); };
  });
}

async function dbGet(key) {
  var db = await openDB();
  return new Promise((resolve) => {
    var tx  = db.transaction('kv', 'readonly');
    var req = tx.objectStore('kv').get(key);
    req.onsuccess = function() { resolve(req.result); };
    req.onerror   = function() { resolve(null); };
  });
}

async function dbSet(key, val) {
  var db = await openDB();
  return new Promise((resolve) => {
    var tx  = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve;
  });
}

async function getAuth() {
  var token  = await dbGet('token');
  var apiUrl = await dbGet('apiUrl');
  return (token && apiUrl) ? { token, apiUrl } : null;
}

// ── Main WiFi check logic ─────────────────────
async function doWifiCheck() {
  var auth = await getAuth();
  if (!auth) return; // not logged in yet

  try {
    var r = await fetch(auth.apiUrl + '/api/attendance/wifi-detect', {
      headers: { 'Authorization': 'Bearer ' + auth.token }
    });
    if (!r.ok) return;
    var d = await r.json();
    if (!d.wifiEnabled) return;

    // ── ON OFFICE WIFI ──
    if (d.isOffice) {
      if (!d.alreadyCheckedIn) {
        // Auto check-in
        var cr = await fetch(auth.apiUrl + '/api/attendance/wifi-checkin', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + auth.token }
        });
        var cd = await cr.json();
        if (cd.success) {
          await self.registration.showNotification('✅ Checked In — Zeebas HR', {
            body: 'Auto checked in via Office WiFi',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: 'zeebas-checkin',
            renotify: false,
            silent: false
          });
        }
      }
      // Already checked in + returned from break → handled by break-return
      else if (d.checkedOut && d.isBreakCheckout) {
        // Don't auto-return from SW — require user to open app and choose Break/Office Work
        await self.registration.showNotification('📶 Back in Office — Zeebas HR', {
          body: 'Open the app to complete your break return',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'zeebas-return',
          renotify: false
        });
      }

    // ── OFF OFFICE WIFI ──
    } else {
      if (d.alreadyCheckedIn && !d.checkedOut) {
        var awayMins = (typeof d.minutesSinceCheckIn === 'number') ? d.minutesSinceCheckIn : 0;
        if (awayMins >= 5) {
          // Been checked in for 5+ min and off office WiFi → start break
          var br = await fetch(auth.apiUrl + '/api/attendance/break-checkout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + auth.token }
          });
          var bd = await br.json();
          if (bd.success) {
            await self.registration.showNotification('☕ Break Started — Zeebas HR', {
              body: 'You left office WiFi. Break timer started.',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: 'zeebas-break',
              renotify: false
            });
          }
        }
      }
    }
  } catch (e) {
    // Silently fail — network may be unavailable
    console.log('[SW] wifi check error:', e.message);
  }
}

// ── Event Listeners ───────────────────────────

// Message from main thread — store auth details
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SET_AUTH') {
    dbSet('token',  event.data.token);
    dbSet('apiUrl', event.data.apiUrl);
  }
  if (event.data && event.data.type === 'CLEAR_AUTH') {
    dbSet('token',  null);
    dbSet('apiUrl', null);
  }
});

// Background Periodic Sync — Chrome Android (fires ~every 15 min)
self.addEventListener('periodicsync', function(event) {
  if (event.tag === 'wifi-check') {
    event.waitUntil(doWifiCheck());
  }
});

// Background Sync — fires when device comes online after offline
// (useful when phone reconnects to any network after WiFi disconnect)
self.addEventListener('sync', function(event) {
  if (event.tag === 'wifi-online') {
    event.waitUntil(doWifiCheck());
  }
});

// Notification click — open the app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      if (list.length > 0) {
        return list[0].focus();
      }
      return clients.openWindow('/');
    })
  );
});

// Activate — claim all clients immediately
self.addEventListener('activate', function(event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('install', function(event) {
  self.skipWaiting();
});
