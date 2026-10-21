'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_INITIAL_PASSWORD = 'AdminTemporal123';
process.env.PARTNER_EMAIL = 'paulina@example.test';
process.env.PARTNER_INITIAL_PASSWORD = 'PartnerTemporal123';

const { createApp } = require('../server');

async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}
const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/equipo-${n}-abcdefghijk`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

async function setup(context) {
  const pushes = [];
  const webPush = { sendNotification: async (s, payload, opts) => { if (s.endpoint.includes('viejo')) throw Object.assign(new Error('Gone'), { statusCode: 410 }); pushes.push({ endpoint: s.endpoint, payload: JSON.parse(payload), opts }); } };
  const app = await createApp({ skipPurgeTimer: true, webPush });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  return { baseUrl, partner, admin, pushes, store: app.locals.dataStore };
}

test('TP-312: manifiesto, service worker e íconos de la app', async (context) => {
  const { baseUrl } = await setup(context);
  const m = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.short_name, 'Travel Partner');
  assert.deepEqual(manifest.shortcuts.map((s) => s.url), ['/?go=nuevo-lead', '/?go=hoy', '/?go=cotizaciones']);
  assert.equal(manifest.share_target.params.text, 'share_text');
  for (const icon of manifest.icons) assert.equal((await fetch(`${baseUrl}${icon.src}`)).status, 200, icon.src);
  const sw = await fetch(`${baseUrl}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const html = await (await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } })).text();
  assert.match(html, /rel="manifest"/);
  assert.match(html, /app-movil\.js/);
});

test('TP-312: activar notificaciones y recibir cada aviso de la campanita como push', async (context) => {
  const { partner, admin, pushes, store } = await setup(context);
  const key = await partner('GET', '/api/push/key');
  assert.equal(key.status, 200);
  assert.match(key.body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal((await admin('GET', '/api/push/key')).body.publicKey, key.body.publicKey, 'una sola clave para todos');
  assert.equal((await partner('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://inseguro', keys: {} } })).status, 400);
  assert.equal((await partner('POST', '/api/push/subscribe', { subscription: sub(1) })).status, 200);
  assert.equal((await partner('POST', '/api/push/subscribe', { subscription: sub(1) })).status, 200, 'el mismo equipo no se duplica');
  assert.equal((await partner('GET', '/api/push/key')).body.devices, 1);

  const t = await partner('POST', '/api/push/test');
  assert.equal(t.body.sent, 1);
  assert.match(pushes[0].payload.title, /Notificaciones activadas/);
  assert.equal(pushes[0].opts.vapidDetails.publicKey, key.body.publicKey);

  // Un lead asignado a Paulina genera aviso → push con liga al lead.
  const users = (await admin('GET', '/api/users')).body.users;
  const paulina = users.find((u) => u.email === 'paulina@example.test');
  const lead = (await admin('POST', '/api/leads', { client: { name: 'Mario Paz', phone: '998 555 1212' }, destination: 'Holbox', owner_id: paulina.id })).body.record;
  await new Promise((r) => setTimeout(r, 50));
  const p = pushes.find((x) => /Mario Paz/.test(x.payload.title));
  assert.ok(p, 'llega el push del lead nuevo');
  assert.equal(p.payload.url, `/?lead=${lead.id}`);
  // Avisos con liga (trip:…) llevan ?n=
  await store.createNotification({ userId: paulina.id, kind: 'proveedor', title: 'Precio recibido', body: 'x', link: 'trip:9' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushes.at(-1).payload.url, '/?n=trip%3A9');

  // Los equipos que el navegador dio de baja (410) se quitan solos.
  await partner('POST', '/api/push/subscribe', { subscription: { ...sub(2), endpoint: 'https://fcm.googleapis.com/fcm/send/viejo-xyz-abcdefghijk' } });
  assert.equal((await partner('GET', '/api/push/key')).body.devices, 2);
  await partner('POST', '/api/push/test');
  assert.equal((await partner('GET', '/api/push/key')).body.devices, 1);
  assert.equal((await partner('POST', '/api/push/unsubscribe', { endpoint: sub(1).endpoint })).status, 200);
  assert.equal((await partner('GET', '/api/push/key')).body.devices, 0);
});
