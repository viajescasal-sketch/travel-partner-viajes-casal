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
const { createReminders, addWorkMinutes } = require('../src/reminders');
const { createAssignment } = require('../src/assignment');

const work = { workStart: '09:00', workEnd: '20:00' };
const plusHours = (s, h) => new Date(Date.parse(`${s.replace(' ', 'T')}Z`) + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');

test('horario laboral: las horas solo corren de 9:00 a 20:00', () => {
  assert.equal(addWorkMinutes('2026-10-12 10:00:00', 120, work), '2026-10-12 12:00:00');
  assert.equal(addWorkMinutes('2026-10-12 19:00:00', 120, work), '2026-10-13 10:00:00', 'sigue al día siguiente');
  assert.equal(addWorkMinutes('2026-10-12 23:00:00', 120, work), '2026-10-13 11:00:00', 'de noche empieza a las 9:00');
  assert.equal(addWorkMinutes('2026-10-12 06:30:00', 120, work), '2026-10-12 11:00:00');
  assert.equal(addWorkMinutes('2026-10-12 06:30:00', 0, work), '2026-10-12 09:00:00');
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

test('recordatorios: cotización 48 h sin respuesta y lead sin contacto con aviso al administrador', async (context) => {
  const app = await createApp({ skipPurgeTimer: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.dataStore;
  const mails = [];
  const mailer = { configured: true, async send(m) { mails.push(m); return {}; } };
  let clock = null;
  const reminders = createReminders(store, createAssignment(store, mailer), {}, { now: () => clock });

  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const paulinaId = (await admin('GET', '/api/crm')).body.users.find((u) => u.name && u.role === 'travel_partner').id;
  const adminId = (await admin('GET', '/api/crm')).body.users.find((u) => u.role === 'admin').id;

  // Lead que registra el propio vendedor: ya está en contacto (sin alertas)
  const own = await partner('POST', '/api/leads', { client: { name: 'Luis Propio', phone: '998 111 0000' }, destination: 'Tulum' });
  assert.ok(own.body.record.contacted_at);
  // Lead que el administrador asigna a Paulina: corre el tiempo
  const assigned = await admin('POST', '/api/leads', { client: { name: 'Ana Asignada', phone: '998 222 0000' }, destination: 'Cancún', owner_id: paulinaId });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.body.record.contacted_at, null);
  assert.ok(assigned.body.record.assigned_at);
  const base = assigned.body.record.assigned_at;

  // Primera corrida: marca el inicio
  clock = base;
  await reminders.runOnce();
  // Antes del plazo no avisa
  clock = addWorkMinutes(base, 119, work);
  assert.equal((await reminders.runOnce()).contact, 0);
  // Cumplido el plazo (2 h laborales): aviso a Paulina
  clock = addWorkMinutes(base, 121, work);
  assert.equal((await reminders.runOnce()).contact, 1);
  let bell = await partner('GET', '/api/notifications');
  assert.match(bell.body.items[0].title, /Lead sin contacto: Ana Asignada/);
  assert.equal(bell.body.items[0].leadId, assigned.body.record.id);
  assert.ok(mails.some((m) => /Lead sin contacto: Ana Asignada/.test(m.subject)));
  assert.equal((await reminders.runOnce()).contact, 0, 'no repite el aviso');
  // 2 h laborales después del aviso: al administrador
  clock = addWorkMinutes(clock, 121, work);
  assert.equal((await reminders.runOnce()).escalated, 1);
  const adminBell = await admin('GET', '/api/notifications');
  assert.ok(adminBell.body.items.some((n) => /Paulina|no ha contactado a Ana Asignada/.test(n.title)));

  // "Ya lo contacté" detiene todo
  const contacted = await partner('POST', `/api/leads/${assigned.body.record.id}/contacted`);
  assert.equal(contacted.status, 200);
  assert.ok(contacted.body.record.contacted_at);

  // Otro lead asignado: completar un seguimiento cuenta como contacto
  const second = await admin('POST', '/api/leads', { client: { name: 'Beto Seguimiento', phone: '998 333 0000' }, destination: 'Holbox', owner_id: paulinaId });
  const fup = await partner('POST', '/api/followups', { lead_id: second.body.record.id, title: 'Llamar', due_at: '2099-01-01 10:00' });
  await partner('PATCH', `/api/followups/${fup.body.record.id}`, { done: true });
  const crm = await partner('GET', '/api/crm');
  assert.ok(crm.body.leads.find((l) => l.id === second.body.record.id).contacted_at);
  // Reasignar un lead sin contacto reinicia su tiempo
  const third = await admin('POST', '/api/leads', { client: { name: 'Caro Reasignada', phone: '998 444 0000' }, destination: 'Bacalar', owner_id: paulinaId });
  await store.updateRecord('leads', third.body.record.id, { contact_alert_at: '2026-01-01 10:00:00' });
  await admin('PATCH', `/api/leads/${third.body.record.id}`, { owner_id: adminId });
  const moved = await store.getRecord('leads', third.body.record.id);
  assert.equal(moved.contact_alert_at, null);

  // Cotización enviada: 48 h sin respuesta → seguimiento + aviso, una sola vez
  const quote = await partner('POST', '/api/quotes', { client_id: own.body.client.id, lead_id: own.body.record.id, destination: 'Tulum', hotel: 'Hotel Azul', price: 30000, status: 'Enviada' });
  assert.equal(quote.status, 201);
  const sentAt = (await store.getRecord('quotes', quote.body.record.id)).sent_at;
  assert.ok(sentAt);
  clock = plusHours(sentAt, 47);
  assert.equal((await reminders.runOnce()).quotes, 0);
  clock = plusHours(sentAt, 49);
  assert.equal((await reminders.runOnce()).quotes, 1);
  assert.equal((await reminders.runOnce()).quotes, 0, 'no repite');
  const after = await partner('GET', '/api/crm');
  const created = after.body.followups.find((f) => f.type === 'Cotización' && f.lead_id === own.body.record.id);
  assert.ok(created, 'se creó el seguimiento');
  assert.match(created.title, /cotización COT-\d{4}-\d{4} · Luis Propio/);
  bell = await partner('GET', '/api/notifications');
  assert.ok(bell.body.items.some((n) => /Cotización sin respuesta: Luis Propio/.test(n.title)));
  // Si cambia de estado y se vuelve a enviar, el reloj se reinicia
  await partner('PATCH', `/api/quotes/${quote.body.record.id}`, { status: 'Borrador' });
  assert.equal((await store.getRecord('quotes', quote.body.record.id)).reminder_at, null);

  // Configuración: solo administrador
  assert.equal((await partner('GET', '/api/reminders')).status, 403);
  const cfg = await admin('GET', '/api/reminders');
  assert.equal(cfg.body.quoteHours, 48);
  assert.equal((await admin('PUT', '/api/reminders', { workStart: '20:00', workEnd: '09:00' })).status, 400);
  const saved = await admin('PUT', '/api/reminders', { quoteHours: 24, contactHours: 1, enabled: false });
  assert.equal(saved.body.quoteHours, 24);
  assert.equal(saved.body.enabled, false);
});
