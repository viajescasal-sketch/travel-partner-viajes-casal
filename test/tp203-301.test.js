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
const { createReminders } = require('../src/reminders');
const { createAssignment } = require('../src/assignment');
require('../public/docs/documents.js');

async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body, headers) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), cookie, ...(headers || {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
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
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const users = (await admin('GET', '/api/crm')).body.users;
  return { app, baseUrl, store: app.locals.dataStore, partner, admin, adminId: users.find((u) => u.role === 'admin').id, paulinaId: users.find((u) => u.role === 'travel_partner').id };
}
const pub = async (baseUrl, method, path, body) => { const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('TP-203: el cliente elige una opción y acepta en línea', async (context) => {
  const { baseUrl, store, partner, admin, adminId, paulinaId } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-27', travelers: 2 })).body.record;
  const details = {
    varying: 'hotel', principal: 0, services: { vuelo: false, hotel: true, traslados: true, tours: false, seguro: false }, fixed: {},
    proposals: [
      { hotel: { hotel: 'Hotel Riu', plan: 'Todo incluido', stars: '5' }, price: { total: '30000' }, pay: { esquema: 'anticipo', anticipo: '6000', anticipoFecha: '2099-01-10' } },
      { hotel: { hotel: 'Grand Oasis', stars: '4' }, price: { total: '24,500' }, pay: { esquema: 'anticipo', anticipo: '5000', anticipoFecha: '2099-01-12' } }
    ]
  };
  const quote = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu — Todo incluido', price: 30000, status: 'Enviada', valid_until: '2099-12-31', details })).body.record;
  const url = (await partner('POST', `/api/quotes/${quote.id}/share`, {})).body.url;
  const token = url.split('/').pop();

  const before = await pub(baseUrl, 'GET', `/api/public/quote/${token}`);
  assert.equal(before.body.accept.canAccept, true);
  assert.deepEqual(before.body.accept.options.map((o) => [o.label, o.total]), [['Hotel Riu — Todo incluido', 30000], ['Grand Oasis', 24500]]);
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { option: 1, name: 'Ana López' })).status, 400, 'sin aceptar condiciones');
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { option: 1, name: 'A', terms: true })).status, 400, 'sin nombre');
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { option: 7, name: 'Ana López', terms: true })).status, 400, 'opción inválida');

  const ok = await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { option: 1, name: 'Ana López Pérez', terms: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.payUrl, /^\/pagar\/[a-f0-9]{40}$/);
  const q = await store.getRecord('quotes', quote.id);
  assert.equal(q.status, 'Aceptada');
  assert.equal(q.price, 24500);
  assert.equal(q.hotel, 'Grand Oasis');
  assert.equal(q.details.principal, 1);
  assert.equal(q.acceptance.name, 'Ana López Pérez');
  assert.equal(q.payment_plan.installments[0].amount, 5000, 'el plan usa el anticipo de la opción elegida');
  assert.equal((await store.getRecord('leads', lead.id)).stage, 'Vendido');
  const notes = store.notifications.filter((n) => n.kind === 'quote_accepted');
  assert.ok(notes.some((n) => n.user_id === paulinaId) && notes.some((n) => n.user_id === adminId));

  const again = await pub(baseUrl, 'POST', `/api/public/quote/${token}/accept`, { option: 0, name: 'Otra', terms: true });
  assert.equal(again.body.already, true);
  assert.equal((await store.getRecord('quotes', quote.id)).price, 24500, 'no se cambia la opción ya aceptada');
  const after = await pub(baseUrl, 'GET', `/api/public/quote/${token}`);
  assert.equal(after.body.accept.accepted, true);
  assert.equal(after.body.accept.acceptedOption, 1);
  assert.doesNotMatch(JSON.stringify(after.body), /pay_token|payment_plan|"acceptance"/);

  // Vencida: no se puede aceptar
  const old = (await admin('POST', '/api/quotes', { client_id: lead.client_id, destination: 'Tulum', hotel: 'X', price: 1000, status: 'Enviada', valid_until: '2020-01-01' })).body.record;
  const oldToken = (await admin('POST', `/api/quotes/${old.id}/share`, {})).body.url.split('/').pop();
  assert.equal((await pub(baseUrl, 'GET', `/api/public/quote/${oldToken}`)).body.accept.expired, true);
  assert.equal((await pub(baseUrl, 'POST', `/api/public/quote/${oldToken}/accept`, { name: 'Ana López', terms: true })).status, 400);
});

test('TP-207: motivo de pérdida obligatorio y aviso del recontacto', async (context) => {
  const { store, partner, paulinaId } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Luis Gómez', phone: '998 765 4321' }, destination: 'Tulum' })).body.record;
  const no = await partner('PATCH', `/api/leads/${lead.id}`, { stage: 'Perdido' });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /motivo/);
  assert.equal((await partner('POST', '/api/leads', { client: { name: 'Otro', phone: '998 000 1111' }, destination: 'X', stage: 'Perdido' })).status, 400);
  const lost = await partner('PATCH', `/api/leads/${lead.id}`, { stage: 'Perdido', lost_reason: 'Pospuso o canceló el viaje: lo deja para el verano' });
  assert.equal(lost.status, 200);
  // Editar otras cosas de un perdido no exige volver a escribir el motivo
  assert.equal((await partner('PATCH', `/api/leads/${lead.id}`, { notes: 'Llamar en mayo' })).status, 200);
  // Recontacto programado: avisa aunque el lead esté cerrado
  const fu = await partner('POST', '/api/followups', { lead_id: lead.id, type: 'WhatsApp', title: 'Recontactar a Luis', due_at: '2099-03-01 10:00' });
  assert.equal(fu.status, 201);
  const assignment = createAssignment(store, { configured: false });
  let clock = '2099-02-01 10:00:00';
  const reminders = createReminders(store, assignment, {}, { now: () => clock });
  await reminders.runOnce();
  clock = '2099-03-01 10:30:00';
  const r = await reminders.runOnce();
  assert.equal(r.overdue, 1);
  assert.ok(store.notifications.some((n) => n.kind === 'followup_overdue' && n.user_id === paulinaId));
});

