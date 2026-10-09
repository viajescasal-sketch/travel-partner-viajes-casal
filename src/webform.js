'use strict';

// Formulario web conectado al CRM (reemplaza a Tally): página pública incrustable en el sitio y landings.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { nowCancun, ValidationError } = require('./crm-schema');
const { SELLER_ROLES } = require('./access');
const { createLeadIntake } = require('./lead-intake');
const { cleanPhone, norm } = require('./bot-intake');

// Preguntas del formulario (mismas que el Tally, más las de calificación). El navegador las recibe de aquí.
const FORM = {
  services: [
    { id: 'paquete', label: 'Paquete completo', hint: 'Vuelo + hotel + traslados', icon: '🧳' },
    { id: 'vuelo', label: 'Solo vuelo', hint: 'Boletos de avión', icon: '✈️' },
    { id: 'hotel', label: 'Solo hospedaje', hint: 'Hotel, villa o departamento', icon: '🏨' },
    { id: 'tours', label: 'Solo tours o experiencias', hint: 'Cenotes, barco, cultura…', icon: '🌴' },
    { id: 'asesoria', label: 'No sé, quiero que me asesoren', hint: 'Te ayudamos a armarlo', icon: '💬' }
  ],
  tipoVuelo: ['Redondo', 'Solo ida', 'Aún no sé'],
  hospedaje: ['Todo incluido', 'Hotel boutique', 'Departamento o villa privada', 'No tengo preferencia, quiero recomendaciones'],
  experiencias: ['Cenotes y aventura', 'Zonas arqueológicas o cultura', 'Tours en barco o snorkel', 'Vida nocturna o entretenimiento', 'Gastronomía', 'Aún no sé, quiero opciones'],
  preocupacion: ['No sé por dónde empezar', 'Me preocupa el presupuesto', 'Miedo a que algo salga mal o a estafas', 'Solo quiero que alguien más lo resuelva'],
  fechas: ['Tengo fechas fijas', 'Mis fechas son flexibles', 'Aún no tengo fechas'],
  cuando: ['Este mes', 'En 1 a 3 meses', 'En 3 a 6 meses', 'En más de 6 meses'],
  noches: ['2-3', '4-6', '7 o más', 'No estoy seguro'],
  presupuesto: ['Menos de $8,000 MXN', '$8,000 a $15,000 MXN', '$15,000 a $25,000 MXN', 'Más de $25,000 MXN', 'Prefiero que me orienten según lo que incluye'],
  etapa: ['Solo estoy explorando ideas', 'Ya quiero ver opciones y precios', 'Quiero reservar pronto (esta semana o las próximas 2)'],
  motivo: ['Vacaciones', 'Luna de miel', 'Aniversario', 'Viaje familiar', 'Viaje con amigos', 'Cumpleaños', 'Otro'],
  quien: ['Yo decido', 'Lo decido con mi pareja o familia', 'Estoy cotizando para alguien más']
};
const PER_PERSON = [8000, 15000, 25000, 25000, null];
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULTS = { enabled: true, ownerId: null, notifyEmail: true, whatsapp: '' };

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const oneOf = (value, list) => (list.includes(value) ? value : '');
const validDate = (value) => {
  if (!ISO_RE.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const fmtDate = (iso) => {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return iso ? `${Number(iso.slice(8, 10))} ${months[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '';
};

// 10 dígitos sin lada = México.
const phoneFrom = (raw) => (/^\D*(\d\D*){10}$/.test(raw) && !raw.trim().startsWith('+') ? cleanPhone(`52${raw.replace(/\D/g, '')}`) : cleanPhone(raw));

// Valida y ordena lo que manda el formulario.
function readForm(body, today) {
  const b = body && typeof body === 'object' ? body : {};
  const f = {
    nombre: text(b.nombre, 120),
    telefono: phoneFrom(text(b.whatsapp, 40)),
    correo: text(b.correo, 254).toLowerCase(),
    servicio: FORM.services.find((s) => s.id === b.servicio) || null,
    ciudadSalida: text(b.ciudadSalida, 120),
    tipoVuelo: oneOf(b.tipoVuelo, FORM.tipoVuelo),
    hospedaje: oneOf(b.hospedaje, FORM.hospedaje),
    experiencias: (Array.isArray(b.experiencias) ? b.experiencias : []).filter((x) => FORM.experiencias.includes(x)).slice(0, FORM.experiencias.length),
    preocupacion: oneOf(b.preocupacion, FORM.preocupacion),
    destino: text(b.destino, 120),
    fechas: oneOf(b.fechas, FORM.fechas),
    llegada: validDate(b.llegada),
    regreso: validDate(b.regreso),
    cuando: oneOf(b.cuando, FORM.cuando),
    adultos: Math.min(Math.max(parseInt(b.adultos, 10) || 0, 0), 60),
    ninos: Math.min(Math.max(parseInt(b.ninos, 10) || 0, 0), 30),
    edades: text(b.edades, 80),
    noches: oneOf(b.noches, FORM.noches),
    presupuesto: oneOf(b.presupuesto, FORM.presupuesto),
    etapa: oneOf(b.etapa, FORM.etapa),
    motivo: oneOf(b.motivo, FORM.motivo),
    quien: oneOf(b.quien, FORM.quien),
    comentarios: text(b.comentarios, 1500),
    origen: text(b.origen, 80).replace(/[^\w .:/-]/g, ''),
    utm: ['utm_source', 'utm_medium', 'utm_campaign'].map((k) => text(b[k], 60).replace(/[^\w .:/-]/g, '')).filter(Boolean).join(' / '),
    pagina: text(b.pagina, 200).replace(/[^\w .:/?=&%#-]/g, '')
  };
  if (f.nombre.length < 2) throw new ValidationError('Escribe tu nombre');
  if (!f.telefono) throw new ValidationError('Escribe un WhatsApp válido (con lada)');
  if (f.correo && !EMAIL_RE.test(f.correo)) throw new ValidationError('Revisa tu correo');
  if (!f.servicio) throw new ValidationError('Elige qué necesitas para tu viaje');
  if (!f.destino) throw new ValidationError('Escribe a qué destino te gustaría viajar');
  if (!f.adultos) throw new ValidationError('Indica cuántos adultos viajan');
  if (f.llegada && f.llegada < today) throw new ValidationError('La fecha de llegada ya pasó');
  if (f.llegada && f.regreso && f.regreso < f.llegada) throw new ValidationError('La fecha de regreso no puede ser antes de la llegada');
  if (f.fechas === FORM.fechas[2]) { f.llegada = null; f.regreso = null; }
  if (!f.llegada) f.regreso = null;
  return f;
}

// Respuestas de calificación del CRM a partir del formulario (se busca la opción por su texto).
function qualificationAnswers(f, questions, today) {
  const pick = (id, re) => {
    const q = questions.find((x) => x.id === id);
    return q ? (q.options.find((o) => re.test(norm(o.label))) || {}).label || null : null;
  };
  const answers = {};
  const budgetIndex = FORM.presupuesto.indexOf(f.presupuesto);
  if (budgetIndex >= 0) answers.q_presupuesto = pick('q_presupuesto', [/menos de \$?8/, /8 a \$?15/, /15 a \$?25/, /mas de \$?25/, /no lo sabe|no sabe|orient/][budgetIndex]);
  const stageIndex = FORM.etapa.indexOf(f.etapa);
  if (stageIndex >= 0) answers.q_decision = pick('q_decision', [/explor/, /compar/, /listo|reservar/][stageIndex]);
  const datesIndex = FORM.fechas.indexOf(f.fechas);
  if (datesIndex >= 0) answers.q_fechas = pick('q_fechas', [/^si|fija/, /flexib/, /aun no|todavia/][datesIndex]);
  let whenIndex = FORM.cuando.indexOf(f.cuando);
  if (f.llegada) {
    const days = daysBetween(today, f.llegada);
    whenIndex = days <= 31 ? 0 : days <= 92 ? 1 : days <= 183 ? 2 : 3;
  }
  if (whenIndex >= 0) answers.q_cuando = pick('q_cuando', [/este mes/, /1 a 3/, /3 a 6/, /mas de 6|sin fecha/][whenIndex]);
  const whoIndex = FORM.quien.indexOf(f.quien);
  if (whoIndex >= 0) answers.q_quien = pick('q_quien', [/mismo|el cliente|yo/, /pareja|familia/, /alguien/][whoIndex]);
  return Object.fromEntries(Object.entries(answers).filter(([, v]) => v));
}

function travelersText(f) {
  const kids = f.ninos ? `, ${f.ninos} ${f.ninos === 1 ? 'niño' : 'niños'}${f.edades ? ` (edades: ${f.edades})` : ''}` : '';
  return `${f.adultos} ${f.adultos === 1 ? 'adulto' : 'adultos'}${kids}`;
}
function datesText(f) {
  if (f.llegada) return `${fmtDate(f.llegada)}${f.regreso ? ` al ${fmtDate(f.regreso)}` : ''}${f.fechas === FORM.fechas[1] ? ' (flexibles)' : ''}`;
  return f.cuando ? `Sin fechas aún · ${f.cuando}` : 'Sin fechas aún';
}
function summaryRows(f) {
  return [
    ['Servicio', f.servicio.label], ['Ciudad de salida', f.ciudadSalida], ['Tipo de vuelo', f.tipoVuelo], ['Hospedaje', f.hospedaje],
    ['Experiencias', f.experiencias.join(', ')], ['Le preocupa', f.preocupacion], ['Destino', f.destino], ['Fechas', datesText(f)],
    ['Viajeros', travelersText(f)], ['Noches', f.noches], ['Presupuesto por persona', f.presupuesto], ['Etapa', f.etapa],
    ['Motivo', f.motivo], ['Decide', f.quien], ['Correo', f.correo], ['Comentarios', f.comentarios],
    ['Origen', [f.origen, f.utm, f.pagina].filter(Boolean).join(' · ')]
  ].filter(([, v]) => v);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function leadEmail({ f, lead, seller, appUrl, action, score }) {
  const rows = [['Cliente', f.nombre], ['WhatsApp', f.telefono], ...summaryRows(f)];
  const level = score?.level ? `${score.score}% ${score.level}` : 'Sin calificar';
  const title = action === 'created' ? 'Nuevo lead del formulario web' : 'Un cliente con lead abierto volvió a llenar el formulario';
  const textBody = `Hola ${seller.name},\n\n${title}: ${f.nombre} · ${lead.destination}.\nCalificación: ${level}\nContáctalo por WhatsApp en los próximos 15 minutos.\n\n${rows.map(([k, v]) => `• ${k}: ${v}`).join('\n')}\n\nAbrir la plataforma: ${appUrl}\n\n— Travel Partner Viajes Casal`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">
<p style="font-size:15px">Hola ${escapeHtml(seller.name)},</p>
<p style="font-size:15px"><b>${escapeHtml(title)}:</b> ${escapeHtml(f.nombre)} · ${escapeHtml(lead.destination)}<br>Calificación: <b>${escapeHtml(level)}</b><br>Contáctalo por WhatsApp en los próximos 15 minutos.</p>
<table style="border-collapse:collapse;font-size:13px;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #dce6ea;color:#6c7b87;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #dce6ea">${escapeHtml(v)}</td></tr>`).join('')}</table>
<p style="margin-top:18px"><a href="${escapeHtml(appUrl)}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>`;
  return { subject: `${action === 'created' ? 'Nuevo lead' : 'Lead actualizado'} del formulario web · ${f.nombre} · ${lead.destination}`.slice(0, 180), text: textBody, html };
}

