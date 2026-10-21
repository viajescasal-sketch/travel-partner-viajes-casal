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
const T = require('../public/traslado-core');
const { desiredEvents } = (() => { try { return require('../src/gcal-sync'); } catch { return {}; } })();

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
  const sup = (await admin('POST', '/api/suppliers', { name: 'Traslados Caribe', type: 'Traslados' })).body.supplier;
  const other = (await admin('POST', '/api/suppliers', { name: 'Van Express', type: 'Traslados' })).body.supplier;
  const created = await admin('POST', '/api/users', { name: 'Chofer Jefe', email: 'traslados@example.test', role: 'proveedor', supplier_id: sup.id });
  const provider = await signIn(baseUrl, 'traslados@example.test', created.body.temporaryPassword);
  return { store: app.locals.dataStore, partner, admin, provider, sup, other };
}

const details = { kind: 'Redondo (llegada y salida)', passenger: 'Ana López', phone: '998 123 4567', adults: 2, minors: 0, service_date: '2026-12-20', pickup_time: '13:40', pickup_place: 'Aeropuerto CUN T3', dropoff_place: 'Hotel Riu Caribe', flight: 'Y4 123', return_date: '2026-12-24', return_time: '09:00' };
const transferTasks = async (store, tripId) => (await store.listRecords('followups')).filter((f) => f.auto?.kind === 'traslado' && f.auto.trip_id === tripId);

