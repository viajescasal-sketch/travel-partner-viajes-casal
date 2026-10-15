'use strict';

// TP-310: campañas de recompra a clientes anteriores.
//  - Aniversario del viaje (N días antes de que se cumpla un año más de su viaje).
//  - Cumpleaños del cliente (N días antes).
//  - Temporadas (verano, fin de año… en una fecha fija cada año).
// Una vez al día (en horario laboral) se arma la bandeja "Campañas": cada contacto queda Pendiente para que el vendedor
// lo envíe por WhatsApp con un toque (plantillas de la etapa "Recompra") y lo marque Enviado u Omitido.
// Opcional por campaña: correo automático al cliente. Se respetan los clientes marcados "No contactar en campañas".

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const { buildScope, isVisible, canWrite, SELLER_ROLES } = require('./access');

const WINDOW_DAYS = 14; // un contacto vencido sigue en la bandeja hasta 14 días
const MAX_TOUCHES = 40; // por cliente (se conservan los más recientes)
const DEFAULT_SEASONS = [
  { id: 'verano', name: 'el verano', date: '04-15', enabled: true, email: false },
  { id: 'fin-de-ano', name: 'las vacaciones de fin de año', date: '09-15', enabled: true, email: false },
  { id: 'semana-santa', name: 'Semana Santa', date: '01-20', enabled: false, email: false }
];
const DEFAULTS = {
  enabled: true,
  anniversary: { enabled: true, daysBefore: 30, email: false },
  birthday: { enabled: true, daysBefore: 3, email: false },
  seasons: DEFAULT_SEASONS
};
const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const STATUSES = ['Pendiente', 'Enviado', 'Omitido'];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const intIn = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : def; };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
// 29 de febrero en años no bisiestos → 28.
const onYear = (iso, year) => { const md = iso.slice(5, 10); const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; return `${year}-${md === '02-29' && !leap ? '02-28' : md}`; };

function cleanSettings(saved) {
  const c = { ...DEFAULTS, ...(saved || {}) };
  const kind = (k) => ({ enabled: c[k]?.enabled !== false, daysBefore: intIn(c[k]?.daysBefore, 0, 90, DEFAULTS[k].daysBefore), email: c[k]?.email === true });
  const seasons = (Array.isArray(c.seasons) ? c.seasons : DEFAULT_SEASONS).slice(0, 12).map((s, i) => {
    const name = plain(s?.name, 60);
    if (!name || !MMDD_RE.test(String(s?.date || ''))) return null;
    const id = plain(s.id, 30).toLowerCase().replace(/[^a-z0-9-]/g, '') || `t${i + 1}`;
    return { id, name, date: s.date, enabled: s.enabled !== false, email: s.email === true };
  }).filter(Boolean);
  return { enabled: c.enabled !== false, anniversary: kind('anniversary'), birthday: kind('birthday'), seasons };
}

/**
 * Contactos que tocan hoy para un cliente. data: { trips, leads } del cliente. Devuelve [{ key, kind, name, due, trip_id, years }].
 * Aniversario y temporadas solo a clientes anteriores (viajó o compró) sin lead abierto ni viaje próximo.
 */
function dueTouches(client, { trips = [], leads = [] }, cfg, today) {
  if (!cfg.enabled || client.no_marketing) return [];
  const out = [];
  const year = Number(today.slice(0, 4));
  const inWindow = (due) => due <= today && due >= addDays(today, -WINDOW_DAYS);
  const pastTrips = trips.filter((t) => t.end_date && t.end_date < today);
  const isPastClient = pastTrips.length > 0 || leads.some((l) => l.stage === 'Vendido');
  const busy = leads.some((l) => !['Vendido', 'Perdido'].includes(l.stage)) || trips.some((t) => t.start_date >= today || (t.start_date <= today && t.end_date >= today));
  if (cfg.anniversary.enabled && !busy) {
    for (const t of pastTrips) {
      for (const y of [year, year + 1]) {
        const years = y - Number(t.start_date.slice(0, 4));
        if (years < 1) continue;
        const due = addDays(onYear(t.start_date, y), -cfg.anniversary.daysBefore);
        if (inWindow(due)) out.push({ key: `aniv:${t.id}:${y}`, kind: 'aniversario', name: `Aniversario de su viaje a ${t.destination} (${years} ${years === 1 ? 'año' : 'años'})`, due, trip_id: t.id, years, destination: t.destination });
      }
    }
  }
  if (cfg.birthday.enabled && client.birth_date) {
    for (const y of [year, year + 1]) {
      const due = addDays(onYear(client.birth_date, y), -cfg.birthday.daysBefore);
      if (inWindow(due)) out.push({ key: `cumple:${y}`, kind: 'cumpleanos', name: `Cumpleaños de ${firstName(client.name)} (${onYear(client.birth_date, y).slice(8, 10)}/${client.birth_date.slice(5, 7)})`, due });
    }
  }
  if (isPastClient && !busy) {
    for (const s of cfg.seasons.filter((x) => x.enabled)) {
      for (const y of [year, year + 1]) {
        const due = `${y}-${s.date}`;
        if (inWindow(due)) out.push({ key: `temp:${s.id}:${y}`, kind: 'temporada', name: `Temporada: ${s.name}`, due, season: s.id, campaign: s.name });
      }
    }
  }
  return out;
}