function createWebform(dataStore, mailer, env = {}, { assignment } = {}) {
  const intake = createLeadIntake(dataStore, assignment);
  async function config() {
    return { ...DEFAULTS, ...(await dataStore.getSetting('webform') || {}) };
  }
  // WhatsApp al que el cliente escribe al terminar: el del formulario o el de la agencia.
  async function whatsappNumber(cfg) {
    const documents = await dataStore.getSetting('documents') || {};
    const agency = await dataStore.getSetting('agency') || {};
    const raw = cfg.whatsapp || documents.supportWhatsapp || agency.whatsapp || '+52 998 763 6565';
    return String(raw).replace(/\D/g, '');
  }
  const appUrlFor = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

  const router = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, skipFailedRequests: true, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Recibimos varias solicitudes desde tu conexión. Intenta de nuevo en unos minutos o escríbenos por WhatsApp.' } });

  router.get('/public/form', async (req, res, next) => {
    try {
      const cfg = await config();
      const agency = await dataStore.getSetting('agency') || {};
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, enabled: Boolean(cfg.enabled), agency: agency.name || 'Viajes Bumeran Casal', whatsapp: await whatsappNumber(cfg), form: FORM, today: nowCancun().slice(0, 10) });
    } catch (error) { next(error); }
  });

  router.post('/public/lead', limiter, async (req, res, next) => {
    try {
      const cfg = await config();
      if (!cfg.enabled) { res.status(403).json({ ok: false, error: 'El formulario no está disponible por ahora. Escríbenos por WhatsApp.' }); return; }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const wa = await whatsappNumber(cfg);
      // Trampas para robots: envío en menos de 4 segundos, o campo oculto lleno en menos de 20 segundos.
      // Se responde "ok" sin guardar, pero queda registrado para revisarlo en Integraciones.
      const elapsed = Number(body.elapsed) || 0;
      const honeypot = text(body.hp_check ?? body.website, 200);
      const blockReason = elapsed < 4000 ? `envío en ${Math.round(elapsed / 100) / 10} s` : honeypot && elapsed < 20000 ? 'campo oculto lleno' : '';
      if (blockReason) {
        const name = text(body.nombre, 60) || 'sin nombre';
        console.warn(`Formulario web: envío bloqueado como posible spam (${blockReason}) · ${name}`);
        await dataStore.setSetting('webform', { ...cfg, blockedCount: (Number(cfg.blockedCount) || 0) + 1, lastBlockedAt: nowCancun(), lastBlocked: `${name} · ${blockReason}` });
        res.status(201).json({ ok: true, whatsapp: wa });
        return;
      }

      const now = nowCancun();
      const today = now.slice(0, 10);
      const f = readForm(body, today);
      const questions = await intake.questions();
      const answers = qualificationAnswers(f, questions, today);
      const travelers = f.adultos + f.ninos;
      const perPerson = PER_PERSON[FORM.presupuesto.indexOf(f.presupuesto)] ?? null;
      const warn = honeypot ? '\n⚠ Revisar: el campo oculto antispam llegó lleno (puede ser autocompletado del navegador).' : '';
      const notes = `🌐 Formulario web · ${now.slice(0, 16)}\n${summaryRows(f).map(([k, v]) => `• ${k}: ${v}`).join('\n')}${warn}`;
      const result = await intake.intake({
        channel: { label: 'formulario web', source: 'Sitio web', ownerId: cfg.ownerId },
        person: { name: f.nombre, phone: f.telefono, email: f.correo || null },
        lead: { destination: f.destino, start: f.llegada, end: f.regreso, travelers, budget: perPerson ? perPerson * travelers : null },
        answers,
        notes,
        followupDetails: [f.destino, datesText(f), f.presupuesto ? `Presupuesto: ${f.presupuesto}` : null, f.etapa].filter(Boolean).join(' · ')
      });

      // Correo al vendedor (si está activado y el correo de la plataforma funciona).
      let mail = 'Sin aviso por correo';
      if (cfg.notifyEmail && mailer.configured && result.seller?.email) {
        try {
          await mailer.send({ to: result.seller.email, ...leadEmail({ f, lead: result.lead, seller: result.seller, appUrl: appUrlFor(req), action: result.action, score: result.lead.qualification }) });
          mail = `Aviso enviado a ${result.seller.name}`;
        } catch (error) {
          mail = 'No se pudo enviar el aviso por correo';
          console.error('Formulario web: no se pudo enviar el aviso:', error.message);
        }
      }
      if (assignment && result.seller) {
        await assignment.notify(result.seller, result.action === 'created'
          ? { kind: 'assigned', title: `Nuevo lead: ${result.client.name} · ${result.lead.destination}`, body: `Formulario web (${String(result.reason || '').toLowerCase()})`, leadId: result.lead.id }
          : { kind: 'lead_update', title: `${result.client.name} volvió a llenar el formulario`, body: `Lead ${result.lead.destination} actualizado`, leadId: result.lead.id });
      }
      await dataStore.setSetting('webform', { ...cfg, lastAt: now, lastResult: `${result.action === 'created' ? 'Lead creado' : 'Lead actualizado'} · ${result.client.name} · ${mail}` });
      res.status(201).json({ ok: true, whatsapp: wa });
    } catch (error) {
      next(error);
    }
  });

  return { router, config };
}

