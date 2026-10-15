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
const { buildPlan, editPlan, recalc } = require('../src/payments');
const { readTemplates } = require('../src/templates');

test('plan de pagos: se arma con el anticipo de la cotización y la liquidación 30 días antes', () => {
  const quote = { price: 20000, mode: 'Total', details: { proposals: [{ price: { total: '$20,000' }, pay: { esquema: 'anticipo', anticipo: '$5,000', anticipoFecha: '2026-10-15' } }] } };
  const plan = buildPlan(quote, { start_date: '2026-12-20' }, {}, '2026-10-12');
  assert.equal(plan.total, 20000);
  assert.deepEqual(plan.installments.map((i) => [i.id, i.label, i.due, i.amount]), [['p1', 'Anticipo', '2026-10-15', 5000], ['p2', 'Liquidación', '2026-11-20', 15000]]);
  assert.equal(plan.balance, 20000);

  // Sin datos de pago: 30 % de anticipo en 3 días; viaje muy cercano → liquidación antes de la salida
  const simple = buildPlan({ price: 10000, mode: 'Total' }, { start_date: '2026-10-20' }, {}, '2026-10-12');
  assert.deepEqual(simple.installments.map((i) => [i.label, i.due, i.amount]), [['Anticipo', '2026-10-15', 3000], ['Liquidación', '2026-10-19', 7000]]);

  // Esquema "plan" de la cotización; si no suma el total se agrega la liquidación
  const multi = buildPlan({ price: 30000, details: { proposals: [{ price: { total: 30000 }, pay: { esquema: 'plan', pagos: [{ fecha: '2026-10-20', monto: '10000' }, { fecha: '2026-11-10', monto: '10000' }] } }] } }, null, {}, '2026-10-12');
  assert.deepEqual(multi.installments.map((i) => [i.label, i.amount]), [['Anticipo', 10000], ['Pago 2', 10000], ['Liquidación', 10000]]);

  // Editar: los montos deben sumar el total y lo pagado se conserva
  plan.installments[0].payments = [{ amount: 5000 }];
  recalc(plan);
  assert.throws(() => editPlan(plan, { installments: [{ id: 'p1', label: 'Anticipo', due: '2026-10-15', amount: 5000 }, { id: 'p2', label: 'Liquidación', due: '2026-11-20', amount: 10000 }] }), /suman \$15,000/);
  assert.throws(() => editPlan(plan, { installments: [{ id: 'p2', label: 'Liquidación', due: '2026-11-20', amount: 20000 }] }), /ya tiene pagos/);
  const edited = editPlan(plan, { installments: [{ id: 'p1', label: 'Anticipo', due: '2026-10-15', amount: 5000 }, { id: 'p2', label: 'Pago 2', due: '2026-11-01', amount: 7500 }, { label: 'Liquidación', due: '2026-11-25', amount: 7500, link_url: 'https://pago.clip.mx/abc' }] });
  assert.deepEqual(edited.installments.map((i) => [i.id, i.status, i.amount]), [['p1', 'pagado', 5000], ['p2', 'pendiente', 7500], ['p3', 'pendiente', 7500]]);
  assert.equal(edited.balance, 15000);
});

test('plantillas: las nuevas de cobro aparecen también en listas personalizadas', () => {
  const ids = readTemplates({ templates: [{ id: 'pc1', stage: 'primer_contacto', name: 'Hola', body: 'Hola' }] }).templates.map((t) => t.id);
  assert.deepEqual(ids, ['pc1', 'ci3', 'ci4', 'ci5', 'pv3', 'pv4']);
  const ids2 = readTemplates({ templates: [{ id: 'pc1', stage: 'primer_contacto', name: 'Hola', body: 'Hola' }], known: require('../src/templates').DEFAULT_TEMPLATES.map((t) => t.id) }).templates.map((t) => t.id);
  assert.deepEqual(ids2, ['pc1'], 'si el administrador las borró no regresan');
});

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

