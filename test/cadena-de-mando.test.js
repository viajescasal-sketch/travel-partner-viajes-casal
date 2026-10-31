'use strict';

// Cadena de mando: Administrador › Dirección › Travel Partner › Vendedor (+ comisiones solo Administrador y Dirección).
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
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const team = {};
  const users = {};
  for (const [key, role] of [['dir', 'direccion'], ['tp', 'travel_partner'], ['ven', 'vendedor'], ['ops', 'operaciones']]) {
    const created = await admin('POST', '/api/users', { name: `Usuario ${role}`, email: `${key}@example.test`, role });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.user.role, role);
    users[key] = created.body.user;
    team[key] = await signIn(baseUrl, `${key}@example.test`, created.body.temporaryPassword);
  }
  return { admin, ...team, users };
}

const dates = { start_date: '2026-12-10', end_date: '2026-12-14' };

test('Roles nuevos: etiquetas, alta solo por el administrador y Dirección no crea usuarios', async (context) => {
  const { admin, dir, users } = await setup(context);
  assert.equal(users.dir.roleLabel, 'Dirección');
  assert.equal(users.tp.roleLabel, 'Travel Partner');
  assert.equal(users.ven.roleLabel, 'Vendedor');
  assert.equal((await dir('POST', '/api/users', { name: 'X', email: 'x@x.test', role: 'vendedor' })).status, 403);
  assert.equal((await admin('POST', '/api/users', { name: 'X', email: 'x@x.test', role: 'jefe' })).status, 400);
});

test('Visibilidad: Dirección ve a todo el equipo; Travel Partner y Vendedor solo lo suyo', async (context) => {
  const { dir, tp, ven } = await setup(context);
  await tp('POST', '/api/leads', { client: { name: 'Cliente de TP', phone: '998 100 0001' }, destination: 'Cancún' });
  await ven('POST', '/api/leads', { client: { name: 'Cliente de Vendedor', phone: '998 100 0002' }, destination: 'Tulum' });
  const names = async (who) => (await who('GET', '/api/crm')).body.clients.map((c) => c.name).sort();
  assert.deepEqual(await names(dir), ['Cliente de TP', 'Cliente de Vendedor']);
  assert.deepEqual(await names(tp), ['Cliente de TP']);
  assert.deepEqual(await names(ven), ['Cliente de Vendedor']);
});

test('Vendedor: vende pero no crea ni edita viajes; Travel Partner y Dirección sí', async (context) => {
  const { dir, tp, ven } = await setup(context);
  const lead = (await ven('POST', '/api/leads', { client: { name: 'Ana', phone: '998 200 0001' }, destination: 'Cancún' })).body;
  const clientId = lead.record?.client_id ?? lead.lead?.client_id ?? lead.client?.id;
  assert.ok(clientId, JSON.stringify(lead));
  assert.equal((await ven('POST', '/api/trips', { client_id: clientId, destination: 'Cancún', ...dates })).status, 403);
  const own = await tp('POST', '/api/leads', { client: { name: 'Beto', phone: '998 200 0002' }, destination: 'Cancún' });
  const tpClient = own.body.record?.client_id ?? own.body.lead?.client_id ?? own.body.client?.id;
  assert.equal((await tp('POST', '/api/trips', { client_id: tpClient, destination: 'Cancún', ...dates })).status, 201);
  assert.equal((await dir('POST', '/api/trips', { client_id: tpClient, destination: 'Cancún', ...dates })).status, 201);
});

