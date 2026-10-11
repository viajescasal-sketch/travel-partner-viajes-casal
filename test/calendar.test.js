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
const { buildIcs, icsUtc } = require('../src/calendar');

test('formato iCalendar: hora de Cancún a UTC, texto escapado y líneas cortas', () => {
  assert.equal(icsUtc('2026-10-12 10:00:00'), '20261012T150000Z');
  assert.equal(icsUtc('2026-10-12 21:45:00', 30), '20261013T031500Z', 'cruza la medianoche en UTC');
  const ics = buildIcs({
    calendarName: 'Seguimientos CRM · Paulina',
    followups: [{ id: 7, type: 'Llamada', title: 'Llamar a Ana, por la cotización; urgente', details: 'Línea 1\nLínea 2 '.repeat(20), due_at: '2026-10-12 10:00:00', done: false, client_id: 1, lead_id: 2 }],
    data: { clients: [{ id: 1, name: 'Ana López', phone: '+52 998 123 4567' }], leads: [{ id: 2, destination: 'Cancún', stage: 'Cotizado' }] },
    appUrl: 'https://crm.example.test', host: 'crm.example.test', now: new Date('2026-10-10T12:00:00Z')
  });
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `línea demasiado larga: ${line}`);
  const flat = ics.replace(/\r\n /g, '');
  assert.match(flat, /^BEGIN:VCALENDAR\r\n/);
  assert.match(flat, /DTSTART:20261012T150000Z\r\nDTEND:20261012T153000Z/);
  assert.match(flat, /SUMMARY:📞 Llamar a Ana\\, por la cotización\\; urgente · Ana López/);
  assert.match(flat, /UID:seguimiento-7@crm\.example\.test/);
  assert.match(flat, /TRIGGER:-PT10M/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `línea demasiado larga: ${line}`);
});

async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}

test('liga de Google Calendar: privada por usuario, solo sus seguimientos y renovable', async (context) => {
  const app = await createApp({});
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/api/calendar/feed`)).status, 401, 'pedir la liga requiere sesión');
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);

  const lead = await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún' });
  assert.equal(lead.status, 201);
  assert.equal((await partner('POST', '/api/followups', { lead_id: lead.body.record.id, type: 'WhatsApp', title: 'Enviar opciones a Ana', due_at: '2099-01-15 10:30' })).status, 201);
  assert.equal((await admin('POST', '/api/followups', { type: 'Llamada', title: 'Pendiente del administrador', due_at: '2099-01-16 09:00' })).status, 201);

  const mine = await partner('GET', '/api/calendar/feed');
  assert.equal(mine.status, 200);
  assert.match(mine.body.url, /\/calendario\/[a-f0-9]{48}\.ics$/);
  assert.equal((await partner('GET', '/api/calendar/feed')).body.url, mine.body.url, 'la liga se conserva');

  const feed = await fetch(mine.body.url.replace(/^https?:\/\/[^/]+/, baseUrl));
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  const ics = (await feed.text()).replace(/\r\n /g, '');
  assert.match(ics, /X-WR-CALNAME:Seguimientos CRM/);
  assert.match(ics, /SUMMARY:💬 Enviar opciones a Ana · Ana López/);
  assert.match(ics, /DTSTART:20990115T153000Z/);
  assert.doesNotMatch(ics, /Pendiente del administrador/, 'el vendedor no ve lo de otros');

  const adminIcs = (await (await fetch((await admin('GET', '/api/calendar/feed')).body.url.replace(/^https?:\/\/[^/]+/, baseUrl))).text()).replace(/\r\n /g, '');
  assert.match(adminIcs, /Pendiente del administrador/);
  assert.doesNotMatch(adminIcs, /Enviar opciones a Ana/, 'el administrador ve en Google solo lo suyo');

  // Renovar invalida la liga anterior
  const renewed = await partner('POST', '/api/calendar/feed/reset');
  assert.notEqual(renewed.body.url, mine.body.url);
  assert.equal((await fetch(mine.body.url.replace(/^https?:\/\/[^/]+/, baseUrl))).status, 404);
  assert.equal((await fetch(`${baseUrl}/calendario/no-existe.ics`)).status, 404);
  assert.equal((await fetch(renewed.body.url.replace(/^https?:\/\/[^/]+/, baseUrl))).status, 200);
});
