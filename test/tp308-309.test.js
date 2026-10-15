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
const { FORM } = require('../src/webform');
const { cleanAnswers, surveyStats } = require('../src/postventa');
const { nowCancun } = require('../src/crm-schema');

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}
async function setup(context) {
  const sent = [];
  const mailer = { configured: false, from: 'test@example.test', send: async (m) => { sent.push(m); return { delivered: true }; } };
  const app = await createApp({ skipPurgeTimer: true, mailer });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  mailer.configured = true; // después de entrar (con correo activo el administrador pediría el segundo paso)
  const pub = async (method, path, body) => { const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null), type: r.headers.get('content-type') }; };
  return { app, baseUrl, store: app.locals.dataStore, postventa: app.locals.postventa, partner, admin, pub, sent };
}

test('TP-308: respuestas y estadísticas de la encuesta', () => {
  assert.throws(() => cleanAnswers({ overall: 0 }), /estrellas/);
  assert.deepEqual(cleanAnswers({ overall: 5, hotel: '4', transfer: 9, nps: 10, comment: '  Todo increíble ', publish: true }), { overall: 5, hotel: 4, transfer: null, partner: null, nps: 10, comment: 'Todo increíble', publish: true });
  const t = (overall, nps) => ({ survey: { sent_at: 'x', answers: { overall, nps, hotel: null, transfer: null, partner: overall } } });
  const s = surveyStats([t(5, 10), t(4, 9), t(2, 3), { survey: { sent_at: 'x' } }, {}]);
  assert.deepEqual([s.sent, s.answered, s.rate, s.overall, s.nps, s.low], [4, 3, 75, 3.7, 33, 1]);
});

test('TP-308: la encuesta sale al regreso (correo + aviso + seguimiento), se contesta y queda en la ficha 360', async (context) => {
  const { baseUrl, store, postventa, partner, admin, pub, sent } = await setup(context);
  const today = nowCancun().slice(0, 10);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@example.test' }, destination: 'Cancún', travelers: 2 })).body.record;
  const back = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Cancún', start_date: addDays(today, -6), end_date: addDays(today, -1) })).body.record;
  const future = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Tulum', start_date: addDays(today, 10), end_date: addDays(today, 14) })).body.record;

  const run = await postventa.runSurveys({ workStart: '00:00', workEnd: '23:59' });
  assert.equal(run.surveys, 1, 'solo el viaje que ya regresó');
  assert.equal(run.emails, 1);
  assert.match(sent.find((m) => m.to === 'ana@example.test').subject, /cómo te fue en Cancún/);
  const trip = await store.getRecord('trips', back.id);
  assert.equal(trip.status, 'Solicitar reseña');
  assert.ok(trip.survey.sent_at && trip.survey.email_sent_at);
  assert.equal((await store.getRecord('trips', future.id)).survey, null);
  const crm = (await partner('GET', '/api/crm')).body;
  assert.ok(crm.followups.some((f) => /Enviar encuesta postviaje · Ana López/.test(f.title) && f.details.includes(`/encuesta/${trip.survey.token}`)));
  assert.equal((await postventa.runSurveys({ workStart: '00:00', workEnd: '23:59' })).surveys, 0, 'no se repite');

  // Página pública y respuestas.
  const page = await fetch(`${baseUrl}/encuesta/${trip.survey.token}`);
  assert.equal(page.status, 200);
  assert.equal((await fetch(`${baseUrl}/encuesta/${'a'.repeat(40)}`)).status, 404);
  const info = await pub('GET', `/api/public/survey/${trip.survey.token}`);
  assert.equal(info.body.client.first, 'Ana');
  assert.equal(info.body.answered, false);
  assert.match(info.body.referral.code, /^VC-ANA[A-Z0-9]{3}$/, 'trae su código de referido');
  assert.equal((await pub('POST', `/api/public/survey/${trip.survey.token}`, { overall: 0 })).status, 400);
  const done = await pub('POST', `/api/public/survey/${trip.survey.token}`, { overall: 2, hotel: 3, partner: 5, nps: 6, comment: 'El traslado llegó tarde' });
  assert.equal(done.status, 201);
  assert.equal(done.body.answered, true);
  assert.equal((await pub('POST', `/api/public/survey/${trip.survey.token}`, { overall: 5 })).status, 409, 'una sola vez');
  const after = await store.getRecord('trips', back.id);
  assert.equal(after.status, 'Postventa');
  const events = (await partner('GET', `/api/clients/${lead.client_id}/events`)).body.events;
  const review = events.find((e) => e.type === 'review');
  assert.equal(review.rating, 2);
  assert.match(review.body, /Hotel 3★ · Travel Partner 5★ · Recomendaría: 6\/10\nEl traslado llegó tarde/);
  // Calificación baja: aviso al vendedor y al administrador.
  const bellAdmin = (await admin('GET', '/api/notifications')).body;
  assert.match(JSON.stringify(bellAdmin), /calificó su viaje con 2★/);

  // Manual: liga, marcar enviada, correo; reportes.
  const manual = await partner('POST', `/api/trips/${future.id}/survey`, { markSent: true });
  assert.match(manual.body.url, /\/encuesta\/[a-f0-9]{40}$/);
  assert.ok(manual.body.survey.sent_at);
  const stats = (await admin('GET', '/api/postventa/stats')).body;
  assert.deepEqual([stats.survey.sent, stats.survey.answered, stats.survey.overall, stats.survey.low], [2, 1, 2, 1]);
  assert.equal(stats.comments[0].comment, 'El traslado llegó tarde');
  assert.equal((await partner('PUT', '/api/postventa/settings', { delayDays: 3 })).status, 403);
  assert.equal((await admin('PUT', '/api/postventa/settings', { tripadvisorUrl: 'http://x' })).status, 400);
  const cfg = await admin('PUT', '/api/postventa/settings', { delayDays: 2, tripadvisorUrl: 'https://www.tripadvisor.com.mx/x', referrerAmount: 600 });
  assert.deepEqual([cfg.body.delayDays, cfg.body.referrerAmount, cfg.body.welcomeAmount], [2, 600, 300]);
});

