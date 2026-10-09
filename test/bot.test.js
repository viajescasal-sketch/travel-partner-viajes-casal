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
const { parseDates, destinationFrom, peopleFrom, budgetFrom, cleanPhone } = require('../src/bot-intake');

test('lectura de fechas, personas, presupuesto y teléfono del bot', () => {
  const today = '2026-10-09';
  assert.deepEqual(parseDates('Cancún del 10 al 15 de diciembre', today), { start: '2026-12-10', end: '2026-12-15', matched: '10 al 15 de diciembre' });
  assert.equal(parseDates('Madrid, 28 de diciembre al 4 de enero', today).end, '2027-01-04');
  assert.equal(parseDates('Los Cabos 5 al 9 de marzo', today).start, '2027-03-05', 'sin año: la próxima fecha');
  assert.deepEqual(parseDates('CDMX 20/11 al 24/11/2026', today).end, '2026-11-24');
  assert.equal(parseDates('Tulum en Semana Santa', today), null);
  assert.equal(destinationFrom('Cancún del 10 al 15 de diciembre', '10 al 15 de diciembre'), 'Cancún');
  assert.equal(destinationFrom('Tulum en Semana Santa', null), 'Tulum en Semana Santa');
  assert.equal(peopleFrom('2 adultos y 1 niño'), 3);
  assert.equal(peopleFrom('Somos una pareja'), 2);
  assert.equal(budgetFrom('De $8,000 a $15,000'), 15000);
  assert.equal(budgetFrom('Menos de $3,000'), 3000);
  assert.equal(budgetFrom('Quiero que me orienten según lo que incluye'), null);
  assert.equal(budgetFrom('unos 20 mil'), 20000);
  assert.equal(cleanPhone('5219981234567'), '+52 998 123 4567');
  assert.equal(cleanPhone('+52 998 123 4567'), '+52 998 123 4567');
  assert.equal(cleanPhone('<script>'), '');
});

