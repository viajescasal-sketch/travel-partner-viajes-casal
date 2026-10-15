'use strict';

// TP-308 Encuesta y reseña postviaje · TP-309 Programa de referidos.
//  - Un día (configurable) después del regreso se genera la liga privada /encuesta/<token>: se envía por correo al
//    cliente (si tiene) y el vendedor recibe aviso + seguimiento con el WhatsApp listo. Calificación alta → Google/TripAdvisor;
//    baja → aviso al vendedor y al administrador para recuperar al cliente.
//  - Cada cliente tiene un código de referido (VC-XXX000) y una liga /r/<código> con WhatsApp y formulario.
//    El lead referido trae un descuento de bienvenida; cuando se vende, quien refirió gana un crédito para su próximo viaje.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER, ValidationError, nowCancun, sanitize } = require('./crm-schema');
const { buildScope, isVisible, canWrite, SELLER_ROLES } = require('./access');
const { DEFAULT_DOCUMENTS } = require('./documents');
const hooks = require('./hooks');

const DEFAULTS = {
  surveyEnabled: true, delayDays: 1, emailClient: true, tripadvisorUrl: '', goodRating: 4,
  referralEnabled: true, referrerAmount: 500, welcomeAmount: 300
};
const TOKEN_RE = /^[a-f0-9]{40}$/;
const CODE_RE = /^VC-[A-Z0-9]{5,7}$/;
const CODE_IN_TEXT = /\bVC-[A-Z0-9]{5,7}\b/i;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN`;
const plain = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const httpsUrl = (v) => { const s = String(v || '').trim(); return /^https:\/\/[^\s<>"']+$/i.test(s) ? s.slice(0, 300) : ''; };
const intIn = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : def; };

function cleanSettings(saved) {
  const c = { ...DEFAULTS, ...(saved || {}) };
  return {
    surveyEnabled: c.surveyEnabled !== false, delayDays: intIn(c.delayDays, 0, 30, 1), emailClient: c.emailClient !== false,
    tripadvisorUrl: httpsUrl(c.tripadvisorUrl), goodRating: intIn(c.goodRating, 3, 5, 4),
    referralEnabled: c.referralEnabled !== false, referrerAmount: intIn(c.referrerAmount, 0, 100000, 500), welcomeAmount: intIn(c.welcomeAmount, 0, 100000, 300),
    startedAt: c.startedAt || null
  };
}

// Respuestas de la encuesta: 1–5 estrellas (general obligatoria), recomendación 0–10, comentario.
function cleanAnswers(b) {
  const star = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
  const overall = star(b?.overall);
  if (!overall) throw new ValidationError('Elige cuántas estrellas le das a tu viaje');
  const nps = Number(b?.nps);
  return {
    overall, hotel: star(b?.hotel), transfer: star(b?.transfer), partner: star(b?.partner),
    nps: Number.isInteger(nps) && nps >= 0 && nps <= 10 ? nps : null,
    comment: plain(b?.comment, 2000), publish: b?.publish === true
  };
}
// Resumen de encuestas para Reportes.
function surveyStats(trips) {
  const sent = trips.filter((t) => t.survey?.sent_at);
  const answered = sent.filter((t) => t.survey?.answers);
  const avg = (k) => { const v = answered.map((t) => t.survey.answers[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const nps = answered.map((t) => t.survey.answers.nps).filter((x) => x != null);
  const npsScore = nps.length ? Math.round(((nps.filter((x) => x >= 9).length - nps.filter((x) => x <= 6).length) / nps.length) * 100) : null;
  return { sent: sent.length, answered: answered.length, rate: sent.length ? Math.round((answered.length / sent.length) * 100) : 0, overall: avg('overall'), hotel: avg('hotel'), transfer: avg('transfer'), partner: avg('partner'), nps: npsScore, npsCount: nps.length, low: answered.filter((t) => t.survey.answers.overall <= 3).length, reviewClicks: answered.filter((t) => t.survey.review_click_at).length };
}

function createPostventa(dataStore, { assignment = null, mailer = null, env = {}, publicDirectory, now = () => nowCancun() } = {}) {
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';
  async function settings() { return cleanSettings(await dataStore.getSetting('postventa')); }
  async function agency() { return { ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) }; }
  async function documents() { return { ...DEFAULT_DOCUMENTS, ...((await dataStore.getSetting('documents')) || {}) }; }
  const notify = async (user, n) => { if (assignment && user) await assignment.notify(user, n); };
  const admins = async () => (await dataStore.listUsers()).filter((u) => u.active && u.role === 'admin');

  // Vendedor del cliente: el de su lead más reciente, luego el dueño del viaje o del cliente.
  async function sellerFor(clientId, extraIds = []) {
    const leads = (await dataStore.listRecords('leads')).filter((l) => l.client_id === clientId).sort((a, b) => b.id - a.id);
    const client = await dataStore.getRecord('clients', clientId);
    for (const id of [...extraIds, leads[0]?.owner_id, client?.owner_id]) {
      if (!id) continue;
      const u = await dataStore.findUserById(id);
      if (u && u.active && SELLER_ROLES.includes(u.role)) return u;
    }
    return (await admins())[0] || null;
  }

  /* ================= TP-309 · REFERIDOS ================= */
  async function ensureCode(client) {
    if (client.referral?.code) return client;
    const clients = await dataStore.listRecords('clients');
    const used = new Set(clients.map((c) => c.referral?.code).filter(Boolean));
    const base = (String(client.name || '').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase() + 'XXX').slice(0, 3);
    let code;
    do { code = `VC-${base}${Array.from(crypto.randomBytes(3), (b) => ALPHABET[b % ALPHABET.length]).join('')}`; } while (used.has(code));
    return dataStore.updateRecord('clients', client.id, { referral: { ...(client.referral || {}), code, created_at: now(), rewards: client.referral?.rewards || [] } });
  }
  async function findByCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!CODE_RE.test(c)) return null;
    return (await dataStore.listRecords('clients')).find((x) => x.referral?.code === c) || null;
  }
  const referralUrl = (code) => `${appUrl()}/r/${code}`;

  // Liga un lead con quien lo refirió (no a sí mismo; no se cambia si ya tiene uno, salvo que lo pida el equipo).
  async function attachReferral(lead, code, { via = 'liga', userId = null, force = false } = {}) {
    const cfg = await settings();
    if (!cfg.referralEnabled || !lead) return { ok: false, reason: 'Programa de referidos pausado' };
    const referrer = await findByCode(code);
    if (!referrer) return { ok: false, reason: 'No encontramos ese código de referido' };
    if (referrer.id === lead.client_id) return { ok: false, reason: 'Un cliente no puede referirse a sí mismo' };
    if (lead.referral?.referrer_id && !force) return { ok: false, reason: 'El lead ya tiene quien lo refirió' };
    const referral = { code: referrer.referral.code, referrer_id: referrer.id, referrer_name: referrer.name, via, at: now(), by: userId, welcome_amount: cfg.welcomeAmount, welcome_status: cfg.welcomeAmount ? 'Por aplicar' : 'Sin descuento' };
    const updated = await dataStore.updateRecord('leads', lead.id, { referral });
    const client = await dataStore.getRecord('clients', lead.client_id);
    await dataStore.logActivity(userId, 'crm_leads_update', null, { entity: 'leads', entityId: lead.id, summary: `${client?.name || ''} · ${lead.destination}`, note: `Referido por ${referrer.name} (${referral.code}, ${via})` });
    const seller = lead.owner_id ? await dataStore.findUserById(lead.owner_id) : null;
    if (seller && seller.id !== userId) await notify(seller, { kind: 'referral', leadId: lead.id, title: `🤝 Lead referido por ${referrer.name}: ${client?.name || ''}`, body: cfg.welcomeAmount ? `Aplica su descuento de bienvenida de ${money(cfg.welcomeAmount)} en la cotización` : `Código ${referral.code}` });
    if (lead.stage === 'Vendido') await rewardIfSold(updated);
    return { ok: true, lead: updated, referrer };
  }
  async function detachReferral(lead, userId) {
    if (!lead.referral) return lead;
    const updated = await dataStore.updateRecord('leads', lead.id, { referral: null });
    await dataStore.logActivity(userId, 'crm_leads_update', null, { entity: 'leads', entityId: lead.id, summary: lead.destination, note: `Se quitó el referido (${lead.referral.code})` });
    return updated;
  }

  // Al venderse un lead referido, quien lo refirió gana su crédito (una sola vez por lead).
  async function rewardIfSold(lead) {
    const cfg = await settings();
    if (!cfg.referralEnabled || !lead?.referral?.referrer_id || lead.referral.rewarded_at || lead.stage !== 'Vendido') return null;
    const referrer = await dataStore.getRecord('clients', lead.referral.referrer_id);
    if (!referrer) return null;
    const client = await dataStore.getRecord('clients', lead.client_id);
    const reward = { id: `w${Date.now().toString(36)}${lead.id}`, lead_id: lead.id, client_id: lead.client_id, client_name: client?.name || '', destination: lead.destination, amount: cfg.referrerAmount, status: 'Pendiente', created_at: now(), applied_at: null, note: '' };
    const ref = referrer.referral || {};
    await dataStore.updateRecord('clients', referrer.id, { referral: { ...ref, rewards: [...(ref.rewards || []), reward] } });
    await dataStore.updateRecord('leads', lead.id, { referral: { ...lead.referral, rewarded_at: now() } });
    await dataStore.logActivity(null, 'crm_clients_update', null, { entity: 'clients', entityId: referrer.id, summary: referrer.name, note: `Crédito por referido: ${money(reward.amount)} (vendió ${reward.client_name})` });
    const seller = await sellerFor(referrer.id);
    const title = `🎁 ${referrer.name} ganó ${money(reward.amount)} por referir a ${reward.client_name}`;
    const body = 'Avísale y aplícalo en su próximo viaje (Ficha 360 › Referidos)';
    if (seller) await notify(seller, { kind: 'referral', link: `client:${referrer.id}`, title, body });
    for (const a of await admins()) if (a.id !== seller?.id) await notify(a, { kind: 'referral', link: `client:${referrer.id}`, title, body });
    return reward;
  }
  hooks.on(dataStore, 'leadSold', (lead) => rewardIfSold(lead));
  hooks.on(dataStore, 'leadIntake', async ({ lead, notes, ref, channel }) => {
    if (lead.referral) return;
    const code = String(ref || '').trim() || (String(notes || '').match(CODE_IN_TEXT) || [])[0];
    if (code) await attachReferral(lead, code, { via: ref ? `liga (${channel})` : `mensaje (${channel})` });
  });

  /* ================= TP-308 · ENCUESTA POSTVIAJE ================= */
  const newToken = () => crypto.randomBytes(20).toString('hex');
  async function findTripByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    return (await dataStore.listRecords('trips')).find((t) => t.survey?.token && t.survey.token.length === token.length && crypto.timingSafeEqual(Buffer.from(t.survey.token), Buffer.from(token))) || null;
  }
  const surveyUrl = (trip) => `${appUrl()}/encuesta/${trip.survey.token}`;
  async function ensureSurvey(trip) {
    if (trip.survey?.token) return trip;
    return dataStore.updateRecord('trips', trip.id, { survey: { ...(trip.survey || {}), token: newToken(), created_at: now() } });
  }
  function clientMail({ client, trip, url, agencyName, sellerName }) {
    const first = firstName(client.name);
    const subject = `${first ? `${first}, ¿` : '¿'}cómo te fue en ${trip.destination}? Cuéntanos en 1 minuto`;
    const text = `¡Hola ${first || ''}!\n\nEsperamos que hayas disfrutado ${trip.destination}. Nos ayudaría mucho saber cómo te fue: son 4 preguntas y toma menos de un minuto.\n\n${url}\n\nGracias por viajar con ${agencyName}.\n${sellerName ? `— ${sellerName}, tu Travel Partner` : ''}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">
