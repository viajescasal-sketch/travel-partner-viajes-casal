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
const { readForm, qualificationAnswers, FORM } = require('../src/webform');
const { DEFAULT_LEAD_QUESTIONS, normalizeQuestions } = require('../src/documents');

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('lectura y calificación del formulario web', () => {
  const today = '2026-10-09';
  const base = { nombre: 'Ana López', whatsapp: '998 123 4567', servicio: 'paquete', destino: 'Cancún', adultos: 2 };
  const f = readForm({ ...base, fechas: FORM.fechas[0], llegada: '2026-11-20', regreso: '2026-11-25', presupuesto: FORM.presupuesto[2], etapa: FORM.etapa[2], quien: FORM.quien[1], experiencias: ['Gastronomía', '<b>x</b>'] }, today);
  assert.equal(f.telefono, '+52 998 123 4567', '10 dígitos = México');
  assert.deepEqual(f.experiencias, ['Gastronomía']);
  const qs = normalizeQuestions(DEFAULT_LEAD_QUESTIONS);
  assert.deepEqual(qualificationAnswers(f, qs, today), {
    q_presupuesto: '$15 a $25 mil', q_decision: 'Listo para reservar', q_fechas: 'Sí, fijas', q_cuando: 'En 1 a 3 meses', q_quien: 'Lo decide con su pareja o familia'
  });
  const noDates = readForm({ ...base, fechas: FORM.fechas[2], llegada: '2026-11-20', cuando: 'Este mes', presupuesto: FORM.presupuesto[4], etapa: FORM.etapa[0], quien: FORM.quien[2] }, today);
  assert.equal(noDates.llegada, null);
  assert.deepEqual(qualificationAnswers(noDates, qs, today), { q_presupuesto: 'Aún no lo sabe', q_decision: 'Solo está explorando', q_fechas: 'Aún no', q_cuando: 'Este mes', q_quien: 'Cotiza para alguien más' });
  assert.throws(() => readForm({ ...base, whatsapp: '123' }, today), /WhatsApp/);
  assert.throws(() => readForm({ ...base, servicio: 'otro' }, today), /Elige/);
  assert.throws(() => readForm({ ...base, llegada: '2026-01-01' }, today), /ya pasó/);
  assert.throws(() => readForm({ ...base, llegada: '2026-11-20', regreso: '2026-11-10' }, today), /regreso/);
});

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
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
  };
  call.login = async (email, password, newPassword) => {
    const r = await call('POST', '/api/auth/login', { email, password });
    assert.equal(r.status, 200);
    if (r.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('el formulario web crea el lead calificado, avisa y se puede incrustar', async (context) => {
  const sent = [];
  const mailer = { configured: false, from: 'Viajes Casal <no-responder@example.test>', async send(message) { sent.push(message); return {}; } };
  const baseUrl = await startApp(context, mailer);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  mailer.configured = true; // después del inicio de sesión, para no pedir código por correo
  const visitor = clientFor(baseUrl);

  // Página incrustable: solo el formulario se puede mostrar en otros sitios
  const page = await fetch(`${baseUrl}/formulario?embed=1`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(page.headers.get('x-frame-options'), null);
  const home = await fetch(`${baseUrl}/`);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${baseUrl}/formulario-embed.js`)).headers.get('cross-origin-resource-policy'), 'cross-origin');

  const cfg = await visitor('GET', '/api/public/form');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.enabled, true);
  assert.equal(cfg.body.form.services.length, 5);
  assert.match(cfg.body.whatsapp, /^\d{10,15}$/);

  const today = cfg.body.today;
  const payload = {
    nombre: 'Mariana Torres', whatsapp: '+52 999 555 1234', correo: 'Mariana@Example.test', servicio: 'paquete', ciudadSalida: 'Mérida',
    destino: 'Los Cabos', fechas: FORM.fechas[0], llegada: addDays(today, 20), regreso: addDays(today, 25), adultos: 2, ninos: 1, edades: '7',
    noches: '4-6', presupuesto: FORM.presupuesto[3], etapa: FORM.etapa[2], motivo: 'Aniversario', quien: FORM.quien[0],
    comentarios: 'Queremos vista al mar', origen: 'landing-cabos', utm_source: 'instagram', pagina: 'viajescasal.com/cabos', elapsed: 60000, website: ''
  };

  // Robots: campo oculto o envío demasiado rápido → responde ok pero no guarda nada
  assert.equal((await visitor('POST', '/api/public/lead', { ...payload, hp_check: 'spam.com', elapsed: 9000 })).status, 201);
  assert.equal((await visitor('POST', '/api/public/lead', { ...payload, elapsed: 900 })).status, 201);
  assert.equal((await admin('GET', '/api/crm')).body.leads.length, 0);
  const blocked = (await admin('GET', '/api/integrations/webform')).body;
  assert.equal(blocked.blockedCount, 2);
  assert.match(blocked.lastBlocked, /Mariana Torres · envío en 0.9 s/);
  assert.equal((await visitor('POST', '/api/public/lead', { ...payload, destino: '' })).status, 400);

  const created = await visitor('POST', '/api/public/lead', payload);
  assert.equal(created.status, 201);
  assert.equal(created.body.ok, true);
  const crm = (await paulina('GET', '/api/crm')).body;
  assert.equal(crm.leads.length, 1, 'el lead llega a Paulina');
  const lead = crm.leads[0];
  assert.deepEqual([lead.destination, lead.start_date, lead.end_date, lead.travelers, lead.budget, lead.source, lead.stage], ['Los Cabos', addDays(today, 20), addDays(today, 25), 3, 75000, 'Sitio web', 'Nuevo']);
  assert.equal(lead.qualification.answered, 5);
  assert.equal(lead.qualification.level, 'Caliente');
  assert.match(lead.notes, /🌐 Formulario web[\s\S]*Ciudad de salida: Mérida[\s\S]*1 niño \(edades: 7\)[\s\S]*Origen: landing-cabos · instagram · viajescasal.com\/cabos/);
  const client = crm.clients.find((c) => c.id === lead.client_id);
  assert.deepEqual([client.name, client.phone, client.email], ['Mariana Torres', '+52 999 555 1234', 'mariana@example.test']);
  const fup = crm.followups.find((f) => f.lead_id === lead.id);
  assert.match(fup.title, /Contactar a Mariana Torres \(formulario web\)/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'paulina@example.test');
  assert.match(sent[0].subject, /Nuevo lead del formulario web · Mariana Torres · Los Cabos/);
  assert.match(sent[0].text, /Calificación: \d+% Caliente/);
  assert.doesNotMatch(sent[0].html, /<b>x/);

  // Mismo cliente con lead abierto: se actualiza (sin duplicar ni repetir seguimiento)
  const again = await visitor('POST', '/api/public/lead', { ...payload, whatsapp: '9995551234', destino: 'Tulum', fechas: FORM.fechas[2], cuando: 'En 3 a 6 meses', etapa: FORM.etapa[1] });
  assert.equal(again.status, 201);
  const crm2 = (await admin('GET', '/api/crm')).body;
  assert.equal(crm2.leads.length, 1);
  assert.equal(crm2.leads[0].destination, 'Tulum');
  assert.equal(crm2.leads[0].qualification.answers.q_decision, 'Comparando opciones');
  assert.equal(crm2.followups.filter((f) => f.lead_id === lead.id).length, 1);
  assert.equal(crm2.clients.length, 1);

  // Persona real con el campo oculto autocompletado (más de 20 s): entra, marcado para revisar
  const autofill = await visitor('POST', '/api/public/lead', { ...payload, nombre: 'Pedro Sol', whatsapp: '+52 998 000 1111', correo: '', comentarios: 'Soy Pedro Sol', hp_check: 'x', elapsed: 90000 });
  assert.equal(autofill.status, 201);
  const pedro = (await admin('GET', '/api/crm')).body.leads.find((l) => /Pedro Sol/.test(l.notes));
  assert.match(pedro.notes, /⚠ Revisar/);

  // Configuración: solo el administrador; pausar bloquea el envío
  assert.equal((await paulina('GET', '/api/integrations/webform')).status, 403);
  assert.equal((await admin('PUT', '/api/integrations/webform', { whatsapp: 'abc' })).status, 400);
  const updated = await admin('PUT', '/api/integrations/webform', { whatsapp: '+52 998 392 1530', notifyEmail: false, enabled: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.whatsapp, '+52 998 392 1530');
  assert.match((await admin('GET', '/api/integrations/webform')).body.lastResult, /Lead creado · Pedro Sol/);
  const paused = await visitor('GET', '/api/public/form');
  assert.equal(paused.body.enabled, false);
  assert.equal(paused.body.whatsapp, '529983921530');
  assert.equal((await visitor('POST', '/api/public/lead', payload)).status, 403);
});