function createWebformAdminRouter(dataStore, webform, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const publicConfig = (cfg) => ({ enabled: Boolean(cfg.enabled), ownerId: cfg.ownerId ?? null, notifyEmail: cfg.notifyEmail !== false, whatsapp: cfg.whatsapp || '', lastAt: cfg.lastAt || null, lastResult: cfg.lastResult || null, blockedCount: Number(cfg.blockedCount) || 0, lastBlockedAt: cfg.lastBlockedAt || null, lastBlocked: cfg.lastBlocked || null });

  router.get('/integrations/webform', adminOnly, wrap(async (req, res) => {
    res.json({ ok: true, ...publicConfig(await webform.config()) });
  }));

  router.put('/integrations/webform', adminOnly, wrap(async (req, res) => {
    const cfg = await webform.config();
    const body = req.body || {};
    const next = { ...cfg };
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (body.notifyEmail !== undefined) next.notifyEmail = Boolean(body.notifyEmail);
    if (body.whatsapp !== undefined) {
      const wa = String(body.whatsapp || '').trim();
      if (wa && !cleanPhone(wa)) throw new ValidationError('Escribe un WhatsApp válido con lada, por ejemplo +52 998 123 4567');
      next.whatsapp = wa ? cleanPhone(wa) : '';
    }
    if (body.ownerId !== undefined) {
      if (body.ownerId === null || body.ownerId === '') next.ownerId = null;
      else {
        const user = await dataStore.findUserById(Number(body.ownerId));
        if (!user || !user.active || !SELLER_ROLES.includes(user.role)) throw new ValidationError('Elige un vendedor activo');
        next.ownerId = user.id;
      }
    }
    await dataStore.setSetting('webform', next);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: 'Formulario web' });
    res.json({ ok: true, ...publicConfig(next) });
  }));

  return router;
}

module.exports = { createWebform, createWebformAdminRouter, readForm, qualificationAnswers, FORM };
