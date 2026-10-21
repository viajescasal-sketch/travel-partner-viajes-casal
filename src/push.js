'use strict';

// TP-312: notificaciones push al celular (app instalable).
// Todo aviso de la campanita (crm_notifications) también llega como notificación del teléfono
// a los equipos donde el usuario las activó. Claves VAPID: variables VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// o, si no existen, se generan una vez y se guardan en crm_settings ('push_vapid').
// Suscripciones en crm_settings ('push_subs') = { [userId]: [{ endpoint, keys, ua, at }] } (máx. 6 equipos por usuario).

const express = require('express');
const webpushLib = require('web-push');
const { ValidationError, nowCancun } = require('./crm-schema');

const SUBS = 'push_subs';
const VAPID = 'push_vapid';
const MAX_PER_USER = 6;

function createPush(dataStore, { env = {}, webPush = webpushLib } = {}) {
  let keysPromise = null;
  async function keys() {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    if (!keysPromise) {
      keysPromise = (async () => {
        const saved = await dataStore.getSetting(VAPID);
        if (saved?.publicKey && saved?.privateKey) return saved;
        const k = webpushLib.generateVAPIDKeys();
        await dataStore.setSetting(VAPID, { ...k, created_at: nowCancun() });
        return k;
      })().catch((error) => { keysPromise = null; throw error; });
    }
    return keysPromise;
  }
  const subject = () => {
    const mail = String(env.MAIL_FROM || env.SMTP_USER || '').match(/[^\s<>]+@[^\s<>]+/);
    return mail ? `mailto:${mail[0]}` : (String(env.APP_URL || '').startsWith('https://') ? env.APP_URL : 'mailto:soporte@viajescasal.com');
  };

  let queue = Promise.resolve();
  const readSubs = async () => ({ ...((await dataStore.getSetting(SUBS)) || {}) });
  const updateSubs = (fn) => { const run = queue.then(async () => { const s = await readSubs(); fn(s); await dataStore.setSetting(SUBS, s); return s; }); queue = run.catch(() => {}); return run; };

  const cleanSub = (raw) => {
    const endpoint = String(raw?.endpoint || '');
    const p256dh = String(raw?.keys?.p256dh || '');
    const auth = String(raw?.keys?.auth || '');
    if (!/^https:\/\/[^\s]{10,700}$/.test(endpoint) || !/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{10,60}$/.test(auth)) throw new ValidationError('Suscripción inválida');
    return { endpoint, keys: { p256dh, auth } };
  };

  // Envía a todos los equipos del usuario. Quita los que el navegador ya dio de baja (404/410).
  async function sendToUser(userId, { title, body = '', url = '/', tag = '' }) {
    const subs = (await readSubs())[String(userId)] || [];
    if (!subs.length) return 0;
    const k = await keys();
    const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body).slice(0, 240), url, tag: String(tag).slice(0, 60) });
    const gone = [];
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webPush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 3600, urgency: 'high' });
        sent += 1;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) gone.push(s.endpoint);
        else console.error('Push: no se pudo enviar:', error.statusCode || '', error.message);
      }
    }));
    if (gone.length) await updateSubs((s) => { s[String(userId)] = (s[String(userId)] || []).filter((x) => !gone.includes(x.endpoint)); });
    return sent;
  }

  // Cada aviso de la campanita sale también como push (sin frenar a quien lo creó).
  function attach() {
    if (dataStore.__pushAttached) return;
    const original = dataStore.createNotification.bind(dataStore);
    dataStore.createNotification = async (n) => {
      const result = await original(n);
      const params = new URLSearchParams();
      if (n.link) params.set('n', n.link);
      if (n.leadId) params.set('lead', String(n.leadId));
      const url = n.link === 'proveedor' ? '/proveedor' : `/${params.toString() ? `?${params}` : ''}`;
      sendToUser(n.userId, { title: n.title, body: n.body || '', url, tag: n.kind || '' }).catch((error) => console.error('Push:', error.message));
      return result;
    };
    dataStore.__pushAttached = true;
  }

  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/push/key', wrap(async (req, res) => {
    const subs = (await readSubs())[String(req.session.user.id)] || [];
    res.json({ ok: true, publicKey: (await keys()).publicKey, devices: subs.length });
  }));
  router.post('/push/subscribe', wrap(async (req, res) => {
    const sub = cleanSub(req.body?.subscription);
    const ua = String(req.get('user-agent') || '').slice(0, 160);
    await updateSubs((s) => {
      const id = String(req.session.user.id);
      const list = (s[id] || []).filter((x) => x.endpoint !== sub.endpoint);
      s[id] = [...list, { ...sub, ua, at: nowCancun() }].slice(-MAX_PER_USER);
    });
    await dataStore.logActivity(req.session.user.id, 'push_subscribe', req, { note: 'Notificaciones activadas en un equipo' });
    res.json({ ok: true });
  }));
  router.post('/push/unsubscribe', wrap(async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    await updateSubs((s) => { const id = String(req.session.user.id); s[id] = (s[id] || []).filter((x) => x.endpoint !== endpoint); });
    res.json({ ok: true });
  }));
  router.post('/push/test', wrap(async (req, res) => {
    const sent = await sendToUser(req.session.user.id, { title: '🔔 Notificaciones activadas', body: 'Así te avisaremos de leads nuevos, seguimientos y pagos.', url: '/', tag: 'test' });
    res.json({ ok: true, sent });
  }));

  return { router, attach, sendToUser, keys };
}

module.exports = { createPush };
