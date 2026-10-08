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
  // Sin correo configurado: el administrador entra sin segundo paso en las pruebas.
  const mailer = { configured: false, from: null, async send() { return {}; } };
  const app = await createApp({ mailer, skipPurgeTimer: true, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
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
    assert.equal((await call('POST', '/api/auth/login', { email, password })).status, 200);
    assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('bitácora de actividad', async (context) => {
  const { baseUrl, app } = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');

  // Paulina registra lead y cotización
  const lead = (await paulina('POST', '/api/leads', { client: { name: 'Fernanda Ruiz', phone: '55 1987 6543' }, destination: 'Los Cabos', priority: 'Media', budget: 45000 })).body;
  const quote = (await paulina('POST', '/api/quotes', { client_id: lead.client.id, lead_id: lead.record.id, destination: 'Los Cabos', hotel: 'Riu Palace', price: 45000 })).body.record;

  // Edición con cambios concretos
  await paulina('PATCH', `/api/leads/${lead.record.id}`, { priority: 'Alta', notes: 'Prefiere vuelo directo' });
  // Guardar sin cambios no agrega registros
  const before = (await admin('GET', '/api/activity?type=crm')).body.items.length;
  await paulina('PATCH', `/api/leads/${lead.record.id}`, { priority: 'Alta' });
  assert.equal((await admin('GET', '/api/activity?type=crm')).body.items.length, before);

  // El admin acepta la cotización: cambia el estado y el lead pasa a Vendido automáticamente
  await admin('PATCH', `/api/quotes/${quote.id}`, { status: 'Aceptada', price: 47275 });

  const all = (await admin('GET', '/api/activity?type=crm')).body.items;
  const quoteEdit = all.find((a) => a.action === 'crm_quotes_update');
  assert.equal(quoteEdit.userName, 'Administrador');
  assert.match(quoteEdit.summary, /^COT-\d{4}-0001 · Fernanda Ruiz · Riu Palace$/);
  assert.deepEqual(quoteEdit.changes.map((c) => [c.label, c.from, c.to]), [
    ['Precio', '$45,000', '$47,275'],
    ['Estado', 'Borrador', 'Aceptada']
  ]);
  const auto = all.find((a) => a.action === 'crm_leads_update' && a.note);
  assert.match(auto.note, /Automático por la cotización COT-/);
  assert.deepEqual(auto.changes.map((c) => [c.label, c.from, c.to]), [['Etapa', 'Cotizado', 'Vendido']]);
  const leadEdit = all.find((a) => a.action === 'crm_leads_update' && a.userName === 'Paulina');
  assert.deepEqual(leadEdit.changes.map((c) => [c.label, c.from, c.to]), [['Prioridad', 'Media', 'Alta'], ['Notas', null, 'Prefiere vuelo directo']]);
  assert.ok(Number.isFinite(leadEdit.createdMs) && Math.abs(Date.now() - leadEdit.createdMs) < 60000, 'fecha y hora reales');
  assert.equal(all.find((a) => a.action === 'crm_leads_create').summary, 'Fernanda Ruiz · Los Cabos');

  // Historial de un registro: el vendedor ve el de su lead; otro vendedor no
  const history = await paulina('GET', `/api/history/leads/${lead.record.id}`);
  assert.equal(history.status, 200);
  const timeline = history.body.items.slice().reverse();
  assert.deepEqual(timeline.map((a) => a.action), ['crm_leads_create', 'crm_leads_update', 'crm_leads_update', 'crm_leads_update']);
  assert.deepEqual(timeline[1].changes.map((c) => [c.from, c.to]), [['Nuevo', 'Cotizado']], 'avance automático al cotizar');
  const createdB = await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' });
  const bruno = clientFor(baseUrl);
  await bruno.login('bruno@example.test', createdB.body.temporaryPassword, 'BrunoNueva2026x');
  assert.equal((await bruno('GET', `/api/history/leads/${lead.record.id}`)).status, 404);
  assert.equal((await bruno('GET', '/api/activity')).status, 403);
  assert.equal((await admin('GET', '/api/history/pagos/1')).status, 404);

  // Reasignación y eliminación con resumen
  await admin('PATCH', `/api/leads/${lead.record.id}`, { owner_id: createdB.body.user.id });
  const reassign = (await admin('GET', `/api/activity?entity=leads&entityId=${lead.record.id}`)).body.items[0];
  assert.equal(reassign.action, 'crm_leads_reassign');
  assert.deepEqual(reassign.changes[0], { field: 'owner_id', label: 'Vendedor', from: 'Paulina', to: 'Bruno' });
  await admin('DELETE', `/api/clients/${lead.client.id}`);
  const deletion = (await admin('GET', '/api/activity?entity=clients')).body.items[0];
  assert.equal(deletion.action, 'crm_clients_delete');
  assert.equal(deletion.summary, 'Fernanda Ruiz');
  assert.match(deletion.note, /1 leads, 1 cotizaciones/);

  // Filtros
  const byUser = (await admin('GET', `/api/activity?user=${createdB.body.user.id}`)).body.items;
  assert.ok(byUser.length && byUser.every((a) => a.userName === 'Bruno'));
  const security = (await admin('GET', '/api/activity?type=security')).body.items;
  assert.ok(security.some((a) => a.action === 'login_success') && security.every((a) => !a.action.startsWith('crm_')));
  const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  assert.ok((await admin('GET', `/api/activity?from=${today}&to=${today}`)).body.items.length > 0);
  assert.equal((await admin('GET', '/api/activity?from=2020-01-01&to=2020-01-31')).body.items.length, 0);
  const page1 = (await admin('GET', '/api/activity?limit=3')).body.items;
  const page2 = (await admin('GET', `/api/activity?limit=3&before=${page1.at(-1).id}`)).body.items;
  assert.equal(page1.length, 3);
  assert.ok(page2.every((a) => a.id < page1.at(-1).id));

  // Conservación de 2 años
  const dataStore = app.locals.dataStore;
  const total = (await admin('GET', '/api/activity?limit=500')).body.items.length;
  const oldest = (await admin('GET', '/api/activity?limit=500')).body.items.at(-1);
  if (dataStore.pool) await dataStore.pool.execute('UPDATE activity_logs SET created_at = NOW() - INTERVAL 800 DAY WHERE id = ?', [oldest.id]);
  else dataStore.activity.find((a) => a.id === oldest.id).created_ms = Date.now() - 800 * 86400000;
  assert.equal(await dataStore.purgeActivity(730), 1);
  assert.equal((await admin('GET', '/api/activity?limit=500')).body.items.length, total - 1, 'solo se borró lo de más de 2 años');
});
