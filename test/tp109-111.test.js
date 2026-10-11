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
const { scoreLead } = require('../src/scoring');
const { createReminders } = require('../src/reminders');
const { createAssignment } = require('../src/assignment');

test('puntaje automático: presupuesto, fechas, grupo, respuesta y preguntas', () => {
  const today = '2026-10-12';
  const hot = scoreLead({ budget: 120000, travelers: 4, start_date: '2026-10-30', response: 'rapido' }, { today });
  assert.ok(hot.score >= 85, `caliente: ${hot.score}`);
  assert.equal(hot.level, 'Caliente');
  assert.equal(hot.priority, 'Alta');
  assert.deepEqual(hot.parts.map((p) => p.key), ['budget', 'dates', 'group', 'response']);
  assert.equal(hot.parts.reduce((s, p) => s + p.max, 0), 100, 'sin preguntas, los pesos se reparten');
  const cold = scoreLead({ travelers: 1, response: 'no_responde' }, { today });
  assert.equal(cold.level, 'Frío');
  assert.equal(cold.priority, 'Baja');
  const viewed = scoreLead({ travelers: 2 }, { today, quotes: [{ viewed_at: '2026-10-11 10:00:00' }] });
  const plain = scoreLead({ travelers: 2 }, { today });
  assert.ok(viewed.score > plain.score, 'abrir la cotización sube el puntaje');
  const withQ = scoreLead({ travelers: 2, qualification: { score: 90, answered: 5, total: 5, answers: {} } }, { today });
  assert.ok(withQ.parts.some((p) => p.key === 'questions'));
  const custom = scoreLead({ budget: 120000, travelers: 4 }, { today, config: { weights: { budget: 100, dates: 0, group: 0, response: 0, questions: 0 } } });
  assert.equal(custom.score, 100);
});

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
  call.login = async (email, password, newPassword) => {
    const login = await call('POST', '/api/auth/login', { email, password });
    if (login.body.user.mustChangePassword) await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword });
  };
  return call;
}

