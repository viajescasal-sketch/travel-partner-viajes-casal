'use strict';

// TP-301: itinerario digital del viaje para el celular del cliente: /viaje/<token>
// Día por día (automático con la confirmación y editable), vuelos, hotel con mapa, traslados, vouchers para descargar,
// pagos pendientes y contactos de emergencia. El vendedor activa la liga y sube los vouchers desde el viaje.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const { buildScope, isVisible, canWrite, SELLER_ROLES } = require('./access');
const { DEFAULT_DOCUMENTS, sellerInfo } = require('./documents');

const TOKEN_RE = /^[a-f0-9]{40}$/;
const MAX_VOUCHER = 4 * 1024 * 1024;
const MAX_VOUCHERS = 20;
const VOUCHER_TYPES = {
  'application/pdf': (b) => b.slice(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'
};
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };
const newTripToken = () => crypto.randomBytes(20).toString('hex');
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 120);

function createItinerary(dataStore, { publicDirectory, env = {} } = {}) {
  const appUrl = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

  async function findByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const trips = await dataStore.listRecords('trips');
    return trips.find((t) => t.share_token && t.share_token.length === token.length && crypto.timingSafeEqual(Buffer.from(t.share_token), Buffer.from(token))) || null;
  }

  async function payloadFor(trip) {
    const quote = trip.quote_id ? await dataStore.getRecord('quotes', trip.quote_id) : null;
    const leads = (await dataStore.listRecords('leads')).filter((l) => l.client_id === trip.client_id).sort((a, b) => b.id - a.id);
    const lead = (quote?.lead_id && leads.find((l) => l.id === quote.lead_id)) || leads[0] || null;
    let seller = null;
    for (const id of [quote?.owner_id, lead?.owner_id, trip.owner_id]) {
      if (!id) continue;
      const user = await dataStore.findUserById(id);
      if (user && user.active && SELLER_ROLES.includes(user.role)) { seller = user; break; }
      if (!seller && user) seller = user;
    }
    const client = await dataStore.getRecord('clients', trip.client_id);
    const plan = quote?.status === 'Aceptada' ? quote.payment_plan : null;
    const next = plan?.installments?.find((i) => i.status !== 'pagado') || null;
    const info = sellerInfo(seller);
    return {
      ok: true,
      trip: { id: trip.id, destination: trip.destination, start_date: trip.start_date, end_date: trip.end_date, status: trip.status, confirmation: trip.confirmation || null, itinerary: trip.itinerary || null },
      quote: quote ? { id: quote.id, folio: quote.folio, hotel: quote.hotel, price: quote.price, destination: quote.destination, details: quote.details, status: quote.status, payment_plan: plan } : null,
      client: { name: client?.name || '' },
      lead: lead ? { travelers: lead.travelers } : null,
      seller: info ? { name: info.name, phone: info.phone, photoUrl: info.photoUrl } : null,
      agency: { ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) },
      documents: { ...DEFAULT_DOCUMENTS, ...((await dataStore.getSetting('documents')) || {}) },
      vouchers: (trip.vouchers || []).map((v) => ({ id: v.id, name: v.name, mime: v.mime, size: v.size })),
      payment: plan && plan.balance > 0.5 ? { total: plan.total, paid: plan.paid, balance: plan.balance, next: next ? { label: next.label, amount: Math.round((next.amount - (next.paid || 0)) * 100) / 100, due: next.due } : null, url: quote.pay_token ? `/pagar/${quote.pay_token}` : null } : null,
      today: nowCancun().slice(0, 10)
    };
  }
  // Archivos que la liga puede mostrar: vouchers y fotos usadas en la confirmación / cotización / perfil.
  function allowedMedia(payload) {
    const ids = new Set(payload.vouchers.map((v) => Number(v.id)));
    const text = JSON.stringify([payload.trip.confirmation, payload.quote?.details, payload.seller]);
    for (const m of text.matchAll(/"\w*[mM]edia[iI]d"\s*:\s*"?(\d+)/g)) ids.add(Number(m[1]));
    for (const m of text.matchAll(/\/api\/media\/(\d+)/g)) ids.add(Number(m[1]));
    return ids;
  }

  // ---- Rutas públicas ----
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
  const notFoundPage = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Itinerario no disponible</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>Este itinerario ya no está disponible</h2><p>Pide a tu Travel Partner una liga nueva.</p></body>';

  publicRouter.get('/viaje/:token', limiter, async (req, res, next) => {
    try {
      const trip = await findByToken(req.params.token);
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      if (!trip) { res.status(404).type('html').send(notFoundPage); return; }
      res.sendFile('itinerario.html', { root: publicDirectory });
    } catch (error) { next(error); }
  });
  publicRouter.get('/api/public/trip/:token', limiter, async (req, res, next) => {
    try {
      const trip = await findByToken(req.params.token);
      if (!trip) { res.status(404).json({ ok: false, error: 'Este itinerario ya no está disponible' }); return; }
      const payload = await payloadFor(trip);
      if (!req.session?.user && !trip.viewed_at) await dataStore.updateRecord('trips', trip.id, { viewed_at: nowCancun() });
      res.set('Cache-Control', 'no-store');
      res.json(payload);
    } catch (error) { next(error); }
  });
  publicRouter.get('/api/public/trip/:token/file/:id', limiter, async (req, res, next) => {
    try {
      const trip = await findByToken(req.params.token);
      const id = Number(req.params.id);
      if (!trip || !Number.isInteger(id)) { res.status(404).end(); return; }
      const payload = await payloadFor(trip);
      if (!allowedMedia(payload).has(id)) { res.status(404).end(); return; }
      const media = await dataStore.getMedia(id);
      if (!media) { res.status(404).end(); return; }
      const voucher = (trip.vouchers || []).find((v) => Number(v.id) === id);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      if (voucher) res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(voucher.name).replace(/%20/g, ' ')}"`);
      res.type(media.mime).send(media.data);
    } catch (error) { next(error); }
  });

  // ---- Rutas con sesión ----
  const apiRouter = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function visibleTrip(req) {
    const user = req.session.user;
    if (!canWrite(user, 'trips')) throw Object.assign(new Error('Tu rol no permite esta acción'), { status: 403, expose: true });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const trip = data.trips.find((t) => t.id === id);
    if (!trip || !isVisible(buildScope(user, data), 'trips', id)) throw Object.assign(new Error('No se encontró el viaje'), { status: 404, expose: true });
    return trip;
  }
  const out = (trip, req) => ({ ok: true, url: trip.share_token ? `${appUrl(req)}/viaje/${trip.share_token}` : null, viewed_at: trip.viewed_at || null, vouchers: trip.vouchers || [] });

  apiRouter.post('/trips/:id/share', wrap(async (req, res) => {
    const trip = await visibleTrip(req);
    const enabled = req.body?.enabled !== false;
    const token = enabled ? (trip.share_token || newTripToken()) : null;
    let updated = trip;
    if (token !== trip.share_token) {
      updated = await dataStore.updateRecord('trips', trip.id, { share_token: token, viewed_at: null });
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: trip.destination, note: enabled ? 'Itinerario digital activado' : 'Itinerario digital desactivado' });
    }
    res.json(out(updated, req));
  }));

  const rawVoucher = express.raw({ type: Object.keys(VOUCHER_TYPES), limit: MAX_VOUCHER });
  apiRouter.post('/trips/:id/vouchers', (req, res, next) => rawVoucher(req, res, (error) => (error ? next(Object.assign(new Error('El archivo pesa más de 4 MB'), { status: 413, expose: true })) : next())), wrap(async (req, res) => {
    const trip = await visibleTrip(req);
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const check = VOUCHER_TYPES[mime];
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError('No llegó ningún archivo');
    if (!check || !check(req.body)) throw new ValidationError('Formato no permitido. Sube PDF, JPG, PNG o WebP');
    const list = trip.vouchers || [];
    if (list.length >= MAX_VOUCHERS) throw new ValidationError(`Máximo ${MAX_VOUCHERS} documentos por viaje`);
    let name = cleanName(decodeURIComponent(String(req.get('x-file-name') || ''))) || `Documento ${list.length + 1}`;
    if (!/\.\w{2,4}$/.test(name)) name += mime === 'application/pdf' ? '.pdf' : `.${mime.split('/')[1].replace('jpeg', 'jpg')}`;
    const id = await dataStore.createMedia({ ownerId: req.session.user.id, mime, data: req.body });
    const updated = await dataStore.updateRecord('trips', trip.id, { vouchers: [...list, { id, name, mime, size: req.body.length, at: nowCancun() }] });
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: trip.destination, note: `Documento agregado al itinerario: ${name}` });
    res.status(201).json(out(updated, req));
  }));
  apiRouter.delete('/trips/:id/vouchers/:mediaId', wrap(async (req, res) => {
    const trip = await visibleTrip(req);
    const mediaId = Number(req.params.mediaId);
    const list = trip.vouchers || [];
    const gone = list.find((v) => Number(v.id) === mediaId);
    if (!gone) throw Object.assign(new Error('No se encontró el documento'), { status: 404, expose: true });
    const updated = await dataStore.updateRecord('trips', trip.id, { vouchers: list.filter((v) => Number(v.id) !== mediaId) });
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: trip.destination, note: `Documento quitado del itinerario: ${gone.name}` });
    res.json(out(updated, req));
  }));

  return { publicRouter, apiRouter };
}

module.exports = { createItinerary, newTripToken };
