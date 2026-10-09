'use strict';

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nowCancun, ValidationError } = require('./crm-schema');
const { SELLER_ROLES } = require('./access');
const { createLeadIntake } = require('./lead-intake');
const { parseDates, destinationFrom, peopleFrom, budgetFrom, budgetOption, cleanPhone } = require('./bot-intake');

const FIELDS = {
  telefono: 40, nombre: 120, producto: 80, destino: 300, ciudadSalida: 160, fechaVuelo: 160, personas: 120, presupuesto: 120,
  tipoHospedaje: 120, tipoExperiencia: 120, preferencias: 600, traslado: 120, etapa: 300, resumen: 3000, conversacion: 120
};
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Convierte lo que manda el bot en datos de lead.
function interpret(body, today) {
  const input = {};
  for (const [key, max] of Object.entries(FIELDS)) {
    const value = body[key];
    input[key] = value == null ? '' : String(value).replace(/\r/g, '').trim().slice(0, max);
  }
  const datesText = [input.destino, input.fechaVuelo].filter(Boolean).join(' · ');
  const dates = parseDates(input.destino, today) || parseDates(input.fechaVuelo, today);
  const people = peopleFrom(input.personas);
  const perPerson = budgetFrom(input.presupuesto);
  return {
    input,
    datesText,
    phone: cleanPhone(input.telefono),
    name: input.nombre || 'Cliente de WhatsApp',
    destination: destinationFrom(input.destino, dates && !/\d{4}-\d{2}-\d{2}/.test(input.destino) ? dates.matched : null) || input.producto || 'Por definir',
    start: dates?.start || null,
    end: dates?.end || null,
    travelers: people,
    perPerson,
    budget: perPerson ? Math.round(perPerson * (people || 1)) : null
  };
}

function notesFrom(data, stamp) {
  const i = data.input;
  const rows = [
    ['Servicio', i.producto], ['Destino y fechas', i.destino], ['Ciudad de salida', i.ciudadSalida], ['Fechas del vuelo', i.fechaVuelo],
    ['Personas', i.personas], ['Presupuesto por persona', i.presupuesto], ['Hospedaje', i.tipoHospedaje], ['Experiencia', i.tipoExperiencia],
    ['Preferencias', i.preferencias], ['Traslado / auto', i.traslado], ['Motivo y etapa', i.etapa]
  ].filter(([, v]) => v);
  return `🤖 Bot de WhatsApp · ${stamp.slice(0, 16)}\n${rows.map(([k, v]) => `• ${k}: ${v}`).join('\n')}`;
}

function createBotRouter(dataStore, { assignment } = {}) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiadas solicitudes' } });

  async function config() {
    return { enabled: false, tokenHash: null, tokenHint: null, ownerId: null, ...(await dataStore.getSetting('botpress') || {}) };
  }
  async function remember(cfg, result) {
    await dataStore.setSetting('botpress', { ...cfg, lastAt: nowCancun(), lastResult: result });
  }

  router.post('/integrations/botpress/lead', limiter, async (req, res, next) => {
    try {
      const cfg = await config();
      const token = req.get('x-tp-token') || '';
      const valid = cfg.enabled && cfg.tokenHash && token.length >= 20
        && crypto.timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(cfg.tokenHash));
      if (!valid) { res.status(401).json({ ok: false, error: 'Clave inválida o integración desactivada' }); return; }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const now = nowCancun();
      const data = interpret(body, now.slice(0, 10));
      if (!data.phone && !body.nombre) throw new ValidationError('Faltan el teléfono y el nombre del cliente');
      const intake = createLeadIntake(dataStore, assignment);
      const qs = await intake.questions();
      const budgetQuestion = qs.find((q) => q.id === 'q_presupuesto');
      const option = budgetOption(data.perPerson, budgetQuestion, data.input.presupuesto);
      const destination = data.destination && data.destination !== 'Por definir' ? data.destination : null;
      const { action, lead, client, followup, seller, reason } = await intake.intake({
        channel: { label: 'bot de WhatsApp', source: 'WhatsApp', ownerId: cfg.ownerId },
        person: { name: data.name, phone: data.phone, email: null },
        lead: { destination, start: data.start, end: data.end, travelers: data.travelers, budget: data.budget },
        answers: option ? { [budgetQuestion.id]: option } : {},
        notes: notesFrom(data, now),
        followupDetails: [data.destination, data.datesText && !data.start ? `Fechas: ${data.datesText}` : null, data.input.presupuesto ? `Presupuesto: ${data.input.presupuesto}` : null].filter(Boolean).join(' · ')
      });
      if (assignment && seller) {
        const info = { id: lead.id, client: client.name, destination: lead.destination, phone: client.phone, extra: data.input.presupuesto ? `Presupuesto: ${data.input.presupuesto}` : '' };
        if (action === 'created') await assignment.notifyAssigned(seller, [info], { by: `Bot de WhatsApp (${String(reason || '').toLowerCase()})`, req });
        else await assignment.notify(seller, { kind: 'lead_update', title: `${client.name} volvió a escribir al bot`, body: `Lead ${lead.destination} actualizado`, leadId: lead.id });
      }
      await remember(cfg, `${action === 'created' ? 'Lead creado' : 'Lead actualizado'} · ${client.name}${seller ? ` · ${seller.name}` : ''}`);
      res.status(action === 'created' ? 201 : 200).json({ ok: true, action, leadId: lead.id, clientId: client.id, followupId: followup?.id || null });
    } catch (error) {
      next(error);
    }
  });

  return { router, config, hashToken };
}

// Rutas de administración (dentro de la sesión): estado, generar clave y vendedor por defecto.
function createBotAdminRouter(dataStore, bot, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const publicConfig = (cfg) => ({ enabled: Boolean(cfg.enabled), hasToken: Boolean(cfg.tokenHash), tokenHint: cfg.tokenHint, ownerId: cfg.ownerId ?? null, lastAt: cfg.lastAt || null, lastResult: cfg.lastResult || null });

  router.get('/integrations/botpress', adminOnly, wrap(async (req, res) => {
    res.json({ ok: true, ...publicConfig(await bot.config()) });
  }));

  // Genera una clave nueva (la anterior deja de servir). Se muestra una sola vez.
  router.post('/integrations/botpress/token', adminOnly, wrap(async (req, res) => {
    const cfg = await bot.config();
    const token = `tp_${crypto.randomBytes(24).toString('base64url')}`;
    const next = { ...cfg, enabled: true, tokenHash: hashToken(token), tokenHint: token.slice(-4), tokenCreatedAt: nowCancun() };
    await dataStore.setSetting('botpress', next);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: 'Bot de WhatsApp: nueva clave de conexión' });
    res.status(201).json({ ok: true, token, ...publicConfig(next) });
  }));

  router.put('/integrations/botpress', adminOnly, wrap(async (req, res) => {
    const cfg = await bot.config();
    const body = req.body || {};
    const next = { ...cfg };
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled) && Boolean(cfg.tokenHash);
    if (body.ownerId !== undefined) {
      if (body.ownerId === null || body.ownerId === '') next.ownerId = null;
      else {
        const user = await dataStore.findUserById(Number(body.ownerId));
        if (!user || !user.active || !SELLER_ROLES.includes(user.role)) throw new ValidationError('Elige un vendedor activo');
        next.ownerId = user.id;
      }
    }
    await dataStore.setSetting('botpress', next);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: 'Bot de WhatsApp' });
    res.json({ ok: true, ...publicConfig(next) });
  }));

  return router;
}

module.exports = { createBotRouter, createBotAdminRouter, interpret };
