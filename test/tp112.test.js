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
const { desiredEvents, fromGoogle, toGoogle } = require('../src/gcal-sync');

// Google Calendar de mentira: tokens, calendarios y eventos con syncToken.
function fakeGoogle() {
  const g = { calendars: {}, seq: 0, calls: [], revoked: false };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const touch = (cal, ev) => { g.seq += 1; ev._seq = g.seq; ev.updated = new Date().toISOString(); cal.events.set(ev.id, ev); };
  g.userEdit = (calId, match, change) => { const cal = g.calendars[calId]; const ev = [...cal.events.values()].find(match); Object.assign(ev, change); touch(cal, ev); return ev; };
  g.userCreate = (calId, ev) => { const cal = g.calendars[calId]; const e = { id: `u${g.seq + 1}`, status: 'confirmed', ...ev }; touch(cal, e); return e; };
  g.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    g.calls.push(`${method} ${u.pathname}`);
    const body = opts.body && String(opts.headers?.['content-type']).includes('json') ? JSON.parse(opts.body) : null;
    const form = opts.body && String(opts.headers?.['content-type']).includes('urlencoded') ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      if (form.grant_type === 'authorization_code') {
        const payload = Buffer.from(JSON.stringify({ email: 'paulina.viajes@gmail.com' })).toString('base64url');
        return json(200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', scope: 'openid email https://www.googleapis.com/auth/calendar.app.created', id_token: `x.${payload}.y` });
      }
      return form.refresh_token === 'rt-1' ? json(200, { access_token: 'at-2', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) { g.revoked = true; return json(200, {}); }
    const path = u.pathname.replace('/calendar/v3', '');
    if (path === '/calendars' && method === 'POST') { const id = `cal${Object.keys(g.calendars).length + 1}@group.calendar.google.com`; g.calendars[id] = { summary: body.summary, events: new Map() }; return json(200, { id }); }
    const m = path.match(/^\/calendars\/([^/]+)(\/events(?:\/([^/]+))?)?$/);
    const cal = m && g.calendars[decodeURIComponent(m[1])];
    if (!cal) return json(404, { error: { message: 'Not Found' } });
    if (!m[2]) return json(200, { id: decodeURIComponent(m[1]) });
    const evId = m[3] && decodeURIComponent(m[3]);
    if (!evId && method === 'POST') { const ev = { id: `e${g.seq + 1}`, status: 'confirmed', ...body }; touch(cal, ev); return json(200, ev); }
    if (!evId) {
      const st = u.searchParams.get('syncToken');
      const items = [...cal.events.values()].filter((e) => (st ? e._seq > Number(st) : true));
      return json(200, { items, nextSyncToken: String(g.seq) });
    }
    const ev = cal.events.get(evId);
    if (!ev || ev.status === 'cancelled') return json(404, { error: { message: 'Not Found' } });
    if (method === 'PATCH') { Object.assign(ev, body); touch(cal, ev); return json(200, ev); }
    if (method === 'DELETE') { ev.status = 'cancelled'; touch(cal, ev); return { ok: true, status: 204, text: async () => '' }; }
    return json(200, ev);
  };
  return g;
}

async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, location: r.headers.get('location'), body: await r.json().catch(() => null) };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}
async function setup(context) {
  const g = fakeGoogle();
  const app = await createApp({ skipPurgeTimer: true, gcalFetch: g.fetch });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  return { baseUrl, partner, admin, g, gcal: app.locals.gcal, store: app.locals.dataStore };
}
const events = (g) => [...Object.values(g.calendars)[0].events.values()].filter((e) => e.status !== 'cancelled');
const keyOf = (e) => e.extendedProperties?.private?.tp;

