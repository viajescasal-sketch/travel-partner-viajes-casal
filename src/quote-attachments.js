'use strict';

// TP-113: cotizaciones hechas antes del CRM (o fuera de él) adjuntas como PDF/imagen o como link.
// Se guardan como una cotización normal (folio, monto, estado…) con details.external:
//   { kind: 'file', media_id, name, mime }  ó  { kind: 'link', url }
//   más ref (folio o referencia original), date (fecha en que se cotizó) y notes.

const express = require('express');
const { ValidationError } = require('./crm-schema');
const { canWrite } = require('./access');

const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = {
  'application/pdf': (b) => b.slice(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'
};
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 120);

// Limpia details.external; lanza error si no trae ni archivo válido ni link https.
async function cleanExternal(raw, dataStore) {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Adjunta el PDF o pega el link de la cotización');
  const base = { ref: str(raw.ref, 60), date: isDate(raw.date) ? raw.date : '', notes: str(raw.notes, 500) };
  if (raw.kind === 'link') {
    const url = str(raw.url, 600);
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { ok = false; }
    if (!ok) throw new ValidationError('El link debe empezar con https://');
    return { kind: 'link', url, ...base };
  }
  const id = Number(raw.media_id);
  const media = Number.isInteger(id) && id > 0 ? await dataStore.getMedia(id) : null;
  if (!media || !FILE_TYPES[media.mime]) throw new ValidationError('Vuelve a subir el archivo de la cotización (PDF o imagen)');
  return { kind: 'file', media_id: id, mime: media.mime, name: cleanName(raw.name) || `cotizacion.${media.mime === 'application/pdf' ? 'pdf' : media.mime.split('/')[1]}`, ...base };
}

// Normaliza el cuerpo de una cotización externa antes de guardarla.
async function prepareExternalQuote(body, current, dataStore) {
  const incoming = body?.details && typeof body.details === 'object' ? body.details.external : undefined;
  const wasExternal = Boolean(current?.details?.external);
  if (incoming === undefined) {
    // Una cotización externa conserva su adjunto aunque se edite otro campo.
    if (wasExternal && body?.details !== undefined) body.details = { ...(current.details || {}), ...(body.details || {}), external: current.details.external };
    return body;
  }
  const external = await cleanExternal(incoming, dataStore);
  body.details = { kind: 'externa', external };
  if (!body.hotel && !current?.hotel) body.hotel = external.ref ? `Cotización ${external.ref}` : 'Cotización adjunta';
  return body;
}

function createQuoteAttachments(dataStore) {
  const router = express.Router();
  const raw = express.raw({ type: Object.keys(FILE_TYPES), limit: MAX_FILE });
  router.post('/quote-files', (req, res, next) => {
    if (!canWrite(req.session.user, 'quotes')) return next(Object.assign(new Error('Tu rol no permite adjuntar cotizaciones'), { status: 403, expose: true }));
    return raw(req, res, (error) => (error ? next(Object.assign(new Error('El archivo pesa más de 5 MB'), { status: 413, expose: true })) : next()));
  }, async (req, res, next) => {
    try {
      const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!FILE_TYPES[mime] || !Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError('Sube un PDF o una imagen (JPG, PNG o WebP)');
      if (!FILE_TYPES[mime](req.body)) throw new ValidationError('El archivo no es un PDF o imagen válido');
      const id = await dataStore.createMedia({ ownerId: req.session.user.id, mime, data: req.body });
      let name = '';
      try { name = cleanName(decodeURIComponent(String(req.get('x-file-name') || ''))); } catch { name = ''; }
      res.status(201).json({ ok: true, media_id: id, mime, name, url: `/api/media/${id}` });
    } catch (error) { next(error); }
  });
  return { router };
}

module.exports = { createQuoteAttachments, prepareExternalQuote, cleanExternal, MAX_FILE };
