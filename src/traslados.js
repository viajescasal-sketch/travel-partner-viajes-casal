'use strict';

// Solicitar traslado desde la ficha del cliente.
// - POST /api/clients/:id/transfer: en un paso crea (si hace falta) el viaje, agrega la reserva de Traslado,
//   envía la solicitud de precio al portal del proveedor (TP-009) y programa las tareas de seguimiento.
// - Las tareas quedan ligadas a la reserva y se mantienen solas: cambian de fecha/título cuando cambia la
//   reserva y se cierran cuando el proveedor responde, cuando se paga o si el traslado se cancela.

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun, sanitize } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const TPTrip = require('../public/viaje-core');
const P = require('../public/proveedor-core');
const T = require('../public/traslado-core');
const { isEnabled: supplierModuleOn } = require('./supplier-module');

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL_STATUS = ['Por reservar', 'Solicitada', 'Confirmada'];
const uniq = (a) => [...new Set(a.filter((x) => Number.isInteger(x)))];

function createTransfers(dataStore, { portal } = {}) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const locks = new Map();
  const serial = (key, fn) => { const prev = locks.get(key) || Promise.resolve(); const run = prev.then(fn, fn); locks.set(key, run.catch(() => {})); return run; };

  async function loadAll() {
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    return data;
  }

  /* ---------- Tareas ligadas a la reserva: se mantienen solas ---------- */
  async function reconcile(trip) {
    if (!trip?.id) return;
    const tasks = (await dataStore.listRecords('followups')).filter((f) => !f.done && f.auto?.kind === T.KIND && f.auto.trip_id === trip.id);
    if (!tasks.length) return;
    const client = (await dataStore.listRecords('clients')).find((c) => c.id === trip.client_id);
    const now = nowCancun();
    for (const f of tasks) {
      const b = (trip.bookings?.list || []).find((x) => x.id === f.auto.booking_id);
      const want = T.desiredTask(f.auto.task, b, trip, client, now);
      if (want.done) {
        await dataStore.updateRecord('followups', f.id, { done: true, details: `${f.details ? `${f.details}\n` : ''}✓ ${want.closeNote}`.slice(0, 2000) });
        continue;
      }
      // Solo se actualiza si la reserva cambió desde la última vez (si el vendedor movió la tarea a mano, se respeta).
      const synced = f.auto.sync || {};
      const patch = {};
      if (want.title && want.title !== synced.title && want.title !== f.title) patch.title = want.title.slice(0, 160);
      if (want.due && want.due !== synced.due && want.due !== f.due_at) { patch.due_at = want.due; patch.overdue_notified_at = null; }
      if (Object.keys(patch).length || want.title !== synced.title || (want.due || '') !== (synced.due || '')) {
        patch.auto = { ...f.auto, sync: { title: want.title || '', due: want.due || '' } };
        await dataStore.updateRecord('followups', f.id, patch);
      }
    }
  }
  function attach() {
    if (dataStore.__transferAttached) return;
    const original = dataStore.updateRecord.bind(dataStore);
    dataStore.updateRecord = async (entity, ...args) => {
      const r = await original(entity, ...args);
      if (entity === 'trips' && r) await reconcile(r).catch((e) => console.error('Tareas de traslado:', e.message));
      return r;
    };
    dataStore.__transferAttached = true;
  }

  /* ---------- Solicitar traslado ---------- */
  router.post('/clients/:id/transfer', wrap(async (req, res) => {
    const user = req.session.user;
    if (!canWrite(user, 'trips') || !canWrite(user, 'followups')) throw fail(403, 'Tu rol no permite solicitar traslados');
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId) || clientId < 1) throw new ValidationError('Identificador inválido');
    const body = req.body || {};
    // Módulo de proveedor apagado: el precio se valida con el proveedor por WhatsApp y se captura a mano aquí.
    const manual = !(await supplierModuleOn(dataStore));

    const result = await serial(`client:${clientId}`, async () => {
      const data = await loadAll();
      const scope = buildScope(user, data);
      const client = data.clients.find((c) => c.id === clientId);
      if (!client || !isVisible(scope, 'clients', clientId)) throw fail(404, 'No se encontró el cliente');
      const elig = T.eligibility(client, data.quotes.filter((q) => isVisible(scope, 'quotes', q.id)));
      if (!elig.ok) throw new ValidationError('Este cliente no tiene traslado incluido: márcalo en su ficha (Datos del cliente › Incluye traslado) o en su cotización');

      // Proveedor del catálogo
      const supplier = (await dataStore.listSuppliers()).find((s) => s.id === Number(body.supplier_id) && s.active !== false);
      if (!supplier) throw new ValidationError('Elige el proveedor de traslados');
      const send = !manual && body.send === true;
      if (send && !(await portal.portalUsersOf(supplier.id)).length) throw new ValidationError(`${supplier.name} aún no tiene acceso al portal. Quita “Enviar al portal” o créale un usuario con rol Proveedor.`);

      // Datos del servicio (los mismos que ve el proveedor)
      const details = P.cleanDetails(body.details);
      const err = P.detailsError(details);
      if (err) throw new ValidationError(err);
      const price = body.price === '' || body.price == null ? '' : Number(String(body.price).replace(/[^0-9.]/g, ''));
      if (price !== '' && (!Number.isFinite(price) || price < 0 || price > 10000000)) throw new ValidationError('Precio de venta inválido');
      const wanted = T.TASKS.filter((k) => body.tasks?.[k] !== false && !(manual && k === 'confirm'));
      // Captura manual: costo del proveedor, fecha de pago (editable), estado y clave de confirmación.
      let cost = '';
      let manualStatus = 'Por reservar';
      let manualDue = '';
      let confirmation = '';
      if (manual) {
        cost = body.cost === '' || body.cost == null ? NaN : Number(String(body.cost).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(cost) || cost <= 0 || cost > 10000000) throw new ValidationError('Captura el costo del proveedor (lo que le vas a pagar)');
        if (body.supplier_due && !DATE_RE.test(String(body.supplier_due))) throw new ValidationError('Fecha de pago al proveedor inválida');
        manualDue = body.supplier_due || '';
        manualStatus = MANUAL_STATUS.includes(body.status) ? body.status : 'Confirmada';
        confirmation = String(body.confirmation || '').trim().slice(0, 60);
      }

      // Viaje: uno existente del cliente o uno nuevo
      let trip;
      let created = false;
      if (body.trip_id) {
        trip = data.trips.find((t) => t.id === Number(body.trip_id) && t.client_id === client.id);
        if (!trip || !isVisible(scope, 'trips', trip.id)) throw new ValidationError('Ese viaje no es de este cliente');
      } else {
        const nt = body.trip || {};
        const quote = elig.quote && isVisible(scope, 'quotes', elig.quote.id) ? elig.quote : null;
        const start = DATE_RE.test(nt.start_date || '') ? nt.start_date : details.service_date;
        const end = DATE_RE.test(nt.end_date || '') ? nt.end_date : details.return_date || start;
        if (end < start) throw new ValidationError('La fecha de regreso no puede ser anterior a la de llegada');
        const tripData = sanitize('trips', { client_id: client.id, quote_id: quote ? quote.id : null, destination: String(nt.destination || quote?.destination || '').trim() || 'Por definir', start_date: start, end_date: end, status: 'Confirmado' });
        trip = await dataStore.insertRecord('trips', tripData, user.id);
        created = true;
        await dataStore.logActivity(user.id, 'crm_trips_create', req, { entity: 'trips', entityId: trip.id, summary: [client.name, trip.destination, trip.start_date].join(' · '), note: 'Creado al solicitar traslado' });
      }

      // Reserva de Traslado
      const today = nowCancun().slice(0, 10);
      const booking = TPTrip.cleanBooking({
        id: `r${Date.now().toString(36)}t`, type: 'Traslado', status: manual ? manualStatus : 'Por reservar', supplier_id: supplier.id, supplier_name: supplier.name,
        description: `${details.kind} · ${P.route(details)}`.slice(0, 300), start_date: details.service_date, end_date: details.return_date || details.service_date,
        time: details.pickup_time, price, cost: manual ? cost : '', model: 'neta', supplier_due: manualDue || P.defaultPayDue(trip.start_date, details.service_date, today),
        confirmation: manual ? confirmation : '', notes: details.notes
      });
      const list = [...(trip.bookings?.list || []), booking];
      trip = await dataStore.updateRecord('trips', trip.id, { bookings: { ...(trip.bookings || {}), list, updated_at: new Date().toISOString().slice(0, 19) } });
      await dataStore.logActivity(user.id, 'crm_trips_update', req, { entity: 'trips', entityId: trip.id, summary: [client.name, trip.destination, trip.start_date].join(' · '), note: `Reservas: + Traslado ${supplier.name} (${manual ? 'capturado a mano' : 'solicitado'} desde la ficha del cliente)` });
      // Alerta de pago: al vendedor del cliente y a los administradores activos (solo en captura manual).
      let payOwners = [user.id];
      let taskOwner = user.id;
      if (manual) {
        const users = (await dataStore.listUsers()).filter((u) => u.active !== false);
        const sellerId = users.some((u) => u.id === client.owner_id && u.role !== 'proveedor') ? client.owner_id : null;
        payOwners = uniq([sellerId, ...users.filter((u) => u.role === 'admin').map((u) => u.id)]);
        if (!payOwners.length) payOwners = [user.id];
        taskOwner = sellerId || user.id;
      }
      return { client, trip, booking, created, supplier, details, send, wanted, payOwners, taskOwner };
    });

    // Solicitud al portal del proveedor (fuera del candado del cliente: el portal tiene el suyo por viaje)
    let booking = result.booking;
    let sendError = null;
    if (result.send) {
      try { booking = await portal.sendRequest(req, result.trip.id, booking.id, result.details); } catch (e) { sendError = e.message; }
    }
    const trip = (await dataStore.listRecords('trips')).find((t) => t.id === result.trip.id) || result.trip;
    booking = (trip.bookings?.list || []).find((b) => b.id === booking.id) || booking;

    // Tareas (en captura manual, la alerta de pago llega al vendedor del cliente y a los administradores)
    const now = nowCancun();
    const tasks = [];
    for (const task of result.wanted) {
      const want = T.desiredTask(task, booking, trip, result.client, now);
      const due = T.initialDue(task, booking, trip, now);
      const owners = manual ? (task === 'pay' ? result.payOwners : [result.taskOwner]) : [req.session.user.id];
      for (const ownerId of owners) {
        const f = await dataStore.insertRecord('followups', sanitize('followups', {
          client_id: result.client.id, type: task === 'pay' ? 'Pago' : task === 'client' ? 'WhatsApp' : 'Llamada',
          title: (want.title || T.TASK_LABELS[task]).slice(0, 160), details: T.taskDetails(task, booking, trip, result.client), due_at: due
        }), ownerId);
        const rec = await dataStore.updateRecord('followups', f.id, { auto: { kind: T.KIND, task, trip_id: trip.id, booking_id: booking.id, sync: { title: want.title || '', due: want.due || '' } } });
        tasks.push(rec);
        await dataStore.logActivity(req.session.user.id, 'crm_followups_create', req, { entity: 'followups', entityId: f.id, summary: rec.title, note: 'Tarea del traslado' });
      }
    }
    res.status(201).json({ ok: true, trip, booking, created: result.created, sent: result.send && !sendError, sendError, tasks, manual });
  }));

  return { router, attach, reconcile };
}

module.exports = { createTransfers };
