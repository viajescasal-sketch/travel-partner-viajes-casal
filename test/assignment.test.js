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
const { MySQLDataStore } = require('../src/data-store');

async function startApp(context, mailer) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const app = await createApp({ mailer, skipPurgeTimer: true, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  call.login = async (email, password, newPassword) => {
    const r = await call('POST', '/api/auth/login', { email, password });
    assert.equal(r.status, 200);
    if (r.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('asignación por turnos con disponibilidad, cliente de siempre y avisos', async (context) => {
  const sent = [];
  const mailer = { configured: false, from: 'x@example.test', async send(m) { sent.push(m); return {}; } };
  const baseUrl = await startApp(context, mailer);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  const eduardo = (await admin('POST', '/api/users', { name: 'Eduardo', email: 'eduardo@example.test', role: 'travel_partner' })).body;
  const bruno = (await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' })).body;
  const ed = clientFor(baseUrl);
  await ed.login('eduardo@example.test', eduardo.temporaryPassword, 'EduardoNueva2026');
  mailer.configured = true;
  const crm = async () => (await admin('GET', '/api/crm')).body;
  const ids = { admin: 1, paulina: 2, eduardo: eduardo.user.id, bruno: bruno.user.id };

  // Solo el administrador configura
  assert.equal((await paulina('GET', '/api/assignment')).status, 403);
  assert.equal((await admin('PUT', '/api/assignment', { mode: 'turnos', participants: [] })).status, 400);
  const saved = await admin('PUT', '/api/assignment', { mode: 'turnos', participants: [ids.paulina, ids.eduardo, ids.bruno] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.next.name, 'Paulina');

  // El bot reparte por turnos
  const token = (await admin('POST', '/api/integrations/botpress/token')).body.token;
  const bot = clientFor(baseUrl);
  const send = (n, extra = {}) => bot('POST', '/api/integrations/botpress/lead', { telefono: `52199800000${n}`, nombre: `Cliente ${n}`, destino: 'Cancún', ...extra }, { 'X-TP-Token': token });
  const owners = [];
  for (const n of [1, 2, 3, 4]) {
    const r = await send(n);
    assert.equal(r.status, 201);
    owners.push((await crm()).leads.find((l) => l.id === r.body.leadId).owner_id);
  }
  assert.deepEqual(owners, [ids.paulina, ids.eduardo, ids.bruno, ids.paulina]);

  // Eduardo se marca no disponible: su turno se salta
  assert.equal((await paulina('PUT', '/api/assignment/availability', { userId: ids.eduardo, available: false })).status, 403);
  assert.equal((await ed('PUT', '/api/assignment/availability', { available: false })).status, 200);
  const r5 = await send(5);
  assert.equal((await crm()).leads.find((l) => l.id === r5.body.leadId).owner_id, ids.bruno);
  assert.equal((await ed('GET', '/api/notifications')).body.available, false);

  // Cliente que ya existe: vuelve con su vendedor de siempre (Bruno atendió al cliente 3)
  const snap = await crm();
  const c3 = snap.clients.find((c) => c.name === 'Cliente 3');
  const lead3 = snap.leads.find((l) => l.client_id === c3.id);
  assert.equal(lead3.owner_id, ids.bruno);
  await admin('PATCH', `/api/leads/${lead3.id}`, { stage: 'Perdido' });
  const again = await send(3);
  assert.equal(again.body.action, 'created');
  assert.equal((await crm()).leads.find((l) => l.id === again.body.leadId).owner_id, ids.bruno);

  // Nadie disponible: queda con el administrador
  await admin('PUT', '/api/assignment/availability', { userId: ids.paulina, available: false });
  await admin('PUT', '/api/assignment/availability', { userId: ids.bruno, available: false });
  const r6 = await send(6);
  assert.equal((await crm()).leads.find((l) => l.id === r6.body.leadId).owner_id, ids.admin);
  for (const id of [ids.paulina, ids.bruno, ids.eduardo]) await admin('PUT', '/api/assignment/availability', { userId: id, available: true });

  // Campanita y correo para Paulina
  const notes = (await paulina('GET', '/api/notifications')).body;
  assert.ok(notes.unread >= 2);
  assert.match(notes.items.at(-1).title, /Nuevo lead: Cliente 1 · Cancún/);
  assert.equal(notes.receivesLeads, true);
  assert.ok(sent.some((m) => m.to === 'paulina@example.test' && /Nuevo lead asignado: Cliente 1/.test(m.subject)));
  await paulina('POST', '/api/notifications/read', { all: true });
  assert.equal((await paulina('GET', '/api/notifications')).body.unread, 0);

  // Reasignación manual: uno desde la ficha y varios a la vez, con aviso
  const paulinaLeads = (await crm()).leads.filter((l) => l.owner_id === ids.paulina).map((l) => l.id);
  assert.equal((await admin('PATCH', `/api/leads/${paulinaLeads[0]}`, { owner_id: ids.eduardo })).status, 200);
  assert.equal((await ed('GET', '/api/notifications')).body.items[0].leadId, paulinaLeads[0]);
  assert.equal((await paulina('POST', '/api/leads/reassign', { ids: paulinaLeads, owner_id: ids.bruno })).status, 403);
  const bulk = await admin('POST', '/api/leads/reassign', { ids: paulinaLeads, owner_id: ids.bruno });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.moved, paulinaLeads.length);
  assert.ok(sent.some((m) => m.to === 'bruno@example.test' && new RegExp(`Te asignaron ${paulinaLeads.length} leads`).test(m.subject)));
  assert.ok((await crm()).leads.filter((l) => paulinaLeads.includes(l.id)).every((l) => l.owner_id === ids.bruno));

  // Lead registrado por el administrador en automático: sigue el turno
  const turn = (await admin('GET', '/api/assignment')).body.next;
  const auto = await admin('POST', '/api/leads', { client: { name: 'Mario Ríos', phone: '998 777 1212' }, destination: 'Tulum', owner_id: 'auto' });
  assert.equal(auto.status, 201);
  assert.equal(auto.body.record.owner_id, turn.id);

  // Modo fijo
  await admin('PUT', '/api/assignment', { mode: 'fijo', fixedId: ids.eduardo });
  const r7 = await send(7);
  assert.equal((await crm()).leads.find((l) => l.id === r7.body.leadId).owner_id, ids.eduardo);
});
