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
const { temporaryPassword } = require('../src/user-routes');

async function startApp(context) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const app = await createApp(dataStore ? { dataStore } : {});
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  call.login = async (email, password, newPassword) => {
    const login = await call('POST', '/api/auth/login', { email, password });
    assert.equal(login.status, 200, `login ${email}`);
    if (newPassword) {
      const changed = await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword });
      assert.equal(changed.status, 200);
    }
    return login.body.user;
  };
  return call;
}

test('contraseña temporal cumple la política', () => {
  for (let i = 0; i < 50; i += 1) {
    const p = temporaryPassword();
    assert.equal(p.length, 14);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /\d/);
  }
});

test('roles: administrador, vendedor y operaciones', async (context) => {
  const baseUrl = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login(process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD, 'AdminNueva2026x');
  const paulinaUser = await paulina.login(process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD, 'PaulinaNueva2026');
  assert.equal(paulinaUser.roleLabel, 'Vendedor');

  // --- Gestión de usuarios ---
  assert.equal((await paulina('POST', '/api/users', { name: 'X', email: 'x@x.test', role: 'admin' })).status, 403);
  const badRole = await admin('POST', '/api/users', { name: 'X', email: 'x@x.test', role: 'jefe' });
  assert.equal(badRole.status, 400);
  const createdB = await admin('POST', '/api/users', { name: 'Bruno Vendedor', email: 'Bruno@Example.test', role: 'travel_partner' });
  assert.equal(createdB.status, 201);
  assert.equal(createdB.body.user.email, 'bruno@example.test');
  assert.equal(createdB.body.user.mustChangePassword, true);
  const dupe = await admin('POST', '/api/users', { name: 'Otro', email: 'bruno@example.test', role: 'operaciones' });
  assert.equal(dupe.status, 409);
  const createdOps = await admin('POST', '/api/users', { name: 'Olga Operaciones', email: 'olga@example.test', role: 'operaciones' });
  assert.equal(createdOps.status, 201);

  const bruno = clientFor(baseUrl);
  await bruno.login('bruno@example.test', createdB.body.temporaryPassword, 'BrunoNueva2026x');
  const olga = clientFor(baseUrl);
  await olga.login('olga@example.test', createdOps.body.temporaryPassword, 'OlgaNueva2026xx');

  // --- Paulina registra su lead ---
  const leadA = await paulina('POST', '/api/leads', {
    client: { name: 'Fernanda Ruiz', phone: '55 1987 6543' }, destination: 'Los Cabos', first_followup_at: '2026-10-09T10:00'
  });
  assert.equal(leadA.status, 201);
  assert.equal(leadA.body.warning, null);
  const clientX = leadA.body.client.id;
  const quoteA = await paulina('POST', '/api/quotes', { client_id: clientX, lead_id: leadA.body.record.id, destination: 'Los Cabos', hotel: 'Riu', price: 40000 });
  assert.equal(quoteA.status, 201);
  // Un vendedor no puede asignar a otro
  const selfAssign = await paulina('POST', '/api/leads', { client_id: clientX, destination: 'Tulum', owner_id: 1 });
  assert.equal(selfAssign.status, 403);

  // --- Bruno no ve nada de Paulina ---
  let crmB = await bruno('GET', '/api/crm');
  assert.equal(crmB.status, 200);
  assert.deepEqual([crmB.body.leads.length, crmB.body.clients.length, crmB.body.quotes.length, crmB.body.followups.length], [0, 0, 0, 0]);
  assert.equal(crmB.body.users.length, 1, 'no ve la lista de usuarios');
  assert.equal((await bruno('PATCH', `/api/leads/${leadA.body.record.id}`, { stage: 'Perdido' })).status, 404);
  assert.equal((await bruno('PATCH', `/api/quotes/${quoteA.body.record.id}`, { status: 'Aceptada' })).status, 404);
  assert.equal((await bruno('POST', `/api/quotes/${quoteA.body.record.id}/duplicate`)).status, 404);
  assert.equal((await bruno('PATCH', `/api/clients/${clientX}`, { name: 'Hack' })).status, 404);
  assert.equal((await bruno('POST', '/api/quotes', { client_id: clientX, destination: 'X', hotel: 'Y', price: 1 })).status, 400);
  assert.equal((await bruno('POST', '/api/leads', { client_id: clientX, destination: 'X' })).status, 400);
  assert.equal((await bruno('DELETE', `/api/leads/${leadA.body.record.id}`)).status, 403);

  // --- Mismo WhatsApp: se crea con aviso ---
  const leadB = await bruno('POST', '/api/leads', { client: { name: 'Fer Ruiz', phone: '+52 5519876543' }, destination: 'Cancún' });
  assert.equal(leadB.status, 201);
  assert.equal(leadB.body.client.id, clientX);
  assert.match(leadB.body.warning, /Paulina/);
  crmB = await bruno('GET', '/api/crm');
  assert.deepEqual(crmB.body.leads.map((l) => l.id), [leadB.body.record.id], 'solo su lead');
  assert.equal(crmB.body.quotes.length, 0, 'no ve cotizaciones de Paulina');
  assert.equal(crmB.body.clients.length, 1);
  const activity = await admin('GET', '/api/activity');
  assert.ok(activity.body.activity.some((a) => a.action === 'crm_shared_client'));

  // --- Administrador ve todo y reasigna ---
  const crmAdmin = await admin('GET', '/api/crm');
  assert.equal(crmAdmin.body.leads.length, 2);
  assert.equal(crmAdmin.body.users.length, 4);
  const brunoId = createdB.body.user.id;
  assert.equal((await admin('PATCH', `/api/leads/${leadA.body.record.id}`, { owner_id: createdOps.body.user.id })).status, 400, 'operaciones no recibe leads');
  const reassigned = await admin('PATCH', `/api/leads/${leadA.body.record.id}`, { owner_id: brunoId });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.body.record.owner_id, brunoId);
  crmB = await bruno('GET', '/api/crm');
  assert.equal(crmB.body.leads.length, 2);
  assert.equal(crmB.body.quotes.length, 1, 'la cotización viaja con el lead');
  assert.equal(crmB.body.followups.length, 1, 'el seguimiento viaja con el lead');
  const crmA = await paulina('GET', '/api/crm');
  assert.equal(crmA.body.leads.length, 0);
  assert.equal((await paulina('PATCH', `/api/leads/${leadA.body.record.id}`, { owner_id: paulinaUser.id })).status, 404);
  const adminLead = await admin('POST', '/api/leads', { client: { name: 'Carlos', phone: '998 111 0000' }, destination: 'Tulum', owner_id: paulinaUser.id });
  assert.equal(adminLead.body.record.owner_id, paulinaUser.id);

  // --- Operaciones ---
  const crmOps = await olga('GET', '/api/crm');
  assert.equal(crmOps.body.leads.length, 0);
  assert.equal(crmOps.body.clients.length, 2);
  assert.equal(crmOps.body.quotes.length, 1);
  assert.equal((await olga('POST', '/api/leads', { client: { name: 'Z', phone: '1234567890' }, destination: 'X' })).status, 403);
  assert.equal((await olga('POST', '/api/quotes', { client_id: clientX, destination: 'X', hotel: 'Y', price: 1 })).status, 403);
  assert.equal((await olga('PATCH', `/api/clients/${clientX}`, { name: 'X' })).status, 403);
  const trip = await olga('POST', '/api/trips', { client_id: clientX, quote_id: quoteA.body.record.id, destination: 'Los Cabos', start_date: '2026-12-10', end_date: '2026-12-14' });
  assert.equal(trip.status, 201);
  assert.equal((await olga('PATCH', `/api/trips/${trip.body.record.id}`, { status: 'Documentación pendiente' })).status, 200);
  assert.equal((await olga('DELETE', `/api/trips/${trip.body.record.id}`)).status, 403);
  assert.equal((await olga('POST', '/api/followups', { lead_id: leadA.body.record.id, title: 'x', due_at: '2026-10-10 10:00' })).status, 400);
  assert.equal((await olga('POST', '/api/followups', { client_id: clientX, title: 'Enviar vouchers', due_at: '2026-10-10 10:00' })).status, 201);
  crmB = await bruno('GET', '/api/crm');
  assert.equal(crmB.body.trips.length, 1, 'el vendedor ve el viaje de su cliente');
  assert.equal(crmB.body.followups.some((f) => f.title === 'Enviar vouchers'), false, 'no ve seguimientos de operaciones');

  // --- Protecciones del administrador ---
  const me = crmAdmin.body.users.find((u) => u.role === 'admin');
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { role: 'travel_partner' })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await admin('POST', `/api/users/${me.id}/reset-password`)).status, 400);

  // --- Desactivar corta la sesión y el acceso ---
  assert.equal((await admin('PATCH', `/api/users/${brunoId}`, { active: false })).status, 200);
  assert.equal((await bruno('GET', '/api/crm')).status, 401);
  assert.equal((await clientFor(baseUrl)('POST', '/api/auth/login', { email: 'bruno@example.test', password: 'BrunoNueva2026x' })).status, 401);

  // --- Cambiar rol se aplica de inmediato ---
  assert.equal((await admin('PATCH', `/api/users/${paulinaUser.id}`, { role: 'operaciones' })).status, 200);
  assert.equal((await paulina('GET', '/api/crm')).body.leads.length, 0);
  assert.equal((await paulina('POST', '/api/leads', { client_id: clientX, destination: 'X' })).status, 403);
  await admin('PATCH', `/api/users/${paulinaUser.id}`, { role: 'travel_partner' });

  // --- Restablecer contraseña cierra la sesión abierta ---
  const reset = await admin('POST', `/api/users/${createdOps.body.user.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await olga('GET', '/api/crm')).status, 401);
  const olga2 = clientFor(baseUrl);
  const relogin = await olga2.login('olga@example.test', reset.body.temporaryPassword);
  assert.equal(relogin.mustChangePassword, true);
  assert.equal((await olga2('GET', '/api/crm')).status, 403, 'debe cambiar la contraseña temporal');

  const users = await admin('GET', '/api/users');
  assert.ok(users.body.users.find((u) => u.email === process.env.PARTNER_EMAIL).lastLoginAt);
});
