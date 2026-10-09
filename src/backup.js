'use strict';

const zlib = require('node:zlib');
const express = require('express');
const { ENTITY_ORDER, nowCancun, ValidationError } = require('./crm-schema');
const { buildSheets, SECTIONS } = require('./export');
const { buildXlsx } = require('./xlsx');
const { DEFAULT_LEAD_QUESTIONS, normalizeQuestions } = require('./documents');

const KEEP_BACKUPS = 30;
const BACKUP_HOUR = '02:00:00'; // hora de Cancún
const CHECK_EVERY_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DEFAULT_BACKUP_SETTINGS = { sendEmail: true, email: '' };

const addDaysIso = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// Último horario programado (02:00 de hoy o de ayer) según la hora actual de Cancún.
function lastSlot(now = nowCancun()) {
  const today = now.slice(0, 10);
  return now.slice(11) >= BACKUP_HOUR ? `${today} ${BACKUP_HOUR}` : `${addDaysIso(today, -1)} ${BACKUP_HOUR}`;
}
const nextSlot = (now = nowCancun()) => `${addDaysIso(lastSlot(now).slice(0, 10), 1)} ${BACKUP_HOUR}`;

function createBackupService({ dataStore, mailer, now = nowCancun }) {
  let running = null;

  async function settings() {
    return { ...DEFAULT_BACKUP_SETTINGS, ...(await dataStore.getSetting('backup') || {}) };
  }

  // A quién se envía: el correo configurado o, si no hay, los administradores activos.
  async function recipients(config) {
    if (config.email) return config.email;
    const admins = (await dataStore.listUsers()).filter((u) => u.role === 'admin' && u.active).map((u) => u.email);
    return admins.join(', ');
  }

  async function collect() {
    const data = {};
    for (const entity of ENTITY_ORDER) data[entity] = await dataStore.listRecords(entity);
    const users = (await dataStore.listUsers()).map(({ id, name, email, role, active, last_login_at, created_at }) => ({ id, name, email, role, active, last_login_at, created_at }));
    const settingsData = {};
    for (const key of ['agency', 'documents', 'lead_questions', 'backup']) settingsData[key] = await dataStore.getSetting(key);
    return { data, users, settings: settingsData };
  }

  async function createBackup({ kind = 'auto', userId = null } = {}) {
    const snapshot = await collect();
    const questions = normalizeQuestions(Array.isArray(snapshot.settings.lead_questions) ? snapshot.settings.lead_questions : DEFAULT_LEAD_QUESTIONS);
    const sections = ['clients', 'leads', 'quotes', 'sales', 'trips', 'followups', 'users'];
    const sheets = buildSheets(sections, snapshot.data, { users: snapshot.users, questions });
    const createdAt = now();
    const counts = Object.fromEntries(sheets.map((s) => [s.name, s.rows.length]));
    const summarySheet = {
      name: 'Resumen',
      columns: [{ header: 'Dato', width: 28 }, { header: 'Valor', width: 30 }],
      rows: [['Respaldo de', 'Travel Partner Viajes Casal'], ['Fecha (hora de Cancún)', createdAt.slice(0, 16)], ['Tipo', kind === 'auto' ? 'Automático diario' : 'Manual'],
        ...Object.entries(counts).map(([name, n]) => [name, String(n)])]
    };
    const xlsx = buildXlsx([summarySheet, ...sheets]);
    const jsonGz = zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'travel-partner-viajes-casal', format: 1, createdAt, ...snapshot }), 'utf8'));
    const id = await dataStore.createBackup({ kind, userId, summary: { counts }, xlsx, jsonGz, createdAt });
    await dataStore.pruneBackups(KEEP_BACKUPS);

    // Envío por correo (si está activado y el correo de la plataforma funciona).
    const config = await settings();
    let emailStatus = 'Envío por correo desactivado';
    if (config.sendEmail) {
      const to = await recipients(config);
      if (!mailer.configured) emailStatus = 'No enviado: el correo de la plataforma no está configurado';
      else if (!to) emailStatus = 'No enviado: no hay destinatario';
      else {
        const day = createdAt.slice(0, 10);
        try {
          await mailer.send({
            to,
            subject: `Respaldo diario Travel Partner · ${day}`,
            text: `Hola,\n\nAdjuntamos el respaldo de la plataforma Travel Partner Viajes Casal del ${day} (${createdAt.slice(11, 16)} hrs, hora de Cancún).\n\n${Object.entries(counts).map(([n, c]) => `• ${n}: ${c}`).join('\n')}\n\nEl archivo Excel se abre directo. El archivo .json.gz es la copia técnica completa para restaurar la información si fuera necesario.\nGuarda este correo; la plataforma conserva solo los últimos ${KEEP_BACKUPS} respaldos.\n\n— Travel Partner Viajes Casal`,
            attachments: [
              { filename: `respaldo-travel-partner-${day}.xlsx`, content: xlsx, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
              { filename: `respaldo-travel-partner-${day}.json.gz`, content: jsonGz, contentType: 'application/gzip' }
            ]
          });
          emailStatus = `Enviado a ${to}`;
        } catch (error) {
          emailStatus = `No enviado: ${error.code === 'MAIL_NOT_CONFIGURED' ? 'correo no configurado' : 'falló el envío'}`;
          console.error('Respaldo: no se pudo enviar el correo:', error.message);
        }
      }
    }
    await dataStore.updateBackupStatus(id, emailStatus);
    await dataStore.logActivity(userId, kind === 'auto' ? 'backup_auto' : 'backup_manual', null, { summary: `Respaldo #${id}`, note: emailStatus });
    return { id, createdAt, counts, emailStatus };
  }

  // Evita dos respaldos al mismo tiempo.
  function run(options) {
    if (!running) running = createBackup(options).finally(() => { running = null; });
    return running;
  }

  // Si ya pasó la hora programada y no hay respaldo automático desde entonces, se hace ahora.
  // (Así también se recupera si el servidor estaba dormido a las 2:00 a.m.)
  async function runIfDue() {
    const due = async () => {
      const last = await dataStore.lastBackupAt('auto');
      return !(last && String(last) >= lastSlot(now()));
    };
    if (!(await due())) return null;
    return dataStore.withLock('tp_auto_backup', async () => ((await due()) ? run({ kind: 'auto' }) : null));
  }

  let timer = null;
  function start() {
    const tick = () => runIfDue().catch((error) => console.error('Respaldo automático falló:', error.message));
    setTimeout(tick, 60 * 1000).unref();
    timer = setInterval(tick, CHECK_EVERY_MS);
    timer.unref();
  }

  return { run, runIfDue, start, settings, recipients, mailConfigured: mailer.configured, nextRun: () => nextSlot(now()), lastSlot: () => lastSlot(now()) };
}

