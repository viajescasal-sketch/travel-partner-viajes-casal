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
// Navegador del cliente: guarda su propia cookie del portal.
function browser(baseUrl) {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set && set.startsWith('tp.cp=')) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, body: type.includes('json') ? await r.json().catch(() => null) : await r.text() };
  };
}
async function setup(context, { mail = true } = {}) {
  const sent = [];
  const mailer = { configured: mail, send: async (m) => { sent.push(m); } };
  const app = await createApp({ skipPurgeTimer: true, mailer });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Laura Gómez', phone: '998 111 2233', email: 'laura@cliente.test' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', travelers: 2 })).body.record;
  return { baseUrl, partner, admin, lead, sent, store: app.locals.dataStore };
}
const codeFrom = (sent) => sent.filter((m) => /portal/.test(m.subject)).map((m) => m.subject.match(/(\d{6})/)).filter(Boolean).pop()[1];

test('TP-313: el equipo activa la liga y el cliente entra con código por correo', async (context) => {
  const { baseUrl, partner, lead, sent } = await setup(context);
  const off = await partner('GET', `/api/clients/${lead.client_id}/portal`);
  assert.equal(off.body.enabled, false);
  const on = await partner('POST', `/api/clients/${lead.client_id}/portal`, {});
  assert.equal(on.status, 200);
  assert.match(on.body.url, /\/mi-portal\/[a-f0-9]{40}$/);
  const token = on.body.url.split('/').pop();
  assert.equal((await partner('POST', `/api/clients/${lead.client_id}/portal`, {})).body.url, on.body.url, 'activar de nuevo no cambia la liga');

  const web = browser(baseUrl);
  const page = await web('GET', `/mi-portal/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Mi portal/);
  assert.equal((await web('GET', `/mi-portal/${'a'.repeat(40)}`)).status, 404);

  // Sin código solo ve su nombre y a dónde llega el código.
  const gate = await web('GET', `/api/public/portal/${token}`);
  assert.equal(gate.body.needsCode, true);
  assert.equal(gate.body.client.first, 'Laura');
  assert.equal(gate.body.emailMasked, 'la•••@cliente.test');
  assert.equal(gate.body.quotes, undefined);
  assert.equal((await web('POST', `/api/public/portal/${token}/request`, { destination: 'X' })).status, 401);

  const sentCode = await web('POST', `/api/public/portal/${token}/code`);
  assert.equal(sentCode.body.via, 'email');
  assert.ok(sent.some((m) => m.to === 'laura@cliente.test' && /portal/.test(m.subject)));
  assert.equal((await web('POST', `/api/public/portal/${token}/code`)).status, 429, 'un código por minuto');
  assert.equal((await web('POST', `/api/public/portal/${token}/verify`, { code: '000000' === codeFrom(sent) ? '111111' : '000000' })).status, 400);
  const ok = await web('POST', `/api/public/portal/${token}/verify`, { code: codeFrom(sent) });
  assert.equal(ok.status, 200);
  const portal = await web('GET', `/api/public/portal/${token}`);
  assert.equal(portal.body.needsCode, undefined);
  assert.equal(portal.body.client.name, 'Laura Gómez');
  assert.equal(portal.body.seller.name, 'Paulina');
  assert.equal(portal.body.allowed, undefined);

  // Otro equipo (sin cookie) vuelve a pedir código; una liga nueva saca a todos.
  assert.equal((await browser(baseUrl)('GET', `/api/public/portal/${token}`)).body.needsCode, true);
  const regen = await partner('POST', `/api/clients/${lead.client_id}/portal`, { regenerate: true });
  assert.notEqual(regen.body.url, on.body.url);
  assert.equal((await web('GET', `/api/public/portal/${token}`)).status, 404, 'la liga anterior deja de servir');
});

test('TP-313: el cliente ve sus cotizaciones, pagos y viajes; y pide una nueva cotización', async (context) => {
  const { baseUrl, partner, lead, sent } = await setup(context);
  const draft = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Borrador interno', price: 1000 })).body.record;
  const sentQ = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Riu Caribe', price: 32000, status: 'Enviada' })).body.record;
  const acc = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hyatt Ziva', price: 45000, status: 'Aceptada' })).body.record;
  await partner('POST', `/api/quotes/${acc.id}/payment-plan`, {});
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: acc.id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;
  await partner('POST', `/api/trips/${trip.id}/share`, { enabled: true });
  // Otro cliente no debe aparecer.
  await partner('POST', '/api/leads', { client: { name: 'Otro Cliente', phone: '998 999 0000' }, destination: 'Tulum' });

  const token = (await partner('POST', `/api/clients/${lead.client_id}/portal`, {})).body.url.split('/').pop();
  const web = browser(baseUrl);
  await web('POST', `/api/public/portal/${token}/code`);
  await web('POST', `/api/public/portal/${token}/verify`, { code: codeFrom(sent) });
  const p = (await web('GET', `/api/public/portal/${token}`)).body;
  assert.deepEqual(p.quotes.map((q) => q.folio).sort(), [sentQ.folio, acc.folio].sort(), 'solo enviadas y aceptadas');
  assert.ok(!JSON.stringify(p).includes(draft.folio));
  assert.match(p.quotes.find((q) => q.folio === sentQ.folio).url, /^\/cotizacion\/[a-f0-9]{40}$/, 'liga de la cotización creada sola');
  assert.equal(p.payments.length, 1);
  assert.equal(p.payments[0].total, 45000);
  assert.match(p.payments[0].url, /^\/pagar\//);
  assert.equal(p.trips.length, 1);
  assert.equal(p.trips[0].destination, 'Cancún');
  assert.ok(!JSON.stringify(p).includes('Tulum'));
  assert.ok(!JSON.stringify(p).includes('owner_id'));
  // La liga de la cotización que da el portal sí abre.
  assert.equal((await web('GET', p.quotes[0].url)).status, 200);

  const bad = await web('POST', `/api/public/portal/${token}/request`, { destination: '' });
  assert.equal(bad.status, 400);
  const req = await web('POST', `/api/public/portal/${token}/request`, { destination: 'Europa', start: '2027-06-01', end: '2027-06-15', travelers: 4, budget: '200,000', notes: 'Luna de miel de mi hija' });
  assert.equal(req.status, 201);
  const crm = (await partner('GET', '/api/crm')).body;
  const newLead = crm.leads.find((l) => l.destination === 'Europa');
  assert.equal(newLead.client_id, lead.client_id);
  assert.equal(newLead.budget, 200000);
  assert.match(newLead.notes, /Portal del cliente/);
  assert.ok(crm.followups.some((f) => f.lead_id === newLead.id));
  const bell = (await partner('GET', '/api/notifications')).body.items;
  assert.match(bell[0].title, /pidió una cotización desde su portal/);
});

test('TP-313: sin correo el código le llega al asesor; permisos del equipo', async (context) => {
  const { baseUrl, partner, admin, sent } = await setup(context, { mail: false });
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Pedro Sin Correo', phone: '998 222 3344' }, destination: 'Mérida' })).body.record;
  const token = (await partner('POST', `/api/clients/${lead.client_id}/portal`, {})).body.url.split('/').pop();
  const web = browser(baseUrl);
  assert.equal((await web('GET', `/api/public/portal/${token}`)).body.byEmail, false);
  const r = await web('POST', `/api/public/portal/${token}/code`);
  assert.equal(r.body.via, 'asesor');
  assert.equal(sent.length, 0);
  const note = (await partner('GET', '/api/notifications')).body.items.find((n) => /Código del portal/.test(n.title));
  const code = note.title.match(/(\d{6})/)[1];
  assert.equal((await web('POST', `/api/public/portal/${token}/verify`, { code })).status, 200);
  assert.equal((await web('GET', `/api/public/portal/${token}`)).body.client.name, 'Pedro Sin Correo');
  // Desactivar
  assert.equal((await admin('DELETE', `/api/clients/${lead.client_id}/portal`)).body.enabled, false);
  assert.equal((await web('GET', `/api/public/portal/${token}`)).status, 404);
});
