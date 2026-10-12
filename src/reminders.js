'use strict';

// Recordatorios automáticos (TP-106):
//  1) Cotización "Enviada" sin respuesta en 48 h → seguimiento al vendedor + aviso (campanita y correo).
//  2) Lead nuevo sin contacto en 2 h de horario laboral → aviso al vendedor; si sigue sin contacto
//     2 h laborales después → aviso también a los administradores.
// Corre cada 5 minutos en el servidor (con candado para que no se duplique).

const express = require('express');
const { ValidationError, nowCancun, sanitize } = require('./crm-schema');

const CHECK_EVERY_MS = 5 * 60 * 1000;
const CLOSED = ['Vendido', 'Perdido'];
const DEFAULTS = {
  enabled: true,
  quoteHours: 48, // cotización enviada sin respuesta
  contactHours: 2, // lead nuevo sin contacto (horas laborales)
  escalateHours: 2, // después del primer aviso, avisar al administrador (horas laborales; 0 = nunca)
  workStart: '09:00',
  workEnd: '20:00',
  email: true
};
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- Fechas en hora de Cancún ("AAAA-MM-DD HH:MM:SS") ----
const toMs = (s) => Date.parse(`${String(s).slice(0, 19).replace(' ', 'T')}Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const minutesOfDay = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Suma minutos contando solo el horario laboral (todos los días).
function addWorkMinutes(start, minutes, { workStart, workEnd }) {
  const open = minutesOfDay(workStart);
  const close = minutesOfDay(workEnd);
  if (close <= open) return fromMs(toMs(start) + minutes * 60000); // horario inválido → 24 h
  let ms = toMs(start);
  let left = minutes;
  for (let guard = 0; guard < 400; guard += 1) {
    const day = Math.floor(ms / 86400000) * 86400000;
    const now = (ms - day) / 60000;
    if (now < open) { ms = day + open * 60000; continue; }
    if (now >= close) { ms = day + 86400000 + open * 60000; continue; }
    const available = close - now;
    if (left <= available) return fromMs(ms + left * 60000);
    left -= available;
    ms = day + 86400000 + open * 60000;
  }
  return fromMs(ms);
}
// Si la hora cae fuera del horario laboral, la pasa al siguiente inicio.
const nextWorkTime = (at, cfg) => addWorkMinutes(at, 0, cfg);

function cleanConfig(saved) {
  const cfg = { ...DEFAULTS, ...(saved || {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.email = cfg.email !== false;
  cfg.quoteHours = Math.min(Math.max(Number(cfg.quoteHours) || DEFAULTS.quoteHours, 1), 720);
  cfg.contactHours = Math.min(Math.max(Number(cfg.contactHours) || DEFAULTS.contactHours, 0.25), 72);
  cfg.escalateHours = Math.min(Math.max(Number(cfg.escalateHours) || 0, 0), 72);
  if (!HHMM_RE.test(String(cfg.workStart))) cfg.workStart = DEFAULTS.workStart;
  if (!HHMM_RE.test(String(cfg.workEnd))) cfg.workEnd = DEFAULTS.workEnd;
  return cfg;
}

function emailFor({ to, title, lines, appUrl }) {
  const text = `Hola ${to.name},\n\n${title}\n\n${lines.map((l) => `• ${l}`).join('\n')}\n\nAbrir la plataforma: ${appUrl}\n\n— Travel Partner Viajes Casal`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">
<p style="font-size:15px">Hola ${escapeHtml(to.name)},</p>
<p style="font-size:15px"><b>${escapeHtml(title)}</b></p>
<ul style="font-size:14px;line-height:1.6">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
<p style="margin-top:18px"><a href="${escapeHtml(appUrl)}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>`;
  return { subject: title.slice(0, 180), text, html };
}

