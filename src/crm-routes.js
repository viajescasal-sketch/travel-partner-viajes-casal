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
const { cleanConfig: reminderConfig } = require('./reminders');
const { scoreLead, cleanScoring, sanitizeScoring, RESPONSES } = require('./scoring');
const { newShareToken } = require('./public-quote');
const { createQuoteEffects } = require('./quote-effects');
const { phoneKey } = require('./data-store');
const TPTrip = require('../public/viaje-core');
const hooks = require('./hooks');
const { STAGES: TEMPLATE_STAGES, VARIABLES: TEMPLATE_VARIABLES, DEFAULT_TEMPLATES, sanitizeTemplates, readTemplates } = require('./templates');
const { goalsFor } = require('./commissions');
const TPFields = require('../public/campos-core');
const { prefsFor } = require('./preferencias');

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

function createCrmRouter(dataStore, { requireRole, assignment = null, payments = null }) {
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

  // TP-106: al reasignar un lead que aún no se contacta, el nuevo vendedor tiene su propio tiempo.
  async function restartContactClock(lead) {
    if (lead.contacted_at || lead.stage !== 'Nuevo') return;
    await dataStore.updateRecord('leads', lead.id, { assigned_at: nowCancun(), contact_alert_at: null, contact_escalated_at: null });
  }
  async function markContacted(leadId) {
    const lead = leadId ? await dataStore.getRecord('leads', leadId) : null;
    if (!lead || lead.contacted_at) return lead;
    return dataStore.updateRecord('leads', lead.id, { contacted_at: nowCancun() });
  }

  // Ajusta etapas y fechas cuando una cotización cambia de estado (src/quote-effects.js).
  const quoteEffects = createQuoteEffects(dataStore, {
    payments,
    onLeadUpdate: async (lead, updated, quote, req) => { if (req) await audit(req, 'update', 'leads', lead, updated, { note: `Automático por la cotización ${quote.folio}` }); }
  });
  const applyQuoteEffects = (quote, req) => quoteEffects(quote, req);

  function checkLeadMatchesClient(lead, clientId) {
    if (lead && lead.client_id !== clientId) throw new ValidationError('El lead no pertenece a ese cliente');
  }

  // TP-306: campos personalizables. undefined = no se tocan; si vienen, se validan contra las definiciones.
  const customDefs = async () => TPFields.cleanDefs(await dataStore.getSetting('custom_fields'));
  async function customFor(entity, input, previous) {
    if (input === undefined) return undefined;
    if (input !== null && typeof input !== 'object') throw new ValidationError('Campos personalizados inválidos');
    const { values, missing } = TPFields.cleanValues((await customDefs())[entity], input || {}, previous || {});
    if (missing.length) throw new ValidationError(`Completa ${missing.length === 1 ? 'el campo' : 'los campos'}: ${missing.join(', ')}`);
    return values;
  }

  async function allSettings() {
    const questions = await dataStore.getSetting('lead_questions');
    return {
      agency: { ...DEFAULT_AGENCY, ...(await dataStore.getSetting('agency') || {}) },
      documents: { ...DEFAULT_DOCUMENTS, ...(await dataStore.getSetting('documents') || {}) },
      leadQuestions: normalizeQuestions(Array.isArray(questions) ? questions : DEFAULT_LEAD_QUESTIONS),
      scoring: cleanScoring(await dataStore.getSetting('lead_scoring')),
      customFields: await customDefs(), // TP-306
      payments: payments ? { ...(await payments.settings()), mercadoPago: payments.mercadoPago.configured } : null,
      reminders: (({ enabled, contactHours, quoteHours, workStart, workEnd }) => ({ enabled, contactHours, quoteHours, workStart, workEnd }))(reminderConfig(await dataStore.getSetting('reminders')))
    };
  }

  // Datos visibles para el usuario en una sola respuesta.
  // TP-109: puntaje automático de cada lead; la prioridad se guarda sola cuando cambia.
  async function refreshScores(data) {
    const config = cleanScoring(await dataStore.getSetting('lead_scoring'));
    const today = nowCancun().slice(0, 10);
    const byLead = new Map();
    data.quotes.forEach((q) => { if (q.lead_id) { if (!byLead.has(q.lead_id)) byLead.set(q.lead_id, []); byLead.get(q.lead_id).push(q); } });
    for (const lead of data.leads) {
      const auto = scoreLead(lead, { today, quotes: byLead.get(lead.id) || [], config });
      lead.auto = auto;
      if (CLOSED_STAGES.includes(lead.stage)) continue;
      if (lead.score !== auto.score || lead.priority !== auto.priority) {
        await dataStore.updateRecord('leads', lead.id, { score: auto.score, priority: auto.priority });
        lead.score = auto.score;
        lead.priority = auto.priority;
      }
    }
  }

  router.get('/crm', wrap(async (req, res) => {
    const ctx = await context(req);
    await refreshScores(ctx.data);
    const visible = filterData(ctx.scope, ctx.data);
    const prefs = await prefsFor(dataStore, ctx.user.id); // avatares y recorrido guiado
    const photo = (u) => (u?.photo_media_id ? `/api/media/${u.photo_media_id}` : null);
    const users = ctx.user.role === 'admin'
      ? (await dataStore.listUsers()).map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active, photoUrl: photo(u), avatar: prefs.avatars[String(u.id)] || null }))
      : [{ id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, active: true, photoUrl: photo(await dataStore.findUserById(ctx.user.id)), avatar: prefs.avatar }];
    res.json({
      ok: true,
      ...visible,
      users,
      roles: ROLE_LABELS,
      settings: await allSettings(),
      me: sellerInfo(await dataStore.findUserById(ctx.user.id)),
      suppliers: dataStore.listSuppliers ? await dataStore.listSuppliers() : [], // TP-305
      goals: await goalsFor(dataStore, ctx.user), // TP-206
      prefs: { avatar: prefs.avatar, tour: prefs.tour },
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
    const leadCustom = await customFor('leads', body.custom, null); // TP-306
    const clientCustom = clientData ? await customFor('clients', body.client?.custom, null) : undefined;
    if (clientData && clientCustom) clientData.custom = clientCustom;

    let ownerId = ctx.user.id;
    let autoReason = null;
    if (body.owner_id === 'auto' && ctx.user.role === 'admin' && assignment) {
      // Automático: el mismo reparto que el bot y el formulario (turnos o fijo).
      const pick = await assignment.pickOwner({ client: body.client_id ? ctx.find('clients', body.client_id) : null });
      if (pick.user) { ownerId = pick.user.id; autoReason = pick.reason; }
    } else if (body.owner_id && ctx.user.role === 'admin') ownerId = (await assignableOwner(parseId(body.owner_id))).id;
    else if (body.owner_id && Number(body.owner_id) !== ctx.user.id) throw forbidden('Solo el administrador puede asignar leads a otro vendedor');

    let client;
    let warning = null;
    if (body.client_id) {
      client = ctx.checkRef('clients', parseId(body.client_id));
    } else {
      client = clientData.phone ? await dataStore.findClientByPhone(clientData.phone) : null;
      // TP-111: si no coincide el WhatsApp, se busca por correo para no duplicar al cliente.
      if (!client && clientData.email) client = ctx.data.clients.find((c) => String(c.email || '').toLowerCase() === clientData.email.toLowerCase()) || null;
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
    else if (!String(data.lost_reason || '').trim()) throw new ValidationError('Elige el motivo de pérdida');
    data.stage_changed_at = nowCancun();
    if (leadCustom) data.custom = leadCustom;
    // TP-106: si lo registra su propio vendedor, ya está en contacto; si se lo asignaron, corre el tiempo del primer contacto.
    if (ownerId === ctx.user.id || data.stage !== 'Nuevo') data.contacted_at = nowCancun();
    else data.assigned_at = nowCancun();
    const lead = await dataStore.insertRecord('leads', data, ownerId);
    await audit(req, 'create', 'leads', null, lead, ownerId !== ctx.user.id ? { note: `Asignado a ${(await dataStore.findUserById(ownerId))?.name || 'otro vendedor'}` } : {});
    if (warning) await log(req, 'crm_shared_client', { entity: 'leads', entityId: lead.id, summary: `${client.name} · ${lead.destination}`, note: warning });
    if (assignment && ownerId !== ctx.user.id) {
      const seller = await dataStore.findUserById(ownerId);
      await assignment.notifyAssigned(seller, [{ id: lead.id, client: client.name, destination: lead.destination, phone: client.phone }], { by: `${ctx.user.name}${autoReason ? ` (${autoReason.toLowerCase()})` : ''}`, req });
    }

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
    await hooks.emit(dataStore, 'leadCreated', { lead, client, channel: 'Plataforma' }); // TP-307
    res.status(201).json({ ok: true, record: await dataStore.getRecord('leads', lead.id) || lead, client, followup, warning });
  }));

  // Reasignar varios leads a la vez (administrador), con un solo aviso al vendedor.
  router.post('/leads/reassign', requireRole('admin'), wrap(async (req, res) => {
    const ctx = await context(req);
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
    if (!ids.length) throw new ValidationError('Elige al menos un lead');
    const owner = await assignableOwner(parseId(req.body?.owner_id));
    const moved = [];
    for (const id of ids) {
      const lead = ctx.mustSee('leads', id);
      if (lead.owner_id === owner.id) continue;
      await dataStore.transferLeadOwnership(id, owner.id);
      await restartContactClock(lead);
      const previous = lead.owner_id ? await dataStore.findUserById(lead.owner_id) : null;
      await log(req, 'crm_leads_reassign', {
        entity: 'leads', entityId: id, summary: summaryFor('leads', lead, ctx.find),
        changes: [{ field: 'owner_id', label: 'Vendedor', from: previous?.name || null, to: owner.name }], note: 'Reasignación de varios leads'
      });
      const client = ctx.find('clients', lead.client_id);
      moved.push({ id, client: client?.name || 'Cliente', destination: lead.destination, phone: client?.phone });
    }
    if (assignment && moved.length && owner.id !== ctx.user.id) await assignment.notifyAssigned(owner, moved, { by: ctx.user.name, req });
    res.json({ ok: true, moved: moved.length, owner: { id: owner.id, name: owner.name } });
  }));

  // TP-106: "Ya lo contacté" (detiene las alertas de lead sin contacto).
  router.post('/leads/:id/contacted', requireWrite('leads'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('leads', id);
    if (current.contacted_at) { res.json({ ok: true, record: current }); return; }
    const record = await dataStore.updateRecord('leads', id, { contacted_at: nowCancun() });
    await audit(req, 'update', 'leads', current, record, { note: 'Marcado como contactado' });
    res.json({ ok: true, record });
  }));

  router.patch('/leads/:id', requireWrite('leads'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('leads', id);
    const body = req.body || {};
    const data = sanitize('leads', body, { partial: true });
    const custom = await customFor('leads', body.custom, current.custom); // TP-306
    if (custom !== undefined) data.custom = custom;
    if (data.canvas) data.canvas = TPTrip.normalizeCanvas(data.canvas, current); // TP-302
    if (data.qualification) data.qualification = scoreQualification(data.qualification, (await allSettings()).leadQuestions);
    if (data.client_id && data.client_id !== current.client_id) ctx.checkRef('clients', data.client_id);
    checkDateRange({ ...current, ...data });
    if (data.stage) {
      if (CLOSED_STAGES.includes(data.stage) && !current.closed_at) data.closed_at = nowCancun();
      if (!CLOSED_STAGES.includes(data.stage)) data.closed_at = null;
      if (data.stage !== current.stage) data.stage_changed_at = nowCancun();
      if (data.stage !== 'Perdido') data.lost_reason = null;
      // TP-207: el motivo de pérdida es obligatorio
      else if (!String((data.lost_reason !== undefined ? data.lost_reason : current.stage === 'Perdido' ? current.lost_reason : '') || '').trim()) throw new ValidationError('Elige el motivo de pérdida');
      if (data.stage !== 'Nuevo' && !current.contacted_at) data.contacted_at = nowCancun();
    }
    let record = await dataStore.updateRecord('leads', id, data);
    await audit(req, 'update', 'leads', current, record);
    if (record.stage === 'Vendido' && current.stage !== 'Vendido') await hooks.emit(dataStore, 'leadSold', record); // TP-309
    if (record.stage !== current.stage) await hooks.emit(dataStore, 'leadStage', { before: current, lead: record }); // TP-307

    if (body.owner_id !== undefined && Number(body.owner_id) !== current.owner_id) {
      if (ctx.user.role !== 'admin') throw forbidden('Solo el administrador puede reasignar leads');
      const owner = await assignableOwner(parseId(body.owner_id));
      await dataStore.transferLeadOwnership(id, owner.id);
      await restartContactClock(current);
      const previous = current.owner_id ? await dataStore.findUserById(current.owner_id) : null;
      await log(req, 'crm_leads_reassign', {
        entity: 'leads', entityId: id, summary: summaryFor('leads', current, ctx.find),
        changes: [{ field: 'owner_id', label: 'Vendedor', from: previous?.name || null, to: owner.name }]
      });
      record = await dataStore.getRecord('leads', id);
      if (assignment && owner.id !== ctx.user.id) {
        const client = ctx.find('clients', record.client_id);
        await assignment.notifyAssigned(owner, [{ id, client: client?.name || 'Cliente', destination: record.destination, phone: client?.phone }], { by: ctx.user.name, req });
      }
    }
    res.json({ ok: true, record: (await dataStore.getRecord('leads', id)) || record });
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
    if (record.status !== 'Borrador') await hooks.emit(dataStore, 'quoteStatus', { before: null, quote: record }); // TP-307
    res.status(201).json({ ok: true, record });
  }));

  router.post('/quotes/:id/duplicate', requireWrite('quotes'), wrap(async (req, res) => {
    const ctx = await context(req);
    const source = ctx.mustSee('quotes', parseId(req.params.id));
    const { id, folio, accepted_at, sent_at, reminder_at, owner_id, created_at, updated_at, share_token, viewed_at, view_count, payment_plan, pay_token, acceptance, ...rest } = source;
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
    if (record.status !== current.status) await hooks.emit(dataStore, 'quoteStatus', { before: current, quote: record }); // TP-307
    res.json({ ok: true, record });
  }));

  // ---- Clientes ----
  router.post('/clients', requireWrite('clients'), wrap(async (req, res) => {
    const data = sanitize('clients', req.body);
    const custom = await customFor('clients', req.body?.custom, null); // TP-306
    if (custom) data.custom = custom;
    // TP-111: no crear un cliente que ya existe (a menos que se confirme).
    if (!req.body?.force) {
      const ctx = await context(req);
      const found = matchesFor(ctx.data.clients, { phone: data.phone, email: data.email });
      if (found.length) { res.status(409).json({ ok: false, error: 'Ya existe un cliente con ese WhatsApp o correo', duplicates: await describeMatches(ctx, found) }); return; }
    }
    const record = await dataStore.insertRecord('clients', data, req.session.user.id);
    await audit(req, 'create', 'clients', null, record);
    res.status(201).json({ ok: true, record });
  }));

  router.patch('/clients/:id', requireWrite('clients'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('clients', id);
    const data = sanitize('clients', req.body, { partial: true });
    const custom = await customFor('clients', req.body?.custom, current.custom); // TP-306
    if (custom !== undefined) data.custom = custom;
    const record = await dataStore.updateRecord('clients', id, data);
    await audit(req, 'update', 'clients', current, record);
    res.json({ ok: true, record });
  }));

  // ---- Viajes ----
  router.post('/trips', requireWrite('trips'), wrap(async (req, res) => {
    const ctx = await context(req);
    const data = sanitize('trips', req.body);
    const custom = await customFor('trips', req.body?.custom, null); // TP-306
    if (custom) data.custom = custom;
    if (data.canvas) data.canvas = TPTrip.normalizeCanvas(data.canvas, data); // TP-302
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
    const custom = await customFor('trips', req.body?.custom, current.custom); // TP-306
    if (custom !== undefined) data.custom = custom;
    if (data.canvas) data.canvas = TPTrip.normalizeCanvas(data.canvas, { ...current, ...data }); // TP-302
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
    if (data.due_at && data.due_at !== current.due_at) data.overdue_notified_at = null; // TP-110: reprogramado, vuelve a avisar si se vence
    if (data.lead_id !== undefined) ctx.checkRef('leads', data.lead_id);
    if (data.client_id !== undefined) ctx.checkRef('clients', data.client_id);
    const record = await dataStore.updateRecord('followups', id, data);
    await audit(req, 'update', 'followups', current, record);
    // TP-106: completar un seguimiento del lead cuenta como contacto.
    if (data.done && !current.done && record.lead_id) await markContacted(record.lead_id);
    res.json({ ok: true, record });
  }));

  // ---- TP-107: plantillas de WhatsApp por etapa ----
  router.get('/templates', wrap(async (req, res) => {
    res.json({ ok: true, stages: TEMPLATE_STAGES, variables: TEMPLATE_VARIABLES, defaults: DEFAULT_TEMPLATES, ...readTemplates(await dataStore.getSetting('wa_templates')) });
  }));
  router.put('/templates', adminOnly, wrap(async (req, res) => {
    const clean = req.body?.restoreDefaults ? { templates: DEFAULT_TEMPLATES, reviewLink: String(req.body.reviewLink || '') } : sanitizeTemplates(req.body || {});
    const saved = sanitizeTemplates(clean);
    await dataStore.setSetting('wa_templates', saved);
    await log(req, 'crm_settings_update', { note: `Plantillas de WhatsApp: ${saved.templates.length} plantillas` });
    res.json({ ok: true, ...readTemplates(saved) });
  }));

  // ---- TP-108: ficha 360 (mensajes, pagos, reseñas y notas del cliente) ----
  const EVENT_TYPES = ['message', 'payment', 'review', 'note'];
  const PAY_METHODS = ['Transferencia', 'Depósito', 'Tarjeta', 'Efectivo', 'Liga de pago', 'Otro'];
  const REVIEW_PLATFORMS = ['Google', 'TripAdvisor', 'Facebook', 'WhatsApp', 'Encuesta postviaje', 'Otro'];
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const plain = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

  router.get('/clients/:id/events', wrap(async (req, res) => {
    const ctx = await context(req);
    const client = ctx.mustSee('clients', parseId(req.params.id));
    const users = await dataStore.listUsers();
    const events = (await dataStore.listClientEvents(client.id)).map((e) => ({ ...e, created_by_name: users.find((u) => u.id === e.created_by)?.name || null }));
    res.json({ ok: true, events });
  }));

  router.post('/clients/:id/events', requireWrite('followups'), wrap(async (req, res) => {
    const ctx = await context(req);
    const client = ctx.mustSee('clients', parseId(req.params.id));
    const b = req.body || {};
    const type = EVENT_TYPES.includes(b.type) ? b.type : null;
    if (!type) throw new ValidationError('Tipo de registro inválido');
    const ref = (entity, id) => {
      if (id == null || id === '') return null;
      const row = ctx.checkRef(entity, parseId(id));
      if (row.client_id !== client.id) throw new ValidationError('El registro relacionado no es de este cliente');
      return row.id;
    };
    const ev = { client_id: client.id, type, lead_id: ref('leads', b.lead_id), quote_id: ref('quotes', b.quote_id), trip_id: ref('trips', b.trip_id), created_by: ctx.user.id };
    if (b.date !== undefined && b.date !== null && b.date !== '') {
      if (!ISO_DATE.test(String(b.date))) throw new ValidationError('Fecha inválida');
      ev.event_at = `${b.date} ${nowCancun().slice(11, 19)}`;
      if (ev.event_at > nowCancun()) throw new ValidationError('La fecha no puede ser futura');
    }
    let note = '';
    if (type === 'message') {
      ev.body = plain(b.body, 4000);
      if (!ev.body) throw new ValidationError('El mensaje está vacío');
      ev.title = plain(b.title, 80) || 'Mensaje de WhatsApp';
      const stage = TEMPLATE_STAGES.find((st) => st.id === b.stage)?.id || null;
      ev.meta = { stage, template: plain(b.template, 20) || null, channel: b.channel === 'copiado' ? 'copiado' : 'whatsapp' };
      note = `Mensaje por WhatsApp: ${ev.title}`;
    } else if (type === 'payment') {
      const amount = Math.round(Number(b.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 50000000) throw new ValidationError('Escribe el monto del pago');
      ev.amount = amount;
      ev.title = plain(b.title, 120) || 'Pago';
      ev.body = plain(b.body, 1000) || null;
      ev.meta = { method: PAY_METHODS.includes(b.method) ? b.method : 'Otro' };
      note = `Pago registrado: ${ev.title} · $${amount.toLocaleString('es-MX')}`;
    } else if (type === 'review') {
      const rating = Number(b.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ValidationError('Elige de 1 a 5 estrellas');
      ev.rating = rating;
      ev.body = plain(b.body, 2000) || null;
      ev.title = `Reseña ${'★'.repeat(rating)}`;
      ev.meta = { platform: REVIEW_PLATFORMS.includes(b.platform) ? b.platform : 'Otro' };
      note = `Reseña registrada: ${rating} estrellas (${ev.meta.platform})`;
    } else {
      ev.body = plain(b.body, 2000);
      if (!ev.body) throw new ValidationError('La nota está vacía');
      ev.title = 'Nota';
      note = 'Nota agregada a la ficha';
    }
    const event = await dataStore.insertClientEvent(ev);
    // TP-110: "pago recibido" al vendedor del cliente y a los administradores (menos a quien lo registró).
    if (type === 'payment' && assignment) {
      const lead = ev.lead_id ? ctx.find('leads', ev.lead_id) : ctx.data.leads.filter((l) => l.client_id === client.id).sort((a, b) => b.id - a.id)[0] || null;
      const users = await dataStore.listUsers();
      const ids = new Set([lead?.owner_id, client.owner_id, ...users.filter((u) => u.active && u.role === 'admin').map((u) => u.id)].filter(Boolean));
      ids.delete(ctx.user.id);
      for (const id of ids) {
        const u = users.find((x) => x.id === id && x.active);
        if (u) await assignment.notify(u, { kind: 'payment', leadId: lead?.id || null, link: `client:${client.id}`, title: `💰 Pago recibido: $${ev.amount.toLocaleString('es-MX')} de ${client.name}`, body: `${ev.title} · ${ev.meta.method} · registró ${ctx.user.name}` });
      }
    }
    await log(req, 'crm_clients_update', { entity: 'clients', entityId: client.id, summary: client.name, note });
    res.status(201).json({ ok: true, event: { ...event, created_by_name: ctx.user.name } });
  }));

  router.delete('/client-events/:id', adminOnly, wrap(async (req, res) => {
    const ctx = await context(req);
    const event = await dataStore.getClientEvent(parseId(req.params.id));
    if (!event) throw notFound('registro');
    const client = ctx.mustSee('clients', event.client_id);
    await dataStore.deleteClientEvent(event.id);
    await log(req, 'crm_clients_update', { entity: 'clients', entityId: client.id, summary: client.name, note: `Registro eliminado de la ficha: ${event.title || event.type}` });
    res.json({ ok: true });
  }));

  // ---- TP-109: respuesta del cliente y pesos del puntaje ----
  router.post('/leads/:id/response', requireWrite('leads'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const current = ctx.mustSee('leads', id);
    const value = req.body?.value ? String(req.body.value) : null;
    if (value && !RESPONSES[value]) throw new ValidationError('Respuesta inválida');
    const record = await dataStore.updateRecord('leads', id, { response: value, ...(value && !current.contacted_at ? { contacted_at: nowCancun() } : {}) });
    await log(req, 'crm_leads_update', { entity: 'leads', entityId: id, summary: summaryFor('leads', current, ctx.find), note: `Respuesta del cliente: ${value ? RESPONSES[value] : 'sin marcar'}` });
    res.json({ ok: true, record });
  }));
  router.get('/scoring', wrap(async (req, res) => { res.json({ ok: true, ...cleanScoring(await dataStore.getSetting('lead_scoring')) }); }));
  router.put('/scoring', adminOnly, wrap(async (req, res) => {
    const cfg = sanitizeScoring(req.body || {});
    await dataStore.setSetting('lead_scoring', cfg);
    await log(req, 'crm_settings_update', { note: `Calificación automática: ${Object.entries(cfg.weights).map(([k, v]) => `${k} ${v}`).join(', ')} · caliente ≥${cfg.hot} · tibio ≥${cfg.warm}` });
    res.json({ ok: true, ...cfg });
  }));

  // ---- TP-110: liga privada de la cotización ----
  const appUrlFor = (req) => String(process.env.APP_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  router.post('/quotes/:id/share', requireWrite('quotes'), wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const ctx = await context(req);
    const quote = ctx.mustSee('quotes', id);
    const enabled = req.body?.enabled !== false;
    const token = enabled ? (quote.share_token || newShareToken()) : null;
    if (token !== quote.share_token) {
      await dataStore.updateRecord('quotes', id, { share_token: token });
      await log(req, 'crm_quotes_update', { entity: 'quotes', entityId: id, summary: summaryFor('quotes', quote, ctx.find), note: enabled ? 'Liga para el cliente activada' : 'Liga para el cliente desactivada' });
    }
    res.json({ ok: true, url: token ? `${appUrlFor(req)}/cotizacion/${token}` : null, viewed_at: quote.viewed_at || null, view_count: quote.view_count || 0 });
  }));

  // ---- TP-111: duplicados por WhatsApp o correo ----
  const emailKey = (v) => String(v || '').trim().toLowerCase();
  const nameKey = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function matchesFor(clients, { phone, email, excludeId }) {
    const pk = phoneKey(phone), ek = emailKey(email);
    return clients.filter((c) => c.id !== excludeId).map((c) => {
      const reasons = [];
      if (pk.length >= 10 && phoneKey(c.phone) === pk) reasons.push('WhatsApp');
      if (ek && emailKey(c.email) === ek) reasons.push('correo');
      return reasons.length ? { c, reasons } : null;
    }).filter(Boolean);
  }
  async function describeMatches(ctx, list) {
    const users = await dataStore.listUsers();
    return list.map(({ c, reasons }) => {
      const visible = isVisible(ctx.scope, 'clients', c.id);
      const ownerIds = new Set([c.owner_id, ...ctx.data.leads.filter((l) => l.client_id === c.id).map((l) => l.owner_id)].filter(Boolean));
      return { id: visible ? c.id : null, name: c.name, visible, reasons, owners: [...ownerIds].map((id) => users.find((u) => u.id === id)?.name).filter(Boolean) };
    });
  }
  router.get('/clients/duplicates/check', wrap(async (req, res) => {
    const ctx = await context(req);
    const list = matchesFor(ctx.data.clients, { phone: req.query.phone, email: req.query.email, excludeId: Number(req.query.exclude) || null });
    res.json({ ok: true, matches: await describeMatches(ctx, list) });
  }));
  router.get('/duplicates', adminOnly, wrap(async (req, res) => {
    const ctx = await context(req);
    const groups = new Map();
    const add = (key, reason, c) => { if (!groups.has(key)) groups.set(key, { reason, ids: new Set() }); groups.get(key).ids.add(c.id); };
    for (const c of ctx.data.clients) {
      if (phoneKey(c.phone).length >= 10) add(`p:${phoneKey(c.phone)}`, 'Mismo WhatsApp', c);
      if (emailKey(c.email)) add(`e:${emailKey(c.email)}`, 'Mismo correo', c);
      if (nameKey(c.name).split(' ').length >= 2) add(`n:${nameKey(c.name)}`, 'Mismo nombre', c);
    }
    // Une grupos que comparten clientes y conserva el motivo más fuerte.
    const merged = [];
    for (const g of [...groups.values()].filter((g) => g.ids.size > 1)) {
      const hit = merged.find((m) => [...g.ids].some((id) => m.ids.has(id)));
      if (hit) { g.ids.forEach((id) => hit.ids.add(id)); if (!hit.reasons.includes(g.reason)) hit.reasons.push(g.reason); } else merged.push({ ids: new Set(g.ids), reasons: [g.reason] });
    }
    const info = (id) => {
      const c = ctx.find('clients', id);
      return { id: c.id, name: c.name, phone: c.phone, email: c.email, created_at: c.created_at, leads: ctx.data.leads.filter((l) => l.client_id === id).length, quotes: ctx.data.quotes.filter((q) => q.client_id === id).length, trips: ctx.data.trips.filter((t) => t.client_id === id).length };
    };
    res.json({ ok: true, groups: merged.map((m) => ({ reasons: m.reasons, strong: m.reasons.some((r) => r !== 'Mismo nombre'), clients: [...m.ids].map(info) })).sort((a, b) => Number(b.strong) - Number(a.strong)) });
  }));
  router.post('/clients/merge', adminOnly, wrap(async (req, res) => {
    const ctx = await context(req);
    const keep = ctx.mustSee('clients', parseId(req.body?.keep_id));
    const drop = ctx.mustSee('clients', parseId(req.body?.merge_id));
    if (keep.id === drop.id) throw new ValidationError('Elige dos clientes distintos');
    const moved = {};
    for (const entity of ['leads', 'quotes', 'trips', 'followups']) {
      const rows = ctx.data[entity].filter((r) => r.client_id === drop.id);
      for (const r of rows) await dataStore.updateRecord(entity, r.id, { client_id: keep.id });
      moved[entity] = rows.length;
    }
    await dataStore.moveClientEvents(drop.id, keep.id);
    const tags = [...new Set([keep.tags, drop.tags].join(',').split(',').map((t) => t.trim()).filter(Boolean))].join(', ').slice(0, 255);
    const fill = {
      phone: keep.phone || drop.phone || null,
      email: keep.email || drop.email || null,
      tags: tags || null,
      notes: [keep.notes, drop.notes && drop.notes !== keep.notes ? `(De ${drop.name}) ${drop.notes}` : ''].filter(Boolean).join('\n').slice(0, 4000) || null
    };
    const record = await dataStore.updateRecord('clients', keep.id, fill);
    await dataStore.deleteRecord('clients', drop.id);
    await log(req, 'crm_clients_merge', { entity: 'clients', entityId: keep.id, summary: keep.name, note: `Fusionado con ${drop.name} (#${drop.id}): ${moved.leads} leads, ${moved.quotes} cotizaciones, ${moved.trips} viajes, ${moved.followups} seguimientos` });
    res.json({ ok: true, record, moved });
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

  // TP-306: definiciones de campos personalizables (las ve todo el equipo; las edita el administrador).
  router.get('/custom-fields', wrap(async (req, res) => { res.json({ ok: true, fields: await customDefs(), types: TPFields.TYPES }); }));
  router.put('/custom-fields', adminOnly, wrap(async (req, res) => {
    const before = await customDefs();
    const fields = TPFields.cleanDefs(req.body?.fields || {});
    await dataStore.setSetting('custom_fields', fields);
    const count = (f) => Object.entries(f).map(([e, l]) => `${TPFields.ENTITIES[e]} ${l.filter((d) => d.active).length}`).join(' · ');
    const added = Object.entries(fields).flatMap(([e, l]) => l.filter((d) => !before[e].some((b) => b.key === d.key)).map((d) => d.label));
    await log(req, 'crm_settings_update', { note: `Campos personalizables: ${count(fields)}${added.length ? ` · nuevos: ${added.join(', ')}` : ''}`.slice(0, 480) });
    res.json({ ok: true, fields });
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
    const sheets = buildSheets(sections, visible, { users: ctx.user.role === 'admin' ? users : users.map(({ id, name }) => ({ id, name })), questions: (await allSettings()).leadQuestions, range, customFields: await customDefs() });
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