async function startApp(context) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const mailer = { configured: false, from: null, async send() { return {}; } };
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
    let r = await call('POST', '/api/auth/login', { email, password });
    if (r.status === 401) r = await call('POST', '/api/auth/login', { email, password: newPassword });
    assert.equal(r.status, 200);
    if (r.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('el bot de WhatsApp crea y actualiza leads', async (context) => {
  const baseUrl = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  const bot = clientFor(baseUrl);
  const payload = {
    telefono: '5219981234567', nombre: 'Laura Méndez', producto: 'Paquete todo incluido', destino: 'Cancún del 10 al 15 de diciembre',
    ciudadSalida: 'Monterrey', personas: '2 adultos y 1 niño', presupuesto: 'De $15,000 a $25,000', tipoHospedaje: 'Todo incluido',
    etapa: 'Aniversario, ya queremos reservar', resumen: 'Resumen de tu solicitud'
  };

  // Sin clave o con la integración apagada no entra nada
  assert.equal((await bot('POST', '/api/integrations/botpress/lead', payload)).status, 401);
  assert.equal((await paulina('POST', '/api/integrations/botpress/token')).status, 403);
  const gen = await admin('POST', '/api/integrations/botpress/token');
  assert.equal(gen.status, 201);
  assert.match(gen.body.token, /^tp_[\w-]{30,}$/);
  const headers = { 'X-TP-Token': gen.body.token };
  assert.equal((await bot('POST', '/api/integrations/botpress/lead', payload, { 'X-TP-Token': `${gen.body.token}x` })).status, 401);
  assert.equal((await admin('GET', '/api/integrations/botpress')).body.token, undefined, 'la clave no se vuelve a mostrar');

  // Lead nuevo: cliente, fechas, personas, presupuesto total, calificación de presupuesto y seguimiento
  const created = await bot('POST', '/api/integrations/botpress/lead', payload, headers);
  assert.equal(created.status, 201);
  assert.equal(created.body.action, 'created');
  const crm = (await paulina('GET', '/api/crm')).body;
  const lead = crm.leads.find((l) => l.id === created.body.leadId);
  assert.ok(lead, 'el lead es de Paulina');
  assert.deepEqual([lead.destination, lead.start_date, lead.end_date, lead.travelers, lead.budget, lead.source, lead.stage], ['Cancún', '2026-12-10', '2026-12-15', 3, 75000, 'WhatsApp', 'Nuevo']);
  assert.match(lead.notes, /Bot de WhatsApp[\s\S]*Ciudad de salida: Monterrey/);
  assert.equal(lead.qualification.answers.q_presupuesto, '$15 a $25 mil');
  const client = crm.clients.find((c) => c.id === lead.client_id);
  assert.deepEqual([client.name, client.phone], ['Laura Méndez', '+52 998 123 4567']);
  const fup = crm.followups.find((f) => f.lead_id === lead.id);
  assert.equal(fup.type, 'WhatsApp');
  assert.match(fup.title, /Contactar a Laura Méndez/);

  // Segunda conversación del mismo número: actualiza el lead abierto, sin duplicar
  const again = await bot('POST', '/api/integrations/botpress/lead', { ...payload, telefono: '+52 998 123 4567', destino: 'Riviera Maya 3 al 8 de enero', presupuesto: 'Más de $25,000' }, headers);
  assert.equal(again.status, 200);
  assert.equal(again.body.action, 'updated');
  assert.equal(again.body.leadId, lead.id);
  const crm2 = (await admin('GET', '/api/crm')).body;
  const updated = crm2.leads.find((l) => l.id === lead.id);
  assert.equal(crm2.leads.filter((l) => l.client_id === client.id).length, 1);
  assert.deepEqual([updated.destination, updated.start_date, updated.end_date], ['Riviera Maya', '2027-01-03', '2027-01-08']);
  assert.equal(updated.qualification.answers.q_presupuesto, 'Más de $25 mil');
  assert.equal(crm2.followups.filter((f) => f.lead_id === lead.id).length, 1, 'no repite el seguimiento pendiente');
  const hist = (await admin('GET', `/api/history/leads/${lead.id}`)).body.items;
  assert.equal(hist[0].note, 'Actualizado por el bot de WhatsApp');
  assert.ok(hist[0].changes.some((c) => c.label === 'Destino' && c.to === 'Riviera Maya'));

  // Lead cerrado: la siguiente conversación abre uno nuevo
  await admin('PATCH', `/api/leads/${lead.id}`, { stage: 'Perdido' });
  const third = await bot('POST', '/api/integrations/botpress/lead', { ...payload, destino: 'Madrid' }, headers);
  assert.equal(third.body.action, 'created');

  // Vendedor por defecto configurable; desactivar corta el acceso
  const bruno = await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' });
  assert.equal((await admin('PUT', '/api/assignment', { mode: 'fijo', fixedId: bruno.body.user.id })).status, 200);
  const fromBruno = await bot('POST', '/api/integrations/botpress/lead', { ...payload, telefono: '5215512345678', nombre: 'Nuevo Cliente' }, headers);
  const brunoLead = (await admin('GET', '/api/crm')).body.leads.find((l) => l.id === fromBruno.body.leadId);
  assert.equal(brunoLead.owner_id, bruno.body.user.id);
  const status = (await admin('GET', '/api/integrations/botpress')).body;
  assert.match(status.lastResult, /Lead creado · Nuevo Cliente/);
  await admin('PUT', '/api/integrations/botpress', { enabled: false });
  assert.equal((await bot('POST', '/api/integrations/botpress/lead', payload, headers)).status, 401);

  // Nueva clave: la anterior deja de servir
  const gen2 = await admin('POST', '/api/integrations/botpress/token');
  assert.equal((await bot('POST', '/api/integrations/botpress/lead', payload, headers)).status, 401);
  assert.equal((await bot('POST', '/api/integrations/botpress/lead', { telefono: '', nombre: '' }, { 'X-TP-Token': gen2.body.token })).status, 400);
});
