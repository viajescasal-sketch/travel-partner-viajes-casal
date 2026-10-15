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
const T = require('../public/viaje-core');
require('../public/docs/documents.js');

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
  return { baseUrl, store: app.locals.dataStore, partner, admin };
}

test('TP-303: tipo por edad, avisos de documentos y renglones para la confirmación', () => {
  assert.equal(T.paxType('2020-12-21', '2026-12-20'), 'Menor', 'cumple 6 un día después: 5 años');
  assert.equal(T.paxType('2025-06-01', '2026-12-20'), 'Infante');
  assert.equal(T.paxType('2014-12-20', '2026-12-20'), 'Adulto', 'cumple 12 el día de salida');
  assert.equal(T.paxType('', '2026-12-20', 'Menor'), 'Menor', 'sin fecha respeta lo elegido');
  const trip = { start_date: '2026-12-20', end_date: '2026-12-27' };
  const alerts = (p) => T.passengerAlerts(T.cleanPassenger({ name: 'X', birth_date: '1990-01-01', ...p }), trip).map((a) => `${a.level}:${a.text}`);
  assert.deepEqual(alerts({ doc_type: 'Pasaporte', doc_number: 'g 123', doc_expiry: '2026-12-01' }), ['danger:Pasaporte vencido antes de la salida']);
  assert.deepEqual(alerts({ doc_type: 'Pasaporte', doc_number: 'G123', doc_expiry: '2026-12-24' }), ['danger:Pasaporte vence durante el viaje']);
  assert.deepEqual(alerts({ doc_type: 'Pasaporte', doc_number: 'G123', doc_expiry: '2027-03-01' }), ['warn:Pasaporte con menos de 6 meses de vigencia al regreso']);
  assert.deepEqual(alerts({ doc_type: 'Pasaporte', doc_number: 'G123', doc_expiry: '2028-01-01' }), []);
  assert.deepEqual(alerts({}), ['info:Sin documento de viaje']);
  const list = T.cleanPassengers([{ name: ' Ana  López ' }, { name: 'Leo López', birth_date: '2018-05-01' }, { name: 'ana lópez' }, { name: '' }], trip.start_date);
  assert.deepEqual(list.map((p) => [p.name, p.type, p.holder]), [['Ana López', 'Adulto', true], ['Leo López', 'Menor', false]], 'sin repetidos ni vacíos; titular = primer adulto');
  assert.equal(T.passengerLines(list, trip.start_date), 'Ana López\nLeo López (menor, 8 años)');
});

