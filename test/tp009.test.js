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
const P = require('../public/proveedor-core');

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
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const sup = (await admin('POST', '/api/suppliers', { name: 'Traslados Caribe', type: 'Traslados', whatsapp: '9981112233' })).body.supplier;
  const other = (await admin('POST', '/api/suppliers', { name: 'Otra Transportadora', type: 'Traslados' })).body.supplier;
  const created = await admin('POST', '/api/users', { name: 'Chofer Jefe', email: 'traslados@example.test', role: 'proveedor', supplier_id: sup.id });
  assert.equal(created.status, 201);
  const provider = await signIn(baseUrl, 'traslados@example.test', created.body.temporaryPassword);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@cliente.test' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', travelers: 2 })).body.record;
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;
  const put = await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [
    { id: 'rtras01', type: 'Traslado', status: 'Por reservar', supplier_id: sup.id, supplier_name: sup.name, description: 'Aeropuerto → Hotel Riu', start_date: '2026-12-20', price: 1800 },
    { id: 'rhot001', type: 'Hotel', status: 'Confirmada', supplier_name: 'Hotel Riu', description: 'Junior Suite', start_date: '2026-12-20', end_date: '2026-12-24', cost: 18000, price: 21000 }
  ] });
  assert.equal(put.status, 200);
  return { baseUrl, store: app.locals.dataStore, partner, admin, provider, sup, other, trip, created: created.body.user };
}

const details = { kind: 'Llegada (aeropuerto → hotel)', passenger: 'Ana López', phone: '998 123 4567', adults: 2, minors: 1, service_date: '2026-12-20', pickup_time: '13:40', pickup_place: 'Aeropuerto CUN T3', dropoff_place: 'Hotel Riu Caribe', flight: 'Y4 123', notes: 'Silla para bebé' };

test('TP-009: el usuario proveedor solo entra a su portal', async (context) => {
  const { admin, provider, sup, created } = await setup(context);
  assert.equal(created.role, 'proveedor');
  assert.equal(created.supplierId, sup.id);
  assert.equal((await admin('POST', '/api/users', { name: 'X', email: 'x@example.test', role: 'proveedor' })).status, 400, 'debe ligarse a un proveedor del catálogo');
  for (const path of ['/api/crm', '/api/suppliers', '/api/leads', '/api/trips', '/api/users', '/api/activity', '/api/supplier-portal/links']) {
    assert.equal((await provider('GET', path)).status, 403, `${path} bloqueado para el proveedor`);
  }
  const portal = await provider('GET', '/api/proveedor/portal');
  assert.equal(portal.status, 200);
  assert.equal(portal.body.supplier.name, 'Traslados Caribe');
  assert.deepEqual(portal.body.services, [], 'no ve reservas que no se le han enviado');
  assert.equal((await provider('GET', '/api/notifications')).status, 200);
  assert.equal((await admin('GET', '/api/proveedor/portal')).status, 403, 'el portal es solo para proveedores');
  const crm = (await admin('GET', '/api/crm')).body;
  assert.ok(!crm.users.some((u) => u.role === 'proveedor'), 'los proveedores no aparecen como parte del equipo');
  const users = (await admin('GET', '/api/users')).body.users;
  assert.equal(users.find((u) => u.email === 'traslados@example.test').supplierId, sup.id);
});

