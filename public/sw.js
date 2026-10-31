'use strict';

/* TP-312 · Service worker de la app Travel Partner
   - Abre aunque no haya internet: guarda la página, estilos, scripts e íconos.
   - Modo consulta sin conexión: si no hay red, entrega lo último que cargó /api/crm (y la sesión), marcado como "sin conexión".
   - Notificaciones push: muestra el aviso y al tocarlo abre la app en el lugar correcto.
   - No toca las páginas públicas (cotización, pago, itinerario, portal del cliente) ni ningún envío de datos. */
const VERSION = 'tp312-4';
const STATIC = `static-${VERSION}`;
const DATA = 'data-v1';
const SHELL = ['/', '/manifest.webmanifest', '/app/icon-192.png', '/app/icon-512.png', '/brand/logo-mark.png'];
const API_CACHE = ['/api/crm', '/api/auth/me', '/api/me/prefs', '/api/notifications'];
const STATIC_RE = /\.(?:js|css|png|jpg|jpeg|webp|svg|ico|woff2?|webmanifest)$/i;
const PUBLIC_RE = /^\/(?:cotizacion|pagar|contrato|viaje|encuesta|r|mi-portal|formulario|calendario|documento|proveedor)(?:\/|\.|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('static-') && k !== STATIC).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// El CRM avisa al cerrar sesión: se borra lo guardado para consulta sin conexión.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'logout') event.waitUntil(caches.delete(DATA));
});

const offlineCopy = async (cached) => {
  const body = await cached.blob();
  const headers = new Headers(cached.headers);
  headers.set('X-TP-Offline', '1');
  return new Response(body, { status: 200, headers });
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || PUBLIC_RE.test(url.pathname)) return;

  // Datos para consulta sin conexión: primero la red; sin red, la última copia.
  if (API_CACHE.includes(url.pathname)) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(url.pathname, copy)); }
      else if (res.status === 401) caches.delete(DATA);
      return res;
    }).catch(async () => {
      const cached = await caches.match(url.pathname, { cacheName: DATA });
      return cached ? offlineCopy(cached) : new Response(JSON.stringify({ ok: false, error: 'Sin conexión a internet' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-TP-Offline': '1' } });
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;

  // La página de la app: primero la red (siempre la versión más nueva); sin red, la guardada.
  if (req.mode === 'navigate') {
    if (url.pathname !== '/') return;
    event.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put('/', copy)); } return res; }).catch(() => caches.match('/', { cacheName: STATIC })));
    return;
  }

  // Scripts, estilos e imágenes (llevan ?v=… por versión): primero la copia guardada.
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(caches.open(STATIC).then(async (c) => {
      const hit = await c.match(req);
      const refresh = fetch(req).then((res) => { if (res.ok && res.type === 'basic') c.put(req, res.clone()); return res; });
      // Con ?v=… la copia guardada es exacta; sin versión se entrega la guardada y se actualiza por detrás.
      if (hit) { if (!url.search) refresh.catch(() => {}); return hit; }
      return refresh;
    }));
  }
});

// ---- Notificaciones push ----
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Travel Partner', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Travel Partner', {
    body: d.body || '', icon: '/app/icon-192.png', badge: '/app/badge-96.png',
    tag: d.tag || undefined, renotify: Boolean(d.tag), data: { url: d.url || '/' }, lang: 'es-MX'
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const app = list.find((w) => new URL(w.url).origin === self.location.origin && !PUBLIC_RE.test(new URL(w.url).pathname));
    if (app) { app.postMessage({ type: 'open', url: target }); return app.focus(); }
    return self.clients.openWindow(target);
  }));
});
