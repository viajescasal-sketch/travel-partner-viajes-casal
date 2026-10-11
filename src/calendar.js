'use strict';

// Calendario de seguimientos en Google Calendar (u otro calendario) por suscripción:
// cada usuario tiene una liga privada .ics que su calendario consulta solo.
// Va en una dirección (CRM → calendario). La sincronización completa con la API de Google queda para después.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER } = require('./crm-schema');
const { buildScope } = require('./access');

const SETTING = 'calendar_feeds'; // { "<userId>": "<token>" }
const DURATION_MIN = 30;
const PAST_DAYS = 60; // seguimientos hechos o vencidos que se siguen mostrando
const TYPE_ICONS = { Llamada: '📞', WhatsApp: '💬', 'Cotización': '📄', Pago: '💰', Otro: '📌' };
const TOKEN_RE = /^[a-f0-9]{48}$/;

// "2026-10-12 10:00:00" (hora de Cancún, UTC-5 todo el año) → "20261012T150000Z"
function icsUtc(cancunDateTime, plusMinutes = 0) {
  const [d, t = '00:00:00'] = String(cancunDateTime).split(/[ T]/);
  const date = new Date(`${d}T${t.slice(0, 8).padEnd(8, ':00')}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + 5 * 60 + plusMinutes);
  return date.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}
const icsText = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Líneas de máximo 75 bytes (RFC 5545), sin partir caracteres UTF-8.
function fold(line) {
  const out = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch) > (out.length ? 74 : 75)) { out.push(current); current = ''; }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n ');
}

function buildIcs({ calendarName, followups, data, appUrl, host, now = new Date() }) {
  const clients = new Map(data.clients.map((c) => [c.id, c]));
  const leads = new Map(data.leads.map((l) => [l.id, l]));
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Viajes Casal//Travel Partner CRM//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(calendarName)}`, 'X-WR-TIMEZONE:America/Cancun', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'
  ];
  for (const f of followups) {
    const client = clients.get(f.client_id);
    const lead = leads.get(f.lead_id);
    const icon = TYPE_ICONS[f.type] || '📌';
    const who = client?.name ? ` · ${client.name}` : '';
    const description = [
      `${f.type}${f.done ? ' (hecho)' : ''}`,
      client ? `Cliente: ${client.name}${client.phone ? ` · ${client.phone}` : ''}` : '',
      lead ? `Lead: ${lead.destination} · ${lead.stage}` : '',
      f.details || '',
      appUrl ? `Abrir en el CRM: ${appUrl}` : ''
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:seguimiento-${f.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsUtc(f.due_at)}`,
      `DTEND:${icsUtc(f.due_at, DURATION_MIN)}`,
      `SUMMARY:${icsText(`${f.done ? '✓ ' : ''}${icon} ${f.title}${f.title.includes(client?.name || '\u0000') ? '' : who}`)}`,
      `DESCRIPTION:${icsText(description)}`,
      `STATUS:${f.done ? 'CANCELLED' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT'
    );
    if (appUrl) lines.push(`URL:${appUrl}`);
    if (!f.done) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(f.title)}`, 'TRIGGER:-PT10M', 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function createCalendarFeed(dataStore, env = {}) {
  const appUrlFor = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const feeds = async () => (await dataStore.getSetting(SETTING)) || {};
  async function tokenFor(userId, { renew = false } = {}) {
    const all = await feeds();
    if (!all[userId] || renew) {
      all[userId] = crypto.randomBytes(24).toString('hex');
      await dataStore.setSetting(SETTING, all);
    }
    return all[userId];
  }
  const feedUrl = (req, token) => `${appUrlFor(req)}/calendario/${token}.ics`;

  // Liga pública (secreta) que consulta Google Calendar.
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  publicRouter.get('/calendario/:file', limiter, async (req, res, next) => {
    try {
      const token = String(req.params.file).replace(/\.ics$/, '');
      if (!TOKEN_RE.test(token)) { res.status(404).type('text').send('Calendario no encontrado'); return; }
      const all = await feeds();
      const entry = Object.entries(all).find(([, t]) => t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token)));
      const user = entry ? await dataStore.findUserById(Number(entry[0])) : null;
      if (!user || user.active === false || user.active === 0) { res.status(404).type('text').send('Calendario no encontrado'); return; }
      const data = {};
      for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
      const scope = buildScope(user, data);
      const since = new Date(Date.now() - 5 * 3600 * 1000 - PAST_DAYS * 86400000).toISOString().slice(0, 10);
      const followups = data.followups
        .filter((f) => (scope.followups === null ? true : scope.followups.has(f.id)))
        // El administrador ve en su calendario lo que tiene asignado (no los de todo el equipo).
        .filter((f) => (user.role === 'admin' ? f.owner_id === user.id || f.owner_id == null : true))
        .filter((f) => String(f.due_at).slice(0, 10) >= since)
        .sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
      const appUrl = appUrlFor(req);
      const ics = buildIcs({ calendarName: `Seguimientos CRM · ${user.name}`, followups, data, appUrl, host: new URL(appUrl).host });
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', 'inline; filename="seguimientos.ics"');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('X-Robots-Tag', 'noindex');
      res.send(ics);
    } catch (error) { next(error); }
  });

  // Con sesión: ver o renovar mi liga.
  const apiRouter = express.Router();
  apiRouter.get('/calendar/feed', async (req, res, next) => {
    try { res.json({ ok: true, url: feedUrl(req, await tokenFor(req.session.user.id)) }); } catch (error) { next(error); }
  });
  apiRouter.post('/calendar/feed/reset', async (req, res, next) => {
    try {
      const url = feedUrl(req, await tokenFor(req.session.user.id, { renew: true }));
      await dataStore.logActivity(req.session.user.id, 'calendar_feed_reset', req, { note: 'Liga de Google Calendar renovada' });
      res.json({ ok: true, url });
    } catch (error) { next(error); }
  });

  return { publicRouter, apiRouter };
}

module.exports = { createCalendarFeed, buildIcs, icsUtc };