test('TP-301: itinerario digital con vouchers, pagos y contactos', async (context) => {
  const { baseUrl, store, partner, admin } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@x.test' }, destination: 'Cancún', start_date: '2099-12-20', end_date: '2099-12-23', travelers: 2 })).body.record;
  const quote = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu', price: 20000, status: 'Aceptada' })).body.record;
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: quote.id, destination: 'Cancún', start_date: '2099-12-20', end_date: '2099-12-23', confirmation: { hotelName: 'Hotel Riu Palace', hotelPhone: '998 848 7000', emergencyPhone: '998 111 2233' } })).body.record;

  const share = await partner('POST', `/api/trips/${trip.id}/share`, {});
  assert.equal(share.status, 200);
  const token = share.body.url.split('/').pop();
  assert.match(token, /^[a-f0-9]{40}$/);
  assert.equal((await partner('POST', `/api/trips/${trip.id}/share`, {})).body.url, share.body.url, 'se conserva');
  const page = await fetch(`${baseUrl}/viaje/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /itinerario\.js/);

  // Vouchers: PDF sí, otros formatos no
  const pdf = Buffer.from('%PDF-1.4\n% voucher de prueba\n%%EOF');
  const up = await partner('POST', `/api/trips/${trip.id}/vouchers`, pdf, { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Voucher hotel.pdf') });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.vouchers[0].name, 'Voucher hotel.pdf');
  assert.equal((await partner('POST', `/api/trips/${trip.id}/vouchers`, Buffer.from('hola'), { 'content-type': 'application/pdf' })).status, 400);
  const voucherId = up.body.vouchers[0].id;

  // Día por día guardado por el vendedor
  const days = [{ date: '2099-12-20', title: 'Llegada', text: '15:00 Check-in', place: 'Hotel Riu Palace' }, { date: '2099-12-21', title: 'Isla Mujeres', text: '09:00 Catamarán', place: '' }];
  assert.equal((await partner('PATCH', `/api/trips/${trip.id}`, { itinerary: { days } })).status, 200);

  const data = (await pub(baseUrl, 'GET', `/api/public/trip/${token}`)).body;
  assert.equal(data.trip.itinerary.days[1].title, 'Isla Mujeres');
  assert.equal(data.client.name, 'Ana López');
  assert.doesNotMatch(JSON.stringify(data), /998 123 4567|ana@x\.test|share_token|pay_token/, 'sin datos de contacto del cliente ni tokens');
  assert.equal(data.vouchers.length, 1);
  assert.equal(data.payment.balance, 20000, 'muestra el saldo pendiente');
  assert.match(data.payment.url, /^\/pagar\//);
  assert.ok((await store.getRecord('trips', trip.id)).viewed_at, 'registra que el cliente lo abrió');

  // El itinerario automático se arma con la confirmación (función compartida)
  const D = globalThis.TPDocs;
  const auto = D.buildItinerary(D.mergeConfirmation(data.trip.confirmation, D.confirmationDefaults({ ...data, seller: data.seller || {} })), data);
  assert.equal(auto.length, 4);
  assert.match(auto[0].text, /Check-in en Hotel Riu Palace/);
  assert.match(auto[3].title, /Regreso/);

  const fileRes = await fetch(`${baseUrl}/api/public/trip/${token}/file/${voucherId}?download=1`);
  assert.equal(fileRes.status, 200);
  assert.match(fileRes.headers.get('content-type'), /pdf/);
  assert.match(fileRes.headers.get('content-disposition'), /attachment/);
  const otherMedia = await store.createMedia({ ownerId: null, mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  assert.equal((await fetch(`${baseUrl}/api/public/trip/${token}/file/${otherMedia}`)).status, 404, 'solo archivos del viaje');

  // Quitar voucher y desactivar liga
  assert.equal((await partner('DELETE', `/api/trips/${trip.id}/vouchers/${voucherId}`)).body.vouchers.length, 0);
  assert.equal((await fetch(`${baseUrl}/api/public/trip/${token}/file/${voucherId}`)).status, 404);
  await partner('POST', `/api/trips/${trip.id}/share`, { enabled: false });
  assert.equal((await fetch(`${baseUrl}/viaje/${token}`)).status, 404);
  assert.equal((await pub(baseUrl, 'GET', `/api/public/trip/${token}`)).status, 404);
  // Operaciones/otros: el administrador sí puede; un viaje ajeno no
  assert.equal((await admin('POST', `/api/trips/${trip.id}/share`, {})).status, 200);
  assert.equal((await partner('POST', '/api/trips/99999/share', {})).status, 404);
});
