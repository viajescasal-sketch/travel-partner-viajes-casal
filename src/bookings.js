'use strict';

// TP-304: reservas centralizadas por viaje (proveedor, confirmación, estado, fechas, costos,
// pago al proveedor y documentos). Solo el equipo ve costos; el cliente ve las claves confirmadas en su itinerario.

const express = require('express');
const { ENTITY_ORDER, ValidationError } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const TPTrip = require('../public/viaje-core');

function createBookings(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  async function visibleTrip(req, write) {
    const user = req.session.user;
    if (write && !canWrite(user, 'trips')) throw Object.assign(new Error('Tu rol no permite esta acción'), { status: 403, expose: true });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const trip = data.trips.find((t) => t.id === id);
    if (!trip || !isVisible(buildScope(user, data), 'trips', id)) throw Object.assign(new Error('No se encontró el viaje'), { status: 404, expose: true });
    return { trip, client: data.clients.find((c) => c.id === trip.client_id) };
  }

  router.get('/trips/:id/bookings', wrap(async (req, res) => {
    const { trip } = await visibleTrip(req, false);
    res.json({ ok: true, bookings: trip.bookings?.list || [] });
  }));

  router.put('/trips/:id/bookings', wrap(async (req, res) => {
    const { trip, client } = await visibleTrip(req, true);
    if (!Array.isArray(req.body?.list)) throw new ValidationError('Envía la lista de reservas');
    if (req.body.list.length > TPTrip.MAX_BOOKINGS) throw new ValidationError(`Máximo ${TPTrip.MAX_BOOKINGS} reservas por viaje`);
    const suppliers = await dataStore.listSuppliers();
    const vouchers = new Set((trip.vouchers || []).map((v) => Number(v.id)));
    const list = TPTrip.cleanBookings(req.body.list).map((b) => {
      const sup = b.supplier_id ? suppliers.find((s) => s.id === b.supplier_id) : null;
      return { ...b, supplier_id: sup ? sup.id : null, supplier_name: sup ? sup.name : b.supplier_name, voucher_ids: b.voucher_ids.filter((v) => vouchers.has(v)) };
    });
    const before = trip.bookings?.list || [];
    const updated = await dataStore.updateRecord('trips', trip.id, { bookings: { list, updated_at: new Date().toISOString().slice(0, 19) } });
    const changes = [];
    list.forEach((b) => {
      const prev = before.find((x) => x.id === b.id);
      if (!prev) changes.push(`+ ${b.type} ${b.supplier_name || b.description}`.trim());
      else if (prev.status !== b.status) changes.push(`${b.type} ${b.supplier_name}: ${prev.status} → ${b.status}`);
      else if (!prev.supplier_paid && b.supplier_paid) changes.push(`${b.type} ${b.supplier_name}: pagada al proveedor`);
    });
    before.filter((p) => !list.some((b) => b.id === p.id)).forEach((p) => changes.push(`− ${p.type} ${p.supplier_name || p.description}`.trim()));
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, {
      entity: 'trips', entityId: trip.id, summary: [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · '),
      note: `Reservas: ${changes.length ? changes.join(' · ').slice(0, 480) : 'sin cambios de estado'}`
    });
    res.json({ ok: true, record: updated, bookings: list });
  }));

  return { router };
}

module.exports = { createBookings };
