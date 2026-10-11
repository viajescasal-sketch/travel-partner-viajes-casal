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

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  call.login = async (email, password, newPassword) => {
    const login = await call('POST', '/api/auth/login', { email, password });
    assert.equal(login.status, 200);
    if (login.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('plantillas de WhatsApp y ficha 360 del cliente', async (context) => {
  const app = await createApp({ skipPurgeTimer: true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');
  const bruno = clientFor(baseUrl);
  const created = await admin('POST', '/api/users', { name: 'Bruno Vendedor', email: 'bruno@example.test', role: 'travel_partner' });
  await bruno.login('bruno@example.test', created.body.temporaryPassword, 'BrunoNueva2026x');

  // --- Plantillas (TP-107) ---
  const tpl = await paulina('GET', '/api/templates');
  assert.equal(tpl.status, 200);
  assert.equal(tpl.body.custom, false);
  assert.deepEqual(tpl.body.stages.map((s) => s.id), ['primer_contacto', 'cotizacion', 'seguimiento', 'cierre', 'postviaje']);
  assert.ok(tpl.body.templates.some((t) => t.stage === 'postviaje' && t.body.includes('{liga_resenas}')));
  assert.equal((await paulina('PUT', '/api/templates', { templates: [] })).status, 403, 'solo el administrador edita');
  assert.equal((await admin('PUT', '/api/templates', { templates: [{ stage: 'otra', name: 'X', body: 'Y' }] })).status, 400);
  assert.equal((await admin('PUT', '/api/templates', { templates: [], reviewLink: 'http://inseguro' })).status, 400);
  const saved = await admin('PUT', '/api/templates', { templates: [{ stage: 'primer_contacto', name: 'Hola', body: 'Hola {nombre}, viaje a {destino}' }, { id: 'pv', stage: 'postviaje', name: 'Reseña', body: 'Gracias {nombre}: {liga_resenas}' }], reviewLink: 'https://g.page/r/viajescasal/review' });
  assert.equal(saved.status, 200);
  assert.equal((await paulina('GET', '/api/templates')).body.templates.length, 2);
  const restored = await admin('PUT', '/api/templates', { restoreDefaults: true, reviewLink: 'https://g.page/r/viajescasal/review' });
  assert.equal(restored.body.templates.length, tpl.body.templates.length);
  assert.equal(restored.body.reviewLink, 'https://g.page/r/viajescasal/review');

  // --- Ficha 360 (TP-108) ---
  const lead = await paulina('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún' });
  const clientId = lead.body.client.id;
  const trip = await paulina('POST', '/api/trips', { client_id: clientId, destination: 'Cancún', start_date: '2026-12-10', end_date: '2026-12-14' });
  assert.equal(trip.status, 201);
  const msg = await paulina('POST', `/api/clients/${clientId}/events`, { type: 'message', title: 'Bienvenida', body: 'Hola Ana 👋', stage: 'primer_contacto', template: 'pc1', lead_id: lead.body.record.id });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.event.meta.stage, 'primer_contacto');
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'payment', amount: 0 })).status, 400);
  const pay = await paulina('POST', `/api/clients/${clientId}/events`, { type: 'payment', amount: '8500.50', title: 'Anticipo', method: 'Transferencia', trip_id: trip.body.record.id, date: '2026-10-01' });
  assert.equal(pay.status, 201);
  assert.equal(pay.body.event.amount, 8500.5);
  assert.equal(pay.body.event.event_at.slice(0, 10), '2026-10-01');
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'payment', amount: 10, date: '2099-01-01' })).status, 400, 'sin fechas futuras');
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'review', rating: 6 })).status, 400);
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'review', rating: 5, body: 'Todo perfecto', platform: 'Google' })).status, 201);
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'note', body: 'Prefiere hoteles adults only' })).status, 201);
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'otro', body: 'x' })).status, 400);

  const list = await paulina('GET', `/api/clients/${clientId}/events`);
  assert.equal(list.body.events.length, 4);
  assert.equal(list.body.events.find((e) => e.type === 'payment').created_by_name, 'Paulina');
  assert.equal(list.body.events.at(-1).type, 'payment', 'ordenados del más reciente al más antiguo');

  // Otro vendedor no ve ni registra en la ficha de un cliente ajeno
  assert.equal((await bruno('GET', `/api/clients/${clientId}/events`)).status, 404);
  assert.equal((await bruno('POST', `/api/clients/${clientId}/events`, { type: 'note', body: 'hola' })).status, 404);
  // Referencias de otro cliente no se aceptan
  const other = await paulina('POST', '/api/leads', { client: { name: 'Beto', phone: '998 765 4321' }, destination: 'Tulum' });
  assert.equal((await paulina('POST', `/api/clients/${clientId}/events`, { type: 'note', body: 'x', lead_id: other.body.record.id })).status, 400);

  // Solo el administrador elimina registros; al borrar el cliente se borran sus registros
  const noteId = list.body.events.find((e) => e.type === 'note').id;
  assert.equal((await paulina('DELETE', `/api/client-events/${noteId}`)).status, 403);
  assert.equal((await admin('DELETE', `/api/client-events/${noteId}`)).status, 200);
  assert.equal((await admin('GET', `/api/clients/${clientId}/events`)).body.events.length, 3);
  assert.equal((await admin('DELETE', `/api/clients/${clientId}`)).status, 200);
  assert.equal((await app.locals.dataStore.listClientEvents(clientId)).length, 0);
});
