'use strict';

/* TP-307: constructor de automatizaciones "si pasa X, haz Y".
   Catálogo de disparadores, condiciones y acciones; limpieza de reglas y evaluación de condiciones.
   Lo usan la plataforma (editor), el servidor (motor) y las pruebas. */
(function (global) {
  const LEAD_STAGES = ['Nuevo', 'Calificado', 'Cotizado', 'Negociación', 'Vendido', 'Perdido'];
  const SOURCES = ['WhatsApp', 'Instagram', 'Facebook', 'Sitio web', 'Referido', 'Otro'];
  const QUOTE_STATUSES = ['Enviada', 'Aceptada', 'Rechazada'];
  const TRIP_STATUSES = ['Confirmado', 'Documentación pendiente', 'En viaje', 'Solicitar reseña', 'Postventa', 'Cerrado'];
  const FOLLOWUP_TYPES = ['Llamada', 'WhatsApp', 'Cotización', 'Pago', 'Otro'];
  const PRIORITIES = ['Alta', 'Media', 'Baja'];
  const MAX_RULES = 60;
  const MAX_CONDITIONS = 8;
  const MAX_ACTIONS = 6;

  // Disparadores. subjects: qué datos hay disponibles para condiciones y textos. timed: los revisa el motor cada hora.
  const TRIGGERS = {
    lead_created: { label: 'Llega un lead nuevo', icon: '🆕', subjects: ['lead', 'client'], help: 'Por la plataforma, el bot de WhatsApp o el formulario web.' },
    lead_stage: { label: 'Un lead cambia de etapa', icon: '🔀', subjects: ['lead', 'client'], params: ['stage'] },
    quote_status: { label: 'Una cotización cambia de estado', icon: '📄', subjects: ['quote', 'lead', 'client'], params: ['status'] },
    payment_received: { label: 'Se recibe un pago', icon: '💰', subjects: ['payment', 'quote', 'lead', 'client'], params: ['full'] },
    lead_idle: { label: 'Un lead lleva días sin movimiento', icon: '⏳', subjects: ['lead', 'client'], params: ['days'], timed: true, help: 'Leads abiertos sin cambios, seguimientos ni notas en N días.' },
    trip_before: { label: 'Faltan N días para un viaje', icon: '✈️', subjects: ['trip', 'client', 'lead'], params: ['days'], timed: true },
    trip_after: { label: 'Pasaron N días del regreso', icon: '🏠', subjects: ['trip', 'client', 'lead'], params: ['days'], timed: true },
    date_field: { label: 'Fecha de un campo personalizado', icon: '📅', subjects: [], params: ['entity', 'field', 'days', 'when', 'yearly'], timed: true, help: 'Ej. 7 días antes del aniversario de bodas del cliente (cada año).' }
  };
  const ENTITY_SUBJECTS = { leads: ['lead', 'client'], clients: ['client'], trips: ['trip', 'client', 'lead'] };
  const subjectsOf = (trigger) => (trigger?.type === 'date_field' ? ENTITY_SUBJECTS[trigger.entity] || ['client'] : TRIGGERS[trigger?.type]?.subjects || []);

  // Campos que se pueden revisar en las condiciones.
  const BASE_FIELDS = [
    { path: 'lead.source', label: 'Origen del lead', subject: 'lead', type: 'select', options: SOURCES },
    { path: 'lead.destination', label: 'Destino del lead', subject: 'lead', type: 'text' },
    { path: 'lead.budget', label: 'Presupuesto', subject: 'lead', type: 'number' },
    { path: 'lead.travelers', label: 'Viajeros', subject: 'lead', type: 'number' },
    { path: 'lead.stage', label: 'Etapa del lead', subject: 'lead', type: 'select', options: LEAD_STAGES },
    { path: 'lead.priority', label: 'Prioridad', subject: 'lead', type: 'select', options: PRIORITIES },
    { path: 'lead.score', label: 'Puntaje del lead', subject: 'lead', type: 'number' },
    { path: 'lead.owner_id', label: 'Vendedor', subject: 'lead', type: 'user' },
    { path: 'client.tags', label: 'Preferencias del cliente', subject: 'client', type: 'text' },
    { path: 'client.email', label: 'Correo del cliente', subject: 'client', type: 'text' },
    { path: 'quote.price', label: 'Precio de la cotización', subject: 'quote', type: 'number' },
    { path: 'quote.destination', label: 'Destino de la cotización', subject: 'quote', type: 'text' },
    { path: 'trip.destination', label: 'Destino del viaje', subject: 'trip', type: 'text' },
    { path: 'trip.status', label: 'Estado del viaje', subject: 'trip', type: 'select', options: TRIP_STATUSES },
    { path: 'payment.amount', label: 'Monto del pago', subject: 'payment', type: 'number' },
    { path: 'payment.full', label: 'Viaje liquidado', subject: 'payment', type: 'bool' }
  ];
  const OPS = { eq: 'es igual a', neq: 'no es', contains: 'contiene', gte: 'es mayor o igual a', lte: 'es menor o igual a', empty: 'está vacío', not_empty: 'tiene dato' };
  const CF_SUBJECT = { leads: 'lead', clients: 'client', trips: 'trip' };
  const CF_TYPE = { text: 'text', longtext: 'text', number: 'number', date: 'text', select: 'select', multi: 'multi', bool: 'bool' };
  /** Campos disponibles para un disparador, incluidos los personalizables (TP-306). */
  function fieldsFor(trigger, customDefs = {}) {
    const subjects = subjectsOf(trigger);
    const custom = Object.entries(CF_SUBJECT).flatMap(([entity, subject]) => (customDefs[entity] || []).filter((d) => d.active !== false).map((d) => ({ path: `${subject}.custom.${d.key}`, label: `${subject === 'lead' ? 'Lead' : subject === 'client' ? 'Cliente' : 'Viaje'} · ${d.label}`, subject, type: CF_TYPE[d.type] || 'text', options: d.options || [] })));
    return [...BASE_FIELDS, ...custom].filter((f) => subjects.includes(f.subject));
  }

  // Acciones. needs: datos que deben existir en el contexto.
  const ACTIONS = {
    followup: { label: 'Crear seguimiento', icon: '📌' },
    whatsapp_task: { label: 'Tarea de WhatsApp con plantilla', icon: '💬', help: 'El vendedor la abre y envía con un toque.' },
    email_client: { label: 'Enviar correo al cliente', icon: '✉️', help: 'Solo si el cliente tiene correo y no está marcado “No contactar”.' },
    notify: { label: 'Avisar al equipo', icon: '🔔' },
    set_stage: { label: 'Cambiar etapa del lead', icon: '🔀', needs: 'lead' },
    assign: { label: 'Asignar vendedor', icon: '👤', needs: 'lead' },
    set_field: { label: 'Llenar un campo personalizado', icon: '✏️' },
    add_tag: { label: 'Agregar preferencia al cliente', icon: '🏷️', needs: 'client' }
  };
  const VARIABLES = ['{nombre}', '{cliente}', '{destino}', '{fechas}', '{vendedor}', '{folio}', '{etapa}', '{monto}', '{dias}'];

  const str = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
  const line = (v, n) => str(v, n).replace(/\s+/g, ' ');
  const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def; };
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const fail = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });
  const oneOf = (v, list, def) => (list.includes(v) ? v : def);
  const userRef = (v) => (v === 'owner' || v === 'admins' ? v : /^\d{1,10}$/.test(String(v)) ? Number(v) : 'owner');

  function cleanTrigger(t) {
    const type = TRIGGERS[t?.type] ? t.type : 'lead_created';
    const out = { type };
    if (type === 'lead_stage') out.stage = oneOf(t.stage, ['', ...LEAD_STAGES], '');
    if (type === 'quote_status') out.status = oneOf(t.status, ['', ...QUOTE_STATUSES], '');
    if (type === 'payment_received') out.full = t.full === true;
    if (type === 'lead_idle') out.days = int(t.days, 1, 365, 5);
    if (type === 'trip_before' || type === 'trip_after') out.days = int(t.days, 0, 365, 7);
    if (type === 'date_field') {
      out.entity = oneOf(t.entity, Object.keys(ENTITY_SUBJECTS), 'clients');
      out.field = /^[a-z0-9_]{1,40}$/.test(String(t.field || '')) ? t.field : '';
      if (!out.field) throw fail('Elige el campo de fecha');
      out.days = int(t.days, 0, 365, 0);
      out.when = t.when === 'after' ? 'after' : 'before';
      out.yearly = t.yearly !== false;
    }
    return out;
  }
  function cleanCondition(c) {
    const path = String(c?.path || '');
    if (!/^(lead|client|quote|trip|payment)\.[a-z_]+(\.[a-z0-9_]{1,40})?$/.test(path)) return null;
    const op = OPS[c.op] ? c.op : 'eq';
    return { path, op, value: ['empty', 'not_empty'].includes(op) ? '' : line(c.value, 120) };
  }
  function cleanAction(a) {
    const type = ACTIONS[a?.type] ? a.type : null;
    if (!type) return null;
    const when = { days: int(a.days, 0, 365, 0), hours: int(a.hours, 0, 72, 0), time: TIME_RE.test(String(a.time || '')) ? a.time : '' };
    switch (type) {
      case 'followup': {
        const title = line(a.title, 160);
        if (!title) throw fail('Escribe el título del seguimiento');
        return { type, ftype: oneOf(a.ftype, FOLLOWUP_TYPES, 'Llamada'), title, details: str(a.details, 1000), to: userRef(a.to), ...when };
      }
      case 'whatsapp_task':
        if (!/^[a-z0-9_]{1,30}$/.test(String(a.template || ''))) throw fail('Elige la plantilla de WhatsApp');
        return { type, template: a.template, title: line(a.title, 160), to: userRef(a.to), ...when };
      case 'email_client': {
        const subject = line(a.subject, 160), body = str(a.body, 4000);
        if (!subject || !body) throw fail('Escribe el asunto y el mensaje del correo');
        return { type, subject, body };
      }
      case 'notify': {
        const title = line(a.title, 160);
        if (!title) throw fail('Escribe el aviso');
        return { type, to: userRef(a.to), title, body: line(a.body, 300), email: a.email === true };
      }
      case 'set_stage': {
        const stage = oneOf(a.stage, ['Nuevo', 'Calificado', 'Cotizado', 'Negociación'], '');
        if (!stage) throw fail('Elige la etapa (Nuevo, Calificado, Cotizado o Negociación)');
        return { type, stage };
      }
      case 'assign': return { type, to: a.to === 'auto' ? 'auto' : /^\d{1,10}$/.test(String(a.to)) ? Number(a.to) : 'auto' };
      case 'set_field': {
        const target = oneOf(a.target, ['lead', 'client', 'trip'], 'client');
        if (!/^[a-z0-9_]{1,40}$/.test(String(a.key || ''))) throw fail('Elige el campo a llenar');
        return { type, target, key: a.key, value: line(a.value, 300) };
      }
      case 'add_tag': {
        const tag = line(a.tag, 40).replace(/,/g, ' ');
        if (!tag) throw fail('Escribe la preferencia a agregar');
        return { type, tag };
      }
      default: return null;
    }
  }
  /** Regla limpia: { id, name, active, trigger, match: 'all'|'any', conditions, actions } */
  function cleanRule(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const name = line(r.name, 100);
    if (!name) throw fail('Ponle nombre a la automatización');
    const trigger = cleanTrigger(r.trigger || {});
    const conditions = (Array.isArray(r.conditions) ? r.conditions : []).slice(0, MAX_CONDITIONS).map(cleanCondition).filter(Boolean);
    const actions = (Array.isArray(r.actions) ? r.actions : []).slice(0, MAX_ACTIONS).map(cleanAction).filter(Boolean);
    if (!actions.length) throw fail('Agrega al menos una acción');
    const subjects = subjectsOf(trigger);
    for (const c of conditions) if (!subjects.includes(c.path.split('.')[0])) throw fail(`La condición “${c.path}” no aplica a este disparador`);
    for (const a of actions) {
      const need = ACTIONS[a.type].needs;
      if (need && !subjects.includes(need)) throw fail(`“${ACTIONS[a.type].label}” necesita un ${need === 'lead' ? 'lead' : 'cliente'} en el disparador`);
      if (a.type === 'set_field' && !subjects.includes(a.target)) throw fail('El campo a llenar no aplica a este disparador');
    }
    return {
      id: /^a[a-z0-9]{3,16}$/.test(String(r.id || '')) ? r.id : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name, active: r.active === true, trigger, match: r.match === 'any' ? 'any' : 'all', conditions, actions,
      ...(r.example ? { example: true } : {})
    };
  }

  // ---- Evaluación ----
  const get = (ctx, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  function testCondition(c, ctx) {
    const v = get(ctx, c.path);
    switch (c.op) {
      case 'empty': return isEmpty(v);
      case 'not_empty': return !isEmpty(v);
      case 'gte': return !isEmpty(v) && Number(v) >= Number(c.value);
      case 'lte': return !isEmpty(v) && Number(v) <= Number(c.value);
      case 'contains': return Array.isArray(v) ? v.some((x) => norm(x).includes(norm(c.value))) : norm(v).includes(norm(c.value));
      case 'neq': return !(Array.isArray(v) ? v.map(norm).includes(norm(c.value)) : typeof v === 'boolean' ? String(v) === c.value || (v ? 'si' : 'no') === norm(c.value) : norm(v) === norm(c.value));
      default: return Array.isArray(v) ? v.map(norm).includes(norm(c.value)) : typeof v === 'boolean' ? String(v) === c.value || (v ? 'si' : 'no') === norm(c.value) : norm(v) === norm(c.value);
    }
  }
  function matches(rule, ctx) {
    if (!rule.conditions.length) return true;
    return rule.match === 'any' ? rule.conditions.some((c) => testCondition(c, ctx)) : rule.conditions.every((c) => testCondition(c, ctx));
  }
  /** ¿El evento corresponde al disparador? (parámetros como la etapa o el estado) */
  function triggerMatches(trigger, event) {
    if (trigger.type !== event.type) return false;
    if (trigger.type === 'lead_stage') return !trigger.stage || trigger.stage === event.stage;
    if (trigger.type === 'quote_status') return !trigger.status || trigger.status === event.status;
    if (trigger.type === 'payment_received') return !trigger.full || event.full === true;
    return true;
  }

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const longDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${Number(iso.slice(8, 10))} de ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : '');
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  /** Reemplaza {variables} en los textos de las acciones. */
  function fill(text, ctx) {
    const src = ctx.trip || ctx.lead || ctx.quote || {};
    const start = ctx.trip?.start_date || ctx.lead?.start_date;
    const end = ctx.trip?.end_date || ctx.lead?.end_date;
    const vars = {
      '{nombre}': String(ctx.client?.name || '').trim().split(/\s+/)[0] || '',
      '{cliente}': ctx.client?.name || '',
      '{destino}': src.destination || ctx.quote?.destination || ctx.lead?.destination || '',
      '{fechas}': start ? `${longDate(start)}${end && end !== start ? ` al ${longDate(end)}` : ''}` : '',
      '{vendedor}': ctx.seller?.name || '',
      '{folio}': ctx.quote?.folio || '',
      '{etapa}': ctx.lead?.stage || '',
      '{monto}': ctx.payment ? money(ctx.payment.amount) : ctx.quote ? money(ctx.quote.price) : '',
      '{dias}': ctx.days != null ? String(ctx.days) : ''
    };
    return String(text || '').replace(/\{[a-z_]+\}/g, (k) => (k in vars ? vars[k] : k)).replace(/[ \t]{2,}/g, ' ').trim();
  }
  /** Descripción corta de la regla para la lista. */
  function describe(rule, { users = [], templates = [], customDefs = {} } = {}) {
    const t = rule.trigger, T = TRIGGERS[t.type];
    let when = T.label;
    if (t.type === 'lead_stage' && t.stage) when = `Un lead pasa a ${t.stage}`;
    if (t.type === 'quote_status' && t.status) when = `Una cotización queda ${t.status}`;
    if (t.type === 'payment_received' && t.full) when = 'El cliente liquida su viaje';
    if (t.type === 'lead_idle') when = `Un lead lleva ${t.days} días sin movimiento`;
    if (t.type === 'trip_before') when = t.days ? `Faltan ${t.days} días para el viaje` : 'El día que sale el viaje';
    if (t.type === 'trip_after') when = t.days ? `${t.days} días después del regreso` : 'El día del regreso';
    if (t.type === 'date_field') { const d = (customDefs[t.entity] || []).find((x) => x.key === t.field); when = `${t.days ? `${t.days} días ${t.when === 'after' ? 'después de' : 'antes de'}` : 'El día de'} “${d?.label || t.field}”${t.yearly ? ' (cada año)' : ''}`; }
    const who = (to) => (to === 'owner' ? 'al vendedor' : to === 'admins' ? 'a los administradores' : `a ${users.find((u) => u.id === to)?.name || 'un usuario'}`);
    const after = (a) => (a.days ? ` en ${a.days} ${a.days === 1 ? 'día' : 'días'}` : a.hours ? ` en ${a.hours} h` : '');
    const acts = rule.actions.map((a) => {
      if (a.type === 'followup') return `${a.ftype}: “${a.title}”${after(a)}`;
      if (a.type === 'whatsapp_task') return `WhatsApp “${templates.find((x) => x.id === a.template)?.name || a.template}”${after(a)}`;
      if (a.type === 'email_client') return `Correo “${a.subject}”`;
      if (a.type === 'notify') return `Avisar ${who(a.to)}`;
      if (a.type === 'set_stage') return `Etapa → ${a.stage}`;
      if (a.type === 'assign') return a.to === 'auto' ? 'Asignar automático' : `Asignar a ${users.find((u) => u.id === a.to)?.name || 'vendedor'}`;
      if (a.type === 'set_field') return `Llenar “${a.key}”`;
      if (a.type === 'add_tag') return `Preferencia “${a.tag}”`;
      return a.type;
    });
    return { when, actions: acts, conditions: rule.conditions.length };
  }

  // Reglas de ejemplo (apagadas).
  const EXAMPLES = [
    { name: 'Lead de presupuesto alto → avisar al administrador', example: true, trigger: { type: 'lead_created' }, conditions: [{ path: 'lead.budget', op: 'gte', value: '80000' }], actions: [{ type: 'notify', to: 'admins', title: '💎 Lead de presupuesto alto: {cliente} · {destino}', body: 'Presupuesto alto. Revisa que se atienda rápido.', email: true }] },
    { name: 'Cotización rechazada → llamar en 2 días', example: true, trigger: { type: 'quote_status', status: 'Rechazada' }, conditions: [], actions: [{ type: 'followup', ftype: 'Llamada', title: 'Llamar a {cliente}: ¿qué no le convenció de {destino}?', details: 'La cotización {folio} se rechazó. Pregunta qué ajustar (fechas, hotel, presupuesto).', days: 2, time: '11:00', to: 'owner' }] },
    { name: 'Viaje en 7 días → enviar itinerario digital', example: true, trigger: { type: 'trip_before', days: 7 }, conditions: [], actions: [{ type: 'whatsapp_task', template: 'ci5', title: 'Enviar itinerario digital a {cliente} ({destino})', days: 0, time: '10:00', to: 'owner' }] },
    { name: 'Lead sin movimiento 5 días → recordatorio', example: true, trigger: { type: 'lead_idle', days: 5 }, conditions: [], actions: [{ type: 'whatsapp_task', template: 'se1', title: 'Retomar a {cliente} ({destino}): 5 días sin movimiento', days: 0, to: 'owner' }, { type: 'notify', to: 'owner', title: '⏳ {cliente} lleva 5 días sin movimiento', body: 'Lead de {destino} en etapa {etapa}.' }] },
    { name: 'Viaje liquidado → confirmar reservas', example: true, trigger: { type: 'payment_received', full: true }, conditions: [], actions: [{ type: 'followup', ftype: 'Otro', title: 'Viaje liquidado: confirmar reservas y enviar documentos a {cliente}', details: '{cliente} terminó de pagar {folio}. Revisa que todas las reservas estén confirmadas.', days: 0, hours: 1, to: 'owner' }] }
  ];

  global.TPAuto = { LEAD_STAGES, SOURCES, QUOTE_STATUSES, TRIP_STATUSES, FOLLOWUP_TYPES, TRIGGERS, ACTIONS, OPS, VARIABLES, BASE_FIELDS, EXAMPLES, MAX_RULES, subjectsOf, fieldsFor, cleanRule, cleanAction, cleanTrigger, testCondition, matches, triggerMatches, fill, describe, get };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPAuto;
}(typeof window !== 'undefined' ? window : globalThis));
