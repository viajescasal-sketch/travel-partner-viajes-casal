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
const { MySQLDataStore } = require('../src/data-store');

// JPEG mínimo válido (1x1).
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function startApp(context) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const mailer = { configured: false, from: null, async send() { return {}; } };
  const app = await createApp({ mailer, skipPurgeTimer: true, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers, cookie },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  call.login = async (email, password, newPassword) => {
    let r = await call('POST', '/api/auth/login', { email, password });
    if (r.status === 401) r = await call('POST', '/api/auth/login', { email, password: newPassword });
    assert.equal(r.status, 200);
    if (r.body.user.mustChangePassword) assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: password, newPassword })).status, 200);
  };
  return call;
}

test('plantilla PDF, cotizador, confirmación y calificación', async (context) => {
  const baseUrl = await startApp(context);
  const admin = clientFor(baseUrl);
  const paulina = clientFor(baseUrl);
  await admin.login('admin@example.test', 'AdminTemporal123', 'AdminNueva2026x');
  await paulina.login('paulina@example.test', 'PartnerTemporal123', 'PaulinaNueva2026');

  // Valores por defecto de la plantilla y de las preguntas
  const crm = (await paulina('GET', '/api/crm')).body;
  assert.equal(crm.settings.documents.brandName, 'VIAJES CASAL');
  assert.equal(crm.settings.documents.reviewsUrl, 'https://g.page/r/CdrMmhT2jbS5EBM/review');
  assert.ok(crm.settings.leadQuestions.length >= 3);
  assert.equal(crm.me.name, 'Paulina');

  // Solo el administrador cambia la plantilla; los enlaces se validan
  const docs = { ...crm.settings.documents, brandName: 'VIAJES BUMERAN CASAL', paymentInstructions: 'Transferencia a la cuenta de la agencia' };
  assert.equal((await paulina('PUT', '/api/settings/documents', docs)).status, 403);
  assert.equal((await admin('PUT', '/api/settings/documents', { ...docs, facebook: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin('PUT', '/api/settings/documents', docs)).status, 200);
  assert.equal((await paulina('GET', '/api/crm')).body.settings.documents.brandName, 'VIAJES BUMERAN CASAL');

  // Preguntas de calificación: botones con puntos, máximo 5
  assert.equal(crm.settings.leadQuestions.length, 5);
  assert.ok(crm.settings.leadQuestions.every((q) => q.options.every((o) => Number.isInteger(o.points))));
  const six = Array.from({ length: 6 }, (_, i) => ({ label: `P${i}`, options: [{ label: 'Sí', points: 10 }, { label: 'No', points: 0 }] }));
  assert.equal((await admin('PUT', '/api/settings/lead-questions', { questions: six })).status, 400);
  assert.equal((await admin('PUT', '/api/settings/lead-questions', { questions: [{ label: 'Tipo', options: [{ label: 'Única', points: 5 }] }] })).status, 400);
  const saved = await admin('PUT', '/api/settings/lead-questions', { questions: [
    { label: '¿Para cuándo?', options: [{ label: 'Este mes', points: 60 }, { label: 'Después', points: 10 }] },
    { label: '¿Presupuesto?', options: [{ label: 'Alto', points: 40 }, { label: 'Bajo', points: 0 }] }
  ] });
  assert.equal(saved.status, 200);
  const [q1, q2] = saved.body.questions;
  assert.match(q1.id, /^q_/);

  // Lead con respuestas: la calificación la calcula el servidor
  const lead = (await paulina('POST', '/api/leads', { client: { name: 'Fernanda Ruiz', phone: '55 1987 6543' }, destination: 'Los Cabos', qualification: { answers: { [q1.id]: 'Este mes', [q2.id]: 'Inventada', q_falsa: 'x' }, score: 100 } })).body;
  assert.deepEqual(lead.record.qualification, { answers: { [q1.id]: 'Este mes' }, answered: 1, total: 2, score: 60, level: 'Tibio' });
  const hot = await paulina('PATCH', `/api/leads/${lead.record.id}`, { qualification: { answers: { [q1.id]: 'Este mes', [q2.id]: 'Alto' } } });
  assert.equal(hot.body.record.qualification.score, 100);
  assert.equal(hot.body.record.qualification.level, 'Caliente');
  assert.equal((await paulina('PATCH', `/api/leads/${lead.record.id}`, { qualification: 'nada' })).status, 400);
  const qualLog = (await admin('GET', `/api/activity?entity=leads&entityId=${lead.record.id}`)).body.items[0];
  assert.deepEqual(qualLog.changes.map((c) => [c.label, c.from, c.to]), [['Calificación', '60% · Tibio', '100% · Caliente']]);

  // Imágenes: formato y permisos
  const up = await paulina('POST', '/api/media', JPEG, { 'content-type': 'image/jpeg' });
  assert.equal(up.status, 201);
  assert.equal((await paulina('POST', '/api/media', Buffer.from('<svg/>'), { 'content-type': 'image/png' })).status, 400);
  assert.equal((await paulina('POST', '/api/media', Buffer.alloc(4 * 1024 * 1024, 1), { 'content-type': 'image/jpeg' })).status, 413);
  const img = await admin('GET', up.body.url);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/jpeg');
  assert.ok(img.body.equals(JPEG));
  assert.equal((await clientFor(baseUrl)('GET', up.body.url)).status, 401, 'sin sesión no hay imágenes');

  // Perfil del vendedor para los documentos
  assert.equal((await paulina('PUT', '/api/profile', { phone: '+52 998 392 1530', website: 'ftp://x' })).status, 400);
  const profile = await paulina('PUT', '/api/profile', { phone: '+52 998 392 1530', bio: 'Soy Paulina', website: 'https://paulina.viajescasal.com', photoMediaId: up.body.id });
  assert.equal(profile.body.profile.photoUrl, up.body.url);

  // Cotización con datos del cotizador
  const details = {
    version: 1, pax: '2 adultos', services: { vuelo: true, hotel: true, traslados: true, tours: false, seguro: false }, varying: 'hotel',
    fixed: { vuelo: { aerolinea: 'Volaris', origen: 'CDMX' }, traslados: { tipo: 'Redondo' } },
    proposals: [
      { hotel: { hotel: 'Riu Palace', stars: '5', plan: 'Todo incluido', mediaId: up.body.id }, price: { total: '45000' }, pay: { esquema: 'anticipo', anticipo: '9000' } },
      { hotel: { hotel: 'Hyatt Ziva', stars: '5' }, price: { total: '52000' }, pay: { esquema: 'anticipo' } }
    ]
  };
  const quote = (await paulina('POST', '/api/quotes', { client_id: lead.client.id, lead_id: lead.record.id, destination: 'Los Cabos', hotel: 'Riu Palace', price: 45000, details })).body.record;
  assert.equal(quote.details.proposals.length, 2);
  assert.equal((await paulina('PATCH', `/api/quotes/${quote.id}`, { details: { big: 'x'.repeat(130000) } })).status, 400);

  const doc = await paulina('GET', `/api/documents/quote/${quote.id}`);
  assert.equal(doc.status, 200);
  assert.equal(doc.body.seller.phone, '+52 998 392 1530');
  assert.equal(doc.body.client.name, 'Fernanda Ruiz');
  assert.equal(doc.body.documents.brandName, 'VIAJES BUMERAN CASAL');
  assert.equal(doc.body.quote.details.fixed.vuelo.aerolinea, 'Volaris');

  // Otro vendedor no ve el documento
  const createdB = await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' });
  const bruno = clientFor(baseUrl);
  await bruno.login('bruno@example.test', createdB.body.temporaryPassword, 'BrunoNueva2026x');
  assert.equal((await bruno('GET', `/api/documents/quote/${quote.id}`)).status, 404);

  // Viaje con confirmación de servicios: Operaciones la llena, el vendedor aparece en el documento
  const ops = await admin('POST', '/api/users', { name: 'Olga', email: 'olga@example.test', role: 'operaciones' });
  const olga = clientFor(baseUrl);
  await olga.login('olga@example.test', ops.body.temporaryPassword, 'OlgaNueva2026xx');
  const trip = (await paulina('POST', '/api/trips', { client_id: lead.client.id, quote_id: quote.id, destination: 'Los Cabos', start_date: '2026-12-10', end_date: '2026-12-14' })).body.record;
  const confirmation = { reservation: 'VC-2026-00001', holder: 'Fernanda Ruiz', passengers: 'Fernanda Ruiz\nLuis Ruiz', services: { flight: true, hotel: true }, airline: 'Volaris' };
  const patched = await olga('PATCH', `/api/trips/${trip.id}`, { confirmation });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.record.confirmation.airline, 'Volaris');
  const tripDoc = (await olga('GET', `/api/documents/trip/${trip.id}`)).body;
  assert.equal(tripDoc.seller.name, 'Paulina');
  assert.equal(tripDoc.quote.details.proposals[0].hotel.hotel, 'Riu Palace');
  assert.equal(tripDoc.canEdit, true);

  // Bitácora: el cambio de la confirmación queda registrado sin volcar el contenido
  const hist = (await admin('GET', `/api/activity?entity=trips&entityId=${trip.id}`)).body.items;
  assert.deepEqual(hist[0].changes.map((c) => [c.label, c.to]), [['Confirmación de servicios', 'Actualizado']]);

  // Cotización de circuito
  const circuit = { version: 1, kind: 'circuito', pax: '2 adultos', startDate: '2027-01-10', circuit: { nombre: 'Ruta Maya', ruta: ['Cancún', 'Mérida'], days: [{ titulo: 'Llegada' }, { titulo: 'Chichén Itzá' }], categories: [{ nombre: 'Estándar', estrellas: '3', hoteles: [{ ciudad: 'Mérida', hotel: 'Hotel Centro' }], precios: ['18500', '14900'] }], occupancies: ['Sencilla', 'Doble'] } };
  const cq = await paulina('POST', '/api/quotes', { client_id: lead.client.id, lead_id: lead.record.id, destination: 'Yucatán', hotel: 'Circuito Ruta Maya', price: 14900, mode: 'Por persona', details: circuit });
  assert.equal(cq.status, 201);
  assert.equal((await paulina('GET', `/api/documents/quote/${cq.body.record.id}`)).body.quote.details.circuit.ruta[1], 'Mérida');

  // Duplicar conserva el cotizador
  const copy = (await paulina('POST', `/api/quotes/${quote.id}/duplicate`)).body.record;
  assert.equal(copy.details.proposals[1].hotel.hotel, 'Hyatt Ziva');

  // Código QR
  const qr = await paulina('GET', `/api/qr?data=${encodeURIComponent('https://wa.me/529983921530')}`);
  assert.equal(qr.type, 'image/png');
  assert.equal((await paulina('GET', '/api/qr')).status, 400);
});
