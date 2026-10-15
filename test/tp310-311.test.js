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
const { dueTouches, cleanSettings, onYear } = require('../src/recompra');
const R = require('../public/reportes-core');
const { nowCancun } = require('../src/crm-schema');

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
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
  const sent = [];
  const mailer = { configured: false, from: 'x@example.test', send: async (m) => { sent.push(m); return { delivered: true }; } };
  const app = await createApp({ skipPurgeTimer: true, mailer });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  mailer.configured = true;
  return { store: app.locals.dataStore, recompra: app.locals.recompra, partner, admin, sent };
}

test('TP-310: qué contactos tocan hoy (aniversario, cumpleaños, temporadas y exclusiones)', () => {
  const cfg = cleanSettings({});
  const today = '2027-11-20';
  const trip = { id: 7, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', status: 'Postventa' };
  const client = { id: 1, name: 'Ana López', birth_date: '1990-11-22' };
  const keys = (c, d, t = today, s = cfg) => dueTouches(c, d, s, t).map((x) => x.key);
  assert.deepEqual(keys(client, { trips: [trip], leads: [] }), ['aniv:7:2027', 'cumple:2027'], '30 días antes del aniversario y 3 antes del cumpleaños');
  const aniv = dueTouches(client, { trips: [trip], leads: [] }, cfg, today)[0];
  assert.equal(aniv.name, 'Aniversario de su viaje a Cancún (1 año)');
  assert.equal(aniv.due, '2027-11-20');
  assert.deepEqual(keys(client, { trips: [trip], leads: [{ stage: 'Cotizado' }] }), ['cumple:2027'], 'con lead abierto no se manda aniversario');
  assert.deepEqual(keys({ ...client, no_marketing: true }, { trips: [trip], leads: [] }), [], 'no contactar');
  assert.deepEqual(keys(client, { trips: [trip], leads: [] }, '2027-12-10'), [], 'fuera de la ventana de 14 días');
  assert.deepEqual(keys(client, { trips: [trip], leads: [] }, '2028-04-20'), ['temp:verano:2028']);
  assert.deepEqual(keys(client, { trips: [], leads: [] }, '2028-04-20'), [], 'temporadas solo a clientes anteriores');
  assert.deepEqual(keys(client, { trips: [trip, { id: 8, start_date: '2028-05-01', end_date: '2028-05-05' }], leads: [] }, '2028-04-20'), [], 'ni a quien ya tiene viaje próximo');
  assert.equal(onYear('2000-02-29', 2027), '2027-02-28');
  const custom = cleanSettings({ anniversary: { daysBefore: 400 }, seasons: [{ name: 'Puente', date: '13-01' }, { name: 'Pascua', date: '03-01', email: true }] });
  assert.equal(custom.anniversary.daysBefore, 90);
  assert.deepEqual(custom.seasons.map((x) => [x.name, x.email]), [['Pascua', true]]);
});

test('TP-310: bandeja diaria, correo opcional, marcar enviado y cumpleaños desde pasajeros', async (context) => {
  const { store, recompra, partner, admin, sent } = await setup(context);
  const today = nowCancun().slice(0, 10);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@example.test' }, destination: 'Cancún' })).body.record;
  await partner('PATCH', `/api/leads/${lead.id}`, { stage: 'Vendido' });
  const soon = addDays(today, 30);
  const yearAgo = `${Number(soon.slice(0, 4)) - 1}${soon.slice(4)}`;
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Cancún', start_date: yearAgo, end_date: addDays(yearAgo, 4) })).body.record;
  // Cumpleaños desde el pasajero con su mismo nombre.
  await partner('PUT', `/api/trips/${trip.id}/passengers`, { list: [{ name: 'Ana López', birth_date: `1990${addDays(today, 3).slice(4)}` }] });
  assert.equal((await store.getRecord('clients', lead.client_id)).birth_date, `1990${addDays(today, 3).slice(4)}`);
  // No contactar: otro cliente con viaje igual.
  const other = (await partner('POST', '/api/leads', { client: { name: 'Pedro Sol', phone: '998 222 3333' }, destination: 'Tulum' })).body.record;
  await partner('PATCH', `/api/leads/${other.id}`, { stage: 'Vendido' });
  await partner('POST', '/api/trips', { client_id: other.client_id, destination: 'Tulum', start_date: yearAgo, end_date: addDays(yearAgo, 3) });
  assert.equal((await partner('PATCH', `/api/clients/${other.client_id}`, { no_marketing: true })).body.record.no_marketing, true);

  await admin('PUT', '/api/campaigns/settings', { birthday: { enabled: true, daysBefore: 3, email: true } });
  const r = await recompra.runDaily({ force: true });
  assert.equal(r.created, 2, 'aniversario + cumpleaños de Ana; Pedro excluido');
  assert.equal(r.emails, 1, 'solo el cumpleaños tiene correo');
  assert.match(sent[0].subject, /Feliz cumpleaños, Ana/);
  assert.equal((await recompra.runDaily({ force: true })).created, 0, 'no se repiten');

  const inbox = (await partner('GET', '/api/campaigns')).body;
  assert.deepEqual(inbox.touches.map((t) => t.kind).sort(), ['aniversario', 'cumpleanos']);
  const aniv = inbox.touches.find((t) => t.kind === 'aniversario');
  assert.equal(aniv.status, 'Pendiente');
  assert.equal(aniv.trip_id, trip.id);
  const done = await partner('PATCH', `/api/clients/${lead.client_id}/campaigns/${aniv.id}`, { status: 'Enviado', note: 'whatsapp' });
  assert.equal(done.body.touch.status, 'Enviado');
  assert.equal((await partner('PATCH', `/api/clients/${lead.client_id}/campaigns/${aniv.id}`, { status: 'X' })).status, 400);
  const bell = JSON.stringify((await partner('GET', '/api/notifications')).body);
  assert.match(bell, /2 clientes para campañas de recompra/);
  assert.equal((await partner('PUT', '/api/campaigns/settings', { enabled: false })).status, 403);
  assert.equal((await admin('PUT', '/api/campaigns/settings', { seasons: [{ name: '', date: '04-01' }] })).status, 400);
  const tpl = (await partner('GET', '/api/templates')).body;
  assert.deepEqual(tpl.templates.filter((t) => t.stage === 'recompra').map((t) => t.id), ['rc1', 'rc2', 'rc3']);
});

test('TP-311: desempeño por vendedor y por origen', () => {
  const leads = [
    { id: 1, owner_id: 2, source: 'WhatsApp', stage: 'Vendido', created_at: '2026-10-01 10:00:00', assigned_at: '2026-10-01 10:00:00', contacted_at: '2026-10-01 11:00:00', closed_at: '2026-10-05 10:00:00' },
    { id: 2, owner_id: 2, source: 'Instagram', stage: 'Perdido', created_at: '2026-10-02 09:00:00', assigned_at: '2026-10-02 09:00:00', contacted_at: '2026-10-02 12:00:00', closed_at: '2026-10-06 09:00:00' },
    { id: 3, owner_id: 3, source: 'WhatsApp', stage: 'Nuevo', created_at: '2026-10-03 09:00:00' },
    { id: 4, owner_id: 3, source: 'Sitio web', stage: 'Vendido', created_at: '2026-09-20 09:00:00', contacted_at: '2026-09-20 09:30:00', closed_at: '2026-10-10 09:00:00', referral: { referrer_id: 9 } }
  ];
  const quotes = [
    { id: 10, lead_id: 1, owner_id: 2, status: 'Aceptada', price: 30000, created_at: '2026-10-02 10:00:00', accepted_at: '2026-10-05 10:00:00', sent_at: '2026-10-02 10:00:00' },
    { id: 11, lead_id: 2, owner_id: 2, status: 'Rechazada', price: 20000, created_at: '2026-10-03 10:00:00' },
    { id: 12, lead_id: 4, owner_id: 3, status: 'Aceptada', price: 50000, created_at: '2026-09-25 10:00:00', accepted_at: '2026-10-10 09:00:00' }
  ];
  const trips = [{ id: 20, quote_id: 10, bookings: { list: [{ status: 'Confirmada', cost: 20000, price: 24000 }, { status: 'Confirmada', cost: 4000, price: 6000 }, { status: 'Cancelada', cost: 999, price: 0 }] } }];
  const names = { 2: 'Paulina', 3: 'Carlos' };
  const r = R.performance({ leads, quotes, trips }, { from: '2026-10-01', to: '2026-10-31', by: 'seller', label: (k) => names[k] });
  const p = r.rows.find((x) => x.label === 'Paulina');
  assert.deepEqual([p.leads, p.contactRate, p.responseHours, p.quotes, p.quotesSent, p.sales, p.revenue, p.ticket, p.conversion, p.lost, p.winRate, p.closeDays, p.profit], [2, 100, 2, 2, 2, 1, 30000, 30000, 50, 1, 50, 4, 6000]);
  const c = r.rows.find((x) => x.label === 'Carlos');
  assert.deepEqual([c.leads, c.contactRate, c.sales, c.revenue, c.conversion, c.profit, c.closeDays], [1, 0, 1, 50000, 0, null, 20], 'la venta de octubre cuenta aunque el lead sea de septiembre');
  assert.equal(r.rows[0].label, 'Carlos', 'ordenado por ingresos');
  assert.deepEqual([r.total.leads, r.total.sales, r.total.revenue, r.total.lost, r.total.responseHours, r.total.profit], [3, 2, 80000, 1, 2, 6000]);
  const o = R.performance({ leads, quotes, trips }, { from: '2026-10-01', to: '2026-10-31', by: 'origin' });
  assert.deepEqual(o.rows.map((x) => [x.label, x.leads, x.sales]), [['Programa de referidos', 0, 1], ['WhatsApp', 2, 1], ['Instagram', 1, 0]]);
  assert.deepEqual(R.period('prev', '2026-10-15'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(R.period('all', '2026-10-15'), { from: '', to: '' });
});