test('Traslado: el botón solo aplica si la cotización lo incluye o la ficha lo marca', async (context) => {
  const { partner, sup } = await setup(context);
  const client = (await partner('POST', '/api/clients', { name: 'Luis Pérez', phone: '998 000 1111' })).body.record;
  const r = await partner('POST', `/api/clients/${client.id}/transfer`, { supplier_id: sup.id, details, trip: { destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Incluye traslado/);

  // Reglas compartidas
  assert.equal(T.eligibility(client, []).ok, false);
  assert.equal(T.eligibility({ ...client, includes_transfer: true }, []).ok, true);
  assert.equal(T.eligibility(client, [{ client_id: client.id, status: 'Enviada', details: { services: { traslados: true } } }]).ok, true);
  assert.equal(T.eligibility(client, [{ client_id: client.id, status: 'Rechazada', details: { services: { traslados: true } } }]).ok, false, 'una cotización rechazada no cuenta');
  assert.equal(T.eligibility(client, [{ client_id: client.id, status: 'Borrador', services: 'Hotel + traslado redondo' }]).ok, true);
  assert.equal(T.eligibility(client, [{ client_id: client.id, status: 'Enviada', details: { services: { traslados: false } } }]).ok, false);

  // Se marca en la ficha (cliente cerrado sin cotización del CRM)
  const p = await partner('PATCH', `/api/clients/${client.id}`, { includes_transfer: true });
  assert.equal(p.status, 200);
  assert.equal(p.body.record.includes_transfer, true);
});

test('Traslado: crea el viaje, la reserva, la solicitud al portal y las 3 tareas; las tareas se mantienen solas', async (context) => {
  const { partner, provider, sup, store } = await setup(context);
  const client = (await partner('POST', '/api/clients', { name: 'Ana López', phone: '998 123 4567', includes_transfer: true })).body.record;
  assert.equal((await partner('POST', `/api/clients/${client.id}/transfer`, { supplier_id: sup.id, details: { ...details, passenger: '' }, trip: { destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' } })).status, 400, 'faltan datos del servicio');
  assert.equal((await store.listRecords('trips')).length, 0, 'si hay error no se crea nada');

  const r = await partner('POST', `/api/clients/${client.id}/transfer`, { supplier_id: sup.id, send: true, price: '2,400', details, trip: { destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.equal(r.body.trip.destination, 'Cancún');
  assert.equal(r.body.trip.start_date, '2026-12-20');
  assert.equal(r.body.sent, true);
  const b = r.body.booking;
  assert.equal(b.type, 'Traslado');
  assert.equal(b.status, 'Solicitada');
  assert.equal(b.price, 2400);
  assert.equal(b.supplier_due, '2026-12-15', 'pago al proveedor 5 días antes del viaje');
  assert.match(b.portal.folio, /^TR-\d{4}$/);

  // Tareas
  let tasks = await transferTasks(store, r.body.trip.id);
  assert.deepEqual(tasks.map((f) => f.auto.task).sort(), ['client', 'confirm', 'pay']);
  const byTask = (k) => tasks.find((f) => f.auto.task === k);
  assert.equal(byTask('pay').due_at.slice(0, 16), '2026-12-15 10:00');
  assert.equal(byTask('pay').type, 'Pago');
  assert.equal(byTask('client').due_at.slice(0, 16), '2026-12-18 10:00', '2 días antes del servicio');
  assert.ok(byTask('confirm').due_at > byTask('confirm').created_at, 'confirmar: un día después');
  assert.ok(tasks.every((f) => f.client_id === client.id && !f.done));
  assert.match(byTask('pay').title, /Pagar traslado TR-\d{4} a Traslados Caribe · Ana López/);

  // El proveedor ve la solicitud
  const portal = (await provider('GET', '/api/proveedor/portal')).body;
  assert.equal(portal.services.length, 1);
  assert.equal(portal.services[0].details.return_date, '2026-12-24');

  // Cotiza → la tarea "Confirmar" se cierra sola
  const tid = r.body.trip.id;
  assert.equal((await provider('POST', `/api/proveedor/services/${tid}/${b.id}/quote`, { amount: 1250 })).status, 200);
  tasks = await transferTasks(store, tid);
  assert.equal(byTask('confirm').done, true);
  assert.match(byTask('confirm').details, /proveedor ya respondió/);

  // Se acepta el precio → la tarea de pago muestra el monto
  assert.equal((await partner('POST', `/api/trips/${tid}/bookings/${b.id}/portal/decision`, { accept: true })).status, 200);
  tasks = await transferTasks(store, tid);
  assert.match(byTask('pay').title, /\$1,250/);
  assert.equal(byTask('pay').done, false);

  // Se paga al proveedor → la tarea de pago se cierra sola; la del cliente sigue abierta
  const trip = (await store.listRecords('trips')).find((t) => t.id === tid);
  const list = trip.bookings.list.map((x) => (x.id === b.id ? { ...x, supplier_paid: true } : x));
  assert.equal((await partner('PUT', `/api/trips/${tid}/bookings`, { list })).status, 200);
  tasks = await transferTasks(store, tid);
  assert.equal(byTask('pay').done, true);
  assert.equal(byTask('client').done, false);
});

test('Traslado: viaje existente, cotización con traslados, proveedor sin portal y cancelación', async (context) => {
  const { partner, sup, other, store } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Marta Ruiz', phone: '998 555 0000' }, destination: 'Tulum', start_date: '2027-01-10', end_date: '2027-01-15', travelers: 3 })).body.record;
  const quote = await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Tulum', hotel: 'Hotel Dreams', price: 45000, status: 'Enviada', details: { version: 1, startDate: '2027-01-10', endDate: '2027-01-15', services: { vuelo: true, hotel: true, traslados: true, tours: false, seguro: false }, proposals: [{ hotel: { name: 'Dreams' }, price: {} }] } });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: quote.body.record.id, destination: 'Tulum', start_date: '2027-01-10', end_date: '2027-01-15' })).body.record;

  // Pedirlo al portal de un proveedor sin acceso → error y no se crea nada
  const bad = await partner('POST', `/api/clients/${lead.client_id}/transfer`, { trip_id: trip.id, supplier_id: other.id, send: true, details: { ...details, service_date: '2027-01-10', return_date: '2027-01-15' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no tiene acceso al portal/);
  assert.equal(((await store.listRecords('trips')).find((t) => t.id === trip.id).bookings?.list || []).length, 0);

  // Sin portal: la reserva queda "Por reservar"; solo 2 tareas
  const r = await partner('POST', `/api/clients/${lead.client_id}/transfer`, { trip_id: trip.id, supplier_id: other.id, send: false, tasks: { confirm: true, pay: true, client: false }, details: { ...details, service_date: '2027-01-10', return_date: '2027-01-15' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, false);
  assert.equal(r.body.trip.id, trip.id);
  assert.equal(r.body.booking.status, 'Por reservar');
  assert.equal(r.body.booking.portal, null);
  let tasks = await transferTasks(store, trip.id);
  assert.deepEqual(tasks.map((f) => f.auto.task).sort(), ['confirm', 'pay']);

  // Google Calendar: el pago aparece una sola vez (como tarea), no duplicado como "pago a proveedor"
  if (desiredEvents) {
    const t2 = (await store.listRecords('trips')).find((t) => t.id === trip.id);
    const withCost = { ...t2, bookings: { list: t2.bookings.list.map((x) => ({ ...x, cost: 900 })) } };
    const data = { clients: await store.listRecords('clients'), leads: await store.listRecords('leads'), quotes: await store.listRecords('quotes'), trips: [withCost], followups: await store.listRecords('followups') };
    const users = await store.listUsers();
    const adminUser = users.find((u) => u.role === 'admin');
    assert.ok(Object.keys(desiredEvents(adminUser, { ...data, followups: [] }, { today: '2027-01-01' })).some((k) => k.startsWith('s:')), 'sin tarea, el pago sí sale como evento');
    const ev = desiredEvents(adminUser, data, { today: '2027-01-01' });
    assert.ok(!Object.keys(ev).some((k) => k.startsWith('s:')), 'sin evento duplicado de pago al proveedor');
  }

  // Se cancela la reserva → sus tareas abiertas se cierran solas
  const t3 = (await store.listRecords('trips')).find((t) => t.id === trip.id);
  const list = t3.bookings.list.map((x) => ({ ...x, status: 'Cancelada' }));
  assert.equal((await partner('PUT', `/api/trips/${trip.id}/bookings`, { list })).status, 200);
  tasks = await transferTasks(store, trip.id);
  assert.ok(tasks.every((f) => f.done), 'tareas cerradas');
  assert.match(tasks[0].details, /se canceló/);
  void sup;
});
