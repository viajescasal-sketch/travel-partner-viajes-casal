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

async function startApp(context) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const app = await createApp({ mailer: { configured: false, from: null, async send() { return {}; } }, skipPurgeTimer: true, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, dataStore: app.locals.dataStore };
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
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

test('tablero: etapa, días en la etapa, motivo de pérdida y venta por cotización', async (context) => {
  const { baseUrl, dataStore } = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');

  const created = await paulina('POST', '/api/leads', { client: { name: 'Sofía Díaz', phone: '998 222 3344' }, destination: 'Cancún', budget: 40000 });
  assert.equal(created.status, 201);
  const lead = created.body.record;
  assert.ok(lead.stage_changed_at, 'el lead nuevo empieza a contar sus días en Nuevo');

  // Simula que lleva 4 días en Nuevo; al moverlo de etapa el contador se reinicia
  await dataStore.updateRecord('leads', lead.id, { stage_changed_at: '2026-01-01 10:00:00' });
  const moved = await paulina('PATCH', `/api/leads/${lead.id}`, { stage: 'Calificado' });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.body.record.stage_changed_at, '2026-01-01 10:00:00');
  const kept = await paulina('PATCH', `/api/leads/${lead.id}`, { priority: 'Alta' });
  assert.equal(kept.body.record.stage_changed_at, moved.body.record.stage_changed_at, 'editar otros datos no reinicia los días');

  // Perdido con motivo; al reabrirlo se borra el motivo
  const lost = await paulina('PATCH', `/api/leads/${lead.id}`, { stage: 'Perdido', lost_reason: 'Precio: encontró algo más barato' });
  assert.deepEqual([lost.body.record.stage, lost.body.record.lost_reason], ['Perdido', 'Precio: encontró algo más barato']);
  assert.ok(lost.body.record.closed_at);
  const hist = (await admin('GET', `/api/history/leads/${lead.id}`)).body.items;
  assert.ok(hist[0].changes.some((c) => c.label === 'Motivo de pérdida' && c.to === 'Precio: encontró algo más barato'));
  const reopened = await paulina('PATCH', `/api/leads/${lead.id}`, { stage: 'Negociación' });
  assert.equal(reopened.body.record.lost_reason, null);
  assert.equal(reopened.body.record.closed_at, null);

  // Vendido: aceptar la cotización mueve el lead a Vendido y reinicia el contador
  const quote = await paulina('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu', price: 52000, status: 'Enviada' });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  await dataStore.updateRecord('leads', lead.id, { stage_changed_at: '2026-01-01 10:00:00' });
  assert.equal((await paulina('PATCH', `/api/quotes/${quote.body.record.id}`, { status: 'Aceptada' })).status, 200);
  const sold = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === lead.id);
  assert.equal(sold.stage, 'Vendido');
  assert.notEqual(sold.stage_changed_at, '2026-01-01 10:00:00');

  // Otro vendedor u operaciones no pueden mover leads ajenos
  const other = await admin('POST', '/api/leads', { client: { name: 'Pedro Gil', phone: '998 999 0000' }, destination: 'Tulum' });
  assert.equal((await paulina('PATCH', `/api/leads/${other.body.record.id}`, { stage: 'Calificado' })).status, 404);
});