test('liga de pago: plan al aceptar, Mercado Pago registra solo, pagos manuales y recordatorios de saldo', async (context) => {
  let clock = '2026-10-12 10:00:00';
  const mails = [];
  const mailer = { configured: false, async send(m) { mails.push(m); return { delivered: true }; } };
  const prefs = [];
  const payments = {};
  const fakeMp = {
    configured: true, sandbox: false,
    async createPreference(body) { prefs.push(body); return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref-${prefs.length}` }; },
    async getPayment(id) { if (!payments[id]) throw new Error('no existe'); return payments[id]; },
    verifySignature: () => true
  };
  const app = await createApp({ skipPurgeTimer: true, mailer, mercadoPago: fakeMp, paymentsNow: () => clock });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.dataStore;

  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  mailer.configured = true; // después de entrar (con correo activo se pide código de verificación)
  const users = (await admin('GET', '/api/crm')).body.users;
  const adminId = users.find((u) => u.role === 'admin').id;
  const paulinaId = users.find((u) => u.role === 'travel_partner').id;

  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@cliente.test' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-27', travelers: 2 })).body.record;
  const created = await partner('POST', '/api/quotes', {
    client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu', price: 20000, status: 'Enviada',
    details: { proposals: [{ price: { total: '20000' }, pay: { esquema: 'anticipo', anticipo: '5000', anticipoFecha: '2026-10-15' } }] }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.record.payment_plan, null, 'sin plan mientras no se acepta');
  const quoteId = created.body.record.id;

  // Aceptar → plan y liga
  const accepted = await partner('PATCH', `/api/quotes/${quoteId}`, { status: 'Aceptada' });
  const plan = accepted.body.record.payment_plan;
  assert.ok(plan, 'el plan se arma al aceptar');
  assert.deepEqual(plan.installments.map((i) => [i.label, i.due, i.amount]), [['Anticipo', '2026-10-15', 5000], ['Liquidación', '2026-11-20', 15000]]);
  const token = accepted.body.record.pay_token;
  assert.match(token, /^[a-f0-9]{40}$/);

  // Un viaje con esta cotización se mantiene al día
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: quoteId, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-27', confirmation: { paymentStatus: 'Pendiente de pago' } })).body.record;

  // Página pública
  const page = await fetch(`${baseUrl}/pagar/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /pagar\.js/);
  assert.equal((await fetch(`${baseUrl}/pagar/${'0'.repeat(40)}`)).status, 404);
  const pub = await (await fetch(`${baseUrl}/api/public/pay/${token}`)).json();
  assert.equal(pub.client.firstName, 'Ana');
  assert.doesNotMatch(JSON.stringify(pub), /998 123|ana@cliente|share_token|pay_token/, 'sin datos de contacto ni tokens');
  assert.equal(pub.plan.balance, 20000);
  assert.equal(pub.methods.mercadoPago, true);

  // Pagar en línea: crea la preferencia de Mercado Pago (se reutiliza si no cambia el monto)
  const checkout = await (await fetch(`${baseUrl}/api/public/pay/${token}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.match(checkout.url, /mercadopago/);
  assert.equal(prefs[0].external_reference, `tp-q${quoteId}-p1`);
  assert.equal(prefs[0].items[0].unit_price, 5000);
  assert.match(prefs[0].notification_url, /\/api\/public\/payments\/mercadopago$/);
  await fetch(`${baseUrl}/api/public/pay/${token}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(prefs.length, 1, 'misma liga para el mismo monto');

  // Aviso de Mercado Pago: pago aprobado → se registra solo (una sola vez)
  payments['111'] = { id: 111, status: 'approved', transaction_amount: 5000, currency_id: 'MXN', external_reference: `tp-q${quoteId}-p1`, date_approved: '2026-10-12T15:20:00.000-04:00', payment_method_id: 'oxxo' };
  for (let i = 0; i < 2; i += 1) {
    const hook = await fetch(`${baseUrl}/api/public/payments/mercadopago?type=payment&data.id=111`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id: '111' } }) });
    assert.equal(hook.status, 200);
  }
  let quote = await store.getRecord('quotes', quoteId);
  assert.equal(quote.payment_plan.installments[0].status, 'pagado');
  assert.equal(quote.payment_plan.paid, 5000);
  const events = (await store.listClientEvents(lead.client_id)).filter((e) => e.type === 'payment');
  assert.equal(events.length, 1, 'el aviso repetido no duplica el pago');
  assert.equal(events[0].meta.provider, 'mercadopago');
  assert.equal(events[0].quote_id, quoteId);
  const notes = store.notifications.filter((n) => n.kind === 'payment');
  assert.ok(notes.some((n) => n.user_id === paulinaId && n.link === `payplan:${quoteId}`), 'avisa al vendedor');
  assert.ok(notes.some((n) => n.user_id === adminId), 'y al administrador');
  assert.ok(mails.some((m) => m.to === 'ana@cliente.test' && /Recibimos tu pago/.test(m.subject)), 'recibo al cliente');
  assert.equal((await store.getRecord('trips', trip.id)).confirmation.paymentStatus, 'Pago parcial');
  assert.equal((await store.getRecord('trips', trip.id)).confirmation.paymentPaid, '5000');

  // Pago pendiente (OXXO) por el regreso del cliente → "en proceso", sin registrar
  payments['222'] = { id: 222, status: 'pending', transaction_amount: 15000, currency_id: 'MXN', external_reference: `tp-q${quoteId}-p2` };
  const back = await (await fetch(`${baseUrl}/api/public/pay/${token}?payment_id=222`)).json();
  assert.equal(back.returned, 'pending');
  assert.equal(back.plan.installments[1].pending, 'pending');
  assert.equal(back.plan.paid, 5000);

  // Pago ajeno o de otra cotización: se ignora
  payments['333'] = { id: 333, status: 'approved', transaction_amount: 1, currency_id: 'MXN', external_reference: 'otra-cosa' };
  assert.equal((await fetch(`${baseUrl}/api/public/payments/mercadopago?type=payment&data.id=333`, { method: 'POST' })).status, 200);

  // Pago manual parcial del vendedor
  const manual = await partner('POST', `/api/quotes/${quoteId}/payment-plan/p2/pay`, { amount: 5000, method: 'Transferencia', date: '2026-10-12' });
  assert.equal(manual.status, 201);
  assert.equal(manual.body.plan.installments[1].status, 'parcial');
  assert.equal(manual.body.plan.balance, 10000);
  assert.match(manual.body.url, new RegExp(`/pagar/${token}$`));
  assert.equal((await partner('POST', `/api/quotes/${quoteId}/payment-plan/p2/pay`, { amount: 100, date: '2099-01-01' })).status, 400, 'sin fechas futuras');

  // Deshacer: solo el administrador
  assert.equal((await partner('POST', `/api/quotes/${quoteId}/payment-plan/p2/undo`)).status, 403);
  const undone = await admin('POST', `/api/quotes/${quoteId}/payment-plan/p2/undo`);
  assert.equal(undone.status, 200);
  assert.equal(undone.body.plan.balance, 15000);
  assert.equal((await store.listClientEvents(lead.client_id)).filter((e) => e.type === 'payment').length, 1, 'se borra de la ficha');

  // Editar el plan: dividir la liquidación en dos
  const edit = await partner('PUT', `/api/quotes/${quoteId}/payment-plan`, { total: 20000, installments: [{ id: 'p1', label: 'Anticipo', due: '2026-10-15', amount: 5000 }, { id: 'p2', label: 'Pago 2', due: '2026-10-20', amount: 7500 }, { label: 'Liquidación', due: '2026-11-20', amount: 7500 }] });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.plan.installments.length, 3);
  assert.equal((await partner('PUT', `/api/quotes/${quoteId}/payment-plan`, { total: 20000, installments: [{ id: 'p2', label: 'Pago 2', due: '2026-10-20', amount: 20000 }] })).status, 400, 'no se quita lo pagado');

  // Recordatorios: 3 días antes del Pago 2 (20 oct) → vendedor, seguimiento "Pago" y correo al cliente
  const before = mails.length;
  clock = '2026-10-17 08:00:00';
  let r = await app.locals.reminders.runOnce();
  assert.ok(!r.payments, 'fuera de horario no avisa');
  clock = '2026-10-17 10:00:00';
  r = await app.locals.reminders.runOnce();
  assert.equal(r.payments, 1);
  assert.ok(store.notifications.some((n) => n.kind === 'payment_due' && n.user_id === paulinaId && n.link === `payplan:${quoteId}`));
  const fu = (await store.listRecords('followups')).find((f) => f.type === 'Pago');
  assert.ok(fu && fu.due_at.startsWith('2026-10-20 09:00'), 'seguimiento de cobro el día del vencimiento');
  const reminderMail = mails.slice(before).find((m) => m.to === 'ana@cliente.test');
  assert.ok(reminderMail && /Recordatorio de pago/.test(reminderMail.subject));
  assert.match(reminderMail.text, new RegExp(`/pagar/${token}`));
  r = await app.locals.reminders.runOnce();
  assert.ok(!r.payments, 'no repite');
  // El día del vencimiento y luego vencido (aviso también al administrador)
  clock = '2026-10-20 09:30:00';
  r = await app.locals.reminders.runOnce();
  assert.equal(r.payments, 1);
  clock = '2026-10-21 09:30:00';
  r = await app.locals.reminders.runOnce();
  assert.equal(r.payments, 1);
  assert.ok(store.notifications.some((n) => n.kind === 'payment_overdue' && n.user_id === adminId));

  // Liquidar todo: la liga muestra "liquidado" y la confirmación del viaje queda pagada
  await partner('POST', `/api/quotes/${quoteId}/payment-plan/p2/pay`, { method: 'Tarjeta' });
  const last = await partner('POST', `/api/quotes/${quoteId}/payment-plan/p3/pay`, { method: 'Efectivo' });
  assert.equal(last.body.plan.status, 'pagado');
  assert.equal((await store.getRecord('trips', trip.id)).confirmation.paymentStatus, 'Pagado por completo');
  const done = await (await fetch(`${baseUrl}/api/public/pay/${token}`)).json();
  assert.equal(done.plan.balance, 0);

  // Otro vendedor no ve el plan; operaciones no puede registrar pagos
  const otherQuote = (await admin('POST', '/api/quotes', { client_id: lead.client_id, destination: 'Tulum', hotel: 'X', price: 1000 })).body.record;
  assert.equal((await partner('POST', `/api/quotes/${otherQuote.id}/payment-plan`)).status, 404);
  assert.equal((await admin('POST', `/api/quotes/${otherQuote.id}/payment-plan`)).status, 400, 'solo cotizaciones aceptadas');

  // Rechazada → la liga deja de funcionar
  await partner('PATCH', `/api/quotes/${quoteId}`, { status: 'Rechazada' });
  assert.equal((await fetch(`${baseUrl}/api/public/pay/${token}`)).status, 404);
});
