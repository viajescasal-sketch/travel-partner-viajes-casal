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
const T = require('../public/viaje-core');
require('../public/docs/documents.js');

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
  return { baseUrl, store: app.locals.dataStore, partner, admin };
}

test('TP-305: catálogo precargado, permisos de edición y validaciones', async (context) => {
  const { partner, admin } = await setup(context);
  const list = await partner('GET', '/api/suppliers');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.suppliers.map((s) => [s.name, s.type]), [['Azabache', 'Mayorista'], ['Grupo Xcaret', 'Operador de tours'], ['HotelDO', 'Mayorista'], ['Travel Shop', 'Mayorista']]);
  assert.equal(list.body.canEdit, false, 'el vendedor solo consulta');
  assert.equal((await partner('POST', '/api/suppliers', { name: 'Hotel X' })).status, 403);

  const riu = await admin('POST', '/api/suppliers', { name: 'Hotel Riu Caribe', type: 'Hotel', commission: '12', email: 'reservas@riu.test', website: 'riu.com', rates: 'JS TI desde $3,800' });
  assert.equal(riu.status, 201);
  assert.equal(riu.body.supplier.commission, 12);
  assert.equal(riu.body.supplier.website, 'https://riu.com');
  assert.equal((await admin('POST', '/api/suppliers', { name: 'hotel riu caribe' })).status, 409, 'sin nombres repetidos');
  assert.equal((await admin('POST', '/api/suppliers', { name: 'Y', commission: 140 })).status, 400);
  assert.equal((await admin('POST', '/api/suppliers', { name: 'Y', email: 'no-es-correo' })).status, 400);
  const upd = await admin('PATCH', `/api/suppliers/${riu.body.supplier.id}`, { phone: '998 111 2233', active: false });
  assert.equal(upd.body.supplier.active, false);
  assert.equal(upd.body.supplier.commission, 12, 'conserva lo que no cambió');
  assert.equal((await partner('DELETE', `/api/suppliers/${riu.body.supplier.id}`)).status, 403);

  const crm = (await partner('GET', '/api/crm')).body;
  assert.equal(crm.suppliers.length, 5, 'la plataforma recibe el catálogo');
  assert.equal(T.netFromCommission(10000, 12), 8800);
  assert.equal(T.netFromCommission('', 12), '');
  assert.equal((await admin('DELETE', `/api/suppliers/${riu.body.supplier.id}`)).status, 200);
  const logs = JSON.stringify((await admin('GET', '/api/activity')).body);
  assert.match(logs, /Proveedor agregado al catálogo/);
});

