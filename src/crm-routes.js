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

const CLOSED_STAGES = ['Vendido', 'Perdido'];
const AGENCY_FIELDS = { name: 120, whatsapp: 40, email: 254, website: 200 };
const DEFAULT_AGENCY = {
  name: 'Viajes Bumeran Casal',
  whatsapp: '+52 998 763 6565',
  email: 'casal@viajesbumeran.com',
  website: 'https://viajescasal.com/'
};

function notFound(label) {
  const error = new Error(`No se encontró el ${label}`);
  error.status = 404;
  error.expose = true;
  return error;
}

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
  const canWrite = requireRole('admin', 'travel_partner');
  const adminOnly = requireRole('admin');

  const wrap = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(translateDbError(error));
    }
  };

  const log = (req, action, metadata) => dataStore.logActivity(req.session.user.id, action, req, metadata);

  async function mustGet(entityName, id) {
    const record = await dataStore.getRecord(entityName, id);
    if (!record) throw notFound(ENTITIES[entityName].label);
    return record;
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

  async function checkLeadMatchesClient(leadId, clientId) {
    if (!leadId) return;
    const lead = await mustGet('leads', leadId);
    if (lead.client_id !== clientId) throw new ValidationError('El lead no pertenece a ese cliente');
  }

  // Todo el CRM en una sola respuesta (volumen de una agencia boutique).
  router.get('/crm', wrap(async (_req, res) => {
    const data = {};
    for (const entityName of ENTITY_ORDER) data[entityName] = await dataStore.listRecords(entityName);
    data.settings = { agency: { ...DEFAULT_AGENCY, ...(await dataStore.getSetting('agency') || {}) } };
    data.serverTime = nowCancun();
    res.json({ ok: true, ...data });
  }));

  // ---- Leads: crea o reutiliza el cliente por número de WhatsApp ----
  router.post('/leads', canWrite, wrap(async (req, res) => {
    const body = req.body || {};
    // Validar todo antes de guardar nada.
    const preview = sanitize('leads', { ...body, client_id: 1 });
    checkDateRange(preview);
    const clientData = body.client_id ? null : sanitize('clients', body.client);
    if (body.first_followup_at) sanitize('followups', { title: 'x', due_at: body.first_followup_at, type: body.first_followup_type || 'WhatsApp' });
    let clientId = body.client_id ? parseId(body.client_id) : null;
    let client;
    if (clientId) {
      client = await mustGet('clients', clientId);
    } else {
      client = clientData.phone ? await dataStore.findClientByPhone(clientData.phone) : null;
      if (client) {
        const updates = {};
        if (!client.email && clientData.email) updates.email = clientData.email;
        if (Object.keys(updates).length) client = await dataStore.updateRecord('clients', client.id, updates);
      } else {
        client = await dataStore.insertRecord('clients', clientData, req.session.user.id);
        await log(req, 'crm_clients_create', { id: client.id });
      }
      clientId = client.id;
    }
    const data = sanitize('leads', { ...body, client_id: clientId });
    checkDateRange(data);
    if (CLOSED_STAGES.includes(data.stage)) data.closed_at = nowCancun();
    const lead = await dataStore.insertRecord('leads', data, req.session.user.id);
    await log(req, 'crm_leads_create', { id: lead.id });

    let followup = null;
    if (body.first_followup_at) {
      const followupData = sanitize('followups', {
        client_id: clientId,
        lead_id: lead.id,
        type: body.first_followup_type || 'WhatsApp',
        title: `Seguimiento a ${client.name}`,
        details: `Lead ${lead.destination}`,
        due_at: body.first_followup_at
      });
      followup = await dataStore.insertRecord('followups', followupData, req.session.user.id);
    }
    res.status(201).json({ ok: true, record: lead, client, followup });
  }));

  router.patch('/leads/:id', canWrite, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await mustGet('leads', id);
    const data = sanitize('leads', req.body, { partial: true });
    checkDateRange({ ...current, ...data });
    if (data.stage) {
      if (CLOSED_STAGES.includes(data.stage) && !current.closed_at) data.closed_at = nowCancun();
      if (!CLOSED_STAGES.includes(data.stage)) data.closed_at = null;
    }
    const record = await dataStore.updateRecord('leads', id, data);
    await log(req, 'crm_leads_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Cotizaciones: folio automático y efectos en el lead ----
  router.post('/quotes', canWrite, wrap(async (req, res) => {
    const data = sanitize('quotes', req.body);
    await mustGet('clients', data.client_id);
    await checkLeadMatchesClient(data.lead_id, data.client_id);
    let record = await insertQuote(data, req.session.user.id);
    record = await applyQuoteEffects(record);
    await log(req, 'crm_quotes_create', { id: record.id, folio: record.folio });
    res.status(201).json({ ok: true, record });
  }));

  router.post('/quotes/:id/duplicate', canWrite, wrap(async (req, res) => {
    const source = await mustGet('quotes', parseId(req.params.id));
    const { id, folio, accepted_at, owner_id, created_at, updated_at, ...rest } = source;
    const record = await insertQuote({ ...rest, status: 'Borrador', accepted_at: null }, req.session.user.id);
    await log(req, 'crm_quotes_duplicate', { from: source.folio, id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/quotes/:id', canWrite, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const current = await mustGet('quotes', id);
    const data = sanitize('quotes', req.body, { partial: true });
    await checkLeadMatchesClient(data.lead_id ?? current.lead_id, data.client_id ?? current.client_id);
    let record = await dataStore.updateRecord('quotes', id, data);
    record = await applyQuoteEffects(record);
    await log(req, 'crm_quotes_update', { id });
    res.json({ ok: true, record });
  }));

  // ---- Seguimientos: completa el cliente a partir del lead ----
  async function fillFollowupClient(data) {
    if (data.lead_id && !data.client_id) {
      const lead = await mustGet('leads', data.lead_id);
      data.client_id = lead.client_id;
    }
    return data;
  }

  router.post('/followups', canWrite, wrap(async (req, res) => {
    const data = await fillFollowupClient(sanitize('followups', req.body));
    const record = await dataStore.insertRecord('followups', data, req.session.user.id);
    await log(req, 'crm_followups_create', { id: record.id });
    res.status(201).json({ ok: true, record });
  }));

  // ---- Altas y ediciones genéricas para clientes y viajes ----
  for (const entityName of ['clients', 'trips']) {
    router.post(`/${entityName}`, canWrite, wrap(async (req, res) => {
      const data = sanitize(entityName, req.body);
      checkDateRange(data);
      const record = await dataStore.insertRecord(entityName, data, req.session.user.id);
      await log(req, `crm_${entityName}_create`, { id: record.id });
      res.status(201).json({ ok: true, record });
    }));
  }

  for (const entityName of ['clients', 'trips', 'followups']) {
    router.patch(`/${entityName}/:id`, canWrite, wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const current = await mustGet(entityName, id);
      const data = sanitize(entityName, req.body, { partial: true });
      checkDateRange({ ...current, ...data });
      const record = await dataStore.updateRecord(entityName, id, data);
      await log(req, `crm_${entityName}_update`, { id });
      res.json({ ok: true, record });
    }));
  }

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
