'use strict';

// Asignación de leads (TP-104): por turnos entre los vendedores disponibles o a un vendedor fijo,
// con aviso al vendedor por correo y en la campanita de la plataforma.

const express = require('express');
const { ValidationError } = require('./crm-schema');
const { SELLER_ROLES } = require('./access');

const MODES = ['turnos', 'fijo'];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isSeller = (u) => u && u.active && SELLER_ROLES.includes(u.role);

function createAssignment(dataStore, mailer, env = {}) {
  async function config(users) {
    const saved = await dataStore.getSetting('assignment');
    const list = users || await dataStore.listUsers();
    const base = { mode: 'turnos', participants: list.filter((u) => u.active && u.role === 'travel_partner').map((u) => u.id), fixedId: null, away: [], lastUserId: null };
    const cfg = { ...base, ...(saved || {}) };
    cfg.participants = (Array.isArray(cfg.participants) ? cfg.participants : []).map(Number);
    cfg.away = (Array.isArray(cfg.away) ? cfg.away : []).map(Number);
    cfg.saved = Boolean(saved);
    return cfg;
  }
  const available = (cfg, u) => isSeller(u) && !cfg.away.includes(u.id);

  // Quién sigue en el turno (sin guardarlo).
  function nextInTurn(cfg, users) {
    const order = cfg.participants.map((id) => users.find((u) => u.id === id)).filter((u) => u && available(cfg, u));
    if (!order.length) return null;
    const lastPos = cfg.participants.indexOf(Number(cfg.lastUserId));
    return order.find((u) => cfg.participants.indexOf(u.id) > lastPos) || order[0];
  }

  /**
   * Elige al vendedor de un lead que entra solo (bot, formulario).
   * Cliente que ya existe → su vendedor de siempre si está activo y disponible; si no, el turno.
   */
  async function pickOwner({ client } = {}) {
    const users = await dataStore.listUsers();
    const adminFallback = () => users.find((u) => u.active && u.role === 'admin') || null;
    let cfg = await config(users);
    if (client?.owner_id) {
      const usual = users.find((u) => u.id === Number(client.owner_id));
      if (available(cfg, usual)) return { user: usual, reason: 'Su vendedor de siempre' };
    }
    if (cfg.mode === 'fijo') {
      const fixed = users.find((u) => u.id === Number(cfg.fixedId));
      if (available(cfg, fixed)) return { user: fixed, reason: 'Vendedor fijo' };
    }
    const turn = async () => {
      cfg = await config(users);
      const next = nextInTurn(cfg, users);
      if (!next) return null;
      const { saved, ...store } = cfg;
      await dataStore.setSetting('assignment', { ...store, lastUserId: next.id });
      return next;
    };
    const next = (await dataStore.withLock('tp_lead_turn', turn, 5)) || await turn();
    if (next) return { user: next, reason: 'Por turno' };
    const admin = adminFallback();
    return { user: admin, reason: 'Nadie disponible: quedó con el administrador' };
  }

  const appUrlFor = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || (req ? `${req.protocol}://${req.get('host')}` : '');

  // Aviso al vendedor: campanita y, si se pide, correo.
  async function notify(user, { title, body, leadId, kind = 'lead', email = null }) {
    if (!user?.id) return;
    try { await dataStore.createNotification({ userId: user.id, kind, title, body, leadId }); } catch (error) { console.error('Aviso: no se pudo guardar:', error.message); }
    if (email && mailer.configured && user.email) {
      try { await mailer.send({ to: user.email, ...email }); } catch (error) { console.error('Aviso: no se pudo enviar el correo:', error.message); }
    }
  }

  function assignedEmail({ seller, leads, by, appUrl }) {
    const many = leads.length > 1;
    const subject = many ? `Te asignaron ${leads.length} leads · Travel Partner` : `Nuevo lead asignado: ${leads[0].client} · ${leads[0].destination}`;
    const rows = leads.map((l) => `• ${l.client} · ${l.destination}${l.phone ? ` · WhatsApp ${l.phone}` : ''}${l.extra ? ` · ${l.extra}` : ''}`);
    const text = `Hola ${seller.name},\n\n${by} ${many ? `te asignó ${leads.length} leads` : 'te asignó un lead'}:\n\n${rows.join('\n')}\n\nContáctalo lo antes posible.\nAbrir la plataforma: ${appUrl}\n\n— Travel Partner Viajes Casal`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">
<p style="font-size:15px">Hola ${escapeHtml(seller.name)},</p>
<p style="font-size:15px">${escapeHtml(by)} ${many ? `te asignó <b>${leads.length} leads</b>` : 'te asignó un lead'}:</p>
<ul style="font-size:14px;line-height:1.6">${leads.map((l) => `<li><b>${escapeHtml(l.client)}</b> · ${escapeHtml(l.destination)}${l.phone ? ` · WhatsApp ${escapeHtml(l.phone)}` : ''}${l.extra ? ` · ${escapeHtml(l.extra)}` : ''}</li>`).join('')}</ul>
<p style="font-size:14px">Contáctalo lo antes posible.</p>
<p style="margin-top:18px"><a href="${escapeHtml(appUrl)}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>`;
    return { subject: subject.slice(0, 180), text, html };
  }

  // Aviso de asignación (nuevo lead o reasignación) con campanita + correo.
  async function notifyAssigned(seller, leads, { by, req, withEmail = true } = {}) {
    if (!seller || !leads.length) return;
    const many = leads.length > 1;
    await notify(seller, {
      kind: 'assigned',
      title: many ? `Te asignaron ${leads.length} leads` : `Nuevo lead: ${leads[0].client} · ${leads[0].destination}`,
      body: many ? leads.slice(0, 5).map((l) => l.client).join(', ') + (leads.length > 5 ? '…' : '') + ` · ${by}` : `${by}${leads[0].extra ? ` · ${leads[0].extra}` : ''}`,
      leadId: many ? null : leads[0].id,
      email: withEmail ? assignedEmail({ seller, leads, by, appUrl: appUrlFor(req) }) : null
    });
  }

  return { config, pickOwner, notify, notifyAssigned, nextInTurn, appUrlFor, isSeller };
}