test('TP-304: reservas del viaje, avisos, itinerario del cliente y reservas desde el Canvas', async (context) => {
  const { baseUrl, partner, admin } = await setup(context);
  const sup = (await admin('POST', '/api/suppliers', { name: 'Hotel Riu Caribe', type: 'Hotel', commission: 12 })).body.supplier;
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', travelers: 2 })).body.record;
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;

  // Solo por la ruta propia (campo interno).
  await partner('PATCH', `/api/trips/${trip.id}`, { bookings: { list: [{ type: 'Hotel', description: 'x' }] } });
  assert.equal((await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings.length, 0);

  const put = await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [
    { type: 'Hotel', status: 'Confirmada', supplier_id: sup.id, supplier_name: 'cualquier cosa', confirmation: 'RIU-7788', description: 'Junior Suite · Todo incluido', start_date: '2026-12-20', end_date: '2026-12-24', cost: 18000, price: 21000, supplier_due: '2026-12-01', voucher_ids: [999] },
    { type: 'Vuelo', status: 'Confirmada', supplier_name: 'Volaris', confirmation: 'XKQ12A', description: 'Y4 123 CDMX → CUN', start_date: '2026-12-20', time: '08:35', cost: 7000, price: 8000, supplier_paid: true },
    { type: 'Traslado', status: 'Por reservar', supplier_name: 'Transportes Caribe', description: 'Aeropuerto ↔ Hotel', start_date: '2026-12-20' },
    { type: 'Tour', status: 'Solicitada', supplier_name: 'Grupo Xcaret', description: 'Xcaret Plus', confirmation: 'SOLO-INTERNO', start_date: '2026-12-22' },
    { type: 'Otro', status: 'Por reservar' }
  ] });
  assert.equal(put.status, 200);
  const list = put.body.bookings;
  assert.equal(list.length, 4, 'descarta renglones vacíos');
  assert.equal(list.find((b) => b.type === 'Hotel').supplier_name, 'Hotel Riu Caribe', 'el nombre viene del catálogo');
  assert.deepEqual(list.find((b) => b.type === 'Hotel').voucher_ids, [], 'solo documentos del viaje');
  assert.deepEqual(list.map((b) => b.type), ['Vuelo', 'Hotel', 'Traslado', 'Tour'], 'ordenadas por fecha y hora');

  const today = '2026-11-28';
  assert.deepEqual(T.bookingAlerts(list[1], trip, today).map((a) => a.text), ['Pagar al proveedor en 3 días']);
  assert.deepEqual(T.bookingAlerts(list[1], trip, '2026-12-03').map((a) => a.level), ['danger']);
  assert.deepEqual(T.bookingAlerts(list[2], trip, today).map((a) => a.text), ['Sin reservar y el viaje sale en 22 días']);
  assert.deepEqual(T.bookingAlerts({ ...list[0], confirmation: '' }, trip, today).map((a) => a.text), ['Confirmada sin número de confirmación']);
  const s = T.bookingsSummary(list, trip, today);
  assert.deepEqual([s.total, s.confirmed, s.pending, s.cost, s.price, s.owed], [4, 2, 2, 25000, 29000, 18000]);

  // Bitácora con los cambios de estado, sin costos.
  await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: list.map((b) => (b.type === 'Traslado' ? { ...b, status: 'Confirmada', confirmation: 'TC-1' } : b)) });
  const logs = JSON.stringify((await admin('GET', '/api/activity')).body);
  assert.match(logs, /Traslado Transportes Caribe: Por reservar → Confirmada/);

  // El cliente ve solo las claves confirmadas y nunca costos.
  const url = (await partner('POST', `/api/trips/${trip.id}/share`, {})).body.url;
  const pub = await (await fetch(`${baseUrl}/api/public/trip/${url.split('/').pop()}`)).json();
  assert.deepEqual(pub.trip.bookings.map((b) => [b.type, b.confirmation]), [['Vuelo', 'XKQ12A'], ['Hotel', 'RIU-7788'], ['Traslado', 'TC-1']]);
  assert.doesNotMatch(JSON.stringify(pub), /SOLO-INTERNO|18000|supplier_due/);
  // La confirmación toma la clave del vuelo confirmado.
  const doc = (await partner('GET', `/api/documents/trip/${trip.id}`)).body;
  assert.equal(TPDocs.confirmationDefaults(doc).flightBooking, 'XKQ12A');

  // Reservas desde el lienzo: liga con el catálogo, no repite bloques ya reservados.
  const canvas = T.normalizeCanvas({ start_date: '2026-12-20', end_date: '2026-12-24', blocks: [
    { type: 'hotel', day: 0, nights: 4, title: 'Hotel Riu Caribe', provider: 'hotel riu caribe', plan: 'Todo incluido', cost: 18000, price: 21000 },
    { type: 'tour', day: 2, time: '07:00', title: 'Xcaret Plus', provider: 'Grupo Xcaret', price: 4600 },
    { type: 'nota', day: 3, title: 'Cena' }
  ] });
  const suppliers = (await partner('GET', '/api/suppliers')).body.suppliers;
  const gen = T.bookingsFromCanvas(canvas, trip, [], suppliers);
  assert.deepEqual(gen.map((b) => [b.type, b.supplier_name, b.supplier_id != null, b.start_date, b.end_date]), [['Hotel', 'Hotel Riu Caribe', true, '2026-12-20', '2026-12-24'], ['Tour', 'Grupo Xcaret', true, '2026-12-22', '2026-12-22']]);
  assert.equal(T.bookingsFromCanvas(canvas, trip, gen, suppliers).length, 0, 'no duplica');
  const fromConf = T.bookingsFromConfirmation({ services: { flight: true, hotel: true, transfer: true }, airline: 'Viva', outboundFlight: 'MTY → CUN', returnFlight: 'CUN → MTY', hotelName: 'Grand Oasis', operator: 'Traslados Q', transferOutOrigin: 'Aeropuerto' }, trip);
  assert.deepEqual(fromConf.map((b) => b.type), ['Vuelo', 'Vuelo', 'Hotel', 'Traslado']);
  assert.equal((await partner('PUT', '/api/trips/99999/bookings', { list: [] })).status, 404);
});
