'use strict';

// Liga privada de la cotización para el cliente (TP-110): /cotizacion/<token>.
// Muestra el mismo diseño del PDF sin iniciar sesión y avisa al vendedor cuando el cliente la abre.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nowCancun } = require('./crm-schema');
const { DEFAULT_DOCUMENTS, sellerInfo } = require('./documents');
const { createQuoteEffects, quoteOptions } = require('./quote-effects');

const TOKEN_RE = /^[a-f0-9]{40}$/;
const REVIEW_GAP_MS = 60 * 60 * 1000; // un aviso por hora como máximo
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };

const newShareToken = () => crypto.randomBytes(20).toString('hex');

function createPublicQuote(dataStore, assignment, { publicDirectory, payments = null, env = {} }) {
  const router = express.Router();
  const applyEffects = createQuoteEffects(dataStore, { payments });
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // TP-203: ¿puede el cliente aceptar en línea?
  function acceptState(quote) {
    const today = nowCancun().slice(0, 10);
    const expired = Boolean(quote.valid_until && String(quote.valid_until).slice(0, 10) < today);
    const accepted = quote.status === 'Aceptada';
    return { accepted, expired, canAccept: !accepted && !expired && quote.status !== 'Rechazada' && Number(quote.price) > 0 };
  }
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
    const { share_token, view_count, viewed_at, reminder_at, sent_at, owner_id, payment_plan, pay_token, acceptance, ...safeQuote } = quote;
    const st = acceptState(quote);
    const payload = {
      ok: true,
      public: true,
      quote: safeQuote,
      client: client ? { id: client.id, name: client.name, phone: null, email: null } : null,
      lead: lead ? { id: lead.id, destination: lead.destination, start_date: lead.start_date, end_date: lead.end_date, travelers: lead.travelers } : null,
      seller: sellerInfo(seller),
      canEdit: false,
      // TP-203: aceptación en línea
      accept: { ...st, options: quoteOptions(quote).map(({ index, label, total }) => ({ index, label, total })), acceptedOption: st.accepted ? (acceptance?.option ?? quote.details?.principal ?? 0) : null, acceptedName: st.accepted && acceptance ? acceptance.name : null, acceptedAt: st.accepted ? (acceptance?.at || quote.accepted_at || null) : null },
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

  // TP-203: el cliente elige una opción y acepta la cotización.
  router.post('/api/public/quote/:token/accept', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Esta cotización ya no está disponible' }); return; }
      const payUrlOf = (q) => (q.pay_token && q.payment_plan ? `/pagar/${q.pay_token}` : null);
      const st = acceptState(quote);
      if (st.accepted) { res.json({ ok: true, already: true, payUrl: payUrlOf(quote) }); return; }
      if (st.expired) { res.status(400).json({ ok: false, error: 'La vigencia de esta cotización ya terminó. Escríbele a tu Travel Partner para actualizar precios y disponibilidad.' }); return; }
      if (!st.canAccept) { res.status(400).json({ ok: false, error: 'Esta cotización no se puede aceptar en línea. Escríbele a tu Travel Partner.' }); return; }
      const name = String(req.body?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (name.length < 3) { res.status(400).json({ ok: false, error: 'Escribe tu nombre completo para aceptar' }); return; }
      if (req.body?.terms !== true) { res.status(400).json({ ok: false, error: 'Confirma que aceptas las condiciones de la cotización' }); return; }
      const options = quoteOptions(quote);
      const index = options.length === 1 ? 0 : Number(req.body?.option);
      const option = options.find((o) => o.index === index);
      if (!option) { res.status(400).json({ ok: false, error: 'Elige una de las opciones' }); return; }
      if (!option.single && !(option.total > 0)) { res.status(400).json({ ok: false, error: 'Esa opción no tiene precio. Escríbele a tu Travel Partner.' }); return; }
      const update = { status: 'Aceptada', acceptance: { by: 'cliente', name, option: index, label: option.label, total: option.total, at: nowCancun() } };
      if (!option.single) {
        update.details = { ...quote.details, principal: index };
        update.price = option.total;
        update.hotel = String(option.label).slice(0, 200);
        update.mode = 'Total';
      }
      let updated = await dataStore.updateRecord('quotes', quote.id, update);
      updated = await applyEffects(updated);
      const client = await dataStore.getRecord('clients', quote.client_id);
      const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
      const note = `Aceptada en línea por el cliente (${name})${options.length > 1 ? ` · opción ${index + 1} de ${options.length}: ${option.label}` : ''} · ${money(updated.price)}`;
      await dataStore.logActivity(null, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: `${quote.folio} · ${client?.name || ''}`, note });
      if (assignment) {
        const users = await dataStore.listUsers();
        const ids = new Set([lead?.owner_id, quote.owner_id, ...users.filter((u) => u.active && u.role === 'admin').map((u) => u.id)].filter(Boolean));
        const title = `🎉 ${client?.name || 'El cliente'} aceptó la cotización ${quote.folio}`;
        const lines = [`${options.length > 1 ? `Eligió la opción ${index + 1}: ` : ''}${option.label}`, `Total: ${money(updated.price)}`, `Aceptó: ${name}`, updated.payment_plan ? `Ya puede pagar su anticipo desde la liga (${money(updated.payment_plan.installments[0]?.amount)}).` : ''].filter(Boolean);
        for (const id of ids) {
          const u = users.find((x) => x.id === id && x.active);
          if (!u) continue;
          await assignment.notify(u, {
            kind: 'quote_accepted', leadId: quote.lead_id || null, link: `quote:${quote.id}`, title: title.slice(0, 200), body: `${option.label} · ${money(updated.price)}`,
            email: { subject: title.slice(0, 180), text: `Hola ${u.name},\n\n${title}\n\n${lines.map((l) => `• ${l}`).join('\n')}\n\nConfirma la reserva con el proveedor y dale seguimiento al anticipo.\nAbrir la plataforma: ${appUrl()}`, html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px"><p>Hola ${escapeHtml(u.name)},</p><p><b>${escapeHtml(title)}</b></p><ul style="line-height:1.6">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul><p>Confirma la reserva con el proveedor y dale seguimiento al anticipo.</p><p><a href="${escapeHtml(appUrl())}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>` }
          });
        }
      }
      res.json({ ok: true, payUrl: payUrlOf(updated) });
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
