/* ══════════════════════════════════════════════
   Zeebas HR — Service Worker  (v2)
   Background WiFi check — works even when app
   is not open (Android Chrome / Chromium PWA)
   Now uses Web Push for reliable background wake.
   ══════════════════════════════════════════════ */

const SW_VERSION = 'zeebas-sw-v2';

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
        // Use minutesSinceLastPing = time since last WiFi ping (accurate "away from office" time).
        // minutesSinceCheckIn = total time since arrival — NOT what we want here.
        var awayMins = (typeof d.minutesSinceLastPing === 'number' && d.minutesSinceLastPing > 0)
          ? d.minutesSinceLastPing
          : (typeof d.minutesSinceCheckIn === 'number' ? d.minutesSinceCheckIn : 0);

        if (awayMins >= 40) {
          // Away from office WiFi for 40+ minutes → auto checkout
          var br = await fetch(auth.apiUrl + '/api/attendance/break-checkout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + auth.token }
          });
          var bd = await br.json();
          if (bd.success) {
            await self.registration.showNotification('⚠️ Auto Checked Out — Zeebas HR', {
              body: 'Away from office WiFi for 40+ min. Open app to return if you\'re back.',
              icon: '/icon-192.png',
              badge: '/icon-192.png',
              tag: 'zeebas-break',
              renotify: false
            });
          }
        }
        // Under 40 min — do nothing. Staff is still checked in.
        // The main app shows "Not in office" banner while WiFi is disconnected.
      }
    }
  } catch (e) {
    // Silently fail — network may be unavailable
    console.log('[SW] wifi check error:', e.message);
  }
}

// ── Event Listeners ───────────────────────────

// ── Push from server → run WiFi check silently ──
// This is the reliable path: server sends silent push every 10 min
// (Mon–Sat, 8:15–10:00 AM). SW wakes up, checks WiFi, auto check-in.
self.addEventListener('push', function(event) {
  var data = null;
  try { data = event.data ? event.data.json() : null; } catch(e) {}
  if (data && data.type === 'WIFI_CHECK') {
    // Silent push — no visible notification, just run the check
    event.waitUntil(doWifiCheck());
  }
});

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
