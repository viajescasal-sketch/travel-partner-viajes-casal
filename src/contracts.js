'use strict';

// TP-204: contrato y términos con firma electrónica antes del anticipo.
//  - Al armarse el plan de pagos de una venta, la cotización queda con "contrato pendiente de firma" (si está activo en Configuración › Contrato).
//  - El cliente lo firma en /contrato/<token> (la misma liga de pago): nombre, casilla de aceptación y firma con el dedo o el mouse.
//  - Se guarda copia del texto firmado, la firma, fecha y hora, IP, dispositivo y huella SHA-256 del documento.
//  - Mientras no firme, su liga de pago le pide firmar primero y no deja pagar en línea.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const { DEFAULT_DOCUMENTS } = require('./documents');
const TPContract = require('../public/contrato-core');

const SETTING = 'contract';
const TOKEN_RE = /^[a-f0-9]{40}$/;
const PNG_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/;
const MAX_SIGNATURE = 120 * 1024;
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function createContracts(dataStore, { assignment = null, mailer = null, env = {}, publicDirectory = null } = {}) {
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';
  const settings = async () => TPContract.cleanSettings(await dataStore.getSetting(SETTING));
  const agencyInfo = async () => ({ ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) });

  /** Contrato vigente de la cotización (el firmado, si ya se firmó). */
  async function documentFor(quote) {
    if (quote.contract?.signed?.doc) return { doc: quote.contract.signed.doc, hash: quote.contract.signed.hash };
    const [client, lead, documents, agency, cfg] = await Promise.all([
      dataStore.getRecord('clients', quote.client_id),
      quote.lead_id ? dataStore.getRecord('leads', quote.lead_id) : null,
      dataStore.getSetting('documents'), agencyInfo(), dataStore.getSetting(SETTING)
    ]);
    const doc = TPContract.build({ cfg, documents: { ...DEFAULT_DOCUMENTS, ...(documents || {}) }, agency, quote, client: client || {}, lead, plan: quote.payment_plan });
    return { doc, hash: sha256(TPContract.canonical(doc)) };
  }

  async function findByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const quote = (await dataStore.listRecords('quotes')).find((q) => q.pay_token && q.pay_token.length === token.length && crypto.timingSafeEqual(Buffer.from(q.pay_token), Buffer.from(token)));
    if (!quote || quote.status !== 'Aceptada' || !quote.payment_plan || TPContract.state(quote) === 'none') return null;
    return quote;
  }

  async function publicPayload(quote) {
    const { doc, hash } = await documentFor(quote);
    const client = await dataStore.getRecord('clients', quote.client_id);
    const signed = quote.contract?.signed || null;
    return {
      ok: true,
      state: TPContract.state(quote),
      agency: await agencyInfo(),
      client: { name: client?.name || '' },
      folio: quote.folio,
      doc, hash,
      signed: signed ? { name: signed.name, at: signed.at, ip: signed.ip, device: signed.ua, hash: signed.hash } : null,
      payUrl: `/pagar/${quote.pay_token}`,
      balance: quote.payment_plan.balance
    };
  }

  async function notifyTeam(quote, client, title, body) {
    if (!assignment) return;
    const users = await dataStore.listUsers();
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const ids = new Set([lead?.owner_id, quote.owner_id, ...users.filter((u) => u.active && u.role === 'admin').map((u) => u.id)].filter(Boolean));
    for (const id of ids) {
      const u = users.find((x) => x.id === id && x.active);
      if (u) await assignment.notify(u, { kind: 'contract', leadId: quote.lead_id || null, link: `payplan:${quote.id}`, title: title.slice(0, 200), body: body.slice(0, 300) });
    }
  }

  // ---- Rutas públicas ----
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const signLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  publicRouter.get('/contrato/:token', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      if (!quote) { res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contrato no disponible</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>Este contrato no está disponible</h2><p>Pide a tu Travel Partner una liga nueva.</p></body>'); return; }
      res.sendFile(path.join(publicDirectory, 'contrato.html'));
    } catch (error) { next(error); }
  });

  publicRouter.get('/api/public/contract/:token', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Este contrato no está disponible' }); return; }
      res.set('Cache-Control', 'no-store');
      res.json(await publicPayload(quote));
    } catch (error) { next(error); }
  });

  publicRouter.get('/api/public/contract/:token/signature', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      const id = quote?.contract?.signed?.signature_id;
      const media = id ? await dataStore.getMedia(id) : null;
      if (!media) { res.status(404).end(); return; }
      res.set('Cache-Control', 'private, max-age=3600');
      res.type('image/png').send(media.data);
    } catch (error) { next(error); }
  });

  publicRouter.post('/api/public/contract/:token/sign', signLimiter, async (req, res, next) => {
    try {
      let quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Este contrato no está disponible' }); return; }
      const st = TPContract.state(quote);
      if (st === 'signed') { res.json({ ok: true, already: true, ...(await publicPayload(quote)) }); return; }
      if (st !== 'pending') { res.status(400).json({ ok: false, error: 'Este contrato no requiere firma. Escríbele a tu Travel Partner.' }); return; }
      const b = req.body || {};
      const name = plain(b.name, 120);
      if (name.length < 3) throw new ValidationError('Escribe tu nombre completo');
      if (b.accept !== true) throw new ValidationError('Confirma que leíste y aceptas el contrato');
      const m = PNG_RE.exec(String(b.signature || ''));
      const png = m ? Buffer.from(m[1], 'base64') : null;
      if (!png || png.length < 300 || png.length > MAX_SIGNATURE || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new ValidationError('Dibuja tu firma en el recuadro');
      const { doc, hash } = await documentFor(quote);
      if (String(b.hash || '') !== hash) { res.status(409).json({ ok: false, error: 'El contrato se actualizó mientras lo leías. Revísalo de nuevo y vuelve a firmar.', ...(await publicPayload(quote)) }); return; }
      quote = await dataStore.getRecord('quotes', quote.id); // por si firmó dos veces al mismo tiempo
      if (TPContract.state(quote) !== 'pending') { res.json({ ok: true, already: true, ...(await publicPayload(quote)) }); return; }
      const signatureId = await dataStore.createMedia({ ownerId: null, mime: 'image/png', data: png });
      const signed = { name, at: nowCancun(), ip: String(req.ip || '').slice(0, 64), ua: plain(req.get('user-agent'), 240), hash, signature_id: signatureId, total: quote.payment_plan?.total ?? null, doc };
      const updated = await dataStore.updateRecord('quotes', quote.id, { contract: { ...quote.contract, signed } });
      const client = await dataStore.getRecord('clients', quote.client_id);
      await dataStore.logActivity(null, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: `${quote.folio} · ${client?.name || ''}`, note: `Contrato firmado en línea por ${name} · huella ${hash.slice(0, 12)}…` });
      if (dataStore.insertClientEvent) await dataStore.insertClientEvent({ client_id: quote.client_id, lead_id: quote.lead_id || null, quote_id: quote.id, type: 'note', title: `Contrato firmado · ${quote.folio}`.slice(0, 120), body: `Firmó ${name} el ${signed.at}. Huella SHA-256: ${hash}`, meta: { contract: true }, event_at: signed.at, created_by: null }).catch(() => {});
      await notifyTeam(quote, client, `✍️ ${client?.name || 'El cliente'} firmó su contrato`, `${quote.folio} · ${quote.destination} · ya puede pagar su anticipo`);
      // Copia para el cliente
      let emailed = false;
      if (mailer?.configured && client?.email) {
        const agency = await agencyInfo();
        const url = `${appUrl()}/contrato/${quote.pay_token}`;
        const first = String(client.name || '').trim().split(/\s+/)[0] || '';
        const text = `Hola ${first},\n\nGracias por firmar tu contrato para tu viaje a ${quote.destination} (${quote.folio}).\nPuedes consultarlo, descargarlo y pagar tu anticipo aquí: ${url}\n\nHuella del documento (SHA-256): ${hash}\n\n${agency.name}`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px"><p>Hola ${escapeHtml(first)},</p><p>Gracias por firmar tu contrato para tu viaje a <b>${escapeHtml(quote.destination)}</b> (${escapeHtml(quote.folio)}).</p><p><a href="${escapeHtml(url)}" style="background:#00b8c8;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Ver mi contrato y pagar mi anticipo</a></p><p style="font-size:12px;color:#5b6b78">Huella del documento (SHA-256): ${escapeHtml(hash)}</p><p style="font-size:13px;color:#5b6b78">${escapeHtml(agency.name)}</p></div>`;
        try { await mailer.send({ to: client.email, subject: `Tu contrato firmado · viaje a ${quote.destination}`.slice(0, 180), text, html }); emailed = true; } catch (error) { console.error(`Correo del contrato (${quote.folio}) no enviado:`, error.message); }
      }
      res.json({ ok: true, emailed, ...(await publicPayload(updated)) });
    } catch (error) { next(error); }
  });

  // ---- Rutas con sesión ----
  const apiRouter = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const forbidden = (msg) => Object.assign(new Error(msg), { status: 403, expose: true });

  apiRouter.get('/contract/settings', wrap(async (req, res) => {
    res.json({ ok: true, ...(await settings()), defaults: { title: TPContract.DEFAULT_TITLE, clauses: TPContract.DEFAULT_CLAUSES }, placeholders: TPContract.PLACEHOLDERS });
  }));
  apiRouter.put('/contract/settings', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw forbidden('Acceso no autorizado');
    const saved = TPContract.cleanSettings(req.body || {});
    await dataStore.setSetting(SETTING, saved);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Contrato: ${saved.enabled ? 'firma obligatoria antes del anticipo' : 'firma desactivada'} · ${saved.clauses.split(/\n\s*\n/).length} cláusulas` });
    res.json({ ok: true, ...saved });
  }));

  async function visibleQuote(req) {
    const user = req.session.user;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const quote = data.quotes.find((q) => q.id === id);
    if (!quote || !isVisible(buildScope(user, data), 'quotes', id)) throw Object.assign(new Error('No se encontró la cotización'), { status: 404, expose: true });
    return quote;
  }

  // Vista del contrato para el equipo (antes o después de firmar).
  apiRouter.get('/quotes/:id/contract', wrap(async (req, res) => {
    const quote = await visibleQuote(req);
    if (quote.status !== 'Aceptada' || !quote.payment_plan) throw new ValidationError('El contrato se arma cuando la venta tiene plan de pagos');
    const { doc, hash } = await documentFor(quote);
    res.json({ ok: true, state: TPContract.state(quote), contract: quote.contract || null, doc, hash, url: quote.pay_token ? `${appUrl()}/contrato/${quote.pay_token}` : null });
  }));

  // Pedir firma (vendedor o administrador) o marcarlo como firmado en papel / sin contrato (solo administrador).
  apiRouter.post('/quotes/:id/contract', wrap(async (req, res) => {
    const user = req.session.user;
    if (!canWrite(user, 'quotes')) throw forbidden('Tu rol no permite esta acción');
    const quote = await visibleQuote(req);
    if (quote.status !== 'Aceptada' || !quote.payment_plan) throw new ValidationError('Primero arma el plan de pagos de la venta');
    const action = String(req.body?.action || '');
    const st = TPContract.state(quote);
    if (st === 'signed') throw new ValidationError('El contrato ya está firmado');
    let contract, note;
    if (action === 'require') {
      contract = { required: true, requested_at: nowCancun(), requested_by: user.id };
      note = 'Se pidió al cliente firmar el contrato antes de pagar';
    } else if (action === 'waive') {
      if (user.role !== 'admin') throw forbidden('Solo el administrador puede quitar la firma del contrato');
      const reason = plain(req.body?.reason, 200) || 'Firmado en papel';
      contract = { ...(quote.contract || { required: true }), required: true, waived: { by: user.id, at: nowCancun(), reason } };
      note = `Contrato sin firma en línea: ${reason}`;
    } else throw new ValidationError('Acción no válida');
    const updated = await dataStore.updateRecord('quotes', quote.id, { contract });
    await dataStore.logActivity(user.id, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note });
    res.json({ ok: true, record: updated, state: TPContract.state(updated) });
  }));

  /** Al armarse el plan de pagos de una venta: contrato pendiente de firma (si está activo). */
  async function requireFor(quote) {
    if (!quote || quote.contract || !(await settings()).enabled) return quote;
    return dataStore.updateRecord('quotes', quote.id, { contract: { required: true, requested_at: nowCancun() } });
  }

  return { publicRouter, apiRouter, requireFor, documentFor, settings };
}

module.exports = { createContracts, sha256 };