function createBackupRouter(dataStore, backupService, { requireRole }) {
  const router = express.Router();
  const adminOnly = requireRole('admin');
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.get('/backups', adminOnly, wrap(async (req, res) => {
    const config = await backupService.settings();
    res.json({
      ok: true,
      backups: await dataStore.listBackups(),
      settings: config,
      recipients: await backupService.recipients(config),
      mailConfigured: Boolean(backupService.mailConfigured),
      nextRun: backupService.nextRun(),
      keep: KEEP_BACKUPS
    });
  }));

  router.post('/backups', adminOnly, wrap(async (req, res) => {
    const result = await backupService.run({ kind: 'manual', userId: req.session.user.id });
    res.status(201).json({ ok: true, ...result });
  }));

  router.put('/backups/settings', adminOnly, wrap(async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const list = email ? email.split(/[,;]\s*/).filter(Boolean) : [];
    if (list.length > 5 || list.some((e) => !EMAIL_RE.test(e) || e.length > 254)) throw new ValidationError('Escribe hasta 5 correos válidos separados por coma');
    const config = { sendEmail: Boolean(body.sendEmail), email: list.join(', ') };
    await dataStore.setSetting('backup', config);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: 'Respaldos' });
    res.json({ ok: true, settings: config });
  }));

  router.get('/backups/:id/download', adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const type = req.query.type === 'json' ? 'json' : 'xlsx';
    const file = Number.isInteger(id) && id > 0 ? await dataStore.getBackupFile(id, type) : null;
    if (!file) { res.status(404).json({ ok: false, error: 'No se encontró el respaldo' }); return; }
    const day = String(file.createdAt).slice(0, 10);
    await dataStore.logActivity(req.session.user.id, 'backup_download', req, { summary: `Respaldo #${id}`, note: type === 'json' ? 'Copia técnica (.json.gz)' : 'Excel' });
    res.set('Cache-Control', 'no-store');
    res.attachment(`respaldo-travel-partner-${day}-${id}.${type === 'json' ? 'json.gz' : 'xlsx'}`);
    res.type(type === 'json' ? 'application/gzip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(file.data);
  }));

  return router;
}

module.exports = { createBackupService, createBackupRouter, lastSlot, nextSlot, KEEP_BACKUPS, SECTIONS };