test('TP-009: solicitud de precio → cotización → aceptación → confirmación y pagos', async (context) => {
  const { partner, admin, provider, sup, other, trip, store } = await setup(context);
  // Validaciones del envío.
  assert.equal((await partner('POST', `/api/trips/${trip.id}/bookings/rhot001/portal/request`, { details })).status, 400, 'sin proveedor del catálogo');
  assert.equal((await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/request`, { details: { ...details, passenger: '' } })).status, 400);
  const req = await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/request`, { details });
  assert.equal(req.status, 200);
  assert.equal(req.body.booking.status, 'Solicitada');
  assert.equal(req.body.booking.portal.folio, 'TR-0001');

  // El proveedor la ve con datos operativos, sin precio de venta ni correo del cliente.
  let portal = (await provider('GET', '/api/proveedor/portal')).body;
  assert.equal(portal.services.length, 1);
  const s = portal.services[0];
  assert.equal(s.state, 'Solicitada');
  assert.equal(s.details.passenger, 'Ana López');
  assert.equal(s.details.minors, 1);
  const raw = JSON.stringify(portal);
  assert.ok(!raw.includes('1800') && !raw.includes('ana@cliente.test') && !raw.includes('21000') && !raw.includes('Junior Suite'), 'sin precio de venta, correo ni otras reservas');
  const notes = (await provider('GET', '/api/notifications')).body.items;
  assert.match(notes[0].title, /Nueva solicitud de precio TR-0001/);

  // Cotiza; no puede confirmar antes de que se acepte.
  assert.equal((await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/confirm`, { confirmation: 'X' })).status, 400);
  assert.equal((await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: 0 })).status, 400);
  const q = await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: '1,250', notes: 'Van privada' });
  assert.equal(q.status, 200);
  assert.equal(q.body.service.quote.amount, 1250);
  const teamNote = (await partner('GET', '/api/notifications')).body.items[0];
  assert.match(teamNote.title, /Traslados Caribe envió precio TR-0001/);
  assert.equal(teamNote.link, `trip:${trip.id}`);

  // Si el equipo guarda las reservas con una copia vieja, no pisa lo que respondió el proveedor.
  const stale = req.body.booking;
  await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [{ ...stale, status: 'Por reservar', notes: 'nota interna' }, { id: 'rhot001', type: 'Hotel', status: 'Confirmada', supplier_name: 'Hotel Riu', description: 'Junior Suite', start_date: '2026-12-20', cost: 18000, price: 21000 }] });
  let bk = (await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings.find((b) => b.id === 'rtras01');
  assert.equal(bk.portal.state, 'Cotizada');
  assert.equal(bk.status, 'Solicitada');
  assert.equal(bk.notes, 'nota interna');
  // No se puede cambiar de proveedor ni quitar la reserva con la solicitud abierta.
  assert.equal((await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [{ ...bk, supplier_id: other.id }] })).status, 400);
  assert.equal((await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [] })).status, 400);

  // Aceptar el precio → costo neto y fecha de pago.
  const dec = await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/decision`, { accept: true });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.booking.cost, 1250);
  assert.equal(dec.body.booking.supplier_due, '2026-12-15', 'sin fecha de pago: 5 días antes del viaje');
  assert.equal((await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/decision`, { accept: true })).status, 400, 'una sola decisión');
  assert.equal((await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: 2000 })).status, 400, 'ya no cambia el precio');

  // El proveedor confirma con folio y chofer.
  const conf = await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/confirm`, { confirmation: 'TC-889', driver_name: 'Luis', driver_phone: '998 000 1111', unit: 'Van blanca' });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.service.state, 'Confirmada');
  bk = (await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings.find((b) => b.id === 'rtras01');
  assert.equal(bk.status, 'Confirmada');
  assert.equal(bk.confirmation, 'TC-889');
  assert.equal(bk.portal.driver.name, 'Luis');

  // Pagos: por pagar y luego pagado (fecha automática).
  portal = (await provider('GET', '/api/proveedor/portal')).body;
  let pay = P.payments(portal.services, '2026-12-01');
  assert.equal(pay.open, 1250);
  assert.equal(P.payments(portal.services, '2026-12-25').late, 1250);
  bk.supplier_paid = true;
  const all = (await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings.map((b) => (b.id === 'rtras01' ? bk : b));
  assert.equal((await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: all })).status, 200);
  portal = (await provider('GET', '/api/proveedor/portal')).body;
  const paid = portal.services[0];
  assert.equal(paid.paid, true);
  assert.match(paid.paid_at, /^\d{4}-\d{2}-\d{2}$/);
  pay = P.payments(portal.services, paid.paid_at);
  assert.equal(pay.open, 0);
  assert.equal(pay.paidMonth, 1250);

  const logs = JSON.stringify((await admin('GET', '/api/activity')).body);
  assert.match(logs, /Portal Traslados Caribe TR-0001: confirmado/);
  void store; void other;
});

test('TP-009: rechazo, sin disponibilidad, cancelación y aislamiento entre proveedores', async (context) => {
  const { baseUrl, partner, admin, provider, other, trip } = await setup(context);
  await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/request`, { details });
  await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: 3000 });
  const rej = await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/decision`, { accept: false, note: 'Muy alto' });
  assert.equal(rej.body.booking.portal.state, 'Rechazada');
  assert.equal(rej.body.booking.cost, '', 'no se toma el precio rechazado');
  // Se puede volver a pedir (mismo folio).
  const again = await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/request`, { details: { ...details, pickup_time: '14:00' } });
  assert.equal(again.body.booking.portal.folio, 'TR-0001');
  assert.equal(again.body.booking.portal.state, 'Solicitada');
  const dec = await provider('POST', `/api/proveedor/services/${trip.id}/rtras01/decline`, { note: 'Sin unidades' });
  assert.equal(dec.body.service.state, 'No disponible');
  assert.equal((await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings.find((b) => b.id === 'rtras01').status, 'Por reservar');
  await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/request`, { details });
  const can = await partner('POST', `/api/trips/${trip.id}/bookings/rtras01/portal/cancel`, { note: 'El cliente canceló' });
  assert.equal(can.body.booking.portal.state, 'Cancelada');
  const sec = P.sections((await provider('GET', '/api/proveedor/portal')).body.services, '2026-12-01');
  assert.equal(sec.closed.length, 1);

  // Un proveedor sin servicios con nosotros no ve los de otro, ni puede responderlos.
  const u2 = (await admin('POST', '/api/users', { name: 'Otra', email: 'otra@example.test', role: 'proveedor', supplier_id: other.id })).body;
  const prov2 = await signIn(baseUrl, 'otra@example.test', u2.temporaryPassword);
  assert.deepEqual((await prov2('GET', '/api/proveedor/portal')).body.services, []);
  assert.equal((await prov2('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: 10 })).status, 404);
  // Un vendedor no puede usar las rutas del proveedor.
  assert.equal((await partner('POST', `/api/proveedor/services/${trip.id}/rtras01/quote`, { amount: 10 })).status, 403);
});

test('TP-009: utilidades del portal (secciones, pagos y calendario)', () => {
  const today = '2026-12-10';
  const list = [
    { state: 'Solicitada', date: '2026-12-20' }, { state: 'Cotizada', date: '2026-12-21' },
    { state: 'Aceptada', date: '2026-12-22', amount: 500, due: '2026-12-05', paid: false },
    { state: 'Confirmada', date: '2026-12-01', amount: 700, due: '2026-12-01', paid: true, paid_at: '2026-12-02' },
    { state: 'Confirmada', date: '2026-12-30', amount: 900, due: '', paid: false },
    { state: 'Cancelada', date: '2026-12-15' }
  ];
  const s = P.sections(list, today);
  assert.equal(s.toQuote.length, 1);
  assert.equal(s.quoted.length, 1);
  assert.equal(s.toConfirm.length, 1);
  assert.equal(s.upcoming.length, 1, 'solo confirmados; los aceptados están en Por confirmar');
  assert.equal(s.done.length, 1);
  assert.equal(s.closed.length, 1);
  const p = P.payments(list, today);
  assert.equal(p.open, 1400);
  assert.equal(p.late, 500);
  assert.equal(p.paidMonth, 700);
  assert.equal(p.noDate, 1);
  assert.deepEqual(Object.keys(p.byDay).sort(), ['2026-12-02', '2026-12-05']);
  const g = P.monthGrid('2026-12');
  assert.equal(g[0].date, '2026-11-30', 'empieza en lunes');
  assert.equal(g.length % 7, 0);
  assert.equal(P.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(P.defaultPayDue('2026-12-20', '2026-12-22', '2026-10-20'), '2026-12-15');
  assert.equal(P.defaultPayDue('2026-03-03', '', '2026-02-01'), '2026-02-26', 'cruza de mes');
  assert.equal(P.defaultPayDue('2026-10-22', '', '2026-10-20'), '2026-10-20', 'si ya pasó, queda hoy');
  assert.equal(P.defaultPayDue('', '2026-12-22', '2026-10-20'), '2026-12-17', 'sin viaje, usa la fecha del servicio');
  assert.equal(P.cleanDetails({ adults: -3, return_date: '2026-01-01', service_date: '2026-02-01' }).return_date, '2026-02-01');
});