test('TP-112: configurar credenciales (solo admin) y conectar la cuenta de Google', async (context) => {
  const { partner, admin, g } = await setup(context);
  assert.equal((await partner('GET', '/api/gcal/status')).body.configured, false);
  assert.equal((await partner('GET', '/api/gcal/connect')).location, '/?gcal=sin-configurar');
  assert.equal((await partner('PUT', '/api/gcal/config', { client_id: 'x.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefghijklmnopqrstuv' })).status, 403);
  assert.equal((await admin('PUT', '/api/gcal/config', { client_id: 'mal', client_secret: 'GOCSPX-abcdefghijklmnopqrstuv' })).status, 400);
  assert.equal((await admin('PUT', '/api/gcal/config', { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefghijklmnopqrstuv' })).status, 200);
  const cfg = (await admin('GET', '/api/gcal/config')).body;
  assert.equal(cfg.hasSecret, true);
  assert.match(cfg.redirectUri, /\/api\/gcal\/callback$/);
  assert.ok(!JSON.stringify(cfg).includes('GOCSPX'), 'el secreto nunca se devuelve');

  const go = await partner('GET', '/api/gcal/connect');
  assert.equal(go.status, 302);
  const auth = new URL(go.location);
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.match(auth.searchParams.get('scope'), /calendar\.app\.created/);
  assert.equal((await partner('GET', '/api/gcal/callback?code=abc&state=otro')).location, '/?gcal=error', 'state inválido');
  const back = await partner('GET', `/api/gcal/callback?code=abc&state=${auth.searchParams.get('state')}`);
  assert.equal(back.location, '/?gcal=ok');
  const st = (await partner('GET', '/api/gcal/status')).body;
  assert.equal(st.connected, true);
  assert.equal(st.email, 'paulina.viajes@gmail.com');
  assert.equal(Object.values(g.calendars)[0].summary, 'Travel Partner');

  assert.equal((await partner('POST', '/api/gcal/disconnect')).status, 200);
  assert.equal(g.revoked, true);
  assert.equal((await partner('GET', '/api/gcal/status')).body.connected, false);
});

test('TP-112: CRM → Google y Google → CRM (mover, renombrar, borrar = hecho, evento nuevo)', async (context) => {
  const { partner, admin, g, gcal } = await setup(context);
  await admin('PUT', '/api/gcal/config', { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-abcdefghijklmnopqrstuv' });
  const go = new URL((await partner('GET', '/api/gcal/connect')).location);
  await partner('GET', `/api/gcal/callback?code=abc&state=${go.searchParams.get('state')}`);
  const me = (await partner('GET', '/api/auth/me')).body.user;

  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;
  const f = (await partner('POST', '/api/followups', { lead_id: lead.id, type: 'Llamada', title: 'Llamar a Ana', due_at: '2026-11-03 10:00' })).body.record;
  const acc = (await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Riu', price: 30000, status: 'Aceptada' })).body.record;
  await partner('POST', `/api/quotes/${acc.id}/payment-plan`, {});
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: acc.id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;
  await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [{ id: 'rhot001', type: 'Hotel', supplier_name: 'HotelDO', description: 'Riu', cost: 22000, supplier_due: '2026-12-01', start_date: '2026-12-20' }] });

  const r = await gcal.syncUser(me.id);
  assert.ok(r.created >= 4);
  const evs = events(g);
  const fe = evs.find((e) => keyOf(e) === `f:${f.id}`);
  assert.equal(fe.summary, '📞 Llamar a Ana');
  assert.deepEqual(fe.start, { dateTime: '2026-11-03T10:00:00', timeZone: 'America/Cancun' });
  assert.ok(evs.some((e) => keyOf(e) === `t:${trip.id}` && e.start.date === '2026-12-20' && e.end.date === '2026-12-25'), 'viaje de día completo');
  assert.ok(evs.some((e) => keyOf(e) === `s:${trip.id}:rhot001` && /Pagar a HotelDO: \$22,000/.test(e.summary)), 'pago a proveedor');
  assert.ok(evs.some((e) => /^p:/.test(keyOf(e)) && /Cobrar/.test(e.summary)), 'pago por cobrar');
  assert.equal((await gcal.syncUser(me.id)).created, 0, 'sin cambios no se repite nada');

  // Cambio en el CRM → se actualiza en Google.
  await partner('PATCH', `/api/followups/${f.id}`, { due_at: '2026-11-04 12:30' });
  await gcal.syncUser(me.id);
  assert.equal(events(g).find((e) => keyOf(e) === `f:${f.id}`).start.dateTime, '2026-11-04T12:30:00');

  // Google → CRM: mover y renombrar.
  const cal = Object.keys(g.calendars)[0];
  g.userEdit(cal, (e) => keyOf(e) === `f:${f.id}`, { start: { dateTime: '2026-11-05T17:15:00-05:00' }, end: { dateTime: '2026-11-05T17:45:00-05:00' }, summary: '📞 Llamar a Ana (confirmar fechas)' });
  await gcal.syncUser(me.id);
  let fu = (await partner('GET', '/api/crm')).body.followups.find((x) => x.id === f.id);
  assert.equal(String(fu.due_at).slice(0, 16), '2026-11-05 17:15');
  assert.equal(fu.title, 'Llamar a Ana (confirmar fechas)');

  // Mover un viaje en Google: el CRM lo regresa a su fecha.
  g.userEdit(cal, (e) => keyOf(e) === `t:${trip.id}`, { start: { date: '2026-12-01' }, end: { date: '2026-12-02' } });
  await gcal.syncUser(me.id);
  assert.equal(events(g).find((e) => keyOf(e) === `t:${trip.id}`).start.date, '2026-12-20');

  // Evento nuevo creado en Google → seguimiento nuevo.
  g.userCreate(cal, { summary: 'Revisar vuelos de Ana', start: { dateTime: '2026-11-06T09:00:00-05:00' }, end: { dateTime: '2026-11-06T09:30:00-05:00' } });
  await gcal.syncUser(me.id);
  const crm = (await partner('GET', '/api/crm')).body;
  const created = crm.followups.find((x) => x.title === 'Revisar vuelos de Ana');
  assert.ok(created);
  assert.equal(String(created.due_at).slice(0, 16), '2026-11-06 09:00');
  assert.ok(events(g).some((e) => keyOf(e) === `f:${created.id}` && e.summary === '📌 Revisar vuelos de Ana'), 'queda ligado al CRM');

  // Borrar en Google = hecho en el CRM (y no se vuelve a crear).
  g.userEdit(cal, (e) => keyOf(e) === `f:${f.id}`, { status: 'cancelled' });
  await gcal.syncUser(me.id);
  fu = (await partner('GET', '/api/crm')).body.followups.find((x) => x.id === f.id);
  assert.equal(fu.done, true);
  await gcal.syncUser(me.id);
  assert.ok(!events(g).some((e) => keyOf(e) === `f:${f.id}`));

  // Marcar pagado al proveedor lo quita del calendario.
  const bl = (await partner('GET', `/api/trips/${trip.id}/bookings`)).body.bookings; bl[0].supplier_paid = true;
  await partner('PUT', `/api/trips/${trip.id}/bookings`, { list: bl });
  await gcal.syncUser(me.id);
  assert.ok(!events(g).some((e) => keyOf(e) === `s:${trip.id}:rhot001`));
  const logs = JSON.stringify((await admin('GET', '/api/activity')).body);
  assert.match(logs, /Marcado como hecho: se borró en Google Calendar/);
  assert.match(logs, /Creado desde Google Calendar/);
});

test('TP-112: utilidades de fecha y alcance por usuario', () => {
  assert.equal(toGoogle('2026-11-03 10:00:00'), '2026-11-03T10:00:00');
  assert.equal(toGoogle('2026-11-03 23:45', 30), '2026-11-04T00:15:00');
  assert.equal(fromGoogle({ dateTime: '2026-11-05T22:15:00Z' }), '2026-11-05 17:15:00');
  assert.equal(fromGoogle({ date: '2026-11-05' }), '2026-11-05 09:00:00');
  const data = { clients: [{ id: 1, name: 'A' }], leads: [], quotes: [], trips: [], followups: [{ id: 1, owner_id: 2, title: 'x', type: 'Llamada', due_at: '2026-11-01 10:00:00', done: false }, { id: 2, owner_id: 3, title: 'y', type: 'Otro', due_at: '2026-11-01 10:00:00', done: false }] };
  const ev = desiredEvents({ id: 2, role: 'travel_partner' }, data, { today: '2026-10-21' });
  assert.deepEqual(Object.keys(ev), ['f:1'], 'cada quien solo sus seguimientos');
});
