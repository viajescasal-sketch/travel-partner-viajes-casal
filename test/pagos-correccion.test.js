'use strict';

// Corrección de pagos con autorización del administrador, ficha 360 ⇄ plan de pagos sincronizados
// y eliminación de cotizaciones por el asesor.

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
    return { status: r.status, body: await r.json() };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}

test('pagos: ficha ⇄ plan sincronizados, corrección con autorización y eliminar cotizaciones', async (context) => {
  const app = await createApp({ skipPurgeTimer: true, mailer: { configured: false, async send() { return {}; } } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.dataStore;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);

  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún', start_date: '2027-03-20', end_date: '2027-03-27', travelers: 2 })).body.record;
  const clientId = lead.client_id;
  const quote = (await partner('POST', '/api/quotes', { client_id: clientId, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu', price: 20000, status: 'Enviada', details: { proposals: [{ price: { total: '20000' }, pay: { esquema: 'anticipo', anticipo: '5000' } }] } })).body.record;
  await partner('PATCH', `/api/quotes/${quote.id}`, { status: 'Aceptada' });
  const plan = async () => (await store.getRecord('quotes', quote.id)).payment_plan;
  const token = (await store.getRecord('quotes', quote.id)).pay_token;
  const publicPaid = async () => (await (await fetch(`${baseUrl}/api/public/pay/${token}`)).json()).plan.paid;

  // 1) Pago desde la ficha 360 con cotización → se aplica al plan (y a la liga/portal del cliente)
  const p1 = await partner('POST', `/api/clients/${clientId}/events`, { type: 'payment', amount: 5000, title: 'Anticipo', method: 'Transferencia', quote_id: quote.id, date: '2026-10-20' });
  assert.equal(p1.status, 201);
  assert.equal(p1.body.installment, 'p1');
  assert.equal((await plan()).paid, 5000);
  assert.equal(await publicPaid(), 5000, 'la liga del cliente ve el pago');
  const p2 = await partner('POST', `/api/clients/${clientId}/events`, { type: 'payment', amount: 3000, title: 'Abono', method: 'Efectivo', quote_id: quote.id });
  assert.equal(p2.body.installment, 'p2', 'el siguiente pago va a la parcialidad pendiente');
  assert.equal((await plan()).paid, 8000);

  // 2) El asesor solicita corregir: no cambia nada hasta que el admin autoriza
  const ev1 = p1.body.event.id;
  assert.equal((await partner('POST', `/api/client-events/${ev1}/change`, { action: 'edit', amount: 4500 })).status, 400, 'pide motivo');
  const req1 = await partner('POST', `/api/client-events/${ev1}/change`, { action: 'edit', amount: 4500, method: 'Depósito', reason: 'Capturé mal el monto' });
  assert.equal(req1.status, 202);
  assert.equal((await plan()).paid, 8000, 'pendiente: el plan no cambia');
  const bell = (await admin('GET', '/api/notifications')).body.items;
  assert.ok(bell.some((n) => n.kind === 'payment_change' && n.link === `paychange:${ev1}`), 'el admin recibe el aviso');
  const pending = (await admin('GET', '/api/payment-changes')).body.changes;
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /monto \$5,000 → \$4,500/);
  assert.equal((await partner('GET', '/api/crm')).body.paymentChanges.length, 1, 'el asesor ve su solicitud pendiente');
  assert.equal((await partner('POST', `/api/payment-changes/${ev1}/approve`)).status, 403, 'solo el admin autoriza');

  // 3) Autoriza → ficha, plan y liga del cliente quedan iguales
  assert.equal((await admin('POST', `/api/payment-changes/${ev1}/approve`)).status, 200);
  assert.equal((await plan()).paid, 7500);
  assert.equal((await plan()).installments[0].payments[0].method, 'Depósito');
  assert.equal(await publicPaid(), 7500);
  const ev = await store.getClientEvent(ev1);
  assert.equal(ev.amount, 4500);
  assert.equal(ev.meta.change, undefined);
  assert.equal(ev.meta.edits[0].prev.amount, 5000, 'queda el historial del cambio');
  assert.ok((await partner('GET', '/api/notifications')).body.items.some((n) => /autorizada/.test(n.title)), 'el asesor recibe la respuesta');

  // 4) Solicitud de eliminar, rechazada → no cambia
  const ev2 = p2.body.event.id;
  await partner('POST', `/api/client-events/${ev2}/change`, { action: 'delete', reason: 'Duplicado' });
  assert.equal((await admin('POST', `/api/payment-changes/${ev2}/reject`, { comment: 'Sí lo recibimos' })).status, 200);
  assert.equal((await plan()).paid, 7500);
  assert.ok(await store.getClientEvent(ev2));

  // 5) El admin elimina un pago desde la ficha → también sale del plan y de la liga (el error que se reportó)
  assert.equal((await admin('DELETE', `/api/client-events/${ev2}`)).status, 200);
  assert.equal((await plan()).paid, 4500);
  assert.equal(await publicPaid(), 4500);

  // 5b) Pagos borrados antes de este cambio (quedaron en el plan): la limpieza los quita
  const ghost = await store.getRecord('quotes', quote.id);
  ghost.payment_plan.installments[1].payments.push({ amount: 999, at: '2026-10-01 10:00:00', method: 'Otro', event_id: 987654 });
  await store.updateRecord('quotes', quote.id, { payment_plan: ghost.payment_plan });
  assert.equal(await app.locals.payments.reconcileDeletedPayments(), 1);
  assert.equal((await plan()).paid, 4500);

  // 6) El admin corrige directo, sin autorización
  const direct = await admin('POST', `/api/client-events/${ev1}/change`, { action: 'edit', amount: 5000 });
  assert.equal(direct.body.applied, true);
  assert.equal((await plan()).paid, 5000);

  // 7) Eliminar cotizaciones: el asesor borra sus duplicadas; las aceptadas solo el admin
  const dup = (await partner('POST', `/api/quotes/${quote.id}/duplicate`)).body.record;
  assert.equal((await partner('DELETE', `/api/quotes/${dup.id}`)).status, 200, 'borra su duplicada');
  assert.equal((await partner('DELETE', `/api/quotes/${quote.id}`)).status, 400, 'aceptada con pagos: no');
  const adminQuote = (await admin('POST', '/api/quotes', { client_id: clientId, destination: 'Tulum', hotel: 'X', price: 1000 })).body.record;
  assert.equal((await partner('DELETE', `/api/quotes/${adminQuote.id}`)).status, 404, 'no ve la del admin');
  assert.equal((await admin('DELETE', `/api/quotes/${quote.id}`)).status, 200, 'el admin sí puede');
});
