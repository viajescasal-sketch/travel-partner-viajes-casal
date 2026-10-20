'use strict';

// TP-009: portal del proveedor de traslados.
// - El administrador crea un usuario con rol "proveedor" ligado a una ficha del catálogo (setting 'supplier_portal').
// - El equipo envía la solicitud desde la reserva (datos operativos), el proveedor cotiza, el equipo acepta o rechaza
//   y el proveedor confirma con su folio y chofer. El proveedor ve sus servicios y el calendario de pagos.
// - El proveedor nunca ve precio de venta, comisiones, correo del cliente ni nada más del CRM.

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const TPTrip = require('../public/viaje-core');
const P = require('../public/proveedor-core');

const SETTING = 'supplier_portal';
// Lo que un usuario proveedor puede pedir a /api (lo demás responde 403).
const PROVIDER_PATHS = [/^\/proveedor(\/|$)/, /^\/account(\/|$)/, /^\/notifications(\/|$)/, /^\/me\/(prefs|avatar|tour)$/];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MXN`;

async function readLinks(dataStore) {
  const raw = (await dataStore.getSetting(SETTING)) || {};
  const users = {};
  for (const [uid, sid] of Object.entries(raw.users || {})) if (/^\d+$/.test(uid) && Number.isInteger(Number(sid)) && Number(sid) > 0) users[uid] = Number(sid);
  return { users, seq: Number.isInteger(raw.seq) ? raw.seq : 0 };
}

// Middleware: el proveedor solo entra a su portal.
function providerGate(req, res, next) {
  if (req.session?.user?.role !== 'proveedor') return next();
  if (PROVIDER_PATHS.some((re) => re.test(req.path))) return next();
  return res.status(403).json({ ok: false, error: 'Tu cuenta de proveedor solo tiene acceso a tu portal' });
}

function createProveedorPortal(dataStore, { assignment, mailer, env = {} } = {}) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const today = () => nowCancun().slice(0, 10);
  const appUrl = (req) => (assignment?.appUrlFor ? assignment.appUrlFor(req) : String(env.APP_URL || '').replace(/\/+$/, ''));
  // Escrituras de la reserva de un viaje en fila (evita que dos cambios simultáneos se pisen).
  const locks = new Map();
  const serial = (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const run = prev.then(fn, fn); locks.set(key, run.catch(() => {})); return run; };

  async function setLinks(mutator) {
    const cur = await readLinks(dataStore);
    mutator(cur);
    await dataStore.setSetting(SETTING, cur);
    return cur;
  }
  async function supplierOf(userId) {
    const sid = (await readLinks(dataStore)).users[String(userId)];
    if (!sid) return null;
    return (await dataStore.listSuppliers()).find((s) => s.id === sid) || null;
  }
  async function portalUsersOf(supplierId) {
    const links = await readLinks(dataStore);
    const ids = Object.entries(links.users).filter(([, sid]) => sid === Number(supplierId)).map(([uid]) => Number(uid));
    return (await dataStore.listUsers()).filter((u) => ids.includes(u.id) && u.role === 'proveedor' && u.active);
  }

  async function loadTrip(tripId) {
    const trip = (await dataStore.listRecords('trips')).find((t) => t.id === Number(tripId));
    if (!trip) throw fail(404, 'No se encontró el servicio');
    return trip;
  }
  // Viaje visible y editable para alguien del equipo.
  async function teamTrip(req) {
    const user = req.session.user;
    if (!canWrite(user, 'trips')) throw fail(403, 'Tu rol no permite esta acción');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const trip = data.trips.find((t) => t.id === id);
    if (!trip || !isVisible(buildScope(user, data), 'trips', id)) throw fail(404, 'No se encontró el viaje');
    return { trip, client: data.clients.find((c) => c.id === trip.client_id) };
  }
  async function saveBooking(trip, next) {
    const list = (trip.bookings?.list || []).map((b) => (b.id === next.id ? next : b));
    await dataStore.updateRecord('trips', trip.id, { bookings: { ...(trip.bookings || {}), list, updated_at: new Date().toISOString().slice(0, 19) } });
    return next;
  }
  const findBooking = (trip, bid) => (trip.bookings?.list || []).find((b) => b.id === String(bid));
  const bump = (portal) => { portal.rev = (Number(portal.rev) || 0) + 1; portal.updated_at = nowCancun(); return portal; };
  const summaryOf = (trip, client) => [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · ');
  const label = (b) => `${P.route(b.portal?.details || {}) || b.description || b.type}`;

  // ---- Avisos ----
  async function notifyProvider(supplierId, { title, body, req }) {
    for (const u of await portalUsersOf(supplierId)) {
      await assignment?.notify(u, {
        kind: 'proveedor', link: 'proveedor', title, body,
        email: mailer?.configured ? {
          subject: `${title} · Viajes Casal`.slice(0, 180),
          text: `Hola ${u.name},\n\n${title}\n${body}\n\nEntra a tu portal: ${appUrl(req)}/proveedor\n\n— Travel Partner Viajes Casal`,
          html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px"><p>Hola ${escapeHtml(u.name)},</p><p style="font-size:15px"><b>${escapeHtml(title)}</b><br>${escapeHtml(body)}</p><p style="margin-top:18px"><a href="${escapeHtml(appUrl(req))}/proveedor" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir mi portal</a></p></div>`
        } : null
      });
    }
  }
  async function notifyTeam(trip, { title, body }) {
    const users = await dataStore.listUsers();
    const to = users.filter((u) => u.active && (u.role === 'admin' || u.role === 'operaciones' || u.id === trip.owner_id));
    for (const u of to) await assignment?.notify(u, { kind: 'proveedor', link: `trip:${trip.id}`, title, body });
  }

  /* ================= Equipo ================= */

  // Qué proveedores tienen acceso al portal (para la pantalla de Reservas y Usuarios).
  router.get('/supplier-portal/links', wrap(async (req, res) => {
    if (req.session.user.role === 'proveedor') throw fail(403, 'Acceso no autorizado');
    const links = await readLinks(dataStore);
    const users = await dataStore.listUsers();
    const bySupplier = {};
    for (const [uid, sid] of Object.entries(links.users)) {
      const u = users.find((x) => x.id === Number(uid) && x.role === 'proveedor');
      if (!u) continue;
      (bySupplier[sid] = bySupplier[sid] || []).push({ id: u.id, name: u.name, email: req.session.user.role === 'admin' ? u.email : undefined, active: Boolean(u.active) });
    }
    res.json({ ok: true, suppliers: bySupplier, users: req.session.user.role === 'admin' ? links.users : undefined });
  }));

  // Solo el administrador liga un usuario proveedor con su ficha del catálogo.
  router.put('/supplier-portal/links/:userId', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw fail(403, 'Solo el administrador da acceso a proveedores');
    const user = await dataStore.findUserById(Number(req.params.userId));
    if (!user || user.role !== 'proveedor') throw fail(404, 'Ese usuario no tiene el rol Proveedor');
    const sid = Number(req.body?.supplier_id);
    const supplier = (await dataStore.listSuppliers()).find((s) => s.id === sid);
    if (!supplier) throw new ValidationError('Elige el proveedor del catálogo');
    await setLinks((l) => { l.users[String(user.id)] = supplier.id; });
    await dataStore.logActivity(req.session.user.id, 'crm_suppliers_update', req, { entity: 'suppliers', entityId: supplier.id, summary: supplier.name, note: `Acceso al portal del proveedor: ${user.name}` });
    res.json({ ok: true });
  }));

  // Enviar (o reenviar) la solicitud de precio al proveedor.
  router.post('/trips/:id/bookings/:bid/portal/request', wrap(async (req, res) => {
    const out = await serial(`trip:${req.params.id}`, async () => {
      const { trip, client } = await teamTrip(req);
      const b = findBooking(trip, req.params.bid);
      if (!b) throw fail(404, 'No se encontró la reserva. Guarda las reservas antes de enviar la solicitud.');
      if (b.status === 'Cancelada') throw new ValidationError('La reserva está cancelada');
      if (!b.supplier_id) throw new ValidationError('Elige un proveedor del catálogo para esta reserva');
      const supplier = (await dataStore.listSuppliers()).find((s) => s.id === b.supplier_id);
      if (!supplier) throw new ValidationError('El proveedor ya no está en el catálogo');
      if (!(await portalUsersOf(supplier.id)).length) throw new ValidationError(`${supplier.name} aún no tiene acceso al portal. Créale un usuario con rol Proveedor en Configuración › Usuarios.`);
      const prev = b.portal;
      if (prev && ['Aceptada', 'Confirmada'].includes(prev.state)) throw new ValidationError('El servicio ya fue aceptado; si cambió algo, cancela la solicitud y envía una nueva');
      const details = P.cleanDetails(req.body?.details);
      const err = P.detailsError(details);
      if (err) throw new ValidationError(err);
      const now = nowCancun();
      let folio = prev?.folio;
      if (!folio) { const l = await setLinks((x) => { x.seq += 1; }); folio = `TR-${String(l.seq).padStart(4, '0')}`; }
      const resend = prev && prev.state === 'Solicitada';
      const portal = bump({ ...(prev || {}), folio, state: 'Solicitada', details, quote: null, decision_note: '', driver: null, requested_at: resend ? prev.requested_at : now, requested_by: req.session.user.name, log: prev?.log || [] });
      P.addLog(portal, req.session.user.name, resend ? 'Datos de la solicitud actualizados' : 'Solicitud de precio enviada', now);
      const next = TPTrip.cleanBooking({ ...b, portal, status: b.status === 'Confirmada' ? b.status : 'Solicitada', start_date: b.start_date || details.service_date, time: b.time || details.pickup_time });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: summaryOf(trip, client), note: `Portal ${supplier.name} ${folio}: ${resend ? 'solicitud actualizada' : 'solicitud de precio enviada'}` });
      return { next, supplier, folio, resend, details };
    });
    await notifyProvider(out.supplier.id, { req, title: out.resend ? `Solicitud ${out.folio} actualizada` : `Nueva solicitud de precio ${out.folio}`, body: `${out.details.kind} · ${out.details.service_date}${out.details.pickup_time ? ` ${out.details.pickup_time}` : ''} · ${P.paxText(out.details)} · ${P.route(out.details)}` });
    res.json({ ok: true, booking: out.next });
  }));

  // Aceptar o rechazar el precio del proveedor.
  router.post('/trips/:id/bookings/:bid/portal/decision', wrap(async (req, res) => {
    const out = await serial(`trip:${req.params.id}`, async () => {
      const { trip, client } = await teamTrip(req);
      const b = findBooking(trip, req.params.bid);
      if (!b?.portal) throw fail(404, 'Esta reserva no tiene solicitud al proveedor');
      if (b.portal.state !== 'Cotizada') throw new ValidationError('El proveedor aún no envía su precio (o ya se decidió)');
      const accept = req.body?.accept === true;
      const note = String(req.body?.note || '').trim().slice(0, 300);
      const now = nowCancun();
      const portal = bump({ ...b.portal, state: accept ? 'Aceptada' : 'Rechazada', decision_note: note, decided_at: now });
      P.addLog(portal, req.session.user.name, accept ? `Precio aceptado ${money(b.portal.quote?.amount)}` : `Precio rechazado${note ? `: ${note}` : ''}`, now);
      const patch = accept
        ? { model: 'neta', cost: b.portal.quote?.amount, supplier_due: b.supplier_due || b.portal.details?.service_date || b.start_date || '' }
        : {};
      const next = TPTrip.cleanBooking({ ...b, ...patch, portal });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: summaryOf(trip, client), note: `Portal ${b.supplier_name} ${portal.folio}: precio ${accept ? 'aceptado' : 'rechazado'} (${money(b.portal.quote?.amount)})` });
      return { next, accept, note, portal };
    });
    await notifyProvider(out.next.supplier_id, { req, title: out.accept ? `Precio aceptado ${out.portal.folio}: confirma el servicio` : `Precio no aceptado ${out.portal.folio}`, body: `${label(out.next)}${out.note ? ` · ${out.note}` : ''}` });
    res.json({ ok: true, booking: out.next });
  }));

  // Cancelar la solicitud (el cliente canceló, se eligió a otro proveedor…).
  router.post('/trips/:id/bookings/:bid/portal/cancel', wrap(async (req, res) => {
    const out = await serial(`trip:${req.params.id}`, async () => {
      const { trip, client } = await teamTrip(req);
      const b = findBooking(trip, req.params.bid);
      if (!b?.portal) throw fail(404, 'Esta reserva no tiene solicitud al proveedor');
      if (P.CLOSED.includes(b.portal.state)) throw new ValidationError('La solicitud ya está cerrada');
      const note = String(req.body?.note || '').trim().slice(0, 300);
      const now = nowCancun();
      const portal = bump({ ...b.portal, state: 'Cancelada', decision_note: note, cancelled_at: now });
      P.addLog(portal, req.session.user.name, `Solicitud cancelada${note ? `: ${note}` : ''}`, now);
      const next = TPTrip.cleanBooking({ ...b, portal });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: summaryOf(trip, client), note: `Portal ${b.supplier_name} ${portal.folio}: solicitud cancelada` });
      return { next, note, portal };
    });
    await notifyProvider(out.next.supplier_id, { req, title: `Servicio ${out.portal.folio} cancelado`, body: `${label(out.next)}${out.note ? ` · ${out.note}` : ''}` });
    res.json({ ok: true, booking: out.next });
  }));

  /* ================= Proveedor ================= */

  async function me(req) {
    if (req.session.user.role !== 'proveedor') throw fail(403, 'Esta sección es solo para proveedores');
    const supplier = await supplierOf(req.session.user.id);
    if (!supplier) throw fail(403, 'Tu usuario aún no está ligado a un proveedor. Avisa a Viajes Casal.');
    return supplier;
  }
  async function servicesOf(supplier) {
    const trips = await dataStore.listRecords('trips');
    const out = [];
    for (const t of trips) for (const b of t.bookings?.list || []) if (b.supplier_id === supplier.id && b.portal?.state) out.push(P.providerView(t, b));
    return out;
  }
  async function myBooking(req, supplier) {
    const trip = await loadTrip(req.params.tripId);
    const b = findBooking(trip, req.params.bid);
    if (!b || b.supplier_id !== supplier.id || !b.portal?.state) throw fail(404, 'No se encontró el servicio');
    return { trip, b };
  }

  router.get('/proveedor/portal', wrap(async (req, res) => {
    const supplier = await me(req);
    const services = await servicesOf(supplier);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true, today: today(),
      supplier: { id: supplier.id, name: supplier.name, type: supplier.type, payment_terms: supplier.payment_terms || '' },
      user: { name: req.session.user.name, email: req.session.user.email },
      services
    });
  }));

  // El proveedor envía (o corrige, mientras no se decida) su precio.
  router.post('/proveedor/services/:tripId/:bid/quote', wrap(async (req, res) => {
    const supplier = await me(req);
    const out = await serial(`trip:${req.params.tripId}`, async () => {
      const { trip, b } = await myBooking(req, supplier);
      if (!['Solicitada', 'Cotizada'].includes(b.portal.state)) throw new ValidationError('Este servicio ya no está esperando precio');
      const amount = P.num(req.body?.amount);
      if (amount === '' || amount <= 0) throw new ValidationError('Escribe el precio total del servicio en pesos');
      const notes = String(req.body?.notes || '').trim().slice(0, 500);
      const now = nowCancun();
      const portal = bump({ ...b.portal, state: 'Cotizada', quote: { amount, notes, at: now } });
      P.addLog(portal, `${req.session.user.name} (${supplier.name})`, `Precio enviado ${money(amount)}${notes ? ` · ${notes}` : ''}`, now);
      const next = TPTrip.cleanBooking({ ...b, portal });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: [trip.destination, trip.start_date].filter(Boolean).join(' · '), note: `Portal ${supplier.name} ${portal.folio}: precio ${money(amount)}` });
      return { trip, next, amount, portal };
    });
    await notifyTeam(out.trip, { title: `💲 ${supplier.name} envió precio ${out.portal.folio}`, body: `${label(out.next)} · ${money(out.amount)} · acéptalo o recházalo en Reservas` });
    res.json({ ok: true, service: P.providerView(out.trip, out.next) });
  }));

  // El proveedor no puede dar el servicio.
  router.post('/proveedor/services/:tripId/:bid/decline', wrap(async (req, res) => {
    const supplier = await me(req);
    const out = await serial(`trip:${req.params.tripId}`, async () => {
      const { trip, b } = await myBooking(req, supplier);
      if (!['Solicitada', 'Cotizada'].includes(b.portal.state)) throw new ValidationError('Este servicio ya fue aceptado; para cancelarlo comunícate con Viajes Casal');
      const note = String(req.body?.note || '').trim().slice(0, 300);
      const now = nowCancun();
      const portal = bump({ ...b.portal, state: 'No disponible', decision_note: note });
      P.addLog(portal, `${req.session.user.name} (${supplier.name})`, `Sin disponibilidad${note ? `: ${note}` : ''}`, now);
      const next = TPTrip.cleanBooking({ ...b, portal, status: b.status === 'Solicitada' ? 'Por reservar' : b.status });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: [trip.destination, trip.start_date].filter(Boolean).join(' · '), note: `Portal ${supplier.name} ${portal.folio}: sin disponibilidad` });
      return { trip, next, note, portal };
    });
    await notifyTeam(out.trip, { title: `⛔ ${supplier.name} no tiene disponibilidad ${out.portal.folio}`, body: `${label(out.next)}${out.note ? ` · ${out.note}` : ''}` });
    res.json({ ok: true, service: P.providerView(out.trip, out.next) });
  }));

  // El proveedor confirma el servicio aceptado (folio, chofer y unidad). También sirve para actualizar al chofer.
  router.post('/proveedor/services/:tripId/:bid/confirm', wrap(async (req, res) => {
    const supplier = await me(req);
    const out = await serial(`trip:${req.params.tripId}`, async () => {
      const { trip, b } = await myBooking(req, supplier);
      if (!['Aceptada', 'Confirmada'].includes(b.portal.state)) throw new ValidationError('Solo se confirman servicios con precio aceptado');
      const body = req.body || {};
      const confirmation = String(body.confirmation || '').trim().slice(0, 60);
      if (!confirmation) throw new ValidationError('Escribe tu número de confirmación o folio');
      const driver = { name: String(body.driver_name || '').trim().slice(0, 80), phone: String(body.driver_phone || '').trim().slice(0, 40), unit: String(body.unit || '').trim().slice(0, 80), notes: String(body.notes || '').trim().slice(0, 300) };
      const first = b.portal.state === 'Aceptada';
      const now = nowCancun();
      const portal = bump({ ...b.portal, state: 'Confirmada', driver, confirmed_at: b.portal.confirmed_at || now });
      P.addLog(portal, `${req.session.user.name} (${supplier.name})`, first ? `Servicio confirmado · ${confirmation}` : `Datos del servicio actualizados · ${confirmation}`, now);
      const next = TPTrip.cleanBooking({ ...b, portal, status: 'Confirmada', confirmation, notes: b.notes });
      await saveBooking(trip, next);
      await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: [trip.destination, trip.start_date].filter(Boolean).join(' · '), note: `Portal ${supplier.name} ${portal.folio}: ${first ? 'confirmado' : 'actualizado'} (${confirmation})` });
      return { trip, next, first, confirmation, portal };
    });
    await notifyTeam(out.trip, { title: out.first ? `✅ ${supplier.name} confirmó ${out.portal.folio}` : `🚐 ${supplier.name} actualizó ${out.portal.folio}`, body: `${label(out.next)} · ${out.confirmation}${out.next.portal.driver?.name ? ` · chofer ${out.next.portal.driver.name}` : ''}` });
    res.json({ ok: true, service: P.providerView(out.trip, out.next) });
  }));

  return { router, providerGate, readLinks, supplierOf };
}

module.exports = { createProveedorPortal, providerGate, PROVIDER_PATHS, SETTING };