function createReminders(dataStore, assignment, env = {}, { now = () => nowCancun(), payments = null } = {}) {
  const appUrl = () => String(env.APP_URL || '').trim().replace(/\/+$/, '') || 'https://travelpartner.viajescasal.com';
  async function config() { return cleanConfig(await dataStore.getSetting('reminders')); }

  async function notify(user, { kind, title, body, leadId, lines, cfg }) {
    if (!assignment || !user) return;
    await assignment.notify(user, { kind, title, body, leadId, email: cfg.email ? emailFor({ to: user, title, lines, appUrl: appUrl() }) : null });
  }

  async function runOnce() {
    const cfg = await config();
    const state = (await dataStore.getSetting('reminders_state')) || {};
    const current = now();
    if (!state.startedAt) {
      // Primera vez: lo anterior no dispara alertas de golpe.
      state.startedAt = current;
    }
    const result = { quotes: 0, contact: 0, escalated: 0, overdue: 0, at: current };
    if (!state.overdueStartedAt) state.overdueStartedAt = current; // TP-110: lo vencido antes de activar no avisa de golpe
    if (!cfg.enabled) { await dataStore.setSetting('reminders_state', { ...state, lastRunAt: current, lastResult: 'Pausados' }); return result; }

    const [quotes, leads, clients, followups, users] = await Promise.all(['quotes', 'leads', 'clients', 'followups'].map((e) => dataStore.listRecords(e)).concat(dataStore.listUsers()));
    const userById = (id) => users.find((u) => u.id === Number(id) && u.active) || null;
    const clientById = (id) => clients.find((c) => c.id === Number(id)) || null;
    const leadById = (id) => leads.find((l) => l.id === Number(id)) || null;
    const admins = users.filter((u) => u.active && u.role === 'admin');

    // 1) Cotizaciones enviadas sin respuesta
    for (const q of quotes) {
      if (q.status !== 'Enviada' || q.reminder_at) continue;
      const lead = leadById(q.lead_id);
      if (lead && CLOSED.includes(lead.stage)) continue;
      let sent = q.sent_at || q.updated_at || q.created_at;
      if (!sent) continue;
      if (sent < state.startedAt) sent = state.startedAt;
      if (toMs(current) - toMs(sent) < cfg.quoteHours * 3600000) continue;
      const client = clientById(q.client_id);
      const ownerId = lead?.owner_id ?? q.owner_id;
      const seller = userById(ownerId) || admins[0] || null;
      const pending = followups.find((f) => !f.done && ((q.lead_id && f.lead_id === q.lead_id) || (!q.lead_id && f.client_id === q.client_id)) && f.type === 'Cotización');
      let followup = pending || null;
      if (!pending) {
        followup = await dataStore.insertRecord('followups', sanitize('followups', {
          client_id: q.client_id, lead_id: q.lead_id || null, type: 'Cotización',
          title: `Dar seguimiento a la cotización ${q.folio || ''} · ${client?.name || 'cliente'}`.replace(/\s+/g, ' ').slice(0, 160),
          details: `Enviada hace más de ${cfg.quoteHours} h sin respuesta. ${q.hotel ? `Hotel: ${q.hotel}. ` : ''}Pregunta si tiene dudas o si quiere ajustar fechas u opciones.`.slice(0, 2000),
          due_at: nextWorkTime(current, cfg).slice(0, 16)
        }), seller?.id ?? null);
        followups.push(followup);
        await dataStore.logActivity(null, 'crm_followups_create', null, { entity: 'followups', entityId: followup.id, summary: followup.title, note: 'Recordatorio automático: cotización sin respuesta' });
      }
      await dataStore.updateRecord('quotes', q.id, { reminder_at: current });
      await notify(seller, {
        cfg, kind: 'reminder', leadId: q.lead_id || null,
        title: `Cotización sin respuesta: ${client?.name || 'cliente'} · ${q.destination}`,
        body: `${q.folio || 'Cotización'} enviada hace más de ${cfg.quoteHours} h${pending ? ' · ya tienes un seguimiento pendiente' : ' · se programó un seguimiento'}`,
        lines: [`Cliente: ${client?.name || '—'}${client?.phone ? ` · WhatsApp ${client.phone}` : ''}`, `Cotización ${q.folio || ''} · ${q.destination}${q.hotel ? ` · ${q.hotel}` : ''}`, `Enviada: ${String(sent).slice(0, 16)} (más de ${cfg.quoteHours} h sin respuesta)`, `Seguimiento: ${String(followup?.due_at || '').slice(0, 16)}`]
      });
      result.quotes += 1;
    }

    // 2) Leads nuevos sin contacto
    for (const l of leads) {
      if (l.stage !== 'Nuevo' || l.contacted_at || CLOSED.includes(l.stage)) continue;
      const base = l.assigned_at || l.created_at;
      if (!base || String(base) < state.startedAt) continue;
      const due = addWorkMinutes(base, Math.round(cfg.contactHours * 60), cfg);
      if (current < due) continue;
      const client = clientById(l.client_id);
      const seller = userById(l.owner_id);
      const lines = [`Cliente: ${client?.name || '—'}${client?.phone ? ` · WhatsApp ${client.phone}` : ''}`, `Destino: ${l.destination}`, `Llegó: ${String(base).slice(0, 16)} · origen ${l.source}`, 'Escríbele por WhatsApp y marca “Ya lo contacté” en la ficha del lead.'];
      if (!l.contact_alert_at) {
        await notify(seller || admins[0], {
          cfg, kind: 'contact_alert', leadId: l.id,
          title: `⏰ Lead sin contacto: ${client?.name || 'cliente'} · ${l.destination}`,
          body: `Lleva más de ${cfg.contactHours} h${cfg.contactHours === 1 ? '' : ''} sin contacto`,
          lines
        });
        await dataStore.updateRecord('leads', l.id, { contact_alert_at: current });
        result.contact += 1;
        continue;
      }
      if (!cfg.escalateHours || l.contact_escalated_at) continue;
      if (current < addWorkMinutes(l.contact_alert_at, Math.round(cfg.escalateHours * 60), cfg)) continue;
      for (const admin of admins) {
        if (admin.id === seller?.id) continue; // ya recibió el primer aviso
        await notify(admin, {
          cfg, kind: 'contact_escalation', leadId: l.id,
          title: `⚠ ${seller?.name || 'Sin vendedor'} no ha contactado a ${client?.name || 'un cliente'}`,
          body: `${l.destination} · sin contacto desde ${String(base).slice(11, 16)} (${String(base).slice(0, 10)})`,
          lines: [`Vendedor: ${seller?.name || 'Sin asignar'}`, ...lines.slice(0, 3)]
        });
      }
      await dataStore.updateRecord('leads', l.id, { contact_escalated_at: current });
      result.escalated += 1;
    }

    // 3) Seguimientos vencidos (TP-110): aviso en la campanita 15 minutos después de la hora, una sola vez.
    for (const f of followups) {
      if (f.done || f.overdue_notified_at || !f.due_at) continue;
      if (String(f.due_at) < state.overdueStartedAt) continue;
      if (toMs(current) - toMs(f.due_at) < 15 * 60000) continue;
      const lead = leadById(f.lead_id);
      if (lead && CLOSED.includes(lead.stage)) continue;
      const owner = userById(f.owner_id ?? lead?.owner_id) || null;
      const client = clientById(f.client_id);
      if (owner && assignment) {
        await assignment.notify(owner, { kind: 'followup_overdue', leadId: f.lead_id || null, link: `followup:${f.id}`, title: `⏰ Seguimiento vencido: ${f.title}`.slice(0, 200), body: `${f.type}${client ? ` · ${client.name}` : ''} · era a las ${String(f.due_at).slice(11, 16)} del ${String(f.due_at).slice(8, 10)}/${String(f.due_at).slice(5, 7)}` });
      }
      await dataStore.updateRecord('followups', f.id, { overdue_notified_at: current });
      result.overdue += 1;
    }

    // 4) TP-202: recordatorios de saldo (antes y el día del vencimiento; aviso si se vence).
    if (payments) {
      try {
        const p = await payments.runReminders({ workStart: cfg.workStart, workEnd: cfg.workEnd, email: cfg.email });
        result.payments = p.before + p.due + p.overdue;
        result.paymentEmails = p.emails;
      } catch (error) { console.error('Recordatorios de pago fallaron:', error.message); }
    }

    const parts = [result.quotes && `${result.quotes} cotizaciones`, result.payments && `${result.payments} cobros`, result.overdue && `${result.overdue} seguimientos vencidos`, result.contact && `${result.contact} leads sin contacto`, result.escalated && `${result.escalated} avisos al administrador`].filter(Boolean);
    await dataStore.setSetting('reminders_state', { ...state, lastRunAt: current, lastResult: parts.length ? `Avisos: ${parts.join(', ')}` : 'Sin pendientes', ...(parts.length ? { lastAlertAt: current, lastAlert: parts.join(', ') } : {}) });
    return result;
  }

  let running = null;
  function run() {
    if (!running) {
      running = (async () => {
        const job = () => runOnce();
        return (await dataStore.withLock('tp_reminders', job, 1)) ?? null;
      })().catch((error) => { console.error('Recordatorios automáticos fallaron:', error.message); return null; }).finally(() => { running = null; });
    }
    return running;
  }
  function start() {
    setTimeout(run, 30 * 1000).unref();
    setInterval(run, CHECK_EVERY_MS).unref();
  }

  return { config, runOnce, run, start };
}

