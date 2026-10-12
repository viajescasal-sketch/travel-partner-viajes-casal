'use strict';

// Liga privada de la cotización para el cliente (TP-110): /cotizacion/<token>.
// Muestra el mismo diseño del PDF sin iniciar sesión y avisa al vendedor cuando el cliente la abre.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nowCancun } = require('./crm-schema');
const { DEFAULT_DOCUMENTS, sellerInfo } = require('./documents');

const TOKEN_RE = /^[a-f0-9]{40}$/;
const REVIEW_GAP_MS = 60 * 60 * 1000; // un aviso por hora como máximo
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };

const newShareToken = () => crypto.randomBytes(20).toString('hex');

function createPublicQuote(dataStore, assignment, { publicDirectory }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

  async function findByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const quotes = await dataStore.listRecords('quotes');
    const quote = quotes.find((q) => q.share_token && q.share_token.length === token.length && crypto.timingSafeEqual(Buffer.from(q.share_token), Buffer.from(token)));
    if (!quote || quote.status === 'Rechazada') return null;
    return quote;
  }

  // Datos del documento; las imágenes se sirven por la misma liga (sin sesión).
  async function payloadFor(quote, token) {
    const client = await dataStore.getRecord('clients', quote.client_id);
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const seller = await dataStore.findUserById(quote.owner_id || lead?.owner_id);
    const { share_token, view_count, viewed_at, reminder_at, sent_at, owner_id, payment_plan, pay_token, ...safeQuote } = quote;
    const payload = {
      ok: true,
      public: true,
      quote: safeQuote,
      client: client ? { id: client.id, name: client.name, phone: null, email: null } : null,
      lead: lead ? { id: lead.id, destination: lead.destination, start_date: lead.start_date, end_date: lead.end_date, travelers: lead.travelers } : null,
      seller: sellerInfo(seller),
      canEdit: false,
      // TP-201: si ya se aceptó, botón para pagar el anticipo / ver su plan de pagos
      payUrl: quote.status === 'Aceptada' && pay_token && payment_plan ? `/pagar/${pay_token}` : null,
      payLabel: payment_plan ? (payment_plan.paid > 0 ? 'Ver mi plan de pagos' : 'Pagar mi anticipo') : null,
      agency: { ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) },
      documents: { ...DEFAULT_DOCUMENTS, ...((await dataStore.getSetting('documents')) || {}) }
    };
    let text = JSON.stringify(payload);
    const ids = new Set();
    text = text.replace(/\/api\/media\/(\d+)/g, (_m, id) => { ids.add(Number(id)); return `/api/public/quote/${token}/media/${id}`; });
    return { body: JSON.parse(text), mediaIds: ids };
  }

  async function notifyView(quote) {
    const now = Date.now();
    const last = quote.viewed_at ? Date.parse(`${String(quote.viewed_at).replace(' ', 'T')}Z`) + 5 * 3600000 : 0;
    await dataStore.updateRecord('quotes', quote.id, { viewed_at: nowCancun(), view_count: (Number(quote.view_count) || 0) + 1 });
    if (now - last < REVIEW_GAP_MS || !assignment) return;
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const client = await dataStore.getRecord('clients', quote.client_id);
    const seller = await dataStore.findUserById(lead?.owner_id || quote.owner_id);
    if (!seller || !seller.active) return;
    const first = !quote.viewed_at;
    await assignment.notify(seller, {
      kind: 'quote_viewed', leadId: quote.lead_id || null, link: `quote:${quote.id}`,
      title: `👀 ${client?.name || 'El cliente'} ${first ? 'abrió' : 'volvió a abrir'} tu cotización`,
      body: `${quote.folio} · ${quote.destination}${first ? ' · buen momento para escribirle' : ''}`
    });
  }

  router.get('/cotizacion/:token', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cotización no disponible</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>Esta cotización ya no está disponible</h2><p>Pide a tu Travel Partner una liga nueva.</p></body>'); return; }
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(publicDirectory, 'documento.html'));
    } catch (error) { next(error); }
  });

  router.get('/api/public/quote/:token', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Esta cotización ya no está disponible' }); return; }
      const { body } = await payloadFor(quote, req.params.token);
      // Las vistas del propio equipo (con sesión) no cuentan.
      if (!req.session?.user) await notifyView(quote);
      res.set('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) { next(error); }
  });

  router.get('/api/public/quote/:token/media/:id', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      const id = Number(req.params.id);
      if (!quote || !Number.isInteger(id)) { res.status(404).end(); return; }
      const { mediaIds } = await payloadFor(quote, req.params.token);
      if (!mediaIds.has(id)) { res.status(404).end(); return; }
      const media = await dataStore.getMedia(id);
      if (!media) { res.status(404).end(); return; }
      res.set('Cache-Control', 'private, max-age=3600');
      res.type(media.mime).send(media.data);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createPublicQuote, newShareToken };