function createRecompra(dataStore, { assignment = null, mailer = null, env = {}, now = () => nowCancun() } = {}) {
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';
  async function settings() { return cleanSettings(await dataStore.getSetting('recompra')); }

  async function sellerFor(client, leads, trips) {
    const ids = [...leads.sort((a, b) => b.id - a.id).map((l) => l.owner_id), ...trips.map((t) => t.owner_id), client.owner_id].filter(Boolean);
    for (const id of ids) { const u = await dataStore.findUserById(id); if (u && u.active && SELLER_ROLES.includes(u.role)) return u; }
    return (await dataStore.listUsers()).find((u) => u.active && u.role === 'admin') || null;
  }
  function emailFor(kind, touch, client, seller, agencyName) {
    const first = firstName(client.name);
    const lines = {
      aniversario: [`¡Hola ${first}!`, `Hace ${touch.years} ${touch.years === 1 ? 'año' : 'años'} estabas disfrutando ${touch.destination}. ¿Qué tal si planeamos la siguiente aventura?`, 'Cuéntanos a dónde te gustaría ir y te armamos opciones a tu medida.'],
      cumpleanos: [`¡Feliz cumpleaños, ${first}! 🎉`, 'Te deseamos un año lleno de viajes y momentos increíbles.', 'Si quieres celebrarlo con una escapada, aquí estamos para ayudarte.'],
      temporada: [`Hola ${first},`, `Ya se acerca ${touch.campaign} y los mejores hoteles y vuelos se apartan con tiempo.`, '¿Te ayudamos a planear tu próximo viaje? Responde este correo o escríbenos por WhatsApp.']
    }[kind];
    const subject = { aniversario: `${first}, ¿planeamos tu próximo viaje?`, cumpleanos: `¡Feliz cumpleaños, ${first}! 🎉`, temporada: `${first}, ya viene ${touch.campaign}` }[kind];
    const sign = `${seller ? `${seller.name}, tu Travel Partner · ` : ''}${agencyName}`;
    return { subject: subject.slice(0, 180), text: `${lines.join('\n\n')}\n\n— ${sign}`, html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">${lines.map((l) => `<p style="font-size:15px">${escapeHtml(l)}</p>`).join('')}<p style="font-size:14px;color:#6c7b87">— ${escapeHtml(sign)}</p></div>` };
  }

  // Una vez al día (lo llama el motor de recordatorios cada 5 min).
  async function runDaily({ workStart = '09:00', workEnd = '20:00', force = false } = {}) {
    const result = { created: 0, emails: 0 };
    const cfg = await settings();
    const current = now();
    const today = current.slice(0, 10);
    const hhmm = current.slice(11, 16);
    const state = (await dataStore.getSetting('recompra_state')) || {};
    if (!force && (state.lastDay === today || hhmm < workStart || hhmm >= workEnd)) return result;
    await dataStore.setSetting('recompra_state', { ...state, lastDay: today, lastRunAt: current });
    if (!cfg.enabled) return result;
    const [clients, leads, trips] = await Promise.all(['clients', 'leads', 'trips'].map((e) => dataStore.listRecords(e)));
    const agencyName = { name: 'Viajes Bumeran Casal', ...((await dataStore.getSetting('agency')) || {}) }.name;
    const perSeller = new Map();
    for (const client of clients) {
      const cl = leads.filter((l) => l.client_id === client.id);
      const ct = trips.filter((t) => t.client_id === client.id);
      const due = dueTouches(client, { trips: ct, leads: cl }, cfg, today);
      if (!due.length) continue;
      const have = new Set((client.campaigns?.touches || []).map((t) => t.key));
      const fresh = due.filter((d) => !have.has(d.key));
      if (!fresh.length) continue;
      const seller = await sellerFor(client, cl, ct);
      const touches = [];
      for (const d of fresh) {
        const kindCfg = d.kind === 'aniversario' ? cfg.anniversary : d.kind === 'cumpleanos' ? cfg.birthday : cfg.seasons.find((s) => s.id === d.season) || {};
        let emailAt = null;
        if (kindCfg.email && client.email && mailer?.configured) {
          try { await mailer.send({ to: client.email, ...emailFor(d.kind, d, client, seller, agencyName) }); emailAt = current; result.emails += 1; } catch (error) { console.error('Campañas: no se pudo enviar el correo:', error.message); }
        }
        touches.push({ id: `c${Date.now().toString(36)}${result.created}`, ...d, status: 'Pendiente', owner_id: seller?.id || null, created_at: current, email_sent_at: emailAt, done_at: null, by: null });
        result.created += 1;
      }
      const list = [...(client.campaigns?.touches || []), ...touches].slice(-MAX_TOUCHES);
      await dataStore.updateRecord('clients', client.id, { campaigns: { touches: list } });
      if (seller) perSeller.set(seller.id, { seller, n: (perSeller.get(seller.id)?.n || 0) + touches.length });
    }
    for (const { seller, n } of perSeller.values()) {
      if (assignment) await assignment.notify(seller, { kind: 'campaign', link: 'campaigns', title: `📣 ${n} ${n === 1 ? 'cliente' : 'clientes'} para campañas de recompra`, body: 'Ábrelos en Campañas: el WhatsApp ya va con el mensaje listo' });
    }
    if (result.created) await dataStore.logActivity(null, 'crm_settings_update', null, { note: `Campañas de recompra: ${result.created} contactos nuevos${result.emails ? `, ${result.emails} correos enviados` : ''}` });
    return result;
  }

  // ---- Rutas con sesión ----
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
  async function scoped(req) {
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    return { data, scope: buildScope(req.session.user, data) };
  }

  router.get('/campaigns', wrap(async (req, res) => {
    const { data, scope } = await scoped(req);
    const touches = data.clients.filter((c) => isVisible(scope, 'clients', c.id)).flatMap((c) => (c.campaigns?.touches || []).map((t) => ({ ...t, client_id: c.id, client_name: c.name, phone: c.phone, email: c.email })));
    res.json({ ok: true, touches: touches.sort((a, b) => String(b.due).localeCompare(String(a.due))), settings: await settings(), state: (await dataStore.getSetting('recompra_state')) || {} });
  }));
  router.patch('/clients/:id/campaigns/:tid', wrap(async (req, res) => {
    if (!canWrite(req.session.user, 'followups')) throw fail(403, 'Tu rol no permite esta acción');
    const { data, scope } = await scoped(req);
    const id = Number(req.params.id);
    const client = data.clients.find((c) => c.id === id);
    if (!client || !isVisible(scope, 'clients', id)) throw fail(404, 'No se encontró el cliente');
    const touches = client.campaigns?.touches || [];
    const t = touches.find((x) => x.id === req.params.tid);
    if (!t) throw fail(404, 'No se encontró el contacto');
    const status = STATUSES.includes(req.body?.status) ? req.body.status : null;
    if (!status) throw new ValidationError('Estado inválido');
    Object.assign(t, { status, done_at: status === 'Pendiente' ? null : now(), by: status === 'Pendiente' ? null : req.session.user.id, note: plain(req.body?.note ?? t.note, 200) });
    await dataStore.updateRecord('clients', client.id, { campaigns: { touches } });
    await dataStore.logActivity(req.session.user.id, 'crm_clients_update', req, { entity: 'clients', entityId: client.id, summary: client.name, note: `Campaña “${t.name}”: ${status}` });
    res.json({ ok: true, touch: t });
  }));
  router.get('/campaigns/settings', wrap(async (req, res) => { res.json({ ok: true, ...(await settings()) }); }));
  router.put('/campaigns/settings', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw fail(403, 'Solo el administrador');
    const b = req.body || {};
    if (Array.isArray(b.seasons) && b.seasons.some((s) => !MMDD_RE.test(String(s?.date || '')) || !plain(s?.name, 60))) throw new ValidationError('Cada temporada necesita nombre y fecha (MM-DD)');
    const saved = cleanSettings({ ...(await settings()), ...b });
    await dataStore.setSetting('recompra', saved);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Campañas de recompra: ${saved.enabled ? 'activas' : 'pausadas'} · aniversario ${saved.anniversary.enabled ? `${saved.anniversary.daysBefore} días antes` : 'no'} · cumpleaños ${saved.birthday.enabled ? `${saved.birthday.daysBefore} días antes` : 'no'} · ${saved.seasons.filter((s) => s.enabled).length} temporadas` });
    res.json({ ok: true, ...saved });
  }));
  router.post('/campaigns/run', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw fail(403, 'Solo el administrador');
    res.json({ ok: true, result: await runDaily({ force: true }) });
  }));

  return { router, runDaily, settings };
}

module.exports = { createRecompra, cleanSettings, dueTouches, DEFAULTS, onYear };