test('Costos y comisiones: el Vendedor no ve costos; solo Administrador y Dirección registran comisiones', async (context) => {
  const { admin, dir, tp, ven, ops, users } = await setup(context);
  const sup = (await admin('POST', '/api/suppliers', { name: 'Hoteles MX', type: 'Mayorista', model: 'comision', commission: 10 })).body.supplier;
  const lead = await ven('POST', '/api/leads', { client: { name: 'Carla', phone: '998 300 0001' }, destination: 'Cancún' });
  const clientId = lead.body.record?.client_id ?? lead.body.lead?.client_id ?? lead.body.client?.id;
  const trip = (await admin('POST', '/api/trips', { client_id: clientId, destination: 'Cancún', ...dates })).body.record;
  const booking = { id: 'r1', type: 'Hotel', status: 'Confirmada', supplier_id: sup.id, description: 'Hotel', price: 10000, cost: 9000, model: 'comision', commission_pct: 10, commission_amount: 1000, supplier_due: '2026-12-05' };
  const put = await admin('PUT', `/api/trips/${trip.id}/bookings`, { list: [booking] });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // El Vendedor ve el viaje y la reserva, pero sin costo, utilidad ni comisión.
  const seen = (await ven('GET', '/api/crm')).body.trips[0].bookings.list[0];
  assert.equal(seen.description, 'Hotel');
  assert.equal(seen.price, 10000);
  for (const k of ['cost', 'model', 'commission_pct', 'commission_amount', 'supplier_due']) assert.equal(seen[k], undefined, `el vendedor no debe ver ${k}`);
  assert.equal((await ven('GET', `/api/trips/${trip.id}/bookings`)).body.bookings[0].cost, undefined);
  // El Travel Partner y la Dirección sí ven costos.
  assert.equal((await dir('GET', '/api/crm')).body.trips[0].bookings.list[0].cost, 9000);

  // Un Travel Partner que edita las reservas no cambia el % ni el monto de comisión ya registrados.
  const tpTrip = (await tp('POST', '/api/leads', { client: { name: 'Dani', phone: '998 300 0002' }, destination: 'Cancún' })).body;
  const tpClient = tpTrip.record?.client_id ?? tpTrip.lead?.client_id ?? tpTrip.client?.id;
  const trip2 = (await tp('POST', '/api/trips', { client_id: tpClient, destination: 'Cancún', ...dates })).body.record;
  const nuevo = await tp('PUT', `/api/trips/${trip2.id}/bookings`, { list: [{ ...booking, id: 'r2', commission_pct: 90, commission_amount: 9000 }] });
  assert.equal(nuevo.status, 200, JSON.stringify(nuevo.body));
  const saved = nuevo.body.bookings[0];
  assert.equal(saved.commission_pct, 10, 'el % sale del catálogo del proveedor, no de lo que escribe el Travel Partner');
  assert.equal(saved.commission_amount, 1000);
  const again = await tp('PUT', `/api/trips/${trip2.id}/bookings`, { list: [{ ...saved, commission_pct: 50, commission_amount: 5000 }] });
  assert.equal(again.body.bookings[0].commission_pct, 10);
  // La Dirección sí lo registra a mano.
  const manual = await dir('PUT', `/api/trips/${trip2.id}/bookings`, { list: [{ ...saved, commission_pct: '', commission_amount: 1234 }] });
  assert.equal(manual.body.bookings[0].commission_amount, 1234);

  // Cobro de la comisión: Administrador y Dirección sí; Travel Partner, Vendedor y Operaciones no.
  const url = `/api/trips/${trip.id}/bookings/${put.body.bookings[0].id}/commission`;
  assert.equal((await tp('PATCH', url, { status: 'Facturada' })).status, 403);
  assert.equal((await ven('PATCH', url, { status: 'Facturada' })).status, 403);
  assert.equal((await ops('PATCH', url, { status: 'Facturada' })).status, 403);
  assert.equal((await dir('PATCH', url, { status: 'Facturada' })).status, 200);
  assert.equal((await admin('PATCH', url, { status: 'Cobrada' })).status, 200);

  // % de comisión del proveedor en el catálogo: solo Administrador y Dirección.
  const catalog = (await ops('PATCH', `/api/suppliers/${sup.id}`, { commission: 40, phone: '998 000 0000' })).body.supplier;
  assert.equal(catalog.commission, 10, 'Operaciones no cambia la comisión del proveedor');
  assert.equal(catalog.phone, '998 000 0000', 'pero sí sus datos de contacto');
  assert.equal((await dir('PATCH', `/api/suppliers/${sup.id}`, { commission: 12 })).body.supplier.commission, 12);

  // Metas y % de comisión de vendedores: Administrador y Dirección.
  const goals = { base: 'ventas', sellers: { [users.tp.id]: { goal: 100000, pct: 10, months: {} } } };
  assert.equal((await tp('PUT', '/api/goals', goals)).status, 403);
  assert.equal((await ven('PUT', '/api/goals', goals)).status, 403);
  assert.equal((await dir('PUT', '/api/goals', goals)).status, 200);
  // Su meta la ven; el % de comisión no.
  const mine = (await tp('GET', '/api/goals')).body.sellers[String(users.tp.id)];
  assert.equal(mine.goal, 100000);
  assert.equal(mine.pct, '');
});

