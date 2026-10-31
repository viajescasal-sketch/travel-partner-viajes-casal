'use strict';

// TP-307: constructor de automatizaciones ("si pasa X, haz Y").
//  - Reglas del administrador en Configuración › Automatizaciones (setting 'automations').
//  - Eventos al momento: lead nuevo, cambio de etapa, estado de cotización, pago recibido (ganchos de src/hooks.js).
//  - Por fecha (cada hora, en horario laboral): lead sin movimiento, días antes/después del viaje, fecha de un campo personalizado.
//  - Acciones: seguimiento, tarea de WhatsApp con plantilla, correo al cliente, aviso al equipo, etapa, vendedor, campo, preferencia.
//  - Los recordatorios que ya existen (TP-106, cobros, postviaje, campañas) siguen funcionando aparte.

const express = require('express');
const { ValidationError, nowCancun, sanitize } = require('./crm-schema');
const hooks = require('./hooks');
const { SELLER_ROLES } = require('./access');
const TPAuto = require('../public/automatizaciones-core');
const TPFields = require('../public/campos-core');
const { readTemplates } = require('./templates');

const SETTING = 'automations';
const LOG = 'automation_log';
const MAX_DEPTH = 3;
const SCHEDULE_EVERY_MS = 60 * 60 * 1000;
const CATCH_UP_DAYS = 3; // si el servidor estuvo dormido, se alcanza a disparar hasta 3 días después
const CLOSED = ['Vendido', 'Perdido'];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function createAutomations(dataStore, { assignment = null, mailer = null, env = {}, now = () => nowCancun() } = {}) {
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';

  // ---- Reglas ----
  async function loadRules() {
    const saved = await dataStore.getSetting(SETTING);
    if (saved && Array.isArray(saved.rules)) return saved.rules;
    // Primera vez: reglas de ejemplo, apagadas.
    const rules = TPAuto.EXAMPLES.map((r, i) => ({ ...TPAuto.cleanRule({ ...r, id: `aejemplo${i + 1}` }), active: false }));
    await dataStore.setSetting(SETTING, { rules, seeded_at: now() });
    return rules;
  }
  const saveRules = (rules) => dataStore.setSetting(SETTING, { rules, updated_at: now() });

  // Bitácora de ejecuciones (una escritura a la vez).
  let logQueue = Promise.resolve();
  const withLog = (fn) => { const run = logQueue.then(async () => { const log = (await dataStore.getSetting(LOG)) || {}; log.fired = log.fired || {}; log.stats = log.stats || {}; log.history = log.history || []; const out = await fn(log); await dataStore.setSetting(LOG, log); return out; }); logQueue = run.catch(() => {}); return run; };

  // ---- Contexto del evento ----
  const users = async () => dataStore.listUsers();
  async function buildContext(base) {
    const ctx = { ...base };
    if (ctx.trip && !ctx.quote && ctx.trip.quote_id) ctx.quote = await dataStore.getRecord('quotes', ctx.trip.quote_id);
    if (ctx.quote && !ctx.lead && ctx.quote.lead_id) ctx.lead = await dataStore.getRecord('leads', ctx.quote.lead_id);
    const clientId = ctx.lead?.client_id ?? ctx.quote?.client_id ?? ctx.trip?.client_id ?? ctx.client?.id;
    if (clientId && (!ctx.client || ctx.client.id !== clientId)) ctx.client = await dataStore.getRecord('clients', clientId);
    const list = await users();
    const ownerId = ctx.lead?.owner_id ?? ctx.quote?.owner_id ?? ctx.trip?.owner_id ?? ctx.client?.owner_id ?? null;
    ctx.seller = list.find((u) => u.id === ownerId && u.active) || null;
    ctx.admins = list.filter((u) => u.active && u.role === 'admin');
    ctx.users = list;
    return ctx;
  }
  const targetOf = (ctx) => (ctx.lead ? { entity: 'leads', id: ctx.lead.id } : ctx.trip ? { entity: 'trips', id: ctx.trip.id } : ctx.quote ? { entity: 'quotes', id: ctx.quote.id } : ctx.client ? { entity: 'clients', id: ctx.client.id } : { entity: null, id: null });
  const summaryOf = (ctx) => [ctx.client?.name, ctx.trip?.destination || ctx.lead?.destination || ctx.quote?.destination].filter(Boolean).join(' · ');
  function recipients(to, ctx) {
    if (to === 'admins') return ctx.admins;
    if (to === 'owner') return [ctx.seller || ctx.admins[0]].filter(Boolean);
    return ctx.users.filter((u) => u.id === to && u.active);
  }
  // Fecha y hora del seguimiento: en N días a la hora indicada, o en N horas.
  function dueOf(a) {
    const current = now();
    const today = current.slice(0, 10);
    if (a.hours && !a.days) {
      const d = new Date(Date.parse(`${current.replace(' ', 'T')}Z`) + a.hours * 3600000);
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }
    const day = addDays(today, a.days || 0);
    const time = a.time || (a.days ? '10:00' : '');
    if (!time) return current.slice(0, 16);
    const due = `${day} ${time}`;
    return due < current.slice(0, 16) ? current.slice(0, 16) : due;
  }

  // ---- Acciones ----
  async function runAction(rule, a, ctx, { dryRun, depth, chain }) {
    const fill = (t) => TPAuto.fill(t, ctx);
    switch (a.type) {
      case 'followup':
      case 'whatsapp_task': {
        if (!ctx.client && !ctx.lead) return { skipped: 'sin cliente' };
        let title = fill(a.title);
        let template = null;
        if (a.type === 'whatsapp_task') {
          template = (readTemplates(await dataStore.getSetting('wa_templates')).templates).find((t) => t.id === a.template) || null;
          title = title || `Enviar WhatsApp “${template?.name || a.template}” a ${ctx.client?.name || 'cliente'}`;
        }
        const owner = recipients(a.to, ctx)[0] || null;
        const due = dueOf(a);
        const text = `${a.type === 'whatsapp_task' ? '💬' : '📌'} ${title} · ${due.slice(5, 16)}${owner ? ` · ${owner.name}` : ''}`;
        if (dryRun) return { ok: text };
        const data = sanitize('followups', {
          client_id: ctx.client?.id ?? null, lead_id: ctx.lead && ctx.lead.client_id === ctx.client?.id ? ctx.lead.id : null,
          type: a.type === 'whatsapp_task' ? 'WhatsApp' : a.ftype, title: title.slice(0, 160),
          details: (a.type === 'whatsapp_task' ? `Plantilla: ${template?.name || a.template}. Ábrela desde el seguimiento y envíala con un toque.` : fill(a.details) || '') .slice(0, 2000) || null,
          due_at: due
        });
        const f = await dataStore.insertRecord('followups', data, owner?.id ?? null);
        await dataStore.updateRecord('followups', f.id, { auto: { rule_id: rule.id, rule: rule.name, template: template?.id || null, trip_id: ctx.trip?.id || null, quote_id: ctx.quote?.id || null } });
        return { ok: text };
      }
      case 'email_client': {
        const c = ctx.client;
        if (!c?.email) return { skipped: 'el cliente no tiene correo' };
        if (c.no_marketing) return { skipped: 'cliente marcado “No contactar”' };
        if (!mailer?.configured) return { skipped: 'correo de la plataforma sin configurar' };
        const subject = fill(a.subject).slice(0, 180);
        const body = fill(a.body);
        if (dryRun) return { ok: `✉️ Correo a ${c.email}: “${subject}”` };
        const agency = { name: 'Viajes Casal', ...((await dataStore.getSetting('agency')) || {}) };
        const sign = [ctx.seller?.name, agency.name].filter(Boolean).join(' · ');
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px;font-size:15px;line-height:1.5">${body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}<p style="font-size:13px;color:#5b6b78;margin-top:22px">${escapeHtml(sign)}${agency.whatsapp ? `<br>WhatsApp ${escapeHtml(agency.whatsapp)}` : ''}</p></div>`;
        try { await mailer.send({ to: c.email, subject, text: `${body}\n\n${sign}`, html }); } catch (error) { return { skipped: `no se envió el correo (${error.message})` }; }
        return { ok: `✉️ Correo a ${c.email}: “${subject}”` };
      }
      case 'notify': {
        const list = recipients(a.to, ctx);
        if (!list.length || !assignment) return { skipped: 'sin destinatarios' };
        const title = fill(a.title).slice(0, 200);
        const body = [fill(a.body), `Automatización: ${rule.name}`].filter(Boolean).join(' · ').slice(0, 300);
        if (dryRun) return { ok: `🔔 Aviso a ${list.map((u) => u.name).join(', ')}: “${title}”` };
        const link = ctx.trip ? `trip:${ctx.trip.id}` : ctx.quote && !ctx.lead ? `quote:${ctx.quote.id}` : !ctx.lead && ctx.client ? `client:${ctx.client.id}` : null;
        for (const u of list) {
          await assignment.notify(u, {
            kind: 'automation', leadId: ctx.lead?.id || null, link, title, body,
            email: a.email && u.email ? { subject: title.slice(0, 180), text: `Hola ${u.name},\n\n${title}\n${body}\n\nAbrir la plataforma: ${appUrl()}`, html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px"><p>Hola ${escapeHtml(u.name)},</p><p><b>${escapeHtml(title)}</b></p><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(appUrl())}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>` } : null
          });
        }
        return { ok: `🔔 Aviso a ${list.map((u) => u.name).join(', ')}` };
      }
      case 'set_stage': {
        const lead = ctx.lead;
        if (!lead) return { skipped: 'sin lead' };
        if (CLOSED.includes(lead.stage)) return { skipped: `el lead ya está ${lead.stage}` };
        if (lead.stage === a.stage) return { skipped: `ya estaba en ${a.stage}` };
        if (dryRun) return { ok: `🔀 Etapa ${lead.stage} → ${a.stage}` };
        const updated = await dataStore.updateRecord('leads', lead.id, { stage: a.stage, stage_changed_at: now(), ...(a.stage !== 'Nuevo' && !lead.contacted_at ? { contacted_at: now() } : {}) });
        await fire({ type: 'lead_stage', stage: a.stage }, { lead: updated }, { depth: depth + 1, chain });
        ctx.lead = updated;
        return { ok: `🔀 Etapa ${lead.stage} → ${a.stage}` };
      }
      case 'assign': {
        const lead = ctx.lead;
        if (!lead) return { skipped: 'sin lead' };
        let user = null;
        if (a.to === 'auto') user = assignment ? (await assignment.pickOwner({ client: ctx.client })).user : null;
        else user = ctx.users.find((u) => u.id === a.to && u.active && SELLER_ROLES.includes(u.role)) || null;
        if (!user) return { skipped: 'no hay vendedor disponible' };
        if (user.id === lead.owner_id) return { skipped: `ya era de ${user.name}` };
        if (dryRun) return { ok: `👤 Asignar a ${user.name}` };
        await dataStore.transferLeadOwnership(lead.id, user.id);
        ctx.lead = await dataStore.getRecord('leads', lead.id);
        ctx.seller = user;
        if (assignment?.notifyAssigned) await assignment.notifyAssigned(user, [{ id: lead.id, client: ctx.client?.name || 'Cliente', destination: lead.destination, phone: ctx.client?.phone }], { by: `Automatización “${rule.name}”` });
        return { ok: `👤 Asignado a ${user.name}` };
      }
      case 'set_field': {
        const entity = { lead: 'leads', client: 'clients', trip: 'trips' }[a.target];
        const rec = ctx[a.target];
        if (!rec) return { skipped: `sin ${a.target}` };
        const def = TPFields.cleanDefs(await dataStore.getSetting('custom_fields'))[entity].find((d) => d.key === a.key && d.active);
        if (!def) return { skipped: `el campo “${a.key}” ya no existe` };
        let value;
        try { value = TPFields.cleanValue(def, fill(a.value)); } catch (error) { return { skipped: error.message }; }
        if (dryRun) return { ok: `✏️ ${def.label}: ${TPFields.display(def, value) || '(vacío)'}` };
        const custom = { ...(rec.custom || {}) };
        if (value === '') delete custom[def.key]; else custom[def.key] = value;
        ctx[a.target] = await dataStore.updateRecord(entity, rec.id, { custom });
        return { ok: `✏️ ${def.label}: ${TPFields.display(def, value) || '(vacío)'}` };
      }
      case 'add_tag': {
        const c = ctx.client;
        if (!c) return { skipped: 'sin cliente' };
        const tags = String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
        if (tags.some((t) => t.toLowerCase() === a.tag.toLowerCase())) return { skipped: `ya tenía “${a.tag}”` };
        const next = [...tags, a.tag].join(', ');
        if (next.length > 255) return { skipped: 'las preferencias ya están llenas' };
        if (dryRun) return { ok: `🏷️ Preferencia “${a.tag}”` };
        ctx.client = await dataStore.updateRecord('clients', c.id, { tags: next });
        return { ok: `🏷️ Preferencia “${a.tag}”` };
      }
      default: return { skipped: 'acción desconocida' };
    }
  }

  async function runRule(rule, ctx, { dryRun = false, depth = 0, chain = new Set(), reason = '' } = {}) {
    const results = [];
    for (const a of rule.actions) {
      try { results.push(await runAction(rule, a, ctx, { dryRun, depth, chain: new Set([...chain, rule.id]) })); } catch (error) { results.push({ skipped: `error: ${error.message}` }); }
    }
    if (dryRun) return results;
    const target = targetOf(ctx);
    const note = results.map((r) => r.ok || `omitido (${r.skipped})`).join(' · ');
    await dataStore.logActivity(null, 'crm_automation', null, { entity: target.entity, entityId: target.id, summary: `${rule.name}${summaryOf(ctx) ? ` · ${summaryOf(ctx)}` : ''}`.slice(0, 200), note: `${reason ? `${reason} · ` : ''}${note}`.slice(0, 480) });
    await withLog((log) => {
      const st = log.stats[rule.id] || { runs: 0 };
      log.stats[rule.id] = { runs: st.runs + 1, last_at: now() };
      log.history.unshift({ at: now(), rule_id: rule.id, rule: rule.name, target: summaryOf(ctx), entity: target.entity, entity_id: target.id, results: results.map((r) => String(r.ok || `Omitido: ${r.skipped}`).slice(0, 160)) });
      log.history = log.history.slice(0, 120);
    });
    return results;
  }

  /** Evento al momento: corre las reglas activas que coinciden. */
  async function fire(event, base, { depth = 0, chain = new Set() } = {}) {
    if (depth > MAX_DEPTH) return [];
    const rules = (await loadRules()).filter((r) => r.active && !chain.has(r.id) && TPAuto.triggerMatches(r.trigger, event));
    if (!rules.length) return [];
    const ctx = await buildContext(base);
    const out = [];
    for (const rule of rules) {
      if (!TPAuto.matches(rule, ctx)) continue;
      out.push({ rule: rule.id, results: await runRule(rule, ctx, { depth, chain }) });
    }
    return out;
  }

  hooks.on(dataStore, 'leadCreated', ({ lead }) => fire({ type: 'lead_created' }, { lead }));
  hooks.on(dataStore, 'leadStage', ({ lead }) => fire({ type: 'lead_stage', stage: lead.stage }, { lead }));
  hooks.on(dataStore, 'quoteStatus', ({ quote }) => fire({ type: 'quote_status', status: quote.status }, { quote }));
  hooks.on(dataStore, 'paymentReceived', ({ quote, plan, amount, installment }) => fire({ type: 'payment_received', full: plan?.status === 'pagado' }, { quote, payment: { amount, full: plan?.status === 'pagado', label: installment?.label || '' } }));

  // ---- Por fecha ----
  // Momento en que toca cada registro para una regla con fecha → [{ base, key, reason }]
  async function dueFor(rule, data, today) {
    const t = rule.trigger;
    const out = [];
    if (t.type === 'lead_idle') {
      for (const lead of data.leads.filter((l) => !CLOSED.includes(l.stage))) {
        const fups = data.followups.filter((f) => f.lead_id === lead.id);
        const last = [lead.stage_changed_at, lead.created_at, lead.contacted_at, ...fups.flatMap((f) => [f.created_at, f.updated_at])].filter(Boolean).map(String).sort().pop();
        if (!last) continue;
        const idle = daysBetween(last.slice(0, 10), today);
        if (idle >= t.days) out.push({ base: { lead, days: idle }, key: `${rule.id}:lead:${lead.id}:${last.slice(0, 10)}`, reason: `${idle} días sin movimiento` });
      }
    }
    if (t.type === 'trip_before' || t.type === 'trip_after') {
      for (const trip of data.trips.filter((x) => x.status !== 'Cerrado')) {
        const date = t.type === 'trip_before' ? trip.start_date : trip.end_date;
        if (!ISO.test(String(date || ''))) continue;
        const target = addDays(date, t.type === 'trip_before' ? -t.days : t.days);
        const late = daysBetween(target, today);
        if (late >= 0 && late <= CATCH_UP_DAYS && (t.type === 'trip_after' || today <= date)) out.push({ base: { trip, days: t.days }, key: `${rule.id}:trip:${trip.id}:${date}`, reason: t.type === 'trip_before' ? `sale el ${date}` : `regresó el ${date}` });
      }
    }
    if (t.type === 'date_field') {
      const list = data[t.entity] || [];
      for (const rec of list) {
        const v = rec.custom?.[t.field];
        if (!ISO.test(String(v || ''))) continue;
        const dates = t.yearly
          ? [-1, 0, 1].map((dy) => { const y = Number(today.slice(0, 4)) + dy; const md = v.slice(5); return md === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? `${y}-02-28` : `${y}-${md}`; })
          : [v];
        for (const d of dates) {
          const target = addDays(d, t.when === 'after' ? t.days : -t.days);
          const late = daysBetween(target, today);
          if (late < 0 || late > CATCH_UP_DAYS) continue;
          const key = { leads: 'lead', clients: 'client', trips: 'trip' }[t.entity];
          out.push({ base: { [key]: rec, days: t.days }, key: `${rule.id}:${t.entity}:${rec.id}:${target}`, reason: `fecha ${d}` });
        }
      }
    }
    return out;
  }

  let lastScheduled = 0;
  async function runScheduled({ force = false, workStart = '09:00', workEnd = '20:00' } = {}) {
    const current = now();
    const hhmm = current.slice(11, 16);
    if (!force && (hhmm < workStart || hhmm >= workEnd)) return { fired: 0 };
    if (!force && Date.now() - lastScheduled < SCHEDULE_EVERY_MS) return { fired: 0 };
    lastScheduled = Date.now();
    const rules = (await loadRules()).filter((r) => r.active && TPAuto.TRIGGERS[r.trigger.type]?.timed);
    if (!rules.length) return { fired: 0 };
    const today = current.slice(0, 10);
    const data = {};
    for (const name of ['clients', 'leads', 'quotes', 'trips', 'followups']) data[name] = await dataStore.listRecords(name);
    const fired = (await dataStore.getSetting(LOG))?.fired || {};
    let count = 0;
    for (const rule of rules) {
      for (const item of await dueFor(rule, data, today)) {
        if (fired[item.key]) continue;
        const ctx = await buildContext(item.base);
        // Se marca aunque no cumpla condiciones, para no revisarlo de nuevo.
        await withLog((log) => { log.fired[item.key] = today; });
        fired[item.key] = today;
        if (!TPAuto.matches(rule, ctx)) continue;
        await runRule(rule, ctx, { reason: item.reason });
        count += 1;
      }
    }
    // Limpieza de marcas viejas (más de 400 días).
    await withLog((log) => { const limit = addDays(today, -400); for (const [k, d] of Object.entries(log.fired)) if (d < limit) delete log.fired[k]; });
    return { fired: count };
  }

  // ---- Prueba sin efectos ----
  async function test(rule, { entity, id }) {
    const rec = await dataStore.getRecord(entity, Number(id));
    if (!rec) throw Object.assign(new Error('No se encontró el registro de prueba'), { status: 404, expose: true });
    const key = { leads: 'lead', clients: 'client', trips: 'trip', quotes: 'quote' }[entity];
    const base = { [key]: rec };
    if (rule.trigger.type === 'payment_received' && rec.payment_plan) base.payment = { amount: rec.payment_plan.paid, full: rec.payment_plan.status === 'pagado', label: '' };
    const ctx = await buildContext(base);
    const defs = TPFields.cleanDefs(await dataStore.getSetting('custom_fields'));
    const fields = TPAuto.fieldsFor(rule.trigger, defs);
    const conditions = rule.conditions.map((c) => ({ label: `${fields.find((f) => f.path === c.path)?.label || c.path} ${TPAuto.OPS[c.op]}${['empty', 'not_empty'].includes(c.op) ? '' : ` ${c.value}`}`, value: TPAuto.get(ctx, c.path) ?? null, ok: TPAuto.testCondition(c, ctx) }));
    const ok = TPAuto.matches(rule, ctx);
    const actions = await runRule(rule, ctx, { dryRun: true });
    return { matches: ok, target: summaryOf(ctx), conditions, actions: actions.map((r) => r.ok || `Se omitiría: ${r.skipped}`) };
  }

  // ---- Rutas (solo administrador) ----
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const adminOnly = (req, _res, next) => (req.session.user.role === 'admin' ? next() : next(Object.assign(new Error('Solo el administrador configura automatizaciones'), { status: 403, expose: true })));
  const log = (req, note) => dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Automatizaciones: ${note}`.slice(0, 480) });

  router.get('/automations', adminOnly, wrap(async (req, res) => {
    const l = (await dataStore.getSetting(LOG)) || {};
    res.json({ ok: true, rules: await loadRules(), stats: l.stats || {}, history: (l.history || []).slice(0, 60), templates: (readTemplates(await dataStore.getSetting('wa_templates')).templates).map(({ id, name, stage }) => ({ id, name, stage })) });
  }));
  router.post('/automations', adminOnly, wrap(async (req, res) => {
    const rules = await loadRules();
    if (rules.length >= TPAuto.MAX_RULES) throw new ValidationError(`Máximo ${TPAuto.MAX_RULES} automatizaciones`);
    const rule = TPAuto.cleanRule({ ...(req.body || {}), id: undefined });
    await saveRules([...rules, rule]);
    await log(req, `nueva “${rule.name}” (${rule.active ? 'activa' : 'apagada'})`);
    res.status(201).json({ ok: true, rule });
  }));
  router.put('/automations/:id', adminOnly, wrap(async (req, res) => {
    const rules = await loadRules();
    const i = rules.findIndex((r) => r.id === req.params.id);
    if (i < 0) throw Object.assign(new Error('No se encontró la automatización'), { status: 404, expose: true });
    const rule = TPAuto.cleanRule({ ...(req.body || {}), id: rules[i].id, example: rules[i].example });
    rules[i] = rule;
    await saveRules(rules);
    await log(req, `“${rule.name}” ${rule.active ? 'activa' : 'apagada'}`);
    res.json({ ok: true, rule });
  }));
  router.delete('/automations/:id', adminOnly, wrap(async (req, res) => {
    const rules = await loadRules();
    const rule = rules.find((r) => r.id === req.params.id);
    if (!rule) throw Object.assign(new Error('No se encontró la automatización'), { status: 404, expose: true });
    await saveRules(rules.filter((r) => r.id !== rule.id));
    await log(req, `eliminada “${rule.name}”`);
    res.json({ ok: true });
  }));
  router.post('/automations/test', adminOnly, wrap(async (req, res) => {
    const rule = TPAuto.cleanRule({ ...(req.body?.rule || {}), name: req.body?.rule?.name || 'Prueba' });
    const entity = ['leads', 'clients', 'trips', 'quotes'].includes(req.body?.entity) ? req.body.entity : null;
    if (!entity) throw new ValidationError('Elige un registro para probar');
    res.json({ ok: true, ...(await test(rule, { entity, id: req.body.id })) });
  }));
  router.post('/automations/run', adminOnly, wrap(async (req, res) => { res.json({ ok: true, ...(await runScheduled({ force: true })) }); }));

  return { router, fire, runScheduled, loadRules, test };
}

module.exports = { createAutomations };