function createRemindersRouter(dataStore, reminders, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.get('/reminders', adminOnly, wrap(async (req, res) => {
    const state = (await dataStore.getSetting('reminders_state')) || {};
    res.json({ ok: true, ...(await reminders.config()), state: { lastRunAt: state.lastRunAt || null, lastResult: state.lastResult || null, lastAlertAt: state.lastAlertAt || null, lastAlert: state.lastAlert || null } });
  }));

  router.put('/reminders', adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const next = { ...(await reminders.config()) };
    for (const key of ['enabled', 'email']) if (body[key] !== undefined) next[key] = Boolean(body[key]);
    for (const key of ['quoteHours', 'contactHours', 'escalateHours']) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || (key !== 'escalateHours' && n <= 0)) throw new ValidationError('Revisa las horas de los recordatorios');
      next[key] = n;
    }
    for (const key of ['workStart', 'workEnd']) {
      if (body[key] === undefined) continue;
      if (!HHMM_RE.test(String(body[key]))) throw new ValidationError('Escribe el horario como HH:MM');
      next[key] = String(body[key]);
    }
    if (minutesOfDay(next.workEnd) <= minutesOfDay(next.workStart)) throw new ValidationError('La hora de salida debe ser después de la de entrada');
    const saved = cleanConfig(next);
    await dataStore.setSetting('reminders', saved);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Recordatorios automáticos: ${saved.enabled ? 'activos' : 'pausados'} · cotización ${saved.quoteHours} h · contacto ${saved.contactHours} h (${saved.workStart}–${saved.workEnd})` });
    res.json({ ok: true, ...saved });
  }));

  // Revisar ahora (útil para probar).
  router.post('/reminders/run', adminOnly, wrap(async (req, res) => {
    const result = await reminders.runOnce();
    res.json({ ok: true, result });
  }));

  return router;
}

module.exports = { createReminders, createRemindersRouter, addWorkMinutes, cleanConfig, DEFAULTS };
