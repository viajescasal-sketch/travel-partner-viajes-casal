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

// Con TEST_DB_NAME definido, la prueba corre contra MySQL real.
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

// Inicia sesión, cambia la contraseña temporal y devuelve un cliente HTTP con cookie.
async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: temporal })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const blocked = await call('GET', '/api/crm');
  assert.equal(blocked.status, 403, 'el CRM exige cambiar la contraseña temporal');
  const changed = await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  assert.equal(changed.status, 200);
  return call;
}

test('CRM: leads, clientes, cotizaciones, viajes y seguimientos persistentes', async (context) => {
  const baseUrl = await startApp(context);
  const anonymous = await fetch(`${baseUrl}/api/crm`);
  assert.equal(anonymous.status, 401);

  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);

  const empty = await partner('GET', '/api/crm');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.leads, []);
  assert.equal(empty.body.settings.agency.name, 'Viajes Bumeran Casal');

  // Validaciones
  const invalid = await partner('POST', '/api/leads', { client: { name: '' }, destination: 'Cancún' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /name/);
  const badDates = await partner('POST', '/api/leads', {
    client: { name: 'Ana', phone: '998 111 2233' }, destination: 'Tulum', start_date: '2026-12-10', end_date: '2026-12-01'
  });
  assert.equal(badDates.status, 400);

  // Lead con cliente nuevo y primer seguimiento
  const lead = await partner('POST', '/api/leads', {
    client: { name: 'Fernanda Ruiz', phone: '+52 55 1987 6543', email: 'fer@example.test' },
    destination: 'Los Cabos', start_date: '2026-12-10', end_date: '2026-12-14',
    travelers: 4, budget: 48000, priority: 'Alta', source: 'Instagram',
    first_followup_at: '2026-10-09T11:30'
  });
  assert.equal(lead.status, 201);
  assert.equal(lead.body.record.stage, 'Nuevo');
  assert.equal(lead.body.followup.due_at, '2026-10-09 11:30:00');

  // Mismo número con otro formato: reutiliza el cliente
  const second = await partner('POST', '/api/leads', { client: { name: 'Fer Ruiz', phone: '5519876543' }, destination: 'Cancún' });
  assert.equal(second.body.client.id, lead.body.client.id);

  // Cotización: folio automático y el lead avanza a Cotizado
  const quote = await partner('POST', '/api/quotes', {
    client_id: lead.body.client.id, lead_id: lead.body.record.id, destination: 'Los Cabos',
    hotel: 'Riu Palace Baja California', price: 47275, mode: 'Total', valid_until: '2026-10-20'
  });
  assert.equal(quote.status, 201);
  assert.match(quote.body.record.folio, /^COT-\d{4}-0001$/);
  let crm = await partner('GET', '/api/crm');
  assert.equal(crm.body.leads.find((l) => l.id === lead.body.record.id).stage, 'Cotizado');

  const copy = await partner('POST', `/api/quotes/${quote.body.record.id}/duplicate`);
  assert.match(copy.body.record.folio, /-0002$/);
  assert.equal(copy.body.record.status, 'Borrador');

  // Lead de otro cliente no se puede ligar
  const otherClient = await partner('POST', '/api/clients', { name: 'Carlos Méndez', phone: '55 1234 5678' });
  const mismatch = await partner('POST', '/api/quotes', {
    client_id: otherClient.body.record.id, lead_id: lead.body.record.id, destination: 'X', hotel: 'Y', price: 1
  });
  assert.equal(mismatch.status, 400);

  // Aceptar la cotización marca el lead como Vendido
  const accepted = await partner('PATCH', `/api/quotes/${quote.body.record.id}`, { status: 'Aceptada' });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body.record.accepted_at);
  crm = await partner('GET', '/api/crm');
  const sold = crm.body.leads.find((l) => l.id === lead.body.record.id);
  assert.equal(sold.stage, 'Vendido');
  assert.ok(sold.closed_at);

  // Viaje y seguimiento
  const trip = await partner('POST', '/api/trips', {
    client_id: lead.body.client.id, quote_id: quote.body.record.id, destination: 'Los Cabos',
    start_date: '2026-12-10', end_date: '2026-12-14', status: 'Documentación pendiente'
  });
  assert.equal(trip.status, 201);
  const followup = await partner('POST', '/api/followups', { lead_id: second.body.record.id, title: 'Llamar', due_at: '2026-10-08 16:00' });
  assert.equal(followup.body.record.client_id, lead.body.client.id);
  const done = await partner('PATCH', `/api/followups/${followup.body.record.id}`, { done: true });
  assert.equal(done.body.record.done, true);

  // Referencia inexistente
  const ghost = await partner('POST', '/api/trips', { client_id: 9999, destination: 'X', start_date: '2026-01-01', end_date: '2026-01-02' });
  assert.equal(ghost.status, 400);

  // Solo el administrador elimina; al borrar el cliente se borra su historial
  const forbidden = await partner('DELETE', `/api/clients/${lead.body.client.id}`);
  assert.equal(forbidden.status, 403);
  const removed = await admin('DELETE', `/api/clients/${lead.body.client.id}`);
  assert.equal(removed.status, 200);
  crm = await admin('GET', '/api/crm');
  assert.equal(crm.body.leads.length, 0);
  assert.equal(crm.body.quotes.length, 0);
  assert.equal(crm.body.trips.length, 0);
  assert.equal(crm.body.followups.length, 0);
  assert.equal(crm.body.clients.length, 1);

  // Perfil de agencia
  const settingsForbidden = await partner('PUT', '/api/settings/agency', { name: 'X' });
  assert.equal(settingsForbidden.status, 403);
  const settings = await admin('PUT', '/api/settings/agency', { name: 'Viajes Casal', whatsapp: '+52 998 763 6565', email: 'hola@viajescasal.com', website: 'https://viajescasal.com' });
  assert.equal(settings.status, 200);
  crm = await partner('GET', '/api/crm');
  assert.equal(crm.body.settings.agency.name, 'Viajes Casal');

  // Actividad registrada
  const activity = await admin('GET', '/api/activity');
  assert.ok(activity.body.activity.some((a) => a.action === 'crm_quotes_create'));
});