test('calificación, notificaciones (cotización vista, pago, vencidos) y duplicados', async (context) => {
  const app = await createApp({ skipPurgeTimer: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.dataStore;
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  const visitor = clientFor(baseUrl);

  // --- TP-109 ---
  const lead = await paulina('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@example.test' }, destination: 'Cancún', travelers: 4, budget: 100000, priority: 'Baja' });
  let crm = (await paulina('GET', '/api/crm')).body;
  let l = crm.leads.find((x) => x.id === lead.body.record.id);
  assert.ok(l.auto && Number.isInteger(l.auto.score));
  assert.equal(l.priority, l.auto.priority, 'la prioridad la pone el puntaje');
  assert.equal((await paulina('POST', `/api/leads/${l.id}/response`, { value: 'x' })).status, 400);
  const before = l.auto.score;
  assert.equal((await paulina('POST', `/api/leads/${l.id}/response`, { value: 'rapido' })).status, 200);
  crm = (await paulina('GET', '/api/crm')).body;
  l = crm.leads.find((x) => x.id === lead.body.record.id);
  assert.ok(l.auto.score > before, 'responder rápido sube el puntaje');
  assert.equal(l.response, 'rapido');
  assert.equal((await paulina('PUT', '/api/scoring', { hot: 80 })).status, 403);
  assert.equal((await admin('PUT', '/api/scoring', { hot: 50, warm: 60 })).status, 400);
  assert.equal((await admin('PUT', '/api/scoring', { weights: { budget: 40, dates: 20, group: 10, response: 20, questions: 10 }, hot: 75, warm: 45 })).body.hot, 75);

  // --- TP-110: liga privada y "cotización vista" ---
  const quote = await paulina('POST', '/api/quotes', { client_id: lead.body.client.id, lead_id: lead.body.record.id, destination: 'Cancún', hotel: 'Riu', price: 50000 });
  const share = await paulina('POST', `/api/quotes/${quote.body.record.id}/share`, {});
  assert.match(share.body.url, /\/cotizacion\/[a-f0-9]{40}$/);
  const token = share.body.url.split('/').pop();
  assert.equal((await paulina('POST', `/api/quotes/${quote.body.record.id}/share`, {})).body.url, share.body.url, 'la liga se conserva');
  const page = await visitor('GET', `/cotizacion/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /documento\.js/);
  const pub = await visitor('GET', `/api/public/quote/${token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.quote.folio, quote.body.record.folio);
  assert.equal(pub.body.client.phone, null, 'no expone datos de contacto');
  assert.equal(pub.body.quote.share_token, undefined);
  let bell = (await paulina('GET', '/api/notifications')).body;
  assert.ok(bell.items.some((n) => n.kind === 'quote_viewed' && /Ana López abrió tu cotización/.test(n.title) && n.link === `quote:${quote.body.record.id}`));
  await visitor('GET', `/api/public/quote/${token}`);
  assert.equal((await paulina('GET', '/api/notifications')).body.items.filter((n) => n.kind === 'quote_viewed').length, 1, 'máximo un aviso por hora');
  assert.equal((await store.getRecord('quotes', quote.body.record.id)).view_count, 2);
  await paulina('GET', `/api/public/quote/${token}`);
  assert.equal((await store.getRecord('quotes', quote.body.record.id)).view_count, 2, 'las vistas del equipo no cuentan');
  assert.equal((await visitor('GET', `/api/public/quote/${token}/media/999`)).status, 404);
  await paulina('POST', `/api/quotes/${quote.body.record.id}/share`, { enabled: false });
  assert.equal((await visitor('GET', `/api/public/quote/${token}`)).status, 404, 'desactivada');
  assert.equal((await visitor('GET', `/cotizacion/${token}`)).status, 404);

  // --- TP-110: pago recibido ---
  const pay = await paulina('POST', `/api/clients/${lead.body.client.id}/events`, { type: 'payment', amount: 9000, title: 'Anticipo', method: 'Transferencia' });
  assert.equal(pay.status, 201);
  bell = (await admin('GET', '/api/notifications')).body;
  assert.ok(bell.items.some((n) => n.kind === 'payment' && /Pago recibido: \$9,000 de Ana López/.test(n.title) && n.link === `client:${lead.body.client.id}`));
  assert.ok(!(await paulina('GET', '/api/notifications')).body.items.some((n) => n.kind === 'payment'), 'quien registra no se avisa a sí mismo');

  // --- TP-110: seguimiento vencido ---
  let clock = '2026-10-12 08:00:00';
  const reminders = createReminders(store, createAssignment(store, { configured: false }), {}, { now: () => clock });
  await reminders.runOnce();
  const fup = await paulina('POST', '/api/followups', { lead_id: lead.body.record.id, type: 'Llamada', title: 'Llamar a Ana', due_at: '2026-10-12 10:00' });
  clock = '2026-10-12 10:10:00';
  assert.equal((await reminders.runOnce()).overdue, 0, 'espera 15 minutos');
  clock = '2026-10-12 10:20:00';
  assert.equal((await reminders.runOnce()).overdue, 1);
  assert.equal((await reminders.runOnce()).overdue, 0, 'una sola vez');
  assert.ok((await paulina('GET', '/api/notifications')).body.items.some((n) => n.kind === 'followup_overdue' && n.link === `followup:${fup.body.record.id}`));
  await paulina('PATCH', `/api/followups/${fup.body.record.id}`, { due_at: '2026-10-12 12:00' });
  assert.equal((await store.getRecord('followups', fup.body.record.id)).overdue_notified_at, null, 'reprogramar reinicia el aviso');

  // --- TP-111: duplicados ---
  const check = await paulina('GET', '/api/clients/duplicates/check?phone=%2B52%20998%20123%204567');
  assert.equal(check.body.matches.length, 1);
  assert.deepEqual(check.body.matches[0].reasons, ['WhatsApp']);
  assert.equal((await paulina('GET', '/api/clients/duplicates/check?email=ANA@example.test')).body.matches[0].reasons[0], 'correo');
  const dupe = await paulina('POST', '/api/clients', { name: 'Ana L.', phone: '9981234567' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.duplicates[0].name, 'Ana López');
  const forced = await paulina('POST', '/api/clients', { name: 'Ana Lopez', phone: '9981234567', force: true });
  assert.equal(forced.status, 201);
  // Lead nuevo con el mismo correo reutiliza al cliente
  const byEmail = await paulina('POST', '/api/leads', { client: { name: 'Ana', phone: '998 000 1111', email: 'ana@example.test' }, destination: 'Tulum' });
  assert.equal(byEmail.body.client.id, lead.body.client.id);
  assert.equal((await paulina('GET', '/api/duplicates')).status, 403);
  const groups = (await admin('GET', '/api/duplicates')).body.groups;
  assert.equal(groups.length, 1);
  assert.ok(groups[0].strong);
  assert.equal(groups[0].clients.length, 2);
  await paulina('POST', '/api/trips', { client_id: forced.body.record.id, destination: 'Mérida', start_date: '2026-12-01', end_date: '2026-12-03' });
  await paulina('POST', `/api/clients/${forced.body.record.id}/events`, { type: 'note', body: 'Nota del duplicado' });
  assert.equal((await paulina('POST', '/api/clients/merge', { keep_id: lead.body.client.id, merge_id: forced.body.record.id })).status, 403);
  const merged = await admin('POST', '/api/clients/merge', { keep_id: lead.body.client.id, merge_id: forced.body.record.id });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.moved.trips, 1);
  crm = (await admin('GET', '/api/crm')).body;
  assert.ok(!crm.clients.some((c) => c.id === forced.body.record.id));
  assert.ok(crm.trips.some((t) => t.destination === 'Mérida' && t.client_id === lead.body.client.id));
  assert.ok((await admin('GET', `/api/clients/${lead.body.client.id}/events`)).body.events.some((e) => e.body === 'Nota del duplicado'));
  assert.equal((await admin('GET', '/api/duplicates')).body.groups.length, 0);
});
