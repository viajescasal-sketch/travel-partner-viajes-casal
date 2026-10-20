'use strict';

// TP-313: portal del cliente. Una liga privada por cliente (/mi-portal/<token>) que reúne lo que hoy
// recibe por separado: cotizaciones (y aceptarlas), plan de pagos y contrato, sus viajes con itinerario,
// encuesta postviaje y referidos, contacto con su asesor y "pedir nueva cotización".
// Acceso: liga + código de 6 dígitos por correo la primera vez en cada equipo (recordado 90 días).
// Si el cliente no tiene correo, el código le llega al asesor (campanita) para que se lo pase por WhatsApp.
// setting 'client_portal' = { clients: { [clientId]: { token, created_at, created_by, last_access, devices: [{ hash, at, last }], code: { hash, exp, tries, sent: [ms] } } } }

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER, ValidationError, nowCancun, sanitize } = require('./crm-schema');
const { buildScope, isVisible, canWrite, SELLER_ROLES } = require('./access');
const { DEFAULT_DOCUMENTS, sellerInfo } = require('./documents');
const TPContract = require('../public/contrato-core');

const SETTING = 'client_portal';
const TOKEN_RE = /^[a-f0-9]{40}$/;
const COOKIE = 'tp.cp';
const DEVICE_DAYS = 90;
const CODE_MINUTES = 10;
const MAX_DEVICES = 10;
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };
const LIVE_QUOTES = ['Enviada', 'Aceptada'];
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const newToken = () => crypto.randomBytes(20).toString('hex');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}${'•'.repeat(Math.max(u.length - 2, 1))}@${d}` : ''; };
const readCookie = (req, name) => { const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`)); return m ? decodeURIComponent(m.slice(name.length + 1)) : ''; };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function createClientPortal(dataStore, { assignment = null, mailer = null, postventa = null, env = {}, publicDirectory, isProduction = false } = {}) {
  const appUrl = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || (req ? `${req.protocol}://${req.get('host')}` : '');
  // Cambios al setting en fila (dos clientes entrando al mismo tiempo no se pisan).
  let queue = Promise.resolve();
  const read = async () => { const raw = (await dataStore.getSetting(SETTING)) || {}; return { clients: { ...(raw.clients || {}) } }; };
  const update = (fn) => { const run = queue.then(async () => { const s = await read(); const out = await fn(s); await dataStore.setSetting(SETTING, s); return out; }); queue = run.catch(() => {}); return run; };

  async function findByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const s = await read();
    for (const [cid, p] of Object.entries(s.clients)) if (p?.token && safeEq(p.token, token)) return { clientId: Number(cid), portal: p };
    return null;
  }
  const deviceOk = (portal, req) => {
    const raw = readCookie(req, COOKIE);
    if (!raw || !/^[a-f0-9]{48}$/.test(raw)) return false;
    const h = sha(raw);
    const now = Date.now();
    return (portal.devices || []).some((d) => d.hash === h && d.exp > now);
  };

  // Asesor del cliente: el de su lead más reciente, luego el de sus cotizaciones/viajes o el dueño del cliente.
  async function sellerFor(client, data) {
    const leads = data.leads.filter((l) => l.client_id === client.id).sort((a, b) => b.id - a.id);
    const ids = [leads[0]?.owner_id, ...data.quotes.filter((q) => q.client_id === client.id).sort((a, b) => b.id - a.id).map((q) => q.owner_id), client.owner_id];
    let fallback = null;
    for (const id of ids) {
      if (!id) continue;
      const u = await dataStore.findUserById(id);
      if (u && u.active && SELLER_ROLES.includes(u.role)) return u;
      if (!fallback && u) fallback = u;
    }
    return fallback || (await dataStore.listUsers()).find((u) => u.active && u.role === 'admin') || null;
  }
  async function loadAll() {
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    return data;
  }

  // Lo que ve el cliente. Solo cotizaciones enviadas o aceptadas; nunca costos, notas internas ni otros clientes.
  async function payloadFor(clientId, token, req) {
    const data = await loadAll();
    const client = data.clients.find((c) => c.id === clientId);
    if (!client) throw fail(404, 'Este portal ya no está disponible');
    const today = nowCancun().slice(0, 10);
    const seller = await sellerFor(client, data);
    const info = sellerInfo(seller);
    const files = new Set();
    const fileUrl = (id) => { files.add(Number(id)); return `/api/public/portal/${token}/file/${Number(id)}`; };
    const quotes = [];
    for (const q of data.quotes.filter((x) => x.client_id === clientId && LIVE_QUOTES.includes(x.status)).sort((a, b) => b.id - a.id)) {
      const ext = q.details?.external;
      let url;
      if (ext) url = ext.kind === 'link' ? ext.url : fileUrl(ext.media_id);
      else {
        let shareToken = q.share_token;
        if (!shareToken) { shareToken = newToken(); await dataStore.updateRecord('quotes', q.id, { share_token: shareToken }); }
        url = `/cotizacion/${shareToken}`;
      }
      quotes.push({ id: q.id, folio: q.folio, destination: q.destination, hotel: q.hotel, price: q.price, mode: q.mode, status: q.status, valid_until: q.valid_until || '', expired: Boolean(q.valid_until && q.valid_until < today && q.status !== 'Aceptada'), external: Boolean(ext), url, proposals: Array.isArray(q.details?.proposals) ? q.details.proposals.length : 1 });
    }
    const payments = data.quotes.filter((q) => q.client_id === clientId && q.status === 'Aceptada' && q.payment_plan).map((q) => {
      const plan = q.payment_plan;
      const next = (plan.installments || []).find((i) => i.status !== 'pagado') || null;
      const cstate = TPContract.state(q);
      return {
        folio: q.folio, destination: q.destination, total: plan.total, paid: plan.paid, balance: plan.balance,
        installments: (plan.installments || []).map((i) => ({ label: i.label, amount: i.amount, paid: i.paid || 0, due: i.due, status: i.status })),
        next: next ? { label: next.label, amount: Math.round((next.amount - (next.paid || 0)) * 100) / 100, due: next.due, late: Boolean(next.due && next.due < today) } : null,
        url: q.pay_token ? `/pagar/${q.pay_token}` : null,
        contract: { state: cstate, url: cstate !== 'none' && q.pay_token ? `/contrato/${q.pay_token}` : null }
      };
    });
    const trips = data.trips.filter((t) => t.client_id === clientId).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).map((t) => {
      const list = (t.bookings?.list || []).filter((b) => b.status !== 'Cancelada');
      return {
        destination: t.destination, start_date: t.start_date, end_date: t.end_date, status: t.status,
        phase: !t.start_date ? 'próximo' : t.start_date > today ? 'próximo' : t.end_date && t.end_date < today ? 'pasado' : 'en curso',
        days: t.start_date && t.start_date > today ? Math.round((Date.parse(`${t.start_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null,
        itinerary: t.share_token ? `/viaje/${t.share_token}` : null,
        confirmed: list.filter((b) => b.status === 'Confirmada').length, services: list.length,
        survey: t.survey?.token && !t.survey?.answers ? `/encuesta/${t.survey.token}` : null
      };
    });
    let referral = null;
    if (postventa) {
      const cfg = await postventa.settings();
      if (cfg.referralEnabled && data.trips.some((t) => t.client_id === clientId)) {
        const c2 = await postventa.ensureCode(client);
        referral = { code: c2.referral.code, url: `${appUrl(req)}/r/${c2.referral.code}`, referrerAmount: cfg.referrerAmount, welcomeAmount: cfg.welcomeAmount };
      }
    }
    if (info?.photoUrl) { const m = info.photoUrl.match(/\/api\/media\/(\d+)/); if (m) info.photoUrl = fileUrl(m[1]); }
    return {
      ok: true, today,
      client: { name: client.name, first: String(client.name || '').split(/\s+/)[0] },
      seller: info ? { name: info.name, phone: info.phone, email: info.email, photoUrl: info.photoUrl || null, bio: info.bio } : null,
      agency: { ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) },
      documents: { ...DEFAULT_DOCUMENTS, ...((await dataStore.getSetting('documents')) || {}) },
      quotes, payments, trips, referral,
      allowed: [...files]
    };
  }

  async function notifySeller(clientId, n) {
    if (!assignment) return;
    const data = await loadAll();
    const client = data.clients.find((c) => c.id === clientId);
    const seller = client ? await sellerFor(client, data) : null;
    if (seller) await assignment.notify(seller, n);
    return seller;
  }

  /* ================= Equipo ================= */
  const apiRouter = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function teamClient(req, write) {
    const user = req.session.user;
    if (write && !canWrite(user, 'clients')) throw fail(403, 'Tu rol no permite esta acción');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = await loadAll();
    const client = data.clients.find((c) => c.id === id);
    if (!client || !isVisible(buildScope(user, data), 'clients', id)) throw fail(404, 'No se encontró el cliente');
    return client;
  }
  const status = (client, p, req) => ({
    ok: true, enabled: Boolean(p?.token), url: p?.token ? `${appUrl(req)}/mi-portal/${p.token}` : null,
    created_at: p?.created_at || null, last_access: p?.last_access || null,
    devices: (p?.devices || []).filter((d) => d.exp > Date.now()).length,
    email: client.email || null, emailMasked: maskEmail(client.email), mail: Boolean(mailer?.configured)
  });
  apiRouter.get('/clients/:id/portal', wrap(async (req, res) => {
    const client = await teamClient(req, false);
    res.json(status(client, (await read()).clients[String(client.id)], req));
  }));
  // Activa la liga (o genera una nueva: la anterior deja de servir y se cierran los equipos recordados).
  apiRouter.post('/clients/:id/portal', wrap(async (req, res) => {
    const client = await teamClient(req, true);
    const regenerate = req.body?.regenerate === true;
    const p = await update((s) => {
      const cur = s.clients[String(client.id)];
      if (cur?.token && !regenerate) return cur;
      const next = { token: newToken(), created_at: nowCancun(), created_by: req.session.user.id, last_access: cur?.last_access || null, devices: [], code: null };
      s.clients[String(client.id)] = next;
      return next;
    });
    await dataStore.logActivity(req.session.user.id, 'crm_clients_update', req, { entity: 'clients', entityId: client.id, summary: client.name, note: regenerate ? 'Portal del cliente: liga nueva (la anterior dejó de funcionar)' : 'Portal del cliente activado' });
    res.json(status(client, p, req));
  }));
  apiRouter.delete('/clients/:id/portal', wrap(async (req, res) => {
    const client = await teamClient(req, true);
    await update((s) => { delete s.clients[String(client.id)]; });
    await dataStore.logActivity(req.session.user.id, 'crm_clients_update', req, { entity: 'clients', entityId: client.id, summary: client.name, note: 'Portal del cliente desactivado' });
    res.json(status(client, null, req));
  }));

  /* ================= Cliente (sin sesión) ================= */
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
  const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiados intentos. Espera 15 minutos.' } });
  const notFoundPage = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portal no disponible</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>Este portal ya no está disponible</h2><p>Pide a tu Travel Partner una liga nueva.</p></body>';
  const json = express.json({ limit: '20kb' });
  const noStore = (res) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); };
  async function portalOf(req) {
    const found = await findByToken(req.params.token);
    if (!found) throw fail(404, 'Este portal ya no está disponible. Pide a tu Travel Partner una liga nueva.');
    return found;
  }
  async function signedIn(req) {
    const found = await portalOf(req);
    if (!deviceOk(found.portal, req)) throw fail(401, 'Confirma tu código para entrar');
    return found;
  }

  publicRouter.get('/mi-portal/:token', limiter, async (req, res, next) => {
    try {
      noStore(res);
      if (!(await findByToken(req.params.token))) { res.status(404).type('html').send(notFoundPage); return; }
      res.sendFile('portal.html', { root: publicDirectory });
    } catch (error) { next(error); }
  });

  publicRouter.get('/api/public/portal/:token', limiter, async (req, res, next) => {
    try {
      noStore(res);
      const { clientId, portal } = await portalOf(req);
      const client = await dataStore.getRecord('clients', clientId);
      if (!client) throw fail(404, 'Este portal ya no está disponible');
      if (!deviceOk(portal, req)) {
        res.json({ ok: true, needsCode: true, client: { first: String(client.name || '').split(/\s+/)[0] }, emailMasked: maskEmail(client.email), byEmail: Boolean(client.email && mailer?.configured) });
        return;
      }
      const payload = await payloadFor(clientId, req.params.token, req);
      await update((s) => { const p = s.clients[String(clientId)]; if (p) { p.last_access = nowCancun(); const h = sha(readCookie(req, COOKIE)); const d = (p.devices || []).find((x) => x.hash === h); if (d) d.last = nowCancun(); } });
      const { allowed, ...out } = payload;
      res.json(out);
    } catch (error) { next(error); }
  });

  // Código de 6 dígitos: por correo; si no hay correo, al asesor para que lo mande por WhatsApp.
  publicRouter.post('/api/public/portal/:token/code', codeLimiter, async (req, res, next) => {
    try {
      noStore(res);
      const { clientId } = await portalOf(req);
      const client = await dataStore.getRecord('clients', clientId);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const now = Date.now();
      await update((s) => {
        const p = s.clients[String(clientId)];
        if (!p) throw fail(404, 'Este portal ya no está disponible');
        const sent = (p.code?.sent || []).filter((t) => now - t < 60 * 60 * 1000);
        if (sent.length && now - sent[sent.length - 1] < 60 * 1000) throw fail(429, 'Espera un minuto para pedir otro código');
        if (sent.length >= 5) throw fail(429, 'Pediste demasiados códigos. Intenta en una hora o escribe a tu asesor.');
        p.code = { hash: sha(`${clientId}:${code}`), exp: now + CODE_MINUTES * 60 * 1000, tries: 0, sent: [...sent, now] };
      });
      const viaEmail = Boolean(client.email && mailer?.configured);
      if (viaEmail) {
        try {
          await mailer.send({
            to: client.email,
            subject: `Tu código para entrar a tu portal: ${code}`,
            text: `Hola ${client.name},\n\nTu código para entrar a tu portal de Viajes Casal es: ${code}\nVence en ${CODE_MINUTES} minutos.\n\nSi no lo pediste, ignora este correo.`,
            html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:520px"><p>Hola ${escapeHtml(client.name)},</p><p>Tu código para entrar a tu portal de Viajes Casal es:</p><p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#073b66">${code}</p><p style="color:#6c7b87">Vence en ${CODE_MINUTES} minutos. Si no lo pediste, ignora este correo.</p></div>`
          });
        } catch (error) { console.error('Portal del cliente: no se pudo enviar el código:', error.message); throw fail(502, 'No pudimos enviar el correo. Escribe a tu asesor por WhatsApp.'); }
      } else {
        await notifySeller(clientId, { kind: 'portal', link: null, title: `🔐 Código del portal para ${client.name}: ${code}`, body: `Envíaselo por WhatsApp · vence en ${CODE_MINUTES} min` });
      }
      res.json({ ok: true, via: viaEmail ? 'email' : 'asesor', emailMasked: viaEmail ? maskEmail(client.email) : '' });
    } catch (error) { next(error); }
  });

  publicRouter.post('/api/public/portal/:token/verify', codeLimiter, json, async (req, res, next) => {
    try {
      noStore(res);
      const { clientId } = await portalOf(req);
      const code = String(req.body?.code || '').replace(/\D/g, '');
      const device = crypto.randomBytes(24).toString('hex');
      const now = Date.now();
      await update((s) => {
        const p = s.clients[String(clientId)];
        if (!p?.code || p.code.exp < now) throw fail(400, 'El código venció. Pide uno nuevo.');
        if (p.code.tries >= 5) throw fail(400, 'Demasiados intentos. Pide un código nuevo.');
        if (code.length !== 6 || !safeEq(p.code.hash, sha(`${clientId}:${code}`))) { p.code.tries += 1; throw fail(400, 'El código no es correcto'); }
        p.code = { sent: p.code.sent || [] };
        p.devices = [...(p.devices || []).filter((d) => d.exp > now), { hash: sha(device), at: nowCancun(), last: nowCancun(), exp: now + DEVICE_DAYS * 86400000 }].slice(-MAX_DEVICES);
      });
      res.cookie(COOKIE, device, { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: DEVICE_DAYS * 86400000, path: '/' });
      const client = await dataStore.getRecord('clients', clientId);
      await dataStore.logActivity(null, 'crm_clients_update', req, { entity: 'clients', entityId: clientId, summary: client?.name, note: 'Portal del cliente: entró desde un equipo nuevo' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  publicRouter.post('/api/public/portal/:token/logout', limiter, async (req, res, next) => {
    try {
      const { clientId } = await portalOf(req);
      const h = sha(readCookie(req, COOKIE));
      await update((s) => { const p = s.clients[String(clientId)]; if (p) p.devices = (p.devices || []).filter((d) => d.hash !== h); });
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Archivos que el portal puede mostrar: foto del asesor y cotizaciones adjuntas (TP-113).
  publicRouter.get('/api/public/portal/:token/file/:id', limiter, async (req, res, next) => {
    try {
      const { clientId } = await signedIn(req);
      const payload = await payloadFor(clientId, req.params.token, req);
      const id = Number(req.params.id);
      if (!payload.allowed.includes(id)) throw fail(404, 'Archivo no disponible');
      const media = await dataStore.getMedia(id);
      if (!media) throw fail(404, 'Archivo no disponible');
      res.set('Cache-Control', 'private, max-age=3600');
      res.type(media.mime).send(media.data);
    } catch (error) { next(error); }
  });

  // Pedir una nueva cotización: crea un lead nuevo del cliente con su asesor.
  publicRouter.post('/api/public/portal/:token/request', codeLimiter, json, async (req, res, next) => {
    try {
      noStore(res);
      const { clientId } = await signedIn(req);
      const b = req.body || {};
      const destination = str(b.destination, 120);
      if (!destination) throw new ValidationError('¿A dónde quieres viajar?');
      const start = isDate(b.start) ? b.start : null;
      const end = isDate(b.end) && start && b.end >= start ? b.end : null;
      const travelers = Math.min(Math.max(Math.round(Number(b.travelers) || 0), 0), 99) || null;
      const budget = Math.max(Math.round(Number(String(b.budget || '').replace(/[^\d.]/g, '')) || 0), 0) || null;
      const comments = str(b.notes, 1000);
      const data = await loadAll();
      const client = data.clients.find((c) => c.id === clientId);
      const seller = await sellerFor(client, data);
      const now = nowCancun();
      const notes = `🌐 Portal del cliente · ${now.slice(0, 16)}\n• Destino: ${destination}${start ? `\n• Fechas: ${start}${end ? ` a ${end}` : ''}` : ''}${travelers ? `\n• Viajeros: ${travelers}` : ''}${budget ? `\n• Presupuesto: $${budget.toLocaleString('es-MX')}` : ''}${comments ? `\n• Comentarios: ${comments}` : ''}`;
      const fields = sanitize('leads', { client_id: clientId, destination, start_date: start, end_date: end, travelers, budget, source: 'Otro', stage: 'Nuevo', priority: 'Media', notes });
      fields.stage_changed_at = now;
      fields.assigned_at = now;
      const lead = await dataStore.insertRecord('leads', fields, seller?.id ?? null);
      await dataStore.logActivity(null, 'crm_leads_create', req, { entity: 'leads', entityId: lead.id, summary: `${client.name} · ${destination}`, note: `Solicitado por el cliente desde su portal${seller ? ` · asignado a ${seller.name}` : ''}` });
      await dataStore.insertRecord('followups', sanitize('followups', { client_id: clientId, lead_id: lead.id, type: 'WhatsApp', title: `Contactar a ${client.name}: pidió cotización a ${destination}`.slice(0, 160), details: notes.slice(0, 2000), due_at: now.slice(0, 16) }), seller?.id ?? null);
      if (seller && assignment) await assignment.notify(seller, { kind: 'new_lead', leadId: lead.id, title: `🌐 ${client.name} pidió una cotización desde su portal`, body: `${destination}${start ? ` · ${start}` : ''}${travelers ? ` · ${travelers} viajeros` : ''}`, email: mailer?.configured && seller.email ? { subject: `${client.name} pidió una cotización: ${destination}`, text: `${notes}\n\nAbrir la plataforma: ${appUrl(req)}`, html: `<pre style="font-family:Arial,Helvetica,sans-serif">${escapeHtml(notes)}</pre><p><a href="${escapeHtml(appUrl(req))}">Abrir la plataforma</a></p>` } : null });
      res.status(201).json({ ok: true, seller: seller?.name || null });
    } catch (error) { next(error); }
  });

  return { apiRouter, publicRouter, findByToken };
}

module.exports = { createClientPortal, SETTING };
