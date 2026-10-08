'use strict';

const express = require('express');
const {
  ENTITIES,
  ENTITY_ORDER,
  ValidationError,
  sanitize,
  checkDateRange,
  nowCancun
} = require('./crm-schema');
const { ROLE_LABELS, SELLER_ROLES, canWrite, buildScope, isVisible, filterData } = require('./access');

const CLOSED_STAGES = ['Vendido', 'Perdido'];
const AGENCY_FIELDS = { name: 120, whatsapp: 40, email: 254, website: 200 };
const DEFAULT_AGENCY = {
  name: 'Viajes Bumeran Casal',
  whatsapp: '+52 998 763 6565',
  email: 'casal@viajesbumeran.com',
  website: 'https://viajescasal.com/'
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}
const notFound = (label) => httpError(404, `No se encontró el ${label}`);
const forbidden = (message = 'Tu rol no permite esta acción') => httpError(403, message);

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
  return id;
}

// Traduce errores de integridad de MySQL a mensajes entendibles.
function translateDbError(error) {
  if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') {
    return new ValidationError('El cliente, lead o cotización relacionado no existe');
  }
  return error;
}

function createCrmRouter(dataStore, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');

  const wrap = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(translateDbError(error));
    }
  };

  const log = (req, action, metadata) => dataStore.logActivity(req.session.user.id, action, req, metadata);

  async function loadAll() {
    const data = {};
    for (const entityName of ENTITY_ORDER) data[entityName] = await dataStore.listRecords(entityName);
    return data;
  }

  // Contexto de permisos para la petición actual.
  async function context(req) {
    const user = req.session.user;
    const data = await loadAll();
    const scope = buildScope(user, data);
    const find = (entity, id) => data[entity].find((row) => row.id === Number(id)) || null;
    return {
      user,
      data,
      scope,
      find,
      // Registro visible para el usuario o error 404 (no revela que existe).
      mustSee(entity, id) {
        const record = find(entity, id);
        if (!record || !isVisible(scope, entity, id)) throw notFound(ENTITIES[entity].label);
        return record;
      },
      // Referencia opcional: si viene, debe existir y ser visible.
      checkRef(entity, id) {
        if (id == null) return null;
        const record = find(entity, id);
        if (!record || !isVisible(scope, entity, id)) throw new ValidationError(`El ${ENTITIES[entity].label} relacionado no existe o no está asignado a ti`);
        return record;
      }
    };
  }

  const requireWrite = (entity) => (req, _res, next) => (canWrite(req.session.user, entity) ? next() : next(forbidden()));

  async function assignableOwner(ownerId) {
    const owner = await dataStore.findUserById(ownerId);
    if (!owner || !owner.active || !SELLER_ROLES.includes(owner.role)) {
      throw new ValidationError('El vendedor asignado no existe o no está activo');
    }
    return owner;
  }

  async function nextFolio() {
    const year = nowCancun().slice(0, 4);
    const prefix = `COT-${year}-`;
    const numbers = (await dataStore.listFolios(prefix)).map((folio) => Number(folio.slice(prefix.length)) || 0);
    return `${prefix}${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`;
  }

  async function insertQuote(data, ownerId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await dataStore.insertRecord('quotes', { ...data, folio: await nextFolio() }, ownerId);
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 2) throw error;
      }
    }
    return null;
  }

  // Ajusta etapas y fechas cuando una cotización cambia de estado.
  async function applyQuoteEffects(quote) {
    if (quote.status === 'Aceptada' && !quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: nowCancun() });
    } else if (quote.status !== 'Aceptada' && quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: null });
    }
    if (quote.lead_id) {
      const lead = await dataStore.getRecord('leads', quote.lead_id);
      if (lead) {
        if (quote.status === 'Aceptada' && lead.stage !== 'Vendido') {
          await dataStore.updateRecord('leads', lead.id, { stage: 'Vendido', closed_at: nowCancun() });
        } else if (['Nuevo', 'Calificado'].includes(lead.stage) && quote.status !== 'Rechazada') {
          await dataStore.updateRecord('leads', lead.id, { stage: 'Cotizado' });
        }
      }
    }
    return quote;
  }

  function checkLeadMatchesClient(lead, clientId) {
    if (lead && lead.client_id !== clientId) throw new ValidationError('El lead no pertenece a ese cliente');
  }

  // Datos visibles para el usuario en una sola respuesta.
  router.get('/crm', wrap(async (req, res) => {
    const ctx = await context(req);
    const visible = filterData(ctx.scope, ctx.data);
    const users = ctx.user.role === 'admin'
      ? (await dataStore.listUsers()).map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active }))
      : [{ id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, active: true }];
    res.json({
      ok: true,
      ...visible,
      users,
      roles: ROLE_LABELS,
      settings: { agency: { ...DEFAULT_AGENCY, ...(await dataStore.getSetting('agency') || {}) } },
      serverTime: nowCancun()
    });
  }));

  // ---- Leads: crea o reutiliza el cliente por número de WhatsApp ----
  router.post('/leads', requireWrite('leads'), wrap(async (req, res) => {
    const body = req.body || {};
    const ctx = await context(req);
    // Validar todo antes de guardar nada.
    const preview = sanitize('leads', { ...body, client_id: 1 });
    checkDateRange(preview);
    const clientData = body.client_id ? null : sanitize('clients', body.client);
    if (body.first_followup_at) sanitize('followups', { title: 'x', due_at: body.first_followup_at, type: body.first_followup_type || 'WhatsApp' });

    let ownerId = ctx.user.id;
    if (body.owner_id && ctx.user.role === 'admin') ownerId = (await assignableOwner(parseId(body.owner_id))).id;
    else if (body.owner_id && Number(body.owner_id) !== ctx.user.id) throw forbidden('Solo el administrador puede asignar leads a otro vendedor');

    let client;
    let warning = null;
    if (body.client_id) {
      client = ctx.checkRef('clients', parseId(body.client_id));
    } else {
      client = clientData.phone ? await dataStore.findClientByPhone(clientData.phone) : null;
      if (client) {
        // Cliente existente: avisar si lo atiende otro vendedor.
        const others = new Set(ctx.data.leads.filter((l) => l.client_id === client.id && l.owner_id && l.owner_id !== ownerId).map((l) => l.owner_id));
        if (client.owner_id && client.owner_id !== ownerId) others.add(client.owner_id);
        if (others.size) {
          const names = [];
          for (const id of others) names.push((await dataStore.findUserById(id))?.name || 'otro vendedor');
          warning = `Este cliente ya lo atiende ${names.join(', ')}. El administrador fue notificado.`;
        }
        if (!client.email && clientData.email) client = await dataStore.updateRecord('clients', client.id, { email: clientData.email });
      } else {
        client = await dataStore.insertRecord('clients', clientData, ownerId);
        await log(req, 'crm_clients_create', { id: client.id });
      }
    }
    const data = sanitize('leads', { ...body, client_id: client.id });
    checkDateRange(data);
    if (CLOSED_STAGES.includes(data.stage)) data.closed_at = nowCancun();
    const lead = await dataStore.insertRecord('leads', data, ownerId);
    await log(req, 'crm_leads_create', { id: lead.id, owner_id: ownerId });
    if (warning) await log(req, 'crm_shared_client', { lead_id: lead.id, client_id: client.id });

    let followup = null;
    if (body.first_followup_at) {
      const followupData = sanitize('followups', {
        client_id: client.id,
        lead_id: lead.id,
        type: body.first_followup_type || 'WhatsApp',
        title: `Seguimiento a ${client.name}`,
        details: `Lead ${lead.destination}`,
        due_at: body.first_followup_at
      });
      followup = await dataStore.insertRecord('followups', followupData, ownerId);
    }
    res.status(201).json({ ok: true, record: lead, client, followup, warning });
  }));

  router.patch('/leads/:id', requireWrite('leads'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('leads', id);
    const body = req.body || {};
    const data = sanitize('leads', body, { partial: true });
    if (data.client_id && data.client_id !== current.client_id) ctx.checkRef('clients', data.client_id);
    checkDateRange({ ...current, ...data });
    if (data.stage) {
      if (CLOSED_STAGES.includes(data.stage) && !current.closed_at) data.closed_at = nowCancun();
      if (!CLOSED_STAGES.includes(data.stage)) data.closed_at = null;
    }
    let record = await dataStore.updateRecord('leads', id, data);
    await log(req, 'crm_leads_update', { id });

    if (body.owner_id !== undefined && Number(body.owner_id) !== current.owner_id) {
      if (ctx.user.role !== 'admin') throw forbidden('Solo el administrador puede reasignar leads');
      const owner = await assignableOwner(parseId(body.owner_id));
      await dataStore.transferLeadOwnership(id, owner.id);
      await log(req, 'crm_leads_reassign', { id, from: current.owner_id, to: owner.id });
      record = await dataStore.getRecord('leads', id);
    }
    res.json({ ok: true, record });
  }));

  // ---- Cotizaciones: folio automático y efectos en el lead ----
  router.post('/quotes', requireWrite('quotes'), wrap(async (req, res) => {
    const ctx = await context(req);
    const data = sanitize('quotes', req.body);
    ctx.checkRef('clients', data.client_id);
    const lead = ctx.checkRef('leads', data.lead_id);
    checkLeadMatchesClient(lead, data.client_id);
    let record = await insertQuote(data, lead?.owner_id ?? ctx.user.id);
    record = await applyQuoteEffects(record);
    await log(req, 'crm_quotes_create', { id: record.id, folio: record.folio });
    res.status(201).json({ ok: true, record });
  }));

  router.post('/quotes/:id/duplicate', requireWrite('quotes'), wrap(async (req, res) => {
    const ctx = await context(req);
    const source = ctx.mustSee('quotes', parseId(req.params.id));
    const { id, folio, accepted_at, owner_id, created_at, updated_at, ...rest } = source;
    const record = await insertQuote({ ...rest, status: 'Borrador', accepted_at: null }, owner_id ?? ctx.user.id);
    await log(req, 'crm_quotes_duplicate', { from: source.folio, id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/quotes/:id', requireWrite('quotes'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('quotes', id);
    const data = sanitize('quotes', req.body, { partial: true });
    const clientId = data.client_id ?? current.client_id;
    if (data.client_id !== undefined) ctx.checkRef('clients', data.client_id);
    const lead = data.lead_id !== undefined ? ctx.checkRef('leads', data.lead_id) : (current.lead_id ? ctx.find('leads', current.lead_id) : null);
    checkLeadMatchesClient(lead, clientId);
    let record = await dataStore.updateRecord('quotes', id, data);
    record = await applyQuoteEffects(record);
    await log(req, 'crm_quotes_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Clientes ----
  router.post('/clients', requireWrite('clients'), wrap(async (req, res) => {
    const data = sanitize('clients', req.body);
    const record = await dataStore.insertRecord('clients', data, req.session.user.id);
    await log(req, 'crm_clients_create', { id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/clients/:id', requireWrite('clients'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    ctx.mustSee('clients', id);
    const record = await dataStore.updateRecord('clients', id, sanitize('clients', req.body, { partial: true }));
    await log(req, 'crm_clients_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Viajes ----
  router.post('/trips', requireWrite('trips'), wrap(async (req, res) => {
    const ctx = await context(req);
    const data = sanitize('trips', req.body);
    checkDateRange(data);
    ctx.checkRef('clients', data.client_id);
    const quote = ctx.checkRef('quotes', data.quote_id);
    if (quote && quote.client_id !== data.client_id) throw new ValidationError('La cotización no pertenece a ese cliente');
    const record = await dataStore.insertRecord('trips', data, ctx.user.id);
    await log(req, 'crm_trips_create', { id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/trips/:id', requireWrite('trips'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('trips', id);
    const data = sanitize('trips', req.body, { partial: true });
    checkDateRange({ ...current, ...data });
    if (data.client_id !== undefined) ctx.checkRef('clients', data.client_id);
    if (data.quote_id !== undefined) ctx.checkRef('quotes', data.quote_id);
    const record = await dataStore.updateRecord('trips', id, data);
    await log(req, 'crm_trips_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Seguimientos ----
  router.post('/followups', requireWrite('followups'), wrap(async (req, res) => {
    const ctx = await context(req);
    const data = sanitize('followups', req.body);
    const lead = ctx.checkRef('leads', data.lead_id);
    if (lead && !data.client_id) data.client_id = lead.client_id;
    if (lead && data.client_id !== lead.client_id) throw new ValidationError('El lead no pertenece a ese cliente');
    ctx.checkRef('clients', data.client_id);
    const record = await dataStore.insertRecord('followups', data, lead?.owner_id ?? ctx.user.id);
    await log(req, 'crm_followups_create', { id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/followups/:id', requireWrite('followups'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    ctx.mustSee('followups', id);
    const data = sanitize('followups', req.body, { partial: true });
    if (data.lead_id !== undefined) ctx.checkRef('leads', data.lead_id);
    if (data.client_id !== undefined) ctx.checkRef('clients', data.client_id);
    const record = await dataStore.updateRecord('followups', id, data);
    await log(req, 'crm_followups_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Eliminar: solo administradores ----
  for (const entityName of ENTITY_ORDER) {
    router.delete(`/${entityName}/:id`, adminOnly, wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const deleted = await dataStore.deleteRecord(entityName, id);
      if (!deleted) throw notFound(ENTITIES[entityName].label);
      await log(req, `crm_${entityName}_delete`, { id });
      res.json({ ok: true });
    }));
  }

  // ---- Perfil de la agencia ----
  router.put('/settings/agency', adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const agency = {};
    for (const [field, max] of Object.entries(AGENCY_FIELDS)) {
      const value = String(body[field] ?? '').trim();
      if (value.length > max) throw new ValidationError(`El campo ${field} es demasiado largo`);
      agency[field] = value;
    }
    if (!agency.name) throw new ValidationError('El nombre comercial es obligatorio');
    await dataStore.setSetting('agency', agency);
    await log(req, 'crm_settings_update', { key: 'agency' });
    res.json({ ok: true, agency });
  }));

  return router;
}

module.exports = { createCrmRouter, DEFAULT_AGENCY };
