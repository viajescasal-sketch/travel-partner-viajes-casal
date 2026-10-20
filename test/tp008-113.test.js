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
  const call = async (method, path, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), cookie, ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, type, body: type.includes('json') ? await r.json().catch(() => null) : await r.arrayBuffer() };
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
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Marta Ruiz', phone: '998 765 4321' }, destination: 'Los Cabos', start_date: '2027-01-10', end_date: '2027-01-15', travelers: 2 })).body.record;
  return { baseUrl, partner, admin, lead };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

test('TP-113: subir PDF de una cotización ya trabajada y registrarla como cotización externa', async (context) => {
  const { partner, lead } = await setup(context);
  // Validaciones del archivo.
  assert.equal((await partner('POST', '/api/quote-files', Buffer.from('hola'), { 'content-type': 'application/pdf' })).status, 400, 'no es PDF');
  assert.equal((await partner('POST', '/api/quote-files', Buffer.from('x'), { 'content-type': 'text/plain' })).status, 400);
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await partner('POST', '/api/quote-files', big, { 'content-type': 'application/pdf' })).status, 413);
  const up = await partner('POST', '/api/quote-files', PDF, { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Cotización Cabos.pdf') });
  assert.equal(up.status, 201);
  assert.equal(up.body.name, 'Cotización Cabos.pdf');

  // Sin archivo ni link válido no se guarda.
  assert.equal((await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Los Cabos', price: 1, details: { external: { kind: 'file', media_id: 999 } } })).status, 400);
  assert.equal((await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Los Cabos', price: 1, details: { external: { kind: 'link', url: 'javascript:alert(1)' } } })).status, 400);

  const q = await partner('POST', '/api/quotes', {
    client_id: lead.client_id, lead_id: lead.id, destination: 'Los Cabos', price: 48500, status: 'Enviada', valid_until: '2026-11-30',
    details: { external: { kind: 'file', media_id: up.body.media_id, name: up.body.name, ref: 'HOTELDO-7788', date: '2026-08-02', notes: 'La hizo Paulina antes del CRM' }, proposals: [{ hacked: true }] }
  });
  assert.equal(q.status, 201);
  const rec = q.body.record;
  assert.match(rec.folio, /^COT-\d{4}-\d{4}$/);
  assert.equal(rec.hotel, 'Cotización HOTELDO-7788', 'nombre por omisión');
  assert.equal(rec.details.kind, 'externa');
  assert.equal(rec.details.external.mime, 'application/pdf');
  assert.equal(rec.details.proposals, undefined, 'solo se guarda el adjunto');
  // El lead pasa a Cotizado como con cualquier cotización.
  assert.equal((await partner('GET', '/api/crm')).body.leads.find((l) => l.id === lead.id).stage, 'Cotizado');
  // El PDF se descarga con sesión.
  const file = await partner('GET', `/api/media/${up.body.media_id}`);
  assert.equal(file.status, 200);
  assert.match(file.type, /application\/pdf/);

  // Editar monto o estado conserva el adjunto; aceptarla sigue el flujo normal (plan de pagos).
  const upd = await partner('PATCH', `/api/quotes/${rec.id}`, { price: 50000, status: 'Aceptada', details: {} });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.record.details.external.ref, 'HOTELDO-7788');
  assert.equal((await partner('GET', '/api/crm')).body.leads.find((l) => l.id === lead.id).stage, 'Vendido');
  const plan = await partner('POST', `/api/quotes/${rec.id}/payment-plan`, {});
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.total, 50000);
});

test('TP-113: cotización externa por link y desde un cliente sin lead', async (context) => {
  const { partner, lead } = await setup(context);
  const q = await partner('POST', '/api/quotes', { client_id: lead.client_id, destination: 'Europa', hotel: 'Circuito Europa Mágica', price: 120000, details: { external: { kind: 'link', url: 'https://drive.google.com/file/d/abc/view', ref: 'EUR-22' } } });
  assert.equal(q.status, 201);
  assert.equal(q.body.record.details.external.kind, 'link');
  assert.equal(q.body.record.hotel, 'Circuito Europa Mágica');
  assert.equal(q.body.record.lead_id, null);
  // Cambiar a un archivo reemplaza el link.
  const up = await partner('POST', '/api/quote-files', PDF, { 'content-type': 'application/pdf' });
  const patched = await partner('PATCH', `/api/quotes/${q.body.record.id}`, { details: { external: { kind: 'file', media_id: up.body.media_id } } });
  assert.equal(patched.body.record.details.external.kind, 'file');
  assert.equal(patched.body.record.details.external.name, 'cotizacion.pdf');
});