<p style="font-size:16px">¡Hola ${escapeHtml(first)}! 🌴</p>
<p style="font-size:15px">Esperamos que hayas disfrutado <b>${escapeHtml(trip.destination)}</b>. Nos ayudaría mucho saber cómo te fue: son 4 preguntas y toma menos de un minuto.</p>
<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="background:#ff7959;color:#fff;padding:13px 20px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px">⭐ Calificar mi viaje</a></p>
<p style="font-size:14px;color:#6c7b87">Gracias por viajar con ${escapeHtml(agencyName)}.${sellerName ? `<br>— ${escapeHtml(sellerName)}, tu Travel Partner` : ''}</p></div>`;
    return { subject: subject.slice(0, 180), text, html };
  }
  async function sendSurveyEmail(trip, client) {
    if (!mailer?.configured || !client?.email) return false;
    const seller = await sellerFor(trip.client_id, [trip.owner_id]);
    try {
      await mailer.send({ to: client.email, ...clientMail({ client, trip, url: surveyUrl(trip), agencyName: (await agency()).name, sellerName: seller?.name }) });
      return true;
    } catch (error) { console.error('Encuesta postviaje: no se pudo enviar el correo:', error.message); return false; }
  }

  // Lo llama el motor de recordatorios cada 5 minutos (en horario laboral).
  async function runSurveys({ workStart = '09:00', workEnd = '20:00' } = {}) {
    const result = { surveys: 0, emails: 0 };
    let cfg = await settings();
    const current = now();
    if (!cfg.startedAt) { cfg = { ...cfg, startedAt: current }; await dataStore.setSetting('postventa', cfg); }
    if (!cfg.surveyEnabled) return result;
    const hhmm = current.slice(11, 16);
    if (hhmm < workStart || hhmm >= workEnd) return result;
    const today = current.slice(0, 10);
    // Solo viajes que regresan desde que se activó la función (los anteriores no se mandan de golpe).
    const since = addDays(cfg.startedAt.slice(0, 10), -cfg.delayDays);
    const trips = (await dataStore.listRecords('trips')).filter((t) => !t.survey?.sent_at && t.end_date >= since && addDays(t.end_date, cfg.delayDays) <= today && t.status !== 'Cerrado');
    const followups = await dataStore.listRecords('followups');
    for (const t of trips) {
      const trip = await ensureSurvey(t);
      const client = await dataStore.getRecord('clients', trip.client_id);
      if (!client) continue;
      const emailed = cfg.emailClient ? await sendSurveyEmail(trip, client) : false;
      const seller = await sellerFor(trip.client_id, [trip.owner_id]);
      const lead = (await dataStore.listRecords('leads')).filter((l) => l.client_id === client.id).sort((a, b) => b.id - a.id)[0] || null;
      const title = `Enviar encuesta postviaje · ${client.name} · ${trip.destination}`.slice(0, 160);
      if (!followups.some((f) => !f.done && f.client_id === client.id && f.title === title)) {
        const f = await dataStore.insertRecord('followups', sanitize('followups', { client_id: client.id, lead_id: lead?.id || null, type: 'WhatsApp', title, details: `Regresó el ${trip.end_date}. ${emailed ? 'Ya se le envió por correo; ' : ''}Mándale la encuesta por WhatsApp (plantilla “Encuesta postviaje”): ${surveyUrl(trip)}`.slice(0, 2000), due_at: `${today} ${hhmm < workStart ? workStart : hhmm}` }), seller?.id ?? null);
        followups.push(f);
      }
      const status = ['Confirmado', 'Documentación pendiente', 'En viaje'].includes(trip.status) ? { status: 'Solicitar reseña' } : {};
      await dataStore.updateRecord('trips', trip.id, { ...status, survey: { ...trip.survey, sent_at: current, email_sent_at: emailed ? current : null } });
      await dataStore.logActivity(null, 'crm_trips_update', null, { entity: 'trips', entityId: trip.id, summary: `${client.name} · ${trip.destination}`, note: `Encuesta postviaje lista${emailed ? ' y enviada por correo' : ''}` });
      if (seller) await notify(seller, { kind: 'survey', link: `client:${client.id}`, title: `⭐ ${client.name} regresó de ${trip.destination}: envíale la encuesta`, body: emailed ? 'Ya se le mandó por correo; mándasela también por WhatsApp' : 'Mándala por WhatsApp con la plantilla “Encuesta postviaje”' });
      result.surveys += 1; if (emailed) result.emails += 1;
    }
    // Créditos de referidos pendientes (por si una venta no pasó por la cotización).
    if (cfg.referralEnabled) for (const lead of (await dataStore.listRecords('leads')).filter((l) => l.stage === 'Vendido' && l.referral?.referrer_id && !l.referral.rewarded_at)) await rewardIfSold(lead);
    return result;
  }

  async function recordAnswers(trip, answers) {
    const client = await dataStore.getRecord('clients', trip.client_id);
    const at = now();
    const updated = await dataStore.updateRecord('trips', trip.id, { ...(['Solicitar reseña', 'Confirmado', 'Documentación pendiente', 'En viaje'].includes(trip.status) ? { status: 'Postventa' } : {}), survey: { ...trip.survey, answers, answered_at: at, sent_at: trip.survey.sent_at || at } });
    const parts = [answers.hotel && `Hotel ${answers.hotel}★`, answers.transfer && `Traslados ${answers.transfer}★`, answers.partner && `Travel Partner ${answers.partner}★`, answers.nps != null && `Recomendaría: ${answers.nps}/10`].filter(Boolean).join(' · ');
    if (dataStore.insertClientEvent) await dataStore.insertClientEvent({ client_id: trip.client_id, type: 'review', trip_id: trip.id, created_by: null, rating: answers.overall, title: `Encuesta postviaje ${'★'.repeat(answers.overall)}`, body: [parts, answers.comment].filter(Boolean).join('\n') || null, meta: { platform: 'Encuesta postviaje', publish: answers.publish } });
    await dataStore.logActivity(null, 'crm_trips_update', null, { entity: 'trips', entityId: trip.id, summary: `${client?.name || ''} · ${trip.destination}`, note: `Encuesta contestada: ${answers.overall} estrellas` });
    const cfg = await settings();
    const seller = await sellerFor(trip.client_id, [trip.owner_id]);
    const low = answers.overall < cfg.goodRating && answers.overall <= 3;
    const title = low ? `⚠ ${client?.name || 'Cliente'} calificó su viaje con ${answers.overall}★: llámale hoy` : `⭐ ${client?.name || 'Cliente'} calificó su viaje con ${answers.overall}★`;
    const body = answers.comment ? `“${answers.comment.slice(0, 140)}”` : trip.destination;
    if (seller) await notify(seller, { kind: 'survey', link: `client:${trip.client_id}`, title, body, email: low && seller.email ? { subject: title.slice(0, 180), text: `${title}\n\n${parts}\n${answers.comment}\n\n${appUrl()}`, html: `<div style="font-family:Arial;color:#203342"><p><b>${escapeHtml(title)}</b></p><p>${escapeHtml(parts)}</p><p>${escapeHtml(answers.comment)}</p><p><a href="${escapeHtml(appUrl())}">Abrir la plataforma</a></p></div>` } : null });
    if (low) for (const a of await admins()) if (a.id !== seller?.id) await notify(a, { kind: 'survey', link: `client:${trip.client_id}`, title, body });
    return updated;
  }

  /* ================= Rutas públicas ================= */
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const postLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiados intentos. Intenta más tarde.' } });
  const goneHtml = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>${title}</h2><p>${text}</p></body>`;
  const noIndex = (res) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); };

  publicRouter.get('/encuesta/:token', limiter, async (req, res, next) => {
    try {
      noIndex(res);
      if (!(await findTripByToken(req.params.token))) { res.status(404).type('html').send(goneHtml('Esta encuesta ya no está disponible', 'Escríbele a tu Travel Partner por WhatsApp.')); return; }
      res.sendFile('encuesta.html', { root: publicDirectory });
    } catch (error) { next(error); }
  });
  async function surveyPayload(trip) {
    const cfg = await settings();
    const client = await dataStore.getRecord('clients', trip.client_id);
    const docs = await documents();
    const ag = await agency();
    const seller = await sellerFor(trip.client_id, [trip.owner_id]);
    let referral = null;
    if (cfg.referralEnabled && client) {
      const c = await ensureCode(client);
      referral = { code: c.referral.code, url: referralUrl(c.referral.code), referrerAmount: cfg.referrerAmount, welcomeAmount: cfg.welcomeAmount };
    }
    return {
      ok: true, client: { first: firstName(client?.name) }, trip: { destination: trip.destination, start_date: trip.start_date, end_date: trip.end_date },
      seller: seller ? { first: firstName(seller.name) } : null, agency: { name: ag.name }, answered: Boolean(trip.survey?.answers), answers: trip.survey?.answers || null,
      reviews: { google: httpsUrl(docs.reviewsUrl), tripadvisor: cfg.tripadvisorUrl, goodRating: cfg.goodRating }, referral
    };
  }
  publicRouter.get('/api/public/survey/:token', limiter, async (req, res, next) => {
    try {
      noIndex(res);
      const trip = await findTripByToken(req.params.token);
      if (!trip) { res.status(404).json({ ok: false, error: 'Esta encuesta ya no está disponible' }); return; }
      if (!req.session?.user && !trip.survey.opened_at) await dataStore.updateRecord('trips', trip.id, { survey: { ...trip.survey, opened_at: now() } });
      res.json(await surveyPayload(trip));
    } catch (error) { next(error); }
  });
  publicRouter.post('/api/public/survey/:token', postLimiter, async (req, res, next) => {
    try {
      const trip = await findTripByToken(req.params.token);
      if (!trip) { res.status(404).json({ ok: false, error: 'Esta encuesta ya no está disponible' }); return; }
      if (trip.survey.answers) { res.status(409).json({ ok: false, error: 'Ya recibimos tus respuestas. ¡Gracias!' }); return; }
      const answers = cleanAnswers(req.body);
      const updated = await recordAnswers(trip, answers);
      res.status(201).json(await surveyPayload(updated));
    } catch (error) { next(error); }
  });
  publicRouter.post('/api/public/survey/:token/review-click', postLimiter, async (req, res, next) => {
    try {
      const trip = await findTripByToken(req.params.token);
      if (trip?.survey?.answers && !trip.survey.review_click_at) await dataStore.updateRecord('trips', trip.id, { survey: { ...trip.survey, review_click_at: now(), review_platform: plain(req.body?.platform, 20) } });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  publicRouter.get('/r/:code', limiter, async (req, res, next) => {
    try {
      noIndex(res);
      const cfg = await settings();
      if (!cfg.referralEnabled || !(await findByCode(req.params.code))) { res.status(404).type('html').send(goneHtml('Esta invitación ya no está disponible', 'Escríbenos por WhatsApp y con gusto te ayudamos a planear tu viaje.')); return; }
      res.sendFile('referido.html', { root: publicDirectory });
    } catch (error) { next(error); }
  });
  publicRouter.get('/api/public/ref/:code', limiter, async (req, res, next) => {
    try {
      noIndex(res);
      const cfg = await settings();
      const referrer = cfg.referralEnabled ? await findByCode(req.params.code) : null;
      if (!referrer) { res.status(404).json({ ok: false, error: 'Esta invitación ya no está disponible' }); return; }
      const seller = await sellerFor(referrer.id);
      const ag = await agency();
      const docs = await documents();
      const phone = String(seller?.phone || docs.supportWhatsapp || ag.whatsapp || '').replace(/\D/g, '');
      res.json({ ok: true, code: referrer.referral.code, referrer: firstName(referrer.name), welcomeAmount: cfg.welcomeAmount, agency: ag.name, seller: seller ? firstName(seller.name) : null, whatsapp: phone.length === 10 ? `52${phone}` : phone });
    } catch (error) { next(error); }
  });

  /* ================= Rutas con sesión ================= */
  const apiRouter = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
  async function visible(req, entity, write) {
    const user = req.session.user;
    if (write && !canWrite(user, write)) throw fail(403, 'Tu rol no permite esta acción');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const record = data[entity].find((r) => r.id === id);
    if (!record || !isVisible(buildScope(user, data), entity, id)) throw fail(404, 'No se encontró el registro');
    return { record, data };
  }

  apiRouter.get('/postventa/settings', wrap(async (req, res) => { res.json({ ok: true, ...(await settings()) }); }));
  apiRouter.put('/postventa/settings', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw fail(403, 'Solo el administrador');
    const b = req.body || {};
    if (b.tripadvisorUrl && !httpsUrl(b.tripadvisorUrl)) throw new ValidationError('La liga de TripAdvisor debe empezar con https://');
    const saved = cleanSettings({ ...(await settings()), ...b, startedAt: (await settings()).startedAt });
    await dataStore.setSetting('postventa', saved);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Postviaje y referidos: encuesta ${saved.surveyEnabled ? `activa (${saved.delayDays} día${saved.delayDays === 1 ? '' : 's'} después)` : 'pausada'} · referidos ${saved.referralEnabled ? `${money(saved.referrerAmount)} / ${money(saved.welcomeAmount)}` : 'pausados'}` });
    res.json({ ok: true, ...saved });
  }));
  apiRouter.get('/postventa/stats', wrap(async (req, res) => {
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const scope = buildScope(req.session.user, data);
    const trips = data.trips.filter((t) => isVisible(scope, 'trips', t.id));
    const leads = data.leads.filter((l) => isVisible(scope, 'leads', l.id) && l.referral?.referrer_id);
    const clients = data.clients.filter((c) => isVisible(scope, 'clients', c.id));
    const rewards = clients.flatMap((c) => (c.referral?.rewards || []).map((r) => ({ ...r, referrer_id: c.id, referrer_name: c.name })));
    const top = new Map();
    leads.forEach((l) => { const k = l.referral.referrer_id; const t = top.get(k) || { id: k, name: l.referral.referrer_name, leads: 0, sold: 0 }; t.leads += 1; if (l.stage === 'Vendido') t.sold += 1; top.set(k, t); });
    res.json({
      ok: true, survey: surveyStats(trips),
      comments: trips.filter((t) => t.survey?.answers).sort((a, b) => String(b.survey.answered_at).localeCompare(String(a.survey.answered_at))).slice(0, 8).map((t) => ({ trip_id: t.id, client_id: t.client_id, destination: t.destination, at: t.survey.answered_at, overall: t.survey.answers.overall, nps: t.survey.answers.nps, comment: t.survey.answers.comment, publish: t.survey.answers.publish })),
      referrals: { leads: leads.length, sold: leads.filter((l) => l.stage === 'Vendido').length, pending: rewards.filter((r) => r.status === 'Pendiente').reduce((s, r) => s + r.amount, 0), applied: rewards.filter((r) => r.status === 'Aplicado').reduce((s, r) => s + r.amount, 0), top: [...top.values()].sort((a, b) => b.sold - a.sold || b.leads - a.leads).slice(0, 8) }
    });
  }));

  apiRouter.post('/trips/:id/survey', wrap(async (req, res) => {
    const { record } = await visible(req, 'trips', 'trips');
    let trip = await ensureSurvey(record);
    let emailed = false;
    if (req.body?.email) {
      const client = await dataStore.getRecord('clients', trip.client_id);
      if (!client?.email) throw new ValidationError('El cliente no tiene correo registrado');
      if (!mailer?.configured) throw new ValidationError('El correo de la plataforma no está configurado');
      emailed = await sendSurveyEmail(trip, client);
      if (!emailed) throw fail(502, 'No se pudo enviar el correo');
    }
    if (req.body?.markSent || emailed) {
      trip = await dataStore.updateRecord('trips', trip.id, { survey: { ...trip.survey, sent_at: trip.survey.sent_at || now(), ...(emailed ? { email_sent_at: now() } : {}) } });
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: trip.destination, note: emailed ? 'Encuesta postviaje enviada por correo' : 'Encuesta postviaje enviada' });
    }
    res.json({ ok: true, url: surveyUrl(trip), survey: trip.survey, record: trip });
  }));

  apiRouter.get('/clients/:id/referral', wrap(async (req, res) => {
    const { record, data } = await visible(req, 'clients', null);
    const cfg = await settings();
    const client = cfg.referralEnabled && canWrite(req.session.user, 'clients') ? await ensureCode(record) : record;
    const referred = data.leads.filter((l) => l.referral?.referrer_id === client.id).map((l) => ({ id: l.id, client_id: l.client_id, client_name: data.clients.find((c) => c.id === l.client_id)?.name || '', destination: l.destination, stage: l.stage, at: l.referral.at }));
    res.json({ ok: true, enabled: cfg.referralEnabled, code: client.referral?.code || null, url: client.referral?.code ? referralUrl(client.referral.code) : null, rewards: client.referral?.rewards || [], referred, settings: { referrerAmount: cfg.referrerAmount, welcomeAmount: cfg.welcomeAmount } });
  }));
  apiRouter.patch('/clients/:id/referral/rewards/:rid', wrap(async (req, res) => {
    const { record } = await visible(req, 'clients', 'clients');
    const rewards = record.referral?.rewards || [];
    const r = rewards.find((x) => x.id === req.params.rid);
    if (!r) throw fail(404, 'No se encontró el crédito');
    const status = ['Pendiente', 'Aplicado', 'Cancelado'].includes(req.body?.status) ? req.body.status : null;
    if (!status) throw new ValidationError('Estado inválido');
    Object.assign(r, { status, applied_at: status === 'Aplicado' ? now() : null, note: plain(req.body?.note ?? r.note, 300) });
    const updated = await dataStore.updateRecord('clients', record.id, { referral: { ...record.referral, rewards } });
    await dataStore.logActivity(req.session.user.id, 'crm_clients_update', req, { entity: 'clients', entityId: record.id, summary: record.name, note: `Crédito por referido (${r.client_name}): ${status}${r.note ? ` · ${r.note}` : ''}` });
    res.json({ ok: true, rewards: updated.referral.rewards });
  }));
  apiRouter.put('/leads/:id/referral', wrap(async (req, res) => {
    const { record } = await visible(req, 'leads', 'leads');
    const code = String(req.body?.code || '').trim();
    if (!code) { res.json({ ok: true, record: await detachReferral(record, req.session.user.id) }); return; }
    const r = await attachReferral(record, code, { via: 'capturado por el equipo', userId: req.session.user.id, force: true });
    if (!r.ok) throw new ValidationError(r.reason);
    res.json({ ok: true, record: r.lead });
  }));
  apiRouter.patch('/leads/:id/referral', wrap(async (req, res) => {
    const { record } = await visible(req, 'leads', 'leads');
    if (!record.referral) throw fail(404, 'Este lead no es referido');
    const status = ['Por aplicar', 'Aplicado', 'Sin descuento'].includes(req.body?.welcome_status) ? req.body.welcome_status : null;
    if (!status) throw new ValidationError('Estado inválido');
    const updated = await dataStore.updateRecord('leads', record.id, { referral: { ...record.referral, welcome_status: status } });
    await dataStore.logActivity(req.session.user.id, 'crm_leads_update', req, { entity: 'leads', entityId: record.id, summary: record.destination, note: `Descuento de bienvenida: ${status}` });
    res.json({ ok: true, record: updated });
  }));

  return { publicRouter, apiRouter, runSurveys, rewardIfSold, attachReferral, ensureCode, settings };
}

module.exports = { createPostventa, cleanSettings, cleanAnswers, surveyStats, DEFAULTS };
