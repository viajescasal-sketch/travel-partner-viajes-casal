'use strict';

// TP-320 · Código de origen ([IG-STORY-1112]) que llega en el primer mensaje de WhatsApp.

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
const { originCodeFrom, decodeOrigin } = require('../src/bot-intake');

test('lectura y decodificación del código de origen', () => {
  assert.equal(originCodeFrom('Hola, quiero planear mi viaje con Viajes Casal [IG-STORY-1112]'), 'IG-STORY-1112');
  assert.equal(originCodeFrom('x [fb-post-1120] y'), 'FB-POST-1120');
  assert.equal(originCodeFrom('[ REF ]'), 'REF');
  assert.equal(originCodeFrom('Quiero 2 cuartos [1] y [nota]'), '', 'corchetes comunes no son códigos');
  assert.equal(originCodeFrom(''), '');
  assert.equal(originCodeFrom(undefined), '');
  assert.deepEqual(decodeOrigin('IG-STORY-1112'), { code: 'IG-STORY-1112', source: 'Instagram', label: 'Instagram · historia · 12/11' });
  assert.deepEqual(decodeOrigin('GBP-POST-1122'), { code: 'GBP-POST-1122', source: 'Google Maps', label: 'Google Maps · publicación · 22/11' });
  assert.equal(decodeOrigin('IG-BIO').label, 'Instagram · bio');
  assert.equal(decodeOrigin('ADS-REEL').source, 'Facebook');
  assert.equal(decodeOrigin('LT-BIO').source, 'Otro');
  assert.equal(decodeOrigin('XX-BIO'), null);
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

test('el bot guarda el código de origen en el lead y el primero es el que cuenta', async (context) => {
  const baseUrl = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  const bot = clientFor(baseUrl);
  const token = (await admin('POST', '/api/integrations/botpress/token')).body.token;
  const headers = { 'X-TP-Token': token };
  const base = { telefono: '5219987770001', nombre: 'Marisol Ortega', destino: 'Cancún del 10 al 15 de diciembre', personas: '2 adultos' };

  // Primer mensaje con código: origen y código quedan en el lead, aunque el cliente no diga cómo nos conoció
  const first = await bot('POST', '/api/integrations/botpress/lead', { ...base, mensaje: 'Hola, quiero planear mi viaje con Viajes Casal [IG-STORY-1112]' }, headers);
  assert.equal(first.status, 201);
  let lead = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === first.body.leadId);
  assert.deepEqual([lead.source, lead.origin_code], ['Instagram', 'IG-STORY-1112']);
  assert.match(lead.notes, /Código de origen: \[IG-STORY-1112\] · Instagram · historia · 12\/11/);

  // Vuelve a escribir con otro código: se conserva el primero
  const again = await bot('POST', '/api/integrations/botpress/lead', { ...base, origenCodigo: 'FB-POST-1120' }, headers);
  assert.equal(again.body.action, 'updated');
  lead = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === first.body.leadId);
  assert.deepEqual([lead.source, lead.origin_code], ['Instagram', 'IG-STORY-1112']);

  // El código manda sobre lo que escriba el cliente; el bot puede mandarlo ya extraído (origenCodigo)
  const second = await bot('POST', '/api/integrations/botpress/lead', { telefono: '5219987770002', nombre: 'Raúl Peña', destino: 'Tulum', origen: 'Un amigo', origenCodigo: 'GBP-POST-1122' }, headers);
  const lead2 = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === second.body.leadId);
  assert.deepEqual([lead2.source, lead2.origin_code], ['Google Maps', 'GBP-POST-1122']);

  // Código de Linktree (red "Otro"): si el cliente dice la red, se usa; el código se guarda igual
  const third = await bot('POST', '/api/integrations/botpress/lead', { telefono: '5219987770003', nombre: 'Ana Lugo', destino: 'Cozumel', origen: 'Vi su video en TikTok', mensaje: '[LT-BIO]' }, headers);
  const lead3 = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === third.body.leadId);
  assert.deepEqual([lead3.source, lead3.origin_code], ['TikTok', 'LT-BIO']);

  // Sin código: sigue como antes (WhatsApp) y sin código
  const none = await bot('POST', '/api/integrations/botpress/lead', { telefono: '5219987770004', nombre: 'Luis Gil', destino: 'Mérida' }, headers);
  const lead4 = (await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === none.body.leadId);
  assert.deepEqual([lead4.source, lead4.origin_code ?? null], ['WhatsApp', null]);

  // Paulina puede capturarlo a mano en la ficha del lead
  const patch = await paulina('PATCH', `/api/leads/${lead4.id}`, { origin_code: 'REF' });
  assert.equal(patch.status, 200);
  assert.equal((await paulina('GET', '/api/crm')).body.leads.find((l) => l.id === lead4.id).origin_code, 'REF');
});
