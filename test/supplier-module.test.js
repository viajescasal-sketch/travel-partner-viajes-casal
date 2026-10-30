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
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const sup = (await admin('POST', '/api/suppliers', { name: 'Traslados Caribe', type: 'Traslados' })).body.supplier;
  const created = await admin('POST', '/api/users', { name: 'Chofer Jefe', email: 'traslados@example.test', role: 'proveedor', supplier_id: sup.id });
  const provider = await signIn(baseUrl, 'traslados@example.test', created.body.temporaryPassword);
  return { store: app.locals.dataStore, partner, admin, provider, sup };
}

const details = { kind: 'Redondo (llegada y salida)', passenger: 'Ana López', phone: '998 123 4567', adults: 2, minors: 0, service_date: '2026-12-20', pickup_time: '13:40', pickup_place: 'Aeropuerto CUN T3', dropoff_place: 'Hotel Riu Caribe', return_date: '2026-12-24', return_time: '09:00' };
const trip = { destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' };

test('Módulo de proveedor: solo el admin lo cambia y por defecto está activo', async (context) => {
  const { partner, admin } = await setup(context);
  assert.equal((await partner('GET', '/api/supplier-module')).body.enabled, true);
  assert.equal((await partner('PUT', '/api/supplier-module', { enabled: false })).status, 403);
  assert.equal((await admin('PUT', '/api/supplier-module', { enabled: 'no' })).status, 400);
  assert.equal((await admin('PUT', '/api/supplier-module', { enabled: false })).body.enabled, false);
  assert.equal((await partner('GET', '/api/supplier-module')).body.enabled, false);
});

test('Módulo apagado: el proveedor no entra al portal y los vínculos salen vacíos', async (context) => {
  const { admin, provider, partner } = await setup(context);
  assert.notEqual((await provider('GET', '/api/proveedor/me')).status, 403);
  await admin('PUT', '/api/supplier-module', { enabled: false });
  const r = await provider('GET', '/api/proveedor/me');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /desactivado/);
  const links = await partner('GET', '/api/supplier-portal/links');
  assert.equal(links.body.enabled, false);
  assert.deepEqual(links.body.suppliers, {});
  await admin('PUT', '/api/supplier-module', { enabled: true });
  assert.notEqual((await provider('GET', '/api/proveedor/me')).status, 403);
});

test('Módulo apagado: traslado manual con costo, fecha de pago editable y alerta para vendedora y admin', async (context) => {
  const { admin, partner, sup, store } = await setup(context);
  await admin('PUT', '/api/supplier-module', { enabled: false });
  const client = (await partner('POST', '/api/clients', { name: 'Ana López', phone: '998 123 4567', includes_transfer: true })).body.record;
  const base = { supplier_id: sup.id, details, trip, price: '2400', send: true };

  assert.equal((await partner('POST', `/api/clients/${client.id}/transfer`, base)).status, 400, 'sin costo no se guarda');
  assert.equal((await store.listRecords('trips')).length, 0);

  const r = await partner('POST', `/api/clients/${client.id}/transfer`, { ...base, cost: '1,800', supplier_due: '2026-12-10', status: 'Confirmada', confirmation: 'WA-77' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.manual, true);
  assert.equal(r.body.sent, false, 'nunca se envía al portal');
  assert.equal(r.body.booking.cost, 1800);
  assert.equal(r.body.booking.price, 2400);
  assert.equal(r.body.booking.supplier_due, '2026-12-10');
  assert.equal(r.body.booking.status, 'Confirmada');
  assert.ok(!r.body.booking.portal);

  const tasks = (await store.listRecords('followups')).filter((f) => f.auto?.kind === 'traslado');
  assert.equal(tasks.some((f) => f.auto.task === 'confirm'), false, 'no hay tarea de confirmar con el portal');
  const pays = tasks.filter((f) => f.auto.task === 'pay');
  assert.equal(pays.length, 2, 'alerta de pago para la vendedora y para el admin');
  assert.equal(new Set(pays.map((f) => f.owner_id)).size, 2);
  assert.ok(pays.every((f) => f.due_at.startsWith('2026-12-10')));
  assert.equal(tasks.filter((f) => f.auto.task === 'client').length, 1);
});

test('Módulo apagado: sin fecha de pago usa 5 días antes y pedir precio al portal se bloquea', async (context) => {
  const { admin, partner, sup } = await setup(context);
  const client = (await partner('POST', '/api/clients', { name: 'Luis', phone: '998 000 1111', includes_transfer: true })).body.record;
  await admin('PUT', '/api/supplier-module', { enabled: false });
  const r = await partner('POST', `/api/clients/${client.id}/transfer`, { supplier_id: sup.id, details, trip, cost: 1500 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking.supplier_due, '2026-12-15');
  const req = await partner('POST', `/api/trips/${r.body.trip.id}/bookings/${r.body.booking.id}/portal-request`, { details });
  assert.ok([404, 409].includes(req.status));
});
