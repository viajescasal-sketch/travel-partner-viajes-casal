'use strict';

// TP-112: sincronización completa (dos vías) con Google Calendar.
// Cada vendedor conecta su cuenta de Google (OAuth) y el CRM crea en ella un calendario propio "Travel Partner".
// CRM → Google (al momento y cada 5 min): seguimientos (con hora), viajes (día completo), pagos por cobrar del cliente
//   y pagos a proveedores. Cada evento lleva su clave en extendedProperties.private.tp.
// Google → CRM (seguimientos): mover el evento cambia la fecha/hora; cambiar el título lo cambia en el CRM;
//   borrarlo lo marca como hecho; un evento nuevo creado en el calendario "Travel Partner" crea un seguimiento.
//   Viajes y pagos son de solo lectura en Google: si se mueven allá, el CRM los regresa a su fecha.
// Credenciales: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET o, si no existen, las que el administrador guarda en
//   Configuración › Integraciones (setting 'gcal_config', la clave cifrada). Tokens por usuario en 'gcal_users' (cifrados).

const crypto = require('crypto');
const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun, sanitize } = require('./crm-schema');
const { buildScope } = require('./access');
const { encryptSecret, decryptSecret } = require('./twofa');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.app.created'];
const CONFIG = 'gcal_config';
const USERS = 'gcal_users';
const TZ = 'America/Cancun';
const CAL_NAME = 'Travel Partner';
const FOLLOWUP_MIN = 30;
const PAST_DAYS = 30;
const AHEAD_DAYS = 400;
const ICONS = { Llamada: '📞', WhatsApp: '💬', 'Cotización': '📄', Pago: '💰', Otro: '📌' };
const COLORS = { Llamada: '9', WhatsApp: '2', 'Cotización': '5', Pago: '6', Otro: '8' }; // paleta de Google Calendar
const ICON_RE = /^(?:📞|💬|📄|💰|📌|✈️|🏦|💳)\s*/u;

