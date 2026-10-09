'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const zlib = require('node:zlib');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_INITIAL_PASSWORD = 'AdminTemporal123';
process.env.PARTNER_EMAIL = 'paulina@example.test';
process.env.PARTNER_INITIAL_PASSWORD = 'PartnerTemporal123';

const { createApp } = require('../server');
const { MySQLDataStore } = require('../src/data-store');
const { createBackupService, lastSlot, nextSlot } = require('../src/backup');
const { buildCsv, buildXlsx } = require('../src/xlsx');

function fakeMailer() {
  const sent = [];
  return { configured: true, from: 'no-responder@viajescasal.com', sent, async send(message) { sent.push(message); return { delivered: true }; } };
}

async function startApp(context, mailer) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const app = await createApp({ mailer, skipPurgeTimer: true, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, disposition: response.headers.get('content-disposition') || '', body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  call.login = async (email, password, newPassword, mailer) => {
    let r = await call('POST', '/api/auth/login', { email, password });
    if (r.status === 401) r = await call('POST', '/api/auth/login', { email, password: newPassword });
    if (r.body.twofa) r = await call('POST', '/api/auth/2fa/verify', { code: /(\d{6})/.exec(mailer.sent.at(-1).subject)[1] });
    assert.equal(r.status, 200);
    if (r.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

// Lee los nombres de archivo dentro de un ZIP (directorio central).
function zipNames(buffer) {
  const names = [];
  let i = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(i + 10);
  let p = buffer.readUInt32LE(i + 16);
  for (let n = 0; n < count; n += 1) {
    const len = buffer.readUInt16LE(p + 28), extra = buffer.readUInt16LE(p + 30), comment = buffer.readUInt16LE(p + 32);
    names.push(buffer.slice(p + 46, p + 46 + len).toString('utf8'));
    p += 46 + len + extra + comment;
  }
  return names;
}
function zipEntry(buffer, wanted) {
  let p = 0;
  while (buffer.readUInt32LE(p) === 0x04034b50) {
    const size = buffer.readUInt32LE(p + 18), len = buffer.readUInt16LE(p + 26), extra = buffer.readUInt16LE(p + 28);
    const name = buffer.slice(p + 30, p + 30 + len).toString('utf8');
    const data = buffer.slice(p + 30 + len + extra, p + 30 + len + extra + size);
    if (name === wanted) return zlib.inflateRawSync(data).toString('utf8');
    p += 30 + len + extra + size;
  }
  return null;
}

test('horario del respaldo diario (2:00 a.m. de Cancún)', () => {
  assert.equal(lastSlot('2026-10-09 01:59:59'), '2026-10-08 02:00:00');
  assert.equal(lastSlot('2026-10-09 02:00:00'), '2026-10-09 02:00:00');
  assert.equal(nextSlot('2026-10-09 09:30:00'), '2026-10-10 02:00:00');
  assert.equal(lastSlot('2026-03-01 00:30:00'), '2026-02-28 02:00:00');
});

test('CSV protege fórmulas y conserva acentos', () => {
  const csv = buildCsv({ columns: [{ header: 'Nombre' }, { header: 'Monto' }], rows: [['=HYPERLINK("x")', -500], ['José "Pepe"', 1200]] }).toString('utf8');
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /"'=HYPERLINK\(""x""\)","-500"/);
  assert.match(csv, /"José ""Pepe""","1200"/);
  const xlsx = buildXlsx([{ name: 'Prueba: [1]', columns: [{ header: 'A', type: 'money' }, { header: 'B', type: 'date' }], rows: [[1500, '2026-10-09'], ['<b>&', '']] }]);
  assert.deepEqual(zipNames(xlsx).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
  const sheet = zipEntry(xlsx, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="A2" s="2"><v>1500<\/v><\/c>/);
  assert.match(sheet, /<c r="B2" s="3"><v>46304<\/v><\/c>/);
  assert.match(sheet, /&lt;b&gt;&amp;/);
  assert.match(zipEntry(xlsx, 'xl/workbook.xml'), /name="Prueba   1 "/);
});

test('exportación por rol y respaldo diario con correo', async (context) => {
  const mailer = fakeMailer();
  const { baseUrl, app } = await startApp(context, mailer);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x', mailer);
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026', mailer);

  const mine = (await paulina('POST', '/api/leads', { client: { name: 'Fernanda Ruiz', phone: '55 1987 6543' }, destination: 'Los Cabos', budget: 45000 })).body;
  await paulina('POST', '/api/quotes', { client_id: mine.client.id, lead_id: mine.record.id, destination: 'Los Cabos', hotel: 'Riu Palace', price: 45000, status: 'Aceptada' })
    .then(async (r) => paulina('PATCH', `/api/quotes/${r.body.record.id}`, { status: 'Aceptada' }));
  const other = await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' });
  await admin('POST', '/api/leads', { client: { name: 'Cliente de Bruno', phone: '55 2222 3333' }, destination: 'Madrid', owner_id: other.body.user.id });

  // Vendedor: Excel solo con lo suyo, sin la hoja de usuarios
  const xlsx = await paulina('GET', '/api/export?format=xlsx&sections=clients,leads,sales,users');
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.disposition, /attachment; filename="travel-partner-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const book = zipEntry(xlsx.body, 'xl/workbook.xml');
  assert.match(book, /name="Clientes".*name="Leads".*name="Ventas"/);
  assert.doesNotMatch(book, /Usuarios/);
  const leadsSheet = zipEntry(xlsx.body, 'xl/worksheets/sheet2.xml');
  assert.match(leadsSheet, /Fernanda Ruiz/);
  assert.doesNotMatch(leadsSheet, /Cliente de Bruno/);
  assert.match(zipEntry(xlsx.body, 'xl/worksheets/sheet3.xml'), /Riu Palace/);

  // CSV de una sección y ZIP con varias
  const csv = await paulina('GET', '/api/export?format=csv&sections=leads');
  assert.match(csv.type, /text\/csv/);
  assert.match(csv.body.toString('utf8'), /Calificación %/);
  const csvZip = await admin('GET', '/api/export?format=csv&sections=clients,leads');
  assert.equal(csvZip.type, 'application/zip');
  assert.deepEqual(zipNames(csvZip.body).map((n) => n.replace(/-\d{4}-\d{2}-\d{2}/, '')), ['clientes.csv', 'leads.csv']);
  assert.match(zipEntry(csvZip.body, zipNames(csvZip.body)[1]), /Cliente de Bruno/);

  // Rango de fechas y permisos
  assert.equal((await admin('GET', '/api/export?format=xlsx&sections=leads&from=2020-01-01&to=2020-12-31')).status, 200);
  assert.equal((await admin('GET', '/api/export?format=xlsx&sections=leads&from=ayer')).status, 400);
  assert.equal((await paulina('GET', '/api/export?format=xlsx&sections=users')).status, 400);
  const ops = await admin('POST', '/api/users', { name: 'Olga', email: 'olga@example.test', role: 'operaciones' });
  const olga = clientFor(baseUrl);
  await olga.login('olga@example.test', ops.body.temporaryPassword, 'OlgaNueva2026xx', mailer);
  assert.equal((await olga('GET', '/api/export?sections=leads')).status, 400);
  assert.equal((await olga('GET', '/api/export?sections=trips')).status, 200);
  const exportLog = (await admin('GET', '/api/activity?type=security&limit=50')).body.items.find((a) => a.action === 'data_export');
  assert.ok(exportLog && exportLog.note);

  // Respaldos: solo administrador
  assert.equal((await paulina('GET', '/api/backups')).status, 403);
  assert.equal((await paulina('POST', '/api/backups')).status, 403);
  assert.equal((await admin('PUT', '/api/backups/settings', { sendEmail: true, email: 'no-es-correo' })).status, 400);
  assert.equal((await admin('PUT', '/api/backups/settings', { sendEmail: true, email: 'joel@example.test, socio@example.test' })).status, 200);

  const sentBefore = mailer.sent.length;
  const made = await admin('POST', '/api/backups');
  assert.equal(made.status, 201);
  assert.equal(made.body.emailStatus, 'Enviado a joel@example.test, socio@example.test');
  const mail = mailer.sent.at(-1);
  assert.equal(mailer.sent.length, sentBefore + 1);
  assert.match(mail.subject, /^Respaldo diario Travel Partner/);
  assert.deepEqual(mail.attachments.map((a) => a.filename.replace(/\d{4}-\d{2}-\d{2}/, 'FECHA')), ['respaldo-travel-partner-FECHA.xlsx', 'respaldo-travel-partner-FECHA.json.gz']);
  const restored = JSON.parse(zlib.gunzipSync(mail.attachments[1].content).toString('utf8'));
  assert.equal(restored.data.leads.length, 2);
  assert.ok(restored.users.every((u) => !('password_hash' in u)), 'el respaldo no incluye contraseñas');

  const list = (await admin('GET', '/api/backups')).body;
  assert.equal(list.backups[0].kind, 'manual');
  assert.equal(list.backups[0].summary.counts.Leads, 2);
  assert.equal(list.recipients, 'joel@example.test, socio@example.test');
  const file = await admin('GET', `/api/backups/${list.backups[0].id}/download`);
  assert.equal(file.status, 200);
  assert.match(zipEntry(file.body, 'xl/workbook.xml'), /name="Resumen".*name="Usuarios"/);
  assert.equal((await admin('GET', `/api/backups/${list.backups[0].id}/download?type=json`)).type, 'application/gzip');
  assert.equal((await admin('GET', '/api/backups/999999/download')).status, 404);

  // Automático: corre si ya pasó la hora y no se ha hecho; no se repite el mismo día
  let clock = '2026-10-09 01:30:00';
  const service = createBackupService({ dataStore: app.locals.dataStore, mailer, now: () => clock });
  await admin('PUT', '/api/backups/settings', { sendEmail: false, email: '' });
  const first = await service.runIfDue();
  assert.ok(first && first.emailStatus === 'Envío por correo desactivado');
  clock = '2026-10-09 01:50:00';
  assert.equal(await service.runIfDue(), null, 'ya hay respaldo desde las 2:00 de ayer');
  clock = '2026-10-09 02:05:00';
  assert.ok(await service.runIfDue(), 'nuevo día después de las 2:00');
  clock = '2026-10-09 23:00:00';
  assert.equal(await service.runIfDue(), null);

  // Se conservan como máximo 30
  for (let i = 0; i < 31; i += 1) await service.run({ kind: 'manual' });
  assert.equal((await admin('GET', '/api/backups')).body.backups.length, 30);
});