test('Reparto: Dirección reasigna leads; Travel Partner y Vendedor no', async (context) => {
  const { admin, dir, tp, ven, users } = await setup(context);
  const leadOf = async (who, name, phone) => { const r = (await who('POST', '/api/leads', { client: { name, phone }, destination: 'Cancún' })).body; return r.record?.id ?? r.lead?.id; };
  const tpLead = await leadOf(tp, 'Eli', '998 400 0001');
  const venLead = await leadOf(ven, 'Fer', '998 400 0002');
  assert.ok(tpLead && venLead);
  assert.equal((await ven('PATCH', `/api/leads/${venLead}`, { owner_id: users.tp.id })).status, 403);
  assert.equal((await tp('PATCH', `/api/leads/${tpLead}`, { owner_id: users.ven.id })).status, 403);
  const id = tpLead;
  assert.equal((await dir('PATCH', `/api/leads/${id}`, { owner_id: users.ven.id })).status, 200);
  assert.equal((await admin('GET', '/api/assignment')).body.participants.includes(users.tp.id), true, 'el reparto por turnos incluye a Travel Partner y Vendedor');
});

test('Comisión por venta: % o monto manual, neto = venta − comisión; solo Administrador y Dirección', async (context) => {
  const { admin, dir, tp, ven } = await setup(context);
  const R = require('../public/reportes-core');
  const lead = (await tp('POST', '/api/leads', { client: { name: 'Gina', phone: '998 500 0001' }, destination: 'Cancún' })).body;
  const clientId = lead.record?.client_id ?? lead.lead?.client_id ?? lead.client?.id;
  const quote = (await tp('POST', '/api/quotes', { client_id: clientId, destination: 'Cancún', hotel: 'Hotel Sol', price: 1000, status: 'Aceptada' })).body.record;
  assert.ok(quote?.id, 'cotización creada');
  const url = `/api/quotes/${quote.id}/agency-margin`;

  assert.equal((await tp('PUT', url, { mode: 'pct', value: 20 })).status, 403);
  assert.equal((await ven('PUT', url, { mode: 'pct', value: 20 })).status, 403);
  assert.equal((await dir('PUT', url, { mode: 'pct', value: 150 })).status, 400, 'más de 100 %');
  assert.equal((await dir('PUT', url, { mode: 'monto', value: 5000 })).status, 400, 'mayor al total');
  assert.equal((await dir('PUT', url, { mode: 'otro', value: 1 })).status, 400);

  // 1000 de venta con 20 % → ganancia 200, neto 800
  const saved = await dir('PUT', url, { mode: 'pct', value: 20 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const q = (await admin('GET', '/api/crm')).body.quotes.find((x) => x.id === quote.id);
  assert.deepEqual(q.agency_margin, { mode: 'pct', value: 20 });
  assert.equal(R.saleProfit(q, []), 200);
  assert.equal(1000 - R.saleProfit(q, []), 800);
  // Monto manual
  await admin('PUT', url, { mode: 'monto', value: 150 });
  assert.equal(R.saleProfit((await admin('GET', '/api/crm')).body.quotes.find((x) => x.id === quote.id), []), 150);

  // El Travel Partner dueño de la venta no la ve; el Vendedor tampoco.
  const mine = (await tp('GET', '/api/crm')).body.quotes.find((x) => x.id === quote.id);
  assert.equal(mine.agency_margin, undefined);
  // Quitarla regresa a la utilidad de las reservas
  assert.equal((await dir('PUT', url, { clear: true })).status, 200);
  assert.equal((await admin('GET', '/api/crm')).body.quotes.find((x) => x.id === quote.id).agency_margin, null);
});
