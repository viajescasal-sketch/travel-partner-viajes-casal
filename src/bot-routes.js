'use strict';

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nowCancun, sanitize, ValidationError } = require('./crm-schema');
const { SELLER_ROLES } = require('./access');
const { summaryFor, diffChanges } = require('./audit');
const { DEFAULT_LEAD_QUESTIONS, normalizeQuestions, scoreQualification } = require('./documents');
const { parseDates, destinationFrom, peopleFrom, budgetFrom, budgetOption, cleanPhone } = require('./bot-intake');

const CLOSED = ['Vendido', 'Perdido'];
const FIELDS = {
  telefono: 40, nombre: 120, producto: 80, destino: 300, ciudadSalida: 160, fechaVuelo: 160, personas: 120, presupuesto: 120,
  tipoHospedaje: 120, tipoExperiencia: 120, preferencias: 600, traslado: 120, etapa: 300, resumen: 3000, conversacion: 120
};
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const addMinutes = (stamp, minutes) => {
  const d = new Date(`${stamp.replace(' ', 'T')}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

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

function createBotRouter(dataStore) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiadas solicitudes' } });

  async function config() {
    return { enabled: false, tokenHash: null, tokenHint: null, ownerId: null, ...(await dataStore.getSetting('botpress') || {}) };
  }
  async function questions() {
    const saved = await dataStore.getSetting('lead_questions');
    return normalizeQuestions(Array.isArray(saved) ? saved : DEFAULT_LEAD_QUESTIONS);
  }
  // Vendedor que recibe los leads del bot: el configurado o el primer vendedor activo.
  async function defaultOwner(cfg) {
    const users = await dataStore.listUsers();
    const chosen = users.find((u) => u.id === Number(cfg.ownerId) && u.active && SELLER_ROLES.includes(u.role));
    return chosen || users.find((u) => u.active && u.role === 'travel_partner') || users.find((u) => u.active && u.role === 'admin');
  }
  async function remember(cfg, result) {
    await dataStore.setSetting('botpress', { ...cfg, lastAt: nowCancun(), lastResult: result });
  }
  const log = (action, metadata) => dataStore.logActivity(null, action, null, metadata);

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
      const qs = await questions();
      const budgetQuestion = qs.find((q) => q.id === 'q_presupuesto');
      const option = budgetOption(data.perPerson, budgetQuestion, data.input.presupuesto);
      const notes = notesFrom(data, now);

      // Cliente: se busca por WhatsApp; si no existe se crea.
      let client = data.phone ? await dataStore.findClientByPhone(data.phone) : null;
      const owner = await defaultOwner(cfg);
      let createdClient = false;
      if (!client) {
        client = await dataStore.insertRecord('clients', sanitize('clients', { name: data.name, phone: data.phone || null }), owner?.id ?? null);
        createdClient = true;
        await log('crm_clients_create', { entity: 'clients', entityId: client.id, summary: client.name, note: 'Bot de WhatsApp' });
      }

      const leads = (await dataStore.listRecords('leads')).filter((l) => l.client_id === client.id && !CLOSED.includes(l.stage));
      const open = leads.sort((a, b) => b.id - a.id)[0] || null;
      const all = { clients: [client], leads: open ? [open] : [] };
      const find = (entity, id) => (all[entity] || []).find((r) => r.id === Number(id)) || null;
      let lead;
      let action;
      if (open) {
        // Lead abierto: se completa con lo nuevo y se agregan las respuestas a las notas.
        const changes = { notes: `${open.notes ? `${open.notes}\n\n` : ''}${notes}`.slice(-4000) };
        if (data.destination && data.destination !== 'Por definir') changes.destination = data.destination;
        if (data.start) { changes.start_date = data.start; changes.end_date = data.end && data.end >= data.start ? data.end : null; }
        if (data.travelers) changes.travelers = data.travelers;
        if (data.budget) changes.budget = data.budget;
        if (option) {
          const answers = { ...(open.qualification?.answers || {}), [budgetQuestion.id]: option };
          changes.qualification = scoreQualification({ answers }, qs);
        }
        lead = await dataStore.updateRecord('leads', open.id, changes);
        action = 'updated';
        const diff = diffChanges('leads', open, lead, find).filter((c) => c.field !== 'notes');
        await log('crm_leads_update', { entity: 'leads', entityId: lead.id, summary: summaryFor('leads', lead, find), ...(diff.length ? { changes: diff } : {}), note: 'Actualizado por el bot de WhatsApp' });
      } else {
        const fields = sanitize('leads', {
          client_id: client.id, destination: data.destination, start_date: data.start, end_date: data.start && data.end ? data.end : null,
          travelers: data.travelers, budget: data.budget, source: 'WhatsApp', stage: 'Nuevo', priority: 'Media', notes,
          ...(option ? { qualification: scoreQualification({ answers: { [budgetQuestion.id]: option } }, qs) } : {})
        });
        lead = await dataStore.insertRecord('leads', fields, client.owner_id && !createdClient ? client.owner_id : owner?.id ?? null);
        action = 'created';
        all.leads = [lead];
        await log('crm_leads_create', { entity: 'leads', entityId: lead.id, summary: summaryFor('leads', lead, find), note: `Creado por el bot de WhatsApp${owner ? ` · asignado a ${owner.name}` : ''}` });
      }

      // Aviso al vendedor: seguimiento para contactar en 15 minutos (si no tiene uno pendiente).
      const pending = (await dataStore.listRecords('followups')).some((f) => f.lead_id === lead.id && !f.done);
      let followup = null;
      if (!pending) {
        followup = await dataStore.insertRecord('followups', sanitize('followups', {
          client_id: client.id, lead_id: lead.id, type: 'WhatsApp', title: `Contactar a ${client.name} (bot de WhatsApp)`,
          details: [data.destination, data.datesText && !data.start ? `Fechas: ${data.datesText}` : null, data.input.presupuesto ? `Presupuesto: ${data.input.presupuesto}` : null].filter(Boolean).join(' · ').slice(0, 2000),
          due_at: addMinutes(now, 15)
        }), lead.owner_id);
        await log('crm_followups_create', { entity: 'followups', entityId: followup.id, summary: followup.title, note: 'Bot de WhatsApp' });
      }
      await remember(cfg, `${action === 'created' ? 'Lead creado' : 'Lead actualizado'} · ${client.name}`);
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