// Rutas: campanita (todos), disponibilidad (vendedor o admin) y configuración (admin).
function createAssignmentRouter(dataStore, assignment, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const me = (req) => req.session.user;

  router.get('/notifications', wrap(async (req, res) => {
    const data = await dataStore.listNotifications(me(req).id, Number(req.query.limit) || 30);
    const users = await dataStore.listUsers();
    const cfg = await assignment.config(users);
    const user = users.find((u) => u.id === me(req).id);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...data, latestId: data.items[0]?.id || 0, receivesLeads: Boolean(user && assignment.isSeller(user) && (cfg.participants.includes(user.id) || Number(cfg.fixedId) === user.id)), available: !cfg.away.includes(me(req).id) });
  }));

  router.post('/notifications/read', wrap(async (req, res) => {
    const ids = req.body?.all ? null : req.body?.ids;
    await dataStore.markNotificationsRead(me(req).id, ids);
    res.json({ ok: true });
  }));

  // El vendedor se marca disponible / no disponible (vacaciones). El admin puede hacerlo por cualquiera.
  router.put('/assignment/availability', wrap(async (req, res) => {
    const body = req.body || {};
    const targetId = body.userId !== undefined && body.userId !== null ? Number(body.userId) : me(req).id;
    if (targetId !== me(req).id && me(req).role !== 'admin') { res.status(403).json({ ok: false, error: 'Solo el administrador puede cambiar la disponibilidad de otros' }); return; }
    const users = await dataStore.listUsers();
    const target = users.find((u) => u.id === targetId);
    if (!assignment.isSeller(target)) throw new ValidationError('Ese usuario no recibe leads');
    const { saved, ...cfg } = await assignment.config(users);
    const away = new Set(cfg.away);
    if (body.available) away.delete(targetId); else away.add(targetId);
    await dataStore.setSetting('assignment', { ...cfg, away: [...away] });
    await dataStore.logActivity(me(req).id, 'crm_settings_update', req, { note: `Asignación de leads: ${target.name} ${body.available ? 'disponible' : 'no disponible'}` });
    res.json({ ok: true, available: Boolean(body.available) });
  }));

  router.get('/assignment', adminOnly, wrap(async (req, res) => {
    const users = await dataStore.listUsers();
    const cfg = await assignment.config(users);
    const next = cfg.mode === 'fijo' ? users.find((u) => u.id === Number(cfg.fixedId)) : assignment.nextInTurn(cfg, users);
    res.json({ ok: true, mode: cfg.mode, participants: cfg.participants, fixedId: cfg.fixedId, away: cfg.away, next: next ? { id: next.id, name: next.name } : null, sellers: users.filter(assignment.isSeller).map((u) => ({ id: u.id, name: u.name, role: u.role })) });
  }));

  router.put('/assignment', adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const users = await dataStore.listUsers();
    const { saved, ...cfg } = await assignment.config(users);
    const sellerIds = new Set(users.filter(assignment.isSeller).map((u) => u.id));
    if (body.mode !== undefined) {
      if (!MODES.includes(body.mode)) throw new ValidationError('Modo de asignación inválido');
      cfg.mode = body.mode;
    }
    if (body.participants !== undefined) {
      const list = (Array.isArray(body.participants) ? body.participants : []).map(Number);
      if (list.some((id) => !sellerIds.has(id))) throw new ValidationError('Elige solo vendedores activos');
      cfg.participants = [...new Set(list)];
    }
    if (body.fixedId !== undefined) {
      if (body.fixedId !== null && !sellerIds.has(Number(body.fixedId))) throw new ValidationError('Elige un vendedor activo');
      cfg.fixedId = body.fixedId === null ? null : Number(body.fixedId);
    }
    if (cfg.mode === 'turnos' && !cfg.participants.length) throw new ValidationError('Elige al menos un vendedor para los turnos');
    if (cfg.mode === 'fijo' && !cfg.fixedId) throw new ValidationError('Elige el vendedor fijo');
    await dataStore.setSetting('assignment', cfg);
    await dataStore.logActivity(me(req).id, 'crm_settings_update', req, { note: `Asignación de leads: ${cfg.mode === 'fijo' ? `fijo a ${users.find((u) => u.id === cfg.fixedId)?.name}` : `por turnos entre ${cfg.participants.map((id) => users.find((u) => u.id === id)?.name).join(', ')}`}` });
    const next = cfg.mode === 'fijo' ? users.find((u) => u.id === cfg.fixedId) : assignment.nextInTurn(cfg, users);
    res.json({ ok: true, ...cfg, next: next ? { id: next.id, name: next.name } : null });
  }));

  return router;
}

module.exports = { createAssignment, createAssignmentRouter };
