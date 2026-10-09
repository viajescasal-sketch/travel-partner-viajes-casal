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
const { summaryFor, diffChanges } = require('./audit');
const QRCode = require('qrcode');
const {
  DEFAULT_DOCUMENTS, DEFAULT_LEAD_QUESTIONS, sanitizeDocuments, sanitizeQuestions, normalizeQuestions, scoreQualification,
  checkImage, MAX_IMAGE_BYTES, sellerInfo
} = require('./documents');
const { PROFILE_FIELDS } = require('./data-store');
const { ROLE_SECTIONS, SECTIONS, buildSheets } = require('./export');
const { buildXlsx, buildCsv, zip } = require('./xlsx');

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

  // ---- Bitácora: quién hizo qué y qué cambió ----
  async function finder() {
    const data = await loadAll();
    return (entity, id) => data[entity].find((row) => row.id === Number(id)) || null;
  }
  async function audit(req, action, entity, before, after, extra = {}) {
    const find = await finder();
    const record = after || before;
    const changes = action === 'update' ? diffChanges(entity, before, after, find) : [];
    if (action === 'update' && !changes.length && !extra.note) return;
    await log(req, `crm_${entity}_${action}`, {
      entity,
      entityId: record.id,
      summary: summaryFor(entity, record, find),
      ...(changes.length ? { changes } : {}),
      ...extra
    });
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
  async function applyQuoteEffects(quote, req) {
    if (quote.status === 'Aceptada' && !quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: nowCancun() });
    } else if (quote.status !== 'Aceptada' && quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: null });
    }
    if (quote.lead_id) {
      const lead = await dataStore.getRecord('leads', quote.lead_id);
      if (lead) {
        let updated = null;
        if (quote.status === 'Aceptada' && lead.stage !== 'Vendido') {
          updated = await dataStore.updateRecord('leads', lead.id, { stage: 'Vendido', closed_at: nowCancun(), stage_changed_at: nowCancun(), lost_reason: null });
        } else if (['Nuevo', 'Calificado'].includes(lead.stage) && quote.status !== 'Rechazada') {
          updated = await dataStore.updateRecord('leads', lead.id, { stage: 'Cotizado', stage_changed_at: nowCancun() });
        }
        if (updated && req) await audit(req, 'update', 'leads', lead, updated, { note: `Automático por la cotización ${quote.folio}` });
      }
    }
    return quote;
  }

  function checkLeadMatchesClient(lead, clientId) {
    if (lead && lead.client_id !== clientId) throw new ValidationError('El lead no pertenece a ese cliente');
  }

  async function allSettings() {
    const questions = await dataStore.getSetting('lead_questions');
    return {
      agency: { ...DEFAULT_AGENCY, ...(await dataStore.getSetting('agency') || {}) },
      documents: { ...DEFAULT_DOCUMENTS, ...(await dataStore.getSetting('documents') || {}) },
      leadQuestions: normalizeQuestions(Array.isArray(questions) ? questions : DEFAULT_LEAD_QUESTIONS)
    };
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
      settings: await allSettings(),
      me: sellerInfo(await dataStore.findUserById(ctx.user.id)),
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
        await audit(req, 'create', 'clients', null, client);
      }
    }
    const data = sanitize('leads', { ...body, client_id: client.id });
    checkDateRange(data);
    if (data.qualification) data.qualification = scoreQualification(data.qualification, (await allSettings()).leadQuestions);
    if (CLOSED_STAGES.includes(data.stage)) data.closed_at = nowCancun();
    if (data.stage !== 'Perdido') data.lost_reason = null;
    data.stage_changed_at = nowCancun();
    const lead = await dataStore.insertRecord('leads', data, ownerId);
    await audit(req, 'create', 'leads', null, lead, ownerId !== ctx.user.id ? { note: `Asignado a ${(await dataStore.findUserById(ownerId))?.name || 'otro vendedor'}` } : {});
    if (warning) await log(req, 'crm_shared_client', { entity: 'leads', entityId: lead.id, summary: `${client.name} · ${lead.destination}`, note: warning });

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
      await audit(req, 'create', 'followups', null, followup);
    }
    res.status(201).json({ ok: true, record: lead, client, followup, warning });
  }));

  router.patch('/leads/:id', requireWrite('leads'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('leads', id);
    const body = req.body || {};
    const data = sanitize('leads', body, { partial: true });
    if (data.qualification) data.qualification = scoreQualification(data.qualification, (await allSettings()).leadQuestions);
    if (data.client_id && data.client_id !== current.client_id) ctx.checkRef('clients', data.client_id);
    checkDateRange({ ...current, ...data });
    if (data.stage) {
      if (CLOSED_STAGES.includes(data.stage) && !current.closed_at) data.closed_at = nowCancun();
      if (!CLOSED_STAGES.includes(data.stage)) data.closed_at = null;
      if (data.stage !== current.stage) data.stage_changed_at = nowCancun();
      if (data.stage !== 'Perdido') data.lost_reason = null;
    }
    let record = await dataStore.updateRecord('leads', id, data);
    await audit(req, 'update', 'leads', current, record);

    if (body.owner_id !== undefined && Number(body.owner_id) !== current.owner_id) {
      if (ctx.user.role !== 'admin') throw forbidden('Solo el administrador puede reasignar leads');
      const owner = await assignableOwner(parseId(body.owner_id));
      await dataStore.transferLeadOwnership(id, owner.id);
      const previous = current.owner_id ? await dataStore.findUserById(current.owner_id) : null;
      await log(req, 'crm_leads_reassign', {
        entity: 'leads', entityId: id, summary: summaryFor('leads', current, ctx.find),
        changes: [{ field: 'owner_id', label: 'Vendedor', from: previous?.name || null, to: owner.name }]
      });
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
    record = await applyQuoteEffects(record, req);
    await audit(req, 'create', 'quotes', null, record);
    res.status(201).json({ ok: true, record });
  }));

  router.post('/quotes/:id/duplicate', requireWrite('quotes'), wrap(async (req, res) => {
    const ctx = await context(req);
    const source = ctx.mustSee('quotes', parseId(req.params.id));
    const { id, folio, accepted_at, owner_id, created_at, updated_at, ...rest } = source;
    const record = await insertQuote({ ...rest, status: 'Borrador', accepted_at: null }, owner_id ?? ctx.user.id);
    await audit(req, 'duplicate', 'quotes', null, record, { note: `Copia de ${source.folio}` });
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
    record = await applyQuoteEffects(record, req);
    await audit(req, 'update', 'quotes', current, record);
    res.json({ ok: true, record });
  }));

  // ---- Clientes ----
  router.post('/clients', requireWrite('clients'), wrap(async (req, res) => {
    const data = sanitize('clients', req.body);
    const record = await dataStore.insertRecord('clients', data, req.session.user.id);
    await audit(req, 'create', 'clients', null, record);
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/clients/:id', requireWrite('clients'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('clients', id);
    const record = await dataStore.updateRecord('clients', id, sanitize('clients', req.body, { partial: true }));
    await audit(req, 'update', 'clients', current, record);
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
    await audit(req, 'create', 'trips', null, record);
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
    await audit(req, 'update', 'trips', current, record);
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
    await audit(req, 'create', 'followups', null, record);
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/followups/:id', requireWrite('followups'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('followups', id);
    const data = sanitize('followups', req.body, { partial: true });
    if (data.lead_id !== undefined) ctx.checkRef('leads', data.lead_id);
    if (data.client_id !== undefined) ctx.checkRef('clients', data.client_id);
    const record = await dataStore.updateRecord('followups', id, data);
    await audit(req, 'update', 'followups', current, record);
    res.json({ ok: true, record });
  }));

  // ---- Eliminar: solo administradores ----
  for (const entityName of ENTITY_ORDER) {
    router.delete(`/${entityName}/:id`, adminOnly, wrap(async (req, res) => {
      const id = parseId(req.params.id);
      const data = await loadAll();
      const find = (entity, rid) => data[entity].find((row) => row.id === Number(rid)) || null;
      const before = find(entityName, id);
      if (!before) throw notFound(ENTITIES[entityName].label);
      // Lo que se elimina en cascada con un cliente.
      let note = null;
      if (entityName === 'clients') {
        const count = (entity) => data[entity].filter((row) => row.client_id === id).length;
        const parts = [['leads', 'leads'], ['quotes', 'cotizaciones'], ['trips', 'viajes'], ['followups', 'seguimientos']]
          .map(([entity, label]) => [count(entity), label]).filter(([n]) => n).map(([n, label]) => `${n} ${label}`);
        if (parts.length) note = `También se eliminaron: ${parts.join(', ')}`;
      }
      const summary = summaryFor(entityName, before, find);
      const deleted = await dataStore.deleteRecord(entityName, id);
      if (!deleted) throw notFound(ENTITIES[entityName].label);
      await log(req, `crm_${entityName}_delete`, { entity: entityName, entityId: id, summary, ...(note ? { note } : {}) });
      res.json({ ok: true });
    }));
  }

  // ---- Historial de un registro (visible para quien puede ver el registro) ----
  router.get('/history/:entity/:id', wrap(async (req, res) => {
    const entity = req.params.entity;
    if (!ENTITY_ORDER.includes(entity)) throw notFound('registro');
    const id = parseId(req.params.id);
    const ctx = await context(req);
    ctx.mustSee(entity, id);
    const items = await dataStore.listActivity({ entity, entityId: id, limit: 200 });
    res.json({ ok: true, items });
  }));

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

  // ---- Plantilla PDF y preguntas de calificación ----
  router.put('/settings/documents', adminOnly, wrap(async (req, res) => {
    const documents = sanitizeDocuments(req.body);
    await dataStore.setSetting('documents', documents);
    await log(req, 'crm_settings_update', { key: 'documents', note: 'Plantilla PDF' });
    res.json({ ok: true, documents });
  }));

  router.put('/settings/lead-questions', adminOnly, wrap(async (req, res) => {
    const questions = sanitizeQuestions(req.body);
    await dataStore.setSetting('lead_questions', questions);
    await log(req, 'crm_settings_update', { key: 'lead_questions', note: `Preguntas de calificación (${questions.length})` });
    res.json({ ok: true, questions });
  }));

  // ---- Datos completos para generar los documentos ----
  async function documentContext() {
    const settings = await allSettings();
    return { agency: settings.agency, documents: settings.documents };
  }
  const clientInfo = (c) => (c ? { id: c.id, name: c.name, phone: c.phone, email: c.email } : null);

  router.get('/documents/quote/:id', wrap(async (req, res) => {
    const ctx = await context(req);
    const quote = ctx.mustSee('quotes', parseId(req.params.id));
    const lead = quote.lead_id ? ctx.find('leads', quote.lead_id) : null;
    const seller = await dataStore.findUserById(quote.owner_id || lead?.owner_id || ctx.user.id);
    res.json({
      ok: true,
      quote,
      client: clientInfo(ctx.find('clients', quote.client_id)),
      lead: lead ? { id: lead.id, destination: lead.destination, start_date: lead.start_date, end_date: lead.end_date, travelers: lead.travelers } : null,
      seller: sellerInfo(seller),
      canEdit: canWrite(ctx.user, 'quotes'),
      ...(await documentContext())
    });
  }));

  router.get('/documents/trip/:id', wrap(async (req, res) => {
    const ctx = await context(req);
    const trip = ctx.mustSee('trips', parseId(req.params.id));
    const quote = trip.quote_id ? ctx.find('quotes', trip.quote_id) : null;
    const lead = quote?.lead_id ? ctx.find('leads', quote.lead_id)
      : ctx.data.leads.filter((l) => l.client_id === trip.client_id).sort((a, b) => b.id - a.id)[0] || null;
    let seller = null;
    for (const id of [quote?.owner_id, lead?.owner_id, trip.owner_id, ctx.user.id]) {
      if (!id) continue;
      const user = await dataStore.findUserById(id);
      if (user && SELLER_ROLES.includes(user.role)) { seller = user; break; }
      if (!seller && user) seller = user;
    }
    res.json({
      ok: true,
      trip,
      quote: quote ? { id: quote.id, folio: quote.folio, hotel: quote.hotel, price: quote.price, destination: quote.destination, details: quote.details } : null,
      client: clientInfo(ctx.find('clients', trip.client_id)),
      lead: lead ? { travelers: lead.travelers } : null,
      seller: sellerInfo(seller),
      canEdit: canWrite(ctx.user, 'trips'),
      ...(await documentContext())
    });
  }));

  // ---- Exportar a Excel o CSV (cada quien lo que puede ver) ----
  router.get('/export', wrap(async (req, res) => {
    const ctx = await context(req);
    const allowed = ROLE_SECTIONS[ctx.user.role] || [];
    const sections = [...new Set(String(req.query.sections || '').split(',').map((x) => x.trim()))].filter((x) => allowed.includes(x));
    if (!sections.length) throw allowed.length ? new ValidationError('Elige al menos una sección para exportar') : forbidden();
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
    const range = {};
    for (const key of ['from', 'to']) {
      const value = String(req.query[key] || '');
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('Fecha inválida');
      if (value) range[key] = value;
    }
    const visible = filterData(ctx.scope, ctx.data);
    const users = (await dataStore.listUsers()).map(({ id, name, email, role, active, last_login_at }) => ({ id, name, email, role, active, last_login_at }));
    const sheets = buildSheets(sections, visible, { users: ctx.user.role === 'admin' ? users : users.map(({ id, name }) => ({ id, name })), questions: (await allSettings()).leadQuestions, range });
    const day = nowCancun().slice(0, 10);
    const base = sections.length === 1 ? SECTIONS[sections[0]].toLowerCase() : 'travel-partner';
    let file;
    let filename;
    let type;
    if (format === 'xlsx') {
      file = buildXlsx(sheets);
      filename = `${base}-${day}.xlsx`;
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (sheets.length === 1) {
      file = buildCsv(sheets[0]);
      filename = `${base}-${day}.csv`;
      type = 'text/csv; charset=utf-8';
    } else {
      file = zip(sheets.map((s) => ({ name: `${s.name.toLowerCase()}-${day}.csv`, data: buildCsv(s) })));
      filename = `${base}-csv-${day}.zip`;
      type = 'application/zip';
    }
    await log(req, 'data_export', {
      summary: sheets.map((s) => `${s.name} (${s.rows.length})`).join(', '),
      note: `${format === 'xlsx' ? 'Excel' : 'CSV'}${range.from || range.to ? ` · del ${range.from || 'inicio'} al ${range.to || 'hoy'}` : ''}`
    });
    res.set('Cache-Control', 'no-store');
    res.attachment(filename);
    res.type(type);
    res.send(file);
  }));

  // ---- Imágenes ----
  const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });
  router.post('/media', (req, res, next) => {
    if (req.session.user.role === 'consulta') return next(forbidden());
    return rawImage(req, res, (error) => (error ? next(httpError(413, 'La imagen pesa más de 3 MB')) : next()));
  }, wrap(async (req, res) => {
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    checkImage(mime, req.body);
    const id = await dataStore.createMedia({ ownerId: req.session.user.id, mime, data: req.body });
    res.status(201).json({ ok: true, id, url: `/api/media/${id}` });
  }));

  router.get('/media/:id', wrap(async (req, res) => {
    const media = await dataStore.getMedia(parseId(req.params.id));
    if (!media) throw notFound('archivo');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(media.mime).send(media.data);
  }));

  // Código QR (WhatsApp, reseñas) generado en el servidor.
  router.get('/qr', wrap(async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 500) throw new ValidationError('Texto inválido para el código QR');
    const png = await QRCode.toBuffer(data, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'private, max-age=86400');
    res.type('image/png').send(png);
  }));

  // ---- Perfil para documentos (teléfono, foto y presentación del vendedor) ----
  async function saveProfile(req, userId) {
    const body = req.body || {};
    const fields = {};
    for (const [name, max] of Object.entries(PROFILE_FIELDS)) {
      if (body[name] === undefined) continue;
      const value = String(body[name] ?? '').replace(/\r/g, '').trim();
      if (value.length > max) throw new ValidationError(`El campo ${name} es demasiado largo`);
      if (name === 'website' && value && !/^https?:\/\/\S+$/i.test(value)) throw new ValidationError('El enlace debe empezar con https://');
      fields[name] = value || null;
    }
    if (body.photoMediaId !== undefined) {
      if (body.photoMediaId === null || body.photoMediaId === '') fields.photo_media_id = null;
      else {
        const id = parseId(body.photoMediaId);
        if (!(await dataStore.getMedia(id))) throw new ValidationError('La foto no existe');
        fields.photo_media_id = id;
      }
    }
    await dataStore.updateProfile(userId, fields);
    const user = await dataStore.findUserById(userId);
    await log(req, 'profile_update', { summary: user.name, note: userId === req.session.user.id ? null : 'Editado por el administrador' });
    return sellerInfo(user);
  }
  router.get('/profile', wrap(async (req, res) => {
    res.json({ ok: true, profile: sellerInfo(await dataStore.findUserById(req.session.user.id)) });
  }));
  router.put('/profile', wrap(async (req, res) => {
    res.json({ ok: true, profile: await saveProfile(req, req.session.user.id) });
  }));
  router.get('/profile/:userId', adminOnly, wrap(async (req, res) => {
    const user = await dataStore.findUserById(parseId(req.params.userId));
    if (!user) throw notFound('usuario');
    res.json({ ok: true, profile: sellerInfo(user) });
  }));
  router.put('/profile/:userId', adminOnly, wrap(async (req, res) => {
    const user = await dataStore.findUserById(parseId(req.params.userId));
    if (!user) throw notFound('usuario');
    res.json({ ok: true, profile: await saveProfile(req, user.id) });
  }));

  return router;
}

module.exports = { createCrmRouter, DEFAULT_AGENCY };
