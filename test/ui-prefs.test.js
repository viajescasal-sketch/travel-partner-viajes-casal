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
const AV = require('../public/avatares');

async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
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
  return { partner, admin };
}

test('avatares: 12 animales y uno por defecto estable para cada usuario', () => {
  assert.equal(AV.KEYS.length, 12);
  assert.equal(AV.defaultFor(7), AV.defaultFor(7));
  assert.ok(AV.KEYS.includes(AV.defaultFor(3)));
});

test('cada agente elige su animal; valores fuera de la lista se rechazan', async (t) => {
  const { partner } = await setup(t);
  let crm = await partner('GET', '/api/crm');
  assert.equal(crm.body.prefs.avatar, null);
  assert.equal((await partner('PUT', '/api/me/avatar', { avatar: 'dragon' })).status, 400);
  const ok = await partner('PUT', '/api/me/avatar', { avatar: 'ajolote' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.avatar, 'ajolote');
  crm = await partner('GET', '/api/crm');
  const me = crm.body.users[0];
  assert.equal(crm.body.users.length, 1);
  assert.equal(me.avatar, 'ajolote');
  assert.equal((await partner('PUT', '/api/me/avatar', { avatar: null })).body.avatar, null);
});

test('recorrido: aparece la primera vez, se puede apagar y el admin lo reactiva para todos', async (t) => {
  const { partner, admin } = await setup(t);
  assert.equal((await partner('GET', '/api/me/prefs')).body.tour.show, true);
  assert.equal((await partner('POST', '/api/me/tour', { action: 'seen' })).body.tour.show, false);
  assert.equal((await partner('POST', '/api/me/tour', { action: 'off' })).body.tour.off, true);
  assert.equal((await partner('POST', '/api/me/tour', { action: 'nada' })).status, 400);
  assert.equal((await partner('POST', '/api/tour/reset')).status, 403);
  const reset = await admin('POST', '/api/tour/reset');
  assert.equal(reset.status, 200);
  const after = (await partner('GET', '/api/me/prefs')).body.tour;
  assert.equal(after.show, true);
  assert.equal(after.off, false);
  assert.equal((await partner('POST', '/api/me/tour', { action: 'on' })).body.tour.show, true);
});