const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
// "2026-10-22 10:00:00" (Cancún) ↔ Google
const toGoogle = (cancun, plusMin = 0) => {
  const d = new Date(`${String(cancun).slice(0, 16).replace(' ', 'T')}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + plusMin);
  return d.toISOString().slice(0, 19);
};
const fromGoogle = (start) => {
  if (start?.date) return `${start.date} 09:00:00`;
  const ms = Date.parse(start?.dateTime || '');
  if (Number.isNaN(ms)) return null;
  return new Date(ms - 5 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
};

/* ---------- Eventos que debe tener el calendario de un usuario ---------- */
function desiredEvents(user, data, { appUrl = '', today = nowCancun().slice(0, 10) } = {}) {
  const scope = buildScope(user, data);
  const sees = (entity, id) => scope[entity] === null || scope[entity].has(Number(id));
  const clients = new Map(data.clients.map((c) => [c.id, c]));
  const leads = new Map(data.leads.map((l) => [l.id, l]));
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, AHEAD_DAYS);
  const link = (q) => (appUrl ? `\n\nAbrir en el CRM: ${appUrl}/?${q}` : '');
  const out = {};
  for (const f of data.followups) {
    if (f.owner_id !== user.id || f.done || !f.due_at) continue;
    const day = String(f.due_at).slice(0, 10);
    if (day < from || day > to) continue;
    const c = clients.get(f.client_id);
    const l = leads.get(f.lead_id);
    out[`f:${f.id}`] = {
      summary: `${ICONS[f.type] || '📌'} ${f.title}`,
      description: [c ? `Cliente: ${c.name}${c.phone ? ` · ${c.phone}` : ''}` : '', l ? `Lead: ${l.destination} · ${l.stage}` : '', f.details || ''].filter(Boolean).join('\n') + link(`n=followup:${f.id}`),
      start: { dateTime: toGoogle(f.due_at), timeZone: TZ }, end: { dateTime: toGoogle(f.due_at, FOLLOWUP_MIN), timeZone: TZ },
      colorId: COLORS[f.type] || '8', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
    };
  }
  for (const t of data.trips) {
    if (!sees('trips', t.id) || !isDate(t.start_date)) continue;
    const end = isDate(t.end_date) ? t.end_date : t.start_date;
    if (end < from || t.start_date > to) continue;
    const c = clients.get(t.client_id);
    out[`t:${t.id}`] = {
      summary: `✈️ Viaje: ${c?.name || 'Cliente'} · ${t.destination}`,
      description: `Estado: ${t.status || ''}${c?.phone ? `\nWhatsApp del cliente: ${c.phone}` : ''}` + link(`n=trip:${t.id}`),
      start: { date: t.start_date }, end: { date: addDays(end, 1) }, colorId: '7', transparency: 'transparent',
      reminders: { useDefault: false, overrides: [] }
    };
    for (const b of t.bookings?.list || []) {
      if (b.status === 'Cancelada' || b.supplier_paid || !isDate(b.supplier_due) || b.cost === '' || b.cost == null) continue;
      if (b.supplier_due < from || b.supplier_due > to) continue;
      out[`s:${t.id}:${b.id}`] = {
        summary: `🏦 Pagar a ${b.supplier_name || 'proveedor'}: ${money(b.cost)}`,
        description: `${b.type} · ${b.description || ''}\nViaje: ${c?.name || ''} · ${t.destination} (${t.start_date})${b.confirmation ? `\nConfirmación: ${b.confirmation}` : ''}` + link(`n=trip:${t.id}`),
        start: { date: b.supplier_due }, end: { date: addDays(b.supplier_due, 1) }, colorId: '11', transparency: 'transparent',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 * 60 }] }
      };
    }
  }
  for (const q of data.quotes) {
    if (!sees('quotes', q.id) || q.status !== 'Aceptada' || !q.payment_plan) continue;
    const c = clients.get(q.client_id);
    (q.payment_plan.installments || []).forEach((i, n) => {
      if (i.status === 'pagado' || !isDate(i.due) || i.due < from || i.due > to) return;
      const pending = Math.round(((Number(i.amount) || 0) - (Number(i.paid) || 0)) * 100) / 100;
      out[`p:${q.id}:${i.id || n}`] = {
        summary: `💳 Cobrar ${i.label}: ${money(pending)} · ${c?.name || ''}`,
        description: `${q.folio} · ${q.destination}${c?.phone ? `\nWhatsApp del cliente: ${c.phone}` : ''}` + link(`n=payplan:${q.id}`),
        start: { date: i.due }, end: { date: addDays(i.due, 1) }, colorId: '10', transparency: 'transparent',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 * 60 }] }
      };
    });
  }
  return out;
}

function createGcalSync(dataStore, { env = {}, fetchImpl = fetch, now = () => Date.now(), assignment = null } = {}) {
  const secret = env.SESSION_SECRET || '';
  const appUrlFor = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || (req ? `${req.protocol}://${req.get('host')}` : '');
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

  async function credentials() {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, fromEnv: true };
    const c = (await dataStore.getSetting(CONFIG)) || {};
    const s = c.secret ? decryptSecret(c.secret, secret) : null;
    return c.client_id && s ? { id: c.client_id, secret: s, fromEnv: false } : null;
  }

  // Estado de usuarios en fila (dos sincronizaciones no se pisan).
  let queue = Promise.resolve();
  const readUsers = async () => ({ ...((await dataStore.getSetting(USERS)) || {}) });
  const updateUsers = (fn) => { const run = queue.then(async () => { const s = await readUsers(); const r = await fn(s); await dataStore.setSetting(USERS, s); return r; }); queue = run.catch(() => {}); return run; };

  const access = new Map(); // userId → { token, exp }
  async function http(method, url, { token, body, form } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/json';
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined });
    const text = res.status === 204 ? '' : await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) throw Object.assign(new Error(json?.error?.message || json?.error_description || json?.error || `Google respondió ${res.status}`), { statusCode: res.status, google: json });
    return json;
  }
  async function tokenFor(uid, rec) {
    const cached = access.get(uid);
    if (cached && cached.exp > now() + 60000) return cached.token;
    const cred = await credentials();
    if (!cred) throw fail(400, 'Falta configurar la conexión con Google (Configuración › Integraciones)');
    const refresh = decryptSecret(rec.refresh, secret);
    if (!refresh) throw fail(400, 'Vuelve a conectar tu Google Calendar');
    const t = await http('POST', TOKEN_URL, { form: { client_id: cred.id, client_secret: cred.secret, refresh_token: refresh, grant_type: 'refresh_token' } });
    access.set(uid, { token: t.access_token, exp: now() + (Number(t.expires_in) || 3000) * 1000 });
    return t.access_token;
  }
  const cal = (rec, path = '') => `${API}/calendars/${encodeURIComponent(rec.calendar_id)}${path}`;

  async function ensureCalendar(uid, rec, token) {
    if (rec.calendar_id) {
      try { await http('GET', cal(rec), { token }); return rec; } catch (e) { if (e.statusCode !== 404 && e.statusCode !== 403) throw e; }
    }
    const c = await http('POST', `${API}/calendars`, { token, body: { summary: CAL_NAME, description: 'Seguimientos, viajes y pagos del CRM Travel Partner · Viajes Casal', timeZone: TZ } });
    return { ...rec, calendar_id: c.id, sync_token: null, items: {} };
  }

  async function loadData() {
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    return data;
  }

  // Google → CRM (solo seguimientos). Devuelve el registro actualizado del usuario.
  async function pull(user, rec, token, data) {
    const items = { ...(rec.items || {}) };
    const changes = [];
    let pageToken = null;
    let syncToken = rec.sync_token;
    let next = null;
    for (;;) {
      const q = new URLSearchParams({ showDeleted: 'true', maxResults: '250' });
      if (syncToken) q.set('syncToken', syncToken); else q.set('timeMin', new Date(now() - PAST_DAYS * 86400000).toISOString());
      if (pageToken) q.set('pageToken', pageToken);
      let page;
      try { page = await http('GET', cal(rec, `/events?${q}`), { token }); } catch (e) {
        // El token de sincronización venció: se vuelve a leer completo.
        if (e.statusCode === 410 && syncToken) { syncToken = null; pageToken = null; changes.length = 0; continue; }
        throw e;
      }
      changes.push(...(page.items || []));
      pageToken = page.nextPageToken || null;
      next = page.nextSyncToken || next;
      if (!pageToken) break;
    }
    if (!rec.sync_token) return { ...rec, items, sync_token: next }; // primera lectura: solo toma el punto de partida

    const followups = new Map(data.followups.map((f) => [f.id, f]));
    for (const ev of changes) {
      const key = ev.extendedProperties?.private?.tp || '';
      const known = Object.entries(items).find(([, v]) => v.id === ev.id);
      const k = key || known?.[0] || '';
      if (!k) {
        // Evento nuevo creado a mano en el calendario "Travel Partner" → seguimiento nuevo.
        if (ev.status === 'cancelled' || !ev.start) continue;
        const due = fromGoogle(ev.start);
        if (!due) continue;
        const rec2 = await dataStore.insertRecord('followups', sanitize('followups', { type: 'Otro', title: String(ev.summary || 'Seguimiento').replace(ICON_RE, '').slice(0, 160) || 'Seguimiento', details: ev.description ? String(ev.description).slice(0, 2000) : null, due_at: due.slice(0, 16) }), user.id);
        await dataStore.logActivity(user.id, 'crm_followups_create', null, { entity: 'followups', entityId: rec2.id, summary: rec2.title, note: 'Creado desde Google Calendar' });
        items[`f:${rec2.id}`] = { id: ev.id, h: '' };
        continue;
      }
      // Viajes y pagos son de solo lectura en Google: si se movieron o borraron allá, el CRM los vuelve a poner.
      if (!k.startsWith('f:')) { if (ev.status === 'cancelled') delete items[k]; else if (items[k]) items[k] = { ...items[k], h: 'drift' }; continue; }
      const f = followups.get(Number(k.slice(2)));
      if (!f || f.owner_id !== user.id) continue;
      if (ev.status === 'cancelled') {
        if (items[k] && !f.done) {
          await dataStore.updateRecord('followups', f.id, { done: true });
          await dataStore.logActivity(user.id, 'crm_followups_update', null, { entity: 'followups', entityId: f.id, summary: f.title, note: 'Marcado como hecho: se borró en Google Calendar' });
        }
        delete items[k];
        continue;
      }
      const patch = {};
      const due = fromGoogle(ev.start);
      if (due && due.slice(0, 16) !== String(f.due_at).slice(0, 16)) patch.due_at = due.slice(0, 16);
      const title = String(ev.summary || '').replace(ICON_RE, '').trim().slice(0, 160);
      if (title && title !== f.title) patch.title = title;
      if (Object.keys(patch).length && !f.done) {
        await dataStore.updateRecord('followups', f.id, patch);
        await dataStore.logActivity(user.id, 'crm_followups_update', null, { entity: 'followups', entityId: f.id, summary: f.title, note: `Cambiado en Google Calendar: ${patch.due_at ? `fecha ${patch.due_at}` : ''}${patch.due_at && patch.title ? ' · ' : ''}${patch.title ? `título “${patch.title}”` : ''}` });
      }
    }
    return { ...rec, items, sync_token: next || rec.sync_token };
  }

  // CRM → Google: crea, actualiza o borra para que el calendario quede igual al CRM.
  async function push(user, rec, token, data, appUrl) {
    const want = desiredEvents(user, data, { appUrl });
    const items = { ...(rec.items || {}) };
    let created = 0; let updated = 0; let removed = 0;
    for (const [key, body] of Object.entries(want)) {
      const h = sha(body);
      const cur = items[key];
      if (cur && cur.h === h) continue;
      const ev = { ...body, extendedProperties: { private: { tp: key } } };
      if (cur?.id) {
        try { await http('PATCH', cal(rec, `/events/${encodeURIComponent(cur.id)}`), { token, body: { ...ev, status: 'confirmed' } }); items[key] = { id: cur.id, h }; updated += 1; continue; } catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) throw e; }
      }
      const r = await http('POST', cal(rec, '/events'), { token, body: ev });
      items[key] = { id: r.id, h }; created += 1;
    }
    for (const [key, cur] of Object.entries(items)) {
      if (want[key]) continue;
      try { await http('DELETE', cal(rec, `/events/${encodeURIComponent(cur.id)}`), { token }); } catch (e) { if (![404, 410].includes(e.statusCode)) throw e; }
      delete items[key]; removed += 1;
    }
    return { rec: { ...rec, items }, created, updated, removed };
  }

  const running = new Map();
  async function syncUser(uid, { appUrl = appUrlFor(null) } = {}) {
    if (running.has(uid)) return running.get(uid);
    const job = (async () => {
      const users = await readUsers();
      let rec = users[String(uid)];
      if (!rec?.refresh) return null;
      const user = await dataStore.findUserById(uid);
      if (!user || !user.active) return null;
      try {
        const token = await tokenFor(uid, rec);
        rec = await ensureCalendar(uid, rec, token);
        let data = await loadData();
        rec = await pull(user, rec, token, data);
        data = await loadData();
        const r = await push(user, rec, token, data, appUrl);
        rec = { ...r.rec, last_sync: nowCancun(), last_error: null };
        await updateUsers((s) => { if (s[String(uid)]) s[String(uid)] = { ...s[String(uid)], ...rec, refresh: s[String(uid)].refresh }; });
        return { created: r.created, updated: r.updated, removed: r.removed };
      } catch (error) {
        const msg = error.statusCode === 400 && /invalid_grant/i.test(JSON.stringify(error.google || error.message)) ? 'Google retiró el permiso: vuelve a conectar tu calendario' : String(error.message).slice(0, 200);
        await updateUsers((s) => { if (s[String(uid)]) s[String(uid)] = { ...s[String(uid)], ...(rec?.calendar_id ? { calendar_id: rec.calendar_id } : {}), last_error: msg, last_try: nowCancun() }; });
        if (msg.startsWith('Google retiró') && assignment) { const u = await dataStore.findUserById(uid); if (u) await assignment.notify(u, { kind: 'calendar', title: '📅 Vuelve a conectar tu Google Calendar', body: 'Google retiró el permiso; los seguimientos ya no se sincronizan.' }).catch(() => {}); }
        throw error;
      }
    })();
    running.set(uid, job);
    try { return await job; } finally { running.delete(uid); }
  }
  async function syncAll() {
    const users = await readUsers();
    for (const uid of Object.keys(users)) await syncUser(Number(uid)).catch((e) => console.error(`Google Calendar (${uid}):`, e.message));
  }

  // Cambios en el CRM → sincroniza a los pocos segundos.
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => syncAll().catch(() => {}), 8000); timer.unref?.(); };
  function attach() {
    if (dataStore.__gcalAttached) return;
    for (const method of ['insertRecord', 'updateRecord', 'deleteRecord']) {
      const original = dataStore[method].bind(dataStore);
      dataStore[method] = async (entity, ...args) => { const r = await original(entity, ...args); if (['followups', 'trips', 'quotes'].includes(entity)) readUsers().then((u) => { if (Object.keys(u).length) schedule(); }).catch(() => {}); return r; };
    }
    dataStore.__gcalAttached = true;
  }
  let interval = null;
  const start = () => { if (!interval) { interval = setInterval(() => syncAll().catch(() => {}), 5 * 60 * 1000); interval.unref?.(); } };

  /* ---------- Rutas ---------- */
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const me = (req) => req.session.user;
  const redirectUri = (req) => `${appUrlFor(req)}/api/gcal/callback`;

  router.get('/gcal/status', wrap(async (req, res) => {
    const cred = await credentials();
    const rec = (await readUsers())[String(me(req).id)];
    res.json({ ok: true, configured: Boolean(cred), connected: Boolean(rec?.refresh), email: rec?.email || null, last_sync: rec?.last_sync || null, last_error: rec?.last_error || null, events: rec?.items ? Object.keys(rec.items).length : 0, redirectUri: redirectUri(req), fromEnv: Boolean(cred?.fromEnv) });
  }));
  router.get('/gcal/config', wrap(async (req, res) => {
    if (me(req).role !== 'admin') throw fail(403, 'Solo el administrador configura la conexión');
    const c = (await dataStore.getSetting(CONFIG)) || {};
    const cred = await credentials();
    res.json({ ok: true, client_id: env.GOOGLE_CLIENT_ID || c.client_id || '', hasSecret: Boolean(cred), fromEnv: Boolean(cred?.fromEnv), redirectUri: redirectUri(req), origin: appUrlFor(req) });
  }));
  router.put('/gcal/config', wrap(async (req, res) => {
    if (me(req).role !== 'admin') throw fail(403, 'Solo el administrador configura la conexión');
    const id = String(req.body?.client_id || '').trim();
    const sec = String(req.body?.client_secret || '').trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new ValidationError('El ID de cliente debe terminar en .apps.googleusercontent.com');
    const cur = (await dataStore.getSetting(CONFIG)) || {};
    if (!sec && !cur.secret) throw new ValidationError('Pega también el secreto del cliente');
    if (sec && !/^[\w-]{20,80}$/.test(sec)) throw new ValidationError('El secreto del cliente no tiene el formato esperado (empieza con GOCSPX-)');
    await dataStore.setSetting(CONFIG, { client_id: id, secret: sec ? encryptSecret(sec, secret) : cur.secret, updated_at: nowCancun(), by: me(req).id });
    await dataStore.logActivity(me(req).id, 'crm_settings_update', req, { note: 'Google Calendar: credenciales de conexión guardadas' });
    res.json({ ok: true });
  }));

  router.get('/gcal/connect', wrap(async (req, res) => {
    const cred = await credentials();
    if (!cred) { res.redirect('/?gcal=sin-configurar'); return; }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.gcalState = state;
    const q = new URLSearchParams({ client_id: cred.id, redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    res.redirect(`${AUTH_URL}?${q}`);
  }));
  router.get('/gcal/callback', wrap(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) { res.redirect(`/?gcal=${error === 'access_denied' ? 'cancelado' : 'error'}`); return; }
    if (!state || state !== req.session.gcalState || !code) { res.redirect('/?gcal=error'); return; }
    delete req.session.gcalState;
    const cred = await credentials();
    const t = await http('POST', TOKEN_URL, { form: { code: String(code), client_id: cred.id, client_secret: cred.secret, redirect_uri: redirectUri(req), grant_type: 'authorization_code' } });
    if (!String(t.scope || '').includes('calendar')) { res.redirect('/?gcal=sin-permiso'); return; }
    if (!t.refresh_token) { res.redirect('/?gcal=error'); return; }
    let email = '';
    try { email = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch { email = ''; }
    const uid = me(req).id;
    access.set(uid, { token: t.access_token, exp: now() + (Number(t.expires_in) || 3000) * 1000 });
    await updateUsers((s) => { const old = s[String(uid)] || {}; s[String(uid)] = { ...old, email, refresh: encryptSecret(t.refresh_token, secret), connected_at: nowCancun(), last_error: null, ...(old.email && old.email !== email ? { calendar_id: null, items: {}, sync_token: null } : {}) }; });
    await dataStore.logActivity(uid, 'gcal_connect', req, { note: `Google Calendar conectado (${email})` });
    try { await syncUser(uid, { appUrl: appUrlFor(req) }); } catch (e) { console.error('Google Calendar: primera sincronización:', e.message); }
    res.redirect('/?gcal=ok');
  }));
  router.post('/gcal/sync', wrap(async (req, res) => {
    const r = await syncUser(me(req).id, { appUrl: appUrlFor(req) });
    if (!r) throw fail(400, 'Primero conecta tu Google Calendar');
    res.json({ ok: true, ...r });
  }));
  router.post('/gcal/disconnect', wrap(async (req, res) => {
    const uid = me(req).id;
    const rec = (await readUsers())[String(uid)];
    const refresh = rec?.refresh ? decryptSecret(rec.refresh, secret) : null;
    if (refresh) await http('POST', REVOKE_URL, { form: { token: refresh } }).catch(() => {});
    access.delete(uid);
    await updateUsers((s) => { delete s[String(uid)]; });
    await dataStore.logActivity(uid, 'gcal_disconnect', req, { note: 'Google Calendar desconectado' });
    res.json({ ok: true });
  }));

  return { router, attach, start, syncUser, syncAll, desiredEvents };
}

module.exports = { createGcalSync, desiredEvents, fromGoogle, toGoogle };
