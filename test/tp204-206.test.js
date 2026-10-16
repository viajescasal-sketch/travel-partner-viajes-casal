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
const C = require('../public/contrato-core');
const T = require('../public/viaje-core');
const K = require('../public/comisiones-core');
const R = require('../public/reportes-core');
const { nowCancun } = require('../src/crm-schema');

// PNG de una "firma" (líneas con ruido) para las pruebas.
function signaturePng(w = 240, h = 80) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 255);
  let seed = 7;
  for (let y = 0; y < h; y += 1) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; if (Math.abs(y - 40 - 20 * Math.sin(x / 15)) < 2 || seed % 97 === 0) raw[y * (w + 1) + 1 + x] = 20; } }
  return `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}

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
const pub = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'user-agent': 'Prueba/1.0 (iPhone)' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
async function setup(context, extra = {}) {
  const sent = [];
  const mailer = { configured: false, from: 'x@example.test', send: async (m) => { sent.push(m); return { delivered: true }; } };
  const prefs = [];
  const fakeMp = { configured: true, sandbox: false, async createPreference(b) { prefs.push(b); return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref-${prefs.length}` }; }, async getPayment() { throw new Error('no'); }, verifySignature: () => true };
  const app = await createApp({ skipPurgeTimer: true, mailer, mercadoPago: fakeMp, ...extra });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  mailer.configured = true;
  const users = (await admin('GET', '/api/crm')).body.users;
  return { baseUrl, store: app.locals.dataStore, partner, admin, sent, prefs, adminId: users.find((u) => u.role === 'admin').id, paulinaId: users.find((u) => u.role === 'travel_partner').id };
}
async function sale(ctx, { price = 30000, accept = 'online', name = 'Ana López', phone = '998 123 4567', email = 'ana@cliente.test' } = {}) {
  const lead = (await ctx.partner('POST', '/api/leads', { client: { name, phone, email }, destination: 'Cancún', start_date: '2027-03-10', end_date: '2027-03-15', travelers: 2 })).body.record;
  const quote = (await ctx.partner('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, destination: 'Cancún', hotel: 'Hotel Riu — Todo incluido', price, status: 'Enviada', details: { proposals: [{ price: { total: String(price) }, pay: { esquema: 'anticipo', anticipo: String(price * 0.3) } }] } })).body.record;
  if (accept === 'online') {
    const share = (await ctx.partner('POST', `/api/quotes/${quote.id}/share`, {})).body.url.split('/').pop();
    const ok = await pub(ctx.baseUrl, 'POST', `/api/public/quote/${share}/accept`, { name, terms: true });
    return { lead, share, accepted: ok.body, quote: await ctx.store.getRecord('quotes', quote.id) };
  }
  await ctx.partner('PATCH', `/api/quotes/${quote.id}`, { status: 'Aceptada' });
  return { lead, quote: await ctx.store.getRecord('quotes', quote.id) };
}

test('TP-204: contrato armado con los datos del viaje, plan de pagos y cláusulas editables', () => {
  const cfg = C.cleanSettings({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.title, C.DEFAULT_TITLE);
  assert.equal(C.cleanSettings({ clauses: '   ', title: '' }).clauses, C.DEFAULT_CLAUSES, 'vacío → texto sugerido');
  const doc = C.build({
    cfg: { clauses: 'PAGOS. Total {total}, anticipo {anticipo}.\n\nCANCELACIÓN. {politicas}\n\nFIRMA en {ciudad} con {cliente} para {destino} ({fechas}). {desconocida}' },
    documents: { resPolicies: 'Cancelaciones: cargos del proveedor.\nNo show: sin reembolso.' }, agency: { name: 'Viajes Casal', whatsapp: '+52 998' },
    quote: { folio: 'COT-0007', destination: 'Cancún', hotel: 'Riu', price: 30000, services: 'Vuelo redondo\nTraslados' },
    client: { name: 'Ana López', phone: '9981234567', email: 'ana@x.test' }, lead: { start_date: '2027-03-10', end_date: '2027-03-15', travelers: 2 },
    plan: { total: 30000, installments: [{ label: 'Anticipo', amount: 9000, due: '2026-10-20' }, { label: 'Liquidación', amount: 21000, due: '2027-02-08' }] }
  });
  const text = C.plainText(doc);
  assert.match(doc.intro, /Viajes Casal \("LA AGENCIA"\) y Ana López \("EL CLIENTE"\).*Cancún del 10 de marzo de 2027 al 15 de marzo de 2027/);
  assert.match(text, /Anticipo: \$9,000\.00 MXN · antes del 20 de octubre de 2026/);
  assert.match(text, /1\. PAGOS\. Total \$30,000\.00, anticipo \$9,000\.00 MXN\./);
  assert.match(text, /2\. CANCELACIÓN\. Cancelaciones: cargos del proveedor\. No show: sin reembolso\./);
  assert.match(text, /3\. FIRMA en Cancún, Quintana Roo con Ana López para Cancún/);
  assert.match(text, /\{desconocida\}/, 'las variables desconocidas se quedan como están');
  assert.match(text, /Incluye: Vuelo redondo · Traslados/);
  assert.doesNotMatch(text, /9981234567|ana@x\.test/, 'el contrato no expone teléfono ni correo del cliente');
  assert.equal(C.state({}), 'none');
  assert.equal(C.state({ contract: { required: true } }), 'pending');
  assert.equal(C.state({ contract: { required: true, waived: { at: 'x' } } }), 'waived');
  assert.equal(C.state({ contract: { required: true, signed: { at: 'x' } } }), 'signed');
});

test('TP-204: el cliente firma su contrato antes de pagar el anticipo', async (context) => {
  const ctx = await setup(context);
  const { share, accepted, quote } = await sale(ctx);
  assert.match(accepted.contractUrl, /^\/contrato\/[a-f0-9]{40}$/, 'al aceptar en línea, el siguiente paso es el contrato');
  assert.equal(accepted.payUrl, `/pagar/${quote.pay_token}`);
  assert.equal(quote.contract.required, true);
  const token = quote.pay_token;
  const qpub = await pub(ctx.baseUrl, 'GET', `/api/public/quote/${share}`);
  assert.equal(qpub.body.payUrl, `/contrato/${token}`);
  assert.equal(qpub.body.payLabel, 'Firmar mi contrato y pagar');
  assert.doesNotMatch(JSON.stringify(qpub.body), /"contract"|seller_commission/);
  const pay = await pub(ctx.baseUrl, 'GET', `/api/public/pay/${token}`);
  assert.deepEqual(pay.body.contract, { state: 'pending', url: `/contrato/${token}` });
  assert.equal((await pub(ctx.baseUrl, 'POST', `/api/public/pay/${token}/checkout`, {})).status, 400, 'no puede pagar en línea sin firmar');

  const page = await fetch(`${ctx.baseUrl}/contrato/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /contrato\.js/);
  assert.equal((await fetch(`${ctx.baseUrl}/contrato/${'0'.repeat(40)}`)).status, 404);
  const c = (await pub(ctx.baseUrl, 'GET', `/api/public/contract/${token}`)).body;
  assert.equal(c.state, 'pending');
  assert.match(c.hash, /^[a-f0-9]{64}$/);
  assert.equal(c.doc.blocks[2].rows[1][0], 'Anticipo');
  assert.doesNotMatch(JSON.stringify(c), /998 123|ana@cliente|pay_token|share_token/, 'sin datos de contacto ni tokens');

  const png = signaturePng();
  const sign = (body) => pub(ctx.baseUrl, 'POST', `/api/public/contract/${token}/sign`, body);
  assert.equal((await sign({ name: 'Ana López', accept: true, hash: c.hash })).status, 400, 'sin firma dibujada');
  assert.equal((await sign({ name: 'Ana López', accept: true, hash: c.hash, signature: 'data:image/png;base64,AAAA' })).status, 400, 'firma inválida');
  assert.equal((await sign({ name: 'Ana López', signature: png, hash: c.hash })).status, 400, 'sin aceptar');
  assert.equal((await sign({ name: 'A', accept: true, signature: png, hash: c.hash })).status, 400, 'sin nombre');
  const stale = await sign({ name: 'Ana López', accept: true, signature: png, hash: 'f'.repeat(64) });
  assert.equal(stale.status, 409, 'si el contrato cambió mientras lo leía, debe revisarlo de nuevo');
  assert.equal(stale.body.hash, c.hash);

  ctx.sent.length = 0;
  const ok = await sign({ name: 'Ana López Pérez', accept: true, signature: png, hash: c.hash });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.state, 'signed');
  assert.equal(ok.body.emailed, true);
  assert.equal(ok.body.signed.name, 'Ana López Pérez');
  assert.match(ok.body.signed.device, /iPhone/);
  const saved = await ctx.store.getRecord('quotes', quote.id);
  assert.equal(saved.contract.signed.hash, c.hash);
  assert.equal(saved.contract.signed.total, 30000);
  assert.deepEqual(saved.contract.signed.doc, c.doc, 'se guarda copia del texto firmado');
  assert.equal(ctx.sent.filter((m) => m.to === 'ana@cliente.test' && /contrato firmado/i.test(m.subject)).length, 1, 'copia al cliente');
  assert.ok(ctx.store.notifications.some((n) => n.kind === 'contract' && n.user_id === ctx.paulinaId), 'aviso a la vendedora');
  const sig = await fetch(`${ctx.baseUrl}/api/public/contract/${token}/signature`);
  assert.equal(sig.headers.get('content-type'), 'image/png');
  assert.equal((await pub(ctx.baseUrl, 'GET', `/api/public/pay/${token}`)).body.contract.state, 'signed');
  assert.equal((await pub(ctx.baseUrl, 'POST', `/api/public/pay/${token}/checkout`, {})).status, 200, 'ya firmado, puede pagar');
  assert.equal((await sign({ name: 'Otra', accept: true, signature: png, hash: c.hash })).body.already, true);

  // Cambiar el plan después de firmar no altera la copia firmada.
  await ctx.partner('PUT', `/api/quotes/${quote.id}/payment-plan`, { total: 32000, installments: [{ id: 'p1', label: 'Anticipo', due: '2026-12-01', amount: 9000 }, { id: 'p2', label: 'Liquidación', due: '2027-02-08', amount: 23000 }] });
  const after = (await pub(ctx.baseUrl, 'GET', `/api/public/contract/${token}`)).body;
  assert.equal(after.hash, c.hash);
  const team = await ctx.partner('GET', `/api/quotes/${quote.id}/contract`);
  assert.equal(team.body.state, 'signed');
  assert.match(team.body.url, /\/contrato\/[a-f0-9]{40}$/);
});

test('TP-204: configuración, venta cerrada en la plataforma y contrato en papel', async (context) => {
  const ctx = await setup(context);
  // Venta cerrada por la vendedora (fuera de línea): también pide contrato.
  const manual = await sale(ctx, { accept: 'crm' });
  assert.equal(C.state(manual.quote), 'pending');
  assert.equal((await ctx.partner('PUT', '/api/contract/settings', { enabled: false })).status, 403);
  const s = await ctx.admin('PUT', '/api/contract/settings', { enabled: false, title: 'Contrato de viaje', clauses: 'UNO. {cliente}', city: 'Mérida, Yucatán' });
  assert.equal(s.body.enabled, false);
  assert.equal((await ctx.partner('GET', '/api/contract/settings')).body.city, 'Mérida, Yucatán');
  const off = await sale(ctx, { name: 'Luis Pérez', phone: '998 765 4321', email: 'luis@cliente.test' });
  assert.equal(C.state(off.quote), 'none', 'desactivado: las ventas nuevas no piden firma');
  assert.equal(off.accepted.contractUrl, null);
  assert.equal((await pub(ctx.baseUrl, 'GET', `/api/public/contract/${off.quote.pay_token}`)).status, 404);
  const req = await ctx.partner('POST', `/api/quotes/${off.quote.id}/contract`, { action: 'require' });
  assert.equal(req.body.state, 'pending', 'el vendedor puede pedir la firma de una venta');
  const doc = (await pub(ctx.baseUrl, 'GET', `/api/public/contract/${off.quote.pay_token}`)).body.doc;
  assert.equal(doc.title, 'Contrato de viaje');
  assert.deepEqual(doc.blocks[3].items, ['UNO. Luis Pérez']);
  assert.equal((await ctx.admin('POST', `/api/quotes/${manual.quote.id}/contract`, { action: 'waive', reason: 'Firmado en oficina' })).body.state, 'waived');
  assert.equal((await pub(ctx.baseUrl, 'POST', `/api/public/pay/${manual.quote.pay_token}/checkout`, {})).status, 200);
});

test('TP-205: reglas de comisión por proveedor (tarifa neta o comisionable)', () => {
  const b = T.cleanBooking({ id: 'rabc1', type: 'Hotel', supplier_name: 'HotelDO', model: 'comision', price: 20000, commission_pct: 12, start_date: '2027-03-10', end_date: '2027-03-15', commission_status: 'Cobrada', commission_paid_at: '2027-04-20' });
  assert.equal(b.commission_amount, 2400, 'comisión = % × precio de venta');
  assert.equal(T.bookingProfit(b), 2400);
  assert.equal(b.commission_paid_at, '2027-04-20');
  assert.equal(T.cleanBooking({ id: 'rabc2', supplier_name: 'X', model: 'comision', price: 1000, commission_amount: 150, commission_pct: 300 }).commission_pct, 100);
  const neta = T.cleanBooking({ id: 'rabc3', supplier_name: 'X', price: 1000, cost: 800, commission_pct: 10, commission_status: 'Cobrada' });
  assert.equal(neta.model, 'neta');
  assert.equal(neta.commission_pct, '', 'tarifa neta no guarda comisión');
  assert.equal(T.bookingProfit(neta), 200);
  assert.equal(T.bookingProfit(T.cleanBooking({ id: 'rabc4', supplier_name: 'X', price: 1000 })), null, 'sin costo todavía');
  assert.equal(T.bookingProfit({ ...b, status: 'Cancelada' }), 0);
  assert.equal(T.bookingProfit({ ...b, commission_status: 'Cancelada' }), 0);
  assert.equal(T.commissionDueDefault(b, {}, { commission_days: 45 }), '2027-04-29');
  assert.equal(T.commissionDueDefault(b, {}, null), '2027-04-14', '30 días por omisión');
  const open = { ...b, commission_status: 'Facturada', commission_due: '2027-04-14' };
  assert.deepEqual(T.commissionAlert(open, '2027-04-20'), { level: 'warn', text: 'Comisión por cobrar vencida (6 días)' });
  assert.equal(T.commissionAlert(b, '2027-04-20'), null, 'cobrada: sin aviso');
  const sum = T.bookingsSummary([open, neta, T.cleanBooking({ id: 'rabc5', supplier_name: 'Y', price: 500 })]);
  assert.equal(sum.profit, 2600);
  assert.equal(sum.profitMissing, 1);
  assert.equal(sum.toCollect, 2400);
  assert.equal(R.saleProfit({ id: 1 }, [{ quote_id: 1, bookings: { list: [open, neta] } }]), 2600);
  assert.equal(R.saleProfit({ id: 1 }, [{ quote_id: 1, bookings: { list: [T.cleanBooking({ id: 'rabc6', supplier_name: 'Y', price: 5 })] } }]), null);
  const sup = T.cleanSupplier({ name: 'Azabache', model: 'comision', commission: 12, commission_days: '60' });
  assert.equal(sup.model, 'comision');
  assert.equal(sup.commission_days, 60);
  assert.throws(() => T.cleanSupplier({ name: 'X', commission_days: 900 }), /365/);
});

test('TP-205: comisiones por cobrar en las reservas y su cobro', async (context) => {
  const ctx = await setup(context);
  const { quote } = await sale(ctx, { accept: 'crm' });
  const sup = (await ctx.admin('POST', '/api/suppliers', { name: 'Mayorista Comisión', type: 'Mayorista', model: 'comision', commission: 12, commission_days: 20 })).body.supplier;
  assert.equal(sup.model, 'comision');
  const trip = (await ctx.partner('POST', '/api/trips', { client_id: quote.client_id, quote_id: quote.id, destination: 'Cancún', start_date: '2027-03-10', end_date: '2027-03-15' })).body.record;
  const put = await ctx.partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [
    { id: 'rhotel1', type: 'Hotel', supplier_name: 'Mayorista Comisión', supplier_id: sup.id, model: 'comision', commission_pct: 12, price: 25000, start_date: '2027-03-10', end_date: '2027-03-15', commission_status: 'Cobrada' },
    { id: 'rtras01', type: 'Traslado', supplier_name: 'Traslados X', price: 2000, cost: 1200 }
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const [hotel] = put.body.bookings.filter((b) => b.id === 'rhotel1');
  assert.equal(hotel.commission_amount, 3000);
  assert.equal(hotel.commission_due, '2027-04-04', 'fin del servicio + 20 días del proveedor');
  assert.equal(hotel.commission_status, 'Pendiente', 'la vendedora no marca el cobro de la comisión');
  assert.equal((await ctx.partner('PATCH', `/api/trips/${trip.id}/bookings/rhotel1/commission`, { status: 'Cobrada' })).status, 403);
  assert.equal((await ctx.admin('PATCH', `/api/trips/${trip.id}/bookings/rtras01/commission`, { status: 'Cobrada' })).status, 404, 'tarifa neta: sin comisión');
  const fact = await ctx.admin('PATCH', `/api/trips/${trip.id}/bookings/rhotel1/commission`, { status: 'Facturada', invoice: 'A-123' });
  assert.equal(fact.body.booking.commission_status, 'Facturada');
  assert.equal(fact.body.booking.commission_invoice, 'A-123');
  const paid = await ctx.admin('PATCH', `/api/trips/${trip.id}/bookings/rhotel1/commission`, { status: 'Cobrada' });
  assert.equal(paid.body.booking.commission_paid_at, nowCancun().slice(0, 10));
  // La vendedora vuelve a guardar las reservas: el cobro registrado no se pierde.
  const again = await ctx.partner('PUT', `/api/trips/${trip.id}/bookings`, { list: paid.body.record.bookings.list.map((b) => (b.id === 'rhotel1' ? { ...b, commission_status: 'Pendiente' } : b)) });
  assert.equal(again.body.bookings.find((b) => b.id === 'rhotel1').commission_status, 'Cobrada');
  const t = await ctx.store.getRecord('trips', trip.id);
  assert.equal(R.saleProfit(quote, [t]), 3800, 'utilidad = comisión 3,000 + traslado 800');
  const perf = R.performance({ leads: await ctx.store.listRecords('leads'), quotes: await ctx.store.listRecords('quotes'), trips: [t] }, {});
  assert.equal(perf.total.profit, 3800);
});

test('TP-206: metas mensuales y comisión del vendedor (se libera al liquidar)', async (context) => {
  const goals = K.cleanGoals({ base: 'otra', sellers: { 2: { goal: '150,000', pct: '10', months: { '2026-12': 200000, '2026-13': 5, bad: 1 } }, x: { goal: 1 } } });
  assert.equal(goals.base, 'venta');
  assert.deepEqual(goals.sellers, { 2: { goal: 150000, pct: 10, months: { '2026-12': 200000 } } });
  assert.equal(K.goalFor(goals, 2, '2026-11'), 150000);
  assert.equal(K.goalFor(goals, 2, '2026-12'), 200000);
  assert.equal(K.goalFor(goals, 9, '2026-12'), null);

  const ctx = await setup(context);
  assert.equal((await ctx.partner('PUT', '/api/goals', { sellers: {} })).status, 403);
  const saved = await ctx.admin('PUT', '/api/goals', { base: 'venta', sellers: { [ctx.paulinaId]: { goal: 50000, pct: 10 }, [ctx.adminId]: { goal: 80000, pct: '' }, 9999: { goal: 1 } } });
  assert.deepEqual(Object.keys(saved.body.sellers).sort(), [String(ctx.adminId), String(ctx.paulinaId)].sort(), 'solo usuarios que existen');
  const mine = (await ctx.partner('GET', '/api/crm')).body.goals;
  assert.deepEqual(Object.keys(mine.sellers), [String(ctx.paulinaId)], 'la vendedora solo ve su meta');

  const { quote } = await sale(ctx, { accept: 'crm', price: 30000 });
  const trip = (await ctx.partner('POST', '/api/trips', { client_id: quote.client_id, quote_id: quote.id, destination: 'Cancún', start_date: '2027-03-10', end_date: '2027-03-15' })).body.record;
  await ctx.partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [{ id: 'rhotel2', type: 'Hotel', supplier_name: 'HotelDO', price: 30000, cost: 24000 }] });

  const data = async () => ({ quotes: await ctx.store.listRecords('quotes'), leads: await ctx.store.listRecords('leads'), trips: await ctx.store.listRecords('trips') });
  const month = nowCancun().slice(0, 7);
  let s = K.monthSummary(await data(), saved.body, month, ctx.paulinaId);
  assert.equal(s.goal, 50000);
  assert.equal(s.sold, 30000);
  assert.equal(s.progress, 60);
  assert.equal(s.remaining, 20000);
  assert.equal(s.profit, 6000);
  assert.deepEqual(s.commission, { porLiberar: 600, porPagar: 0, pagada: 0, total: 600 }, '10% de $6,000 de utilidad, por liberar');
  assert.equal(K.commissionBySeller(await data(), saved.body, {}).get(ctx.paulinaId).total, 600);

  assert.equal((await ctx.partner('POST', `/api/quotes/${quote.id}/seller-commission`, { action: 'pay' })).status, 403);
  const early = await ctx.admin('POST', `/api/quotes/${quote.id}/seller-commission`, { action: 'pay' });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /liquida/);
  // El cliente liquida (contrato firmado en papel para registrar los pagos).
  await ctx.admin('POST', `/api/quotes/${quote.id}/contract`, { action: 'waive' });
  for (const inst of quote.payment_plan.installments) await ctx.admin('POST', `/api/quotes/${quote.id}/payment-plan/${inst.id}/pay`, { method: 'Transferencia' });
  s = K.monthSummary(await data(), saved.body, month, ctx.paulinaId);
  assert.equal(s.commission.porPagar, 600, 'liquidado: por pagar');
  const pay = await ctx.admin('POST', `/api/quotes/${quote.id}/seller-commission`, { action: 'pay' });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.deepEqual([pay.body.record.seller_commission.status, pay.body.record.seller_commission.amount, pay.body.record.seller_commission.pct], ['Pagada', 600, 10]);
  // Un cambio posterior de costos no altera la comisión ya pagada.
  await ctx.partner('PUT', `/api/trips/${trip.id}/bookings`, { list: [{ id: 'rhotel2', type: 'Hotel', supplier_name: 'HotelDO', price: 30000, cost: 20000 }] });
  s = K.monthSummary(await data(), saved.body, month, ctx.paulinaId);
  assert.deepEqual(s.commission, { porLiberar: 0, porPagar: 0, pagada: 600, total: 600 });
  assert.equal((await ctx.admin('POST', `/api/quotes/${quote.id}/seller-commission`, { action: 'pay' })).status, 400, 'ya pagada');
  assert.equal((await ctx.admin('POST', `/api/quotes/${quote.id}/seller-commission`, { action: 'undo' })).body.record.seller_commission, null);
  s = K.monthSummary(await data(), saved.body, month, ctx.paulinaId);
  assert.equal(s.commission.porPagar, 1000, 'recalculada con la utilidad actual');

  // Meta en utilidad
  const byProfit = K.monthSummary(await data(), { ...saved.body, base: 'utilidad' }, month, ctx.paulinaId);
  assert.equal(byProfit.value, 10000);
  assert.equal(byProfit.progress, 20);
});
