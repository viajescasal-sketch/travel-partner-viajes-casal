'use strict';

// Preferencias de cada usuario: avatar de animal (si no sube foto) y recorrido guiado de capacitación.
// setting 'ui_prefs' = { avatars: { [userId]: clave }, tour: { round, users: { [userId]: { seen, off } } } }

const express = require('express');
const { ValidationError, nowCancun } = require('./crm-schema');
const { KEYS } = require('../public/avatares');

const SETTING = 'ui_prefs';
const clean = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const avatars = {};
  for (const [id, k] of Object.entries(r.avatars || {})) if (/^\d+$/.test(id) && KEYS.includes(k)) avatars[id] = k;
  const round = Number.isInteger(r.tour?.round) && r.tour.round > 0 ? r.tour.round : 1;
  const users = {};
  for (const [id, v] of Object.entries(r.tour?.users || {})) if (/^\d+$/.test(id) && v && typeof v === 'object') users[id] = { seen: Number(v.seen) || 0, off: v.off === true };
  return { avatars, tour: { round, users, reset_at: r.tour?.reset_at || null } };
};

async function readPrefs(dataStore) { return clean(await dataStore.getSetting(SETTING)); }

/** Lo que necesita la plataforma al cargar: avatares del equipo y si toca mostrar el recorrido. */
async function prefsFor(dataStore, userId) {
  const p = await readPrefs(dataStore);
  const mine = p.tour.users[String(userId)] || { seen: 0, off: false };
  return { avatars: p.avatars, avatar: p.avatars[String(userId)] || null, tour: { round: p.tour.round, show: !mine.off && mine.seen < p.tour.round, off: mine.off } };
}

function createPreferencias(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  let queue = Promise.resolve();
  const update = (fn) => { const run = queue.then(async () => { const p = await readPrefs(dataStore); fn(p); await dataStore.setSetting(SETTING, p); return p; }); queue = run.catch(() => {}); return run; };

  router.get('/me/prefs', wrap(async (req, res) => { res.json({ ok: true, ...(await prefsFor(dataStore, req.session.user.id)) }); }));

  router.put('/me/avatar', wrap(async (req, res) => {
    const key = req.body?.avatar;
    if (key !== null && !KEYS.includes(key)) throw new ValidationError('Elige un avatar de la lista');
    const id = String(req.session.user.id);
    await update((p) => { if (key) p.avatars[id] = key; else delete p.avatars[id]; });
    res.json({ ok: true, ...(await prefsFor(dataStore, req.session.user.id)) });
  }));

  // Recorrido: 'seen' (lo terminó o lo cerró), 'off' (no volver a mostrar), 'on' (volver a mostrar al entrar).
  router.post('/me/tour', wrap(async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['seen', 'off', 'on'].includes(action)) throw new ValidationError('Acción no válida');
    const id = String(req.session.user.id);
    await update((p) => {
      const u = p.tour.users[id] || { seen: 0, off: false };
      if (action === 'seen') u.seen = p.tour.round;
      if (action === 'off') { u.off = true; u.seen = p.tour.round; }
      if (action === 'on') { u.off = false; u.seen = 0; }
      p.tour.users[id] = u;
    });
    res.json({ ok: true, ...(await prefsFor(dataStore, req.session.user.id)) });
  }));

  // El administrador vuelve a mostrar el recorrido a todo el equipo.
  router.post('/tour/reset', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw Object.assign(new Error('Solo el administrador'), { status: 403, expose: true });
    const p = await update((x) => { x.tour.round += 1; x.tour.reset_at = nowCancun(); for (const u of Object.values(x.tour.users)) u.off = false; });
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: 'Recorrido guiado: se mostrará otra vez a todo el equipo' });
    res.json({ ok: true, round: p.tour.round });
  }));

  return { router };
}

module.exports = { createPreferencias, prefsFor };