test('TP-303: pasajeros por viaje, acompañantes del cliente y privacidad en la liga pública', async (context) => {
  const { baseUrl, store, partner, admin } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-27', travelers: 3 })).body.record;
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-27' })).body.record;

  // No se puede escribir por el PATCH general (campo interno).
  await partner('PATCH', `/api/trips/${trip.id}`, { passengers: { list: [{ name: 'Intruso' }] } });
  assert.equal((await store.getRecord('trips', trip.id)).passengers, null);

  const r = await partner('PUT', `/api/trips/${trip.id}/passengers`, {
    list: [
      { name: 'Ana López', birth_date: '1990-03-02', doc_type: 'Pasaporte', doc_number: 'g 1234 5678', doc_expiry: '2027-02-01', nationality: 'Mexicana' },
      { name: 'Leo López', birth_date: '2018-05-01', relation: 'Hijo', doc_type: 'Acta de nacimiento', holder: true },
      { name: 'Mía López', birth_date: '2025-08-01', relation: 'Hija' }
    ],
    skipCompanions: []
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.passengers.map((p) => [p.name, p.type, p.holder]), [['Ana López', 'Adulto', false], ['Leo López', 'Menor', true], ['Mía López', 'Infante', false]]);
  assert.equal(r.body.passengers[0].doc_number, 'G12345678');
  assert.equal(r.body.alerts[0].alerts[0].level, 'warn', 'pasaporte con menos de 6 meses');

  // Acompañantes guardados en el cliente (sin datos del viaje).
  const client = await store.getRecord('clients', lead.client_id);
  assert.deepEqual(client.companions.list.map((c) => [c.name, c.relation]), [['Ana López', 'Titular'], ['Leo López', 'Hijo'], ['Mía López', 'Hija']]);
  assert.equal(client.companions.list[0].holder, undefined);

  // Otro vendedor/rol: operaciones sí; el vendedor dueño sí; un viaje ajeno responde 404.
  assert.equal((await partner('PUT', '/api/trips/99999/passengers', { list: [] })).status, 404);
  assert.equal((await partner('PUT', `/api/trips/${trip.id}/passengers`, { list: 'x' })).status, 400);

  // Bitácora sin números de documento.
  const logs = JSON.stringify((await admin('GET', '/api/activity')).body);
  assert.match(logs, /Pasajeros actualizados: 3/);
  assert.doesNotMatch(logs, /G12345678/);

  // Liga pública: solo nombres y tipo.
  const url = (await partner('POST', `/api/trips/${trip.id}/share`, {})).body.url;
  const pub = await (await fetch(`${baseUrl}/api/public/trip/${url.split('/').pop()}`)).json();
  assert.deepEqual(pub.trip.passengers.list, [{ name: 'Ana López', type: 'Adulto', holder: false }, { name: 'Leo López', type: 'Menor', holder: true }, { name: 'Mía López', type: 'Infante', holder: false }]);
  assert.doesNotMatch(JSON.stringify(pub), /G12345678|1990-03-02/);

  // La confirmación toma la lista (aunque la confirmación guardada diga otra cosa).
  await partner('PATCH', `/api/trips/${trip.id}`, { confirmation: { passengers: 'Ana', travelers: 1, holder: 'Ana' } });
  const doc = (await partner('GET', `/api/documents/trip/${trip.id}`)).body;
  const c = TPDocs.mergeConfirmation(doc.trip.confirmation, TPDocs.confirmationDefaults(doc));
  assert.equal(c.passengers, 'Ana López\nLeo López (menor, 8 años)\nMía López (infante, 1 año)');
  assert.equal(c.travelers, 3);
  assert.equal(c.holder, 'Leo López');
  assert.equal(c._pax, undefined);

  // Quitar un acompañante desde la ficha.
  const comp = await partner('PUT', `/api/clients/${lead.client_id}/companions`, { list: client.companions.list.slice(0, 2) });
  assert.equal(comp.status, 200);
  assert.equal(comp.body.companions.length, 2);
});

test('TP-302: el lienzo se convierte en cotización, itinerario y confirmación', async (context) => {
  const { partner, store } = await setup(context);
  const lead = (await partner('POST', '/api/leads', { client: { name: 'Carlos Ruiz', phone: '998 765 4321' }, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', travelers: 2 })).body.record;
  const canvas = {
    destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24', travelers: 2, pax: '2 adultos',
    blocks: [
      { type: 'vuelo', day: 0, time: '08:35', arrival: '11:02', airline: 'Volaris', flight: 'Y4 123', from: 'CDMX', to: 'CUN', title: 'Vuelo de ida', cost: 7000, price: 8000, notes: 'Maleta de 25 kg' },
      { type: 'traslado', day: 0, time: '11:30', from: 'Aeropuerto', to: 'Hotel Riu', provider: 'Transportes Caribe', title: 'Traslado de llegada', cost: 500, price: 800 },
      { type: 'hotel', day: 0, nights: 4, title: 'Hotel Riu Caribe', plan: 'Todo incluido', room: 'Junior Suite', cost: 18000, price: 21000 },
      { type: 'tour', day: 2, time: '07:00', title: 'Xcaret Plus', provider: 'Grupo Xcaret', place: 'Parque Xcaret', cost: 4000, price: 4600 },
      { type: 'tour', day: 1, time: '09:00', title: 'Isla Mujeres en catamarán', cost: 1800, price: 2400 },
      { type: 'traslado', day: 4, time: '13:00', from: 'Hotel Riu', to: 'Aeropuerto', title: 'Traslado de regreso', cost: 500, price: 800 },
      { type: 'vuelo', day: 4, time: '17:45', arrival: '19:55', airline: 'Volaris', flight: 'Y4 124', from: 'CUN', to: 'CDMX', title: 'Vuelo de regreso', cost: 0, price: '' },
      { type: 'nota', day: 3, title: 'Cena de aniversario' },
      { type: 'fantasma', day: 1, title: 'no válido' }
    ]
  };
  const saved = await partner('PATCH', `/api/leads/${lead.id}`, { canvas });
  assert.equal(saved.status, 200);
  const cv = saved.body.record.canvas;
  assert.equal(cv.blocks.length, 8, 'descarta tipos desconocidos');
  assert.ok(cv.blocks.every((b) => /^b[a-z0-9]+$/.test(b.id)));
  assert.deepEqual(cv.blocks.filter((b) => b.day === 0).map((b) => b.type), ['vuelo', 'traslado', 'hotel']);

  const totals = T.canvasTotals(cv);
  assert.deepEqual([totals.cost, totals.price, totals.profit, totals.margin, totals.perPerson, totals.missingPrice], [31800, 37600, 5800, 15.4, 18800, 1]);

  // Cotización generada (formato del cotizador) y su efecto en el lead.
  const q = T.canvasToQuote(cv, { destination: lead.destination });
  assert.equal(q.hotel, 'Hotel Riu Caribe — Todo incluido');
  assert.equal(q.price, 37600);
  assert.equal(q.details.varying, 'hotel');
  assert.deepEqual(q.details.services, { vuelo: true, hotel: true, traslados: true, tours: true, seguro: false });
  assert.deepEqual(q.details.fixed.vuelo, { aerolinea: 'Volaris', origen: 'CDMX', equipaje: 'Maleta de 25 kg', hsIda: '08:35', hlIda: '11:02', hsReg: '17:45', hlReg: '19:55' });
  assert.equal(q.details.fixed.traslados.tipo, 'Redondo');
  assert.deepEqual(q.details.fixed.tours.items.map((t) => t.nombre), ['Isla Mujeres en catamarán', 'Xcaret Plus']);
  assert.equal(q.details.proposals[0].price.pp, '18800');
  const created = await partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, status: 'Borrador', destination: q.destination, hotel: q.hotel, price: q.price, services: q.services, details: q.details });
  assert.equal(created.status, 201);
  assert.ok(created.body.record.details.canvas.blocks.length, 'la cotización conserva el lienzo');
  const model = TPDocs.quoteModel({ quote: created.body.record, client: { name: 'Carlos Ruiz' }, lead });
  assert.equal(model.dataList.length, 1, 'el PDF de la cotización entiende la estructura');

  // Viaje vendido: el lienzo pasa al viaje y arma itinerario y confirmación.
  const trip = (await partner('POST', '/api/trips', { client_id: lead.client_id, quote_id: created.body.record.id, destination: 'Cancún', start_date: '2026-12-20', end_date: '2026-12-24' })).body.record;
  const tcv = T.canvasFromTrip(trip, created.body.record.details);
  assert.equal(tcv.blocks.length, 8);
  const days = T.canvasToItinerary(tcv, trip);
  assert.equal(days.length, 5);
  assert.equal(days[0].title, 'Llegada a Cancún');
  assert.match(days[0].text, /^08:35 ✈️ Vuelo Volaris Y4 123 CDMX → CUN · llegada 11:02/);
  assert.match(days[0].text, /🏨 Check-in en Hotel Riu Caribe \(Todo incluido\) · 4 noches/);
  assert.equal(days[1].title, 'Isla Mujeres en catamarán');
  assert.equal(days[2].place, 'Parque Xcaret');
  assert.equal(days[3].title, 'Día libre en Cancún');
  assert.match(days[3].text, /📝 Cena de aniversario/);
  assert.equal(days[4].title, 'Regreso a casa');
  assert.match(days[4].text, /^🏨 Check-out de Hotel Riu Caribe/);
  const conf = T.canvasToConfirmation(tcv, trip);
  assert.equal(conf.airline, 'Volaris');
  assert.equal(conf.outboundDeparture, '20 Dic 2026 | 08:35');
  assert.equal(conf.returnArrival, '24 Dic 2026 | 19:55');
  assert.equal(conf.checkout, '24 Dic 2026 | 12:00 hrs');
  assert.equal(conf.operator, 'Transportes Caribe');
  assert.equal(conf.transferBackTime, '13:00');
  assert.match(conf.activitiesDetail, /21 Dic 2026 09:00 — Isla Mujeres en catamarán/);
  assert.deepEqual(conf.services, { flight: true, hotel: true, transfer: true, activities: true, insurance: false, partner: true });

  const applied = await partner('PATCH', `/api/trips/${trip.id}`, { canvas: tcv, itinerary: { days, updated_at: '2026-10-15 10:00', source: 'canvas' }, confirmation: conf });
  assert.equal(applied.status, 200);
  const stored = await store.getRecord('trips', trip.id);
  assert.equal(stored.itinerary.days.length, 5);
  assert.equal(stored.canvas.blocks.length, 8);

  // Un viaje sin lienzo arma uno inicial con su confirmación.
  const fromConf = T.canvasFromTrip({ ...trip, canvas: null, confirmation: { services: { flight: true, hotel: true, transfer: true }, airline: 'Viva', outboundFlight: 'MTY → CUN', outboundDeparture: '20 Dic 2026 | 06:10', hotelName: 'Grand Oasis', transferOutOrigin: 'Aeropuerto', transferOutDestination: 'Grand Oasis', transferBackOrigin: 'Grand Oasis' } }, null);
  assert.deepEqual(fromConf.blocks.map((b) => [b.type, b.day]), [['vuelo', 0], ['traslado', 0], ['hotel', 0], ['traslado', 4]]);
  assert.equal(fromConf.blocks[0].time, '06:10');

  // Límites del lienzo: tamaño y días.
  const big = await partner('PATCH', `/api/leads/${lead.id}`, { canvas: { start_date: '2026-12-20', end_date: '2026-12-21', blocks: [{ type: 'tour', day: 30, title: 'Fuera de rango' }] } });
  assert.equal(big.body.record.canvas.blocks[0].day, 1, 'un bloque fuera de las fechas se queda en el último día');
});
