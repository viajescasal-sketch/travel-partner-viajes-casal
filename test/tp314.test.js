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
  const app = await createApp({ skipPurgeTimer: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  return { baseUrl, partner, store: app.locals.dataStore };
}
const pub = async (baseUrl, method, path, body) => { const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

async function sentQuote(partner, name, phone, pay, withDates = true) {
  const lead = (await partner('POST', '/api/leads', { client: { name, phone }, destination: 'Cancún', ...(withDates ? { start_date: '2099-12-20', end_date: '2099-12-27' } : {}), travelers: 2 })).body.record;
  const details = { varying: 'hotel', principal: 0, services: { vuelo: false, hotel: true, traslados: false, tours: false, seguro: false }, fixed: {}, proposals: [{ hotel: { hotel: 'Hotel Riu', plan: 'Todo incluido', stars: '5' }, price: { total: '30000' }, pay }] };
  const quote = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu — Todo incluido', price: 30000, status: 'Enviada', valid_until: '2099-12-31', details })).body.record;
  const token = (await partner('POST', `/api/quotes/${quote.id}/share`, {})).body.url.split('/').pop();
  return { lead, quote, token };
}

test('TP-314: al aceptar se crea el viaje "Pendiente de pago" y con el primer pago pasa a Confirmado', async (context) => {
  const { baseUrl, partner, store } = await setup(context);
  const { quote, token } = await sentQuote(partner, 'Ana Pendiente', '998 200 3001', { esquema: 'anticipo', anticipo: '6000', anticipoFecha: '2099-01-10' });
  assert.equal((await store.listRecords('trips')).filter((t) => t.quote_id === quote.id).length, 0, 'antes de aceptar no hay viaje');

  const ok = await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { name: 'Ana Pendiente', terms: true, option: 0 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const trips = (await store.listRecords('trips')).filter((t) => t.quote_id === quote.id);
  assert.equal(trips.length, 1, 'se crea un solo viaje');
  assert.equal(trips[0].status, 'Pendiente de pago');
  assert.equal(trips[0].start_date, '2099-12-20');

  const page = await pub(baseUrl, 'GET', `/api/public/quote/${token}`);
  assert.equal(page.body.payLabel, 'Continuar con mi reserva', 'el botón ya no dice anticipo');
  assert.equal(page.body.tripPending, true);

  // aceptar de nuevo o guardar la cotización otra vez no duplica el viaje
  await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { name: 'Ana Pendiente', terms: true, option: 0 });
  assert.equal((await store.listRecords('trips')).filter((t) => t.quote_id === quote.id).length, 1);

  // primer pago → el viaje se confirma
  const paid = await partner('POST', `/api/quotes/${quote.id}/payment-plan/p1/pay`, { amount: 6000, method: 'Transferencia' });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal((await store.getRecord('trips', trips[0].id)).status, 'Confirmado');
  assert.equal((await pub(baseUrl, 'GET', `/api/public/quote/${token}`)).body.tripPending, false);
});

test('TP-314: sin fechas de salida no se crea el viaje solo (lo arma el vendedor)', async (context) => {
  const { baseUrl, partner, store } = await setup(context);
  const { quote, token } = await sentQuote(partner, 'Luis Sin Fecha', '998 200 3002', { esquema: 'anticipo', anticipo: '6000' }, false);
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { name: 'Luis Sin Fecha', terms: true, option: 0 })).status, 200);
  assert.equal((await store.listRecords('trips')).filter((t) => t.quote_id === quote.id).length, 0);
});

test('TP-314: esquema "Pago total (sin anticipo)" arma un solo pago por el total', async (context) => {
  const { baseUrl, partner, store } = await setup(context);
  const { quote, token } = await sentQuote(partner, 'Eva Pago Total', '998 200 3003', { esquema: 'total', anticipoFecha: '2099-01-15' });
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { name: 'Eva Pago Total', terms: true, option: 0 })).status, 200);
  const plan = (await store.getRecord('quotes', quote.id)).payment_plan;
  assert.equal(plan.installments.length, 1);
  assert.equal(plan.installments[0].label, 'Pago total');
  assert.equal(plan.installments[0].amount, 30000);
  assert.equal(plan.installments[0].due, '2099-01-15');
  assert.equal(plan.total, 30000);
});