test('TP-309: código y liga de referido, lead referido por formulario o mensaje, y crédito al venderse', async (context) => {
  const { baseUrl, store, partner, admin, pub } = await setup(context);
  const today = nowCancun().slice(0, 10);
  const ana = (await partner('POST', '/api/leads', { client: { name: 'Ána Pérez', phone: '998 123 4567' }, destination: 'Cancún' })).body.record;
  const ref = (await partner('GET', `/api/clients/${ana.client_id}/referral`)).body;
  assert.match(ref.code, /^VC-ANA[A-Z0-9]{3}$/, 'sin acentos');
  assert.equal(ref.url, `${process.env.APP_URL ? process.env.APP_URL : 'https://travelpartner.viajescasal.com'}/r/${ref.code}`);
  assert.equal((await partner('GET', `/api/clients/${ana.client_id}/referral`)).body.code, ref.code, 'el código no cambia');

  // Página de invitación.
  assert.equal((await fetch(`${baseUrl}/r/${ref.code}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/r/VC-NOEXISTE`)).status, 404);
  const inv = await pub('GET', `/api/public/ref/${ref.code}`);
  assert.deepEqual([inv.body.referrer, inv.body.welcomeAmount, inv.body.code], ['Ána', 300, ref.code]);

  // Lead por el formulario con la liga de referido.
  const payload = { nombre: 'Mariana Torres', whatsapp: '+52 999 555 1234', servicio: 'paquete', destino: 'Los Cabos', fechas: FORM.fechas[0], llegada: addDays(today, 20), regreso: addDays(today, 25), adultos: 2, ninos: 0, presupuesto: FORM.presupuesto[3], etapa: FORM.etapa[2], quien: FORM.quien[0], elapsed: 60000, website: '', ref: ref.code.toLowerCase() };
  assert.equal((await pub('POST', '/api/public/lead', payload)).status, 201);
  let crm = (await admin('GET', '/api/crm')).body;
  const mariana = crm.leads.find((l) => l.destination === 'Los Cabos');
  assert.equal(mariana.referral.referrer_id, ana.client_id);
  assert.equal(mariana.referral.welcome_amount, 300);
  assert.equal(mariana.referral.welcome_status, 'Por aplicar');
  assert.match(mariana.referral.via, /liga \(formulario web\)/);

  // Código escrito en el mensaje (bot) → se detecta en las notas.
  const fake = await store.listRecords('leads');
  assert.ok(fake.length >= 2);
  const intake = require('../src/lead-intake').createLeadIntake(store, null);
  const viaBot = await intake.intake({ channel: { label: 'bot de WhatsApp', source: 'WhatsApp' }, person: { name: 'Luis Gómez', phone: '998 777 8888' }, lead: { destination: 'Tulum' }, notes: `Hola, vengo recomendado por Ana, código ${ref.code}` });
  assert.equal(viaBot.lead.referral.referrer_id, ana.client_id);

  // Nadie se refiere a sí mismo; captura manual y quitar.
  assert.equal((await partner('PUT', `/api/leads/${ana.id}/referral`, { code: ref.code })).status, 400);
  const other = (await partner('POST', '/api/leads', { client: { name: 'Pedro Sol', phone: '998 222 3333' }, destination: 'Mérida' })).body.record;
  assert.equal((await partner('PUT', `/api/leads/${other.id}/referral`, { code: 'VC-ZZZ999' })).status, 400);
  assert.equal((await partner('PUT', `/api/leads/${other.id}/referral`, { code: ref.code })).body.record.referral.via, 'capturado por el equipo');
  assert.equal((await partner('PUT', `/api/leads/${other.id}/referral`, { code: '' })).body.record.referral, null);
  assert.equal((await partner('PATCH', `/api/leads/${mariana.id}/referral`, { welcome_status: 'Aplicado' })).body.record.referral.welcome_status, 'Aplicado');

  // Venta del referido (cotización aceptada) → crédito para quien refirió, una sola vez.
  const q = (await admin('POST', '/api/quotes', { client_id: mariana.client_id, lead_id: mariana.id, destination: 'Los Cabos', hotel: 'Riu Palace', price: 40000, status: 'Aceptada' })).body.record;
  assert.ok(q);
  let anaClient = await store.getRecord('clients', ana.client_id);
  assert.equal(anaClient.referral.rewards.length, 1);
  assert.deepEqual([anaClient.referral.rewards[0].amount, anaClient.referral.rewards[0].status, anaClient.referral.rewards[0].client_name], [500, 'Pendiente', 'Mariana Torres']);
  await admin('PATCH', `/api/leads/${mariana.id}`, { stage: 'Negociación' });
  await admin('PATCH', `/api/leads/${mariana.id}`, { stage: 'Vendido' });
  anaClient = await store.getRecord('clients', ana.client_id);
  assert.equal(anaClient.referral.rewards.length, 1, 'no se duplica');
  // Venta por el tablero (sin cotización).
  await admin('PATCH', `/api/leads/${viaBot.lead.id}`, { stage: 'Vendido' });
  anaClient = await store.getRecord('clients', ana.client_id);
  assert.equal(anaClient.referral.rewards.length, 2);
  const bell = (await partner('GET', '/api/notifications')).body;
  assert.match(JSON.stringify(bell), /ganó \$500 MXN por referir a Mariana Torres/);

  const rw = anaClient.referral.rewards[0];
  const applied = await partner('PATCH', `/api/clients/${ana.client_id}/referral/rewards/${rw.id}`, { status: 'Aplicado', note: 'COT-2027-0009' });
  assert.equal(applied.body.rewards[0].status, 'Aplicado');
  const stats = (await admin('GET', '/api/postventa/stats')).body.referrals;
  assert.deepEqual([stats.leads, stats.sold, stats.pending, stats.applied, stats.top[0].sold], [2, 2, 500, 500, 2]);
  const r2 = (await partner('GET', `/api/clients/${ana.client_id}/referral`)).body;
  assert.equal(r2.referred.length, 2);
});
