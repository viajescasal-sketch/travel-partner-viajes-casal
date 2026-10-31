'use strict';

// TP-304: reservas centralizadas por viaje (proveedor, confirmación, estado, fechas, costos,
// pago al proveedor y documentos). Solo el equipo ve costos; el cliente ve las claves confirmadas en su itinerario.

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const { buildScope, isVisible, canWrite, canSeeCosts, redactBooking } = require('./access');
const TPTrip = require('../public/viaje-core');
const TPProv = require('../public/proveedor-core');

// Solo el Administrador y la Dirección registran comisiones (monto manual, % y cobro).
const FINANCE_ROLES = ['admin', 'direccion'];

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
    const list = trip.bookings?.list || [];
    res.json({ ok: true, bookings: canSeeCosts(req.session.user) ? list : list.map(redactBooking) });
  }));

  router.put('/trips/:id/bookings', wrap(async (req, res) => {
    const { trip, client } = await visibleTrip(req, true);
    if (!Array.isArray(req.body?.list)) throw new ValidationError('Envía la lista de reservas');
    if (req.body.list.length > TPTrip.MAX_BOOKINGS) throw new ValidationError(`Máximo ${TPTrip.MAX_BOOKINGS} reservas por viaje`);
    const suppliers = await dataStore.listSuppliers();
    const vouchers = new Set((trip.vouchers || []).map((v) => Number(v.id)));
    const before = trip.bookings?.list || [];
    const finance = FINANCE_ROLES.includes(req.session.user.role);
    const today = nowCancun().slice(0, 10);
    const openPortal = (b) => b?.portal?.state && !TPProv.CLOSED.includes(b.portal.state);
    const list = TPTrip.cleanBookings(req.body.list).map((b) => {
      const sup = b.supplier_id ? suppliers.find((s) => s.id === b.supplier_id) : null;
      const out = { ...b, supplier_id: sup ? sup.id : null, supplier_name: sup ? sup.name : b.supplier_name, voucher_ids: b.voucher_ids.filter((v) => vouchers.has(v)) };
      // TP-009: la solicitud al portal del proveedor solo cambia por sus rutas. Si el proveedor respondió
      // mientras el equipo tenía abiertas las reservas, se conserva lo que él escribió.
      const prevB = before.find((x) => x.id === out.id);
      out.portal = prevB?.portal || null;
      if (prevB && openPortal(prevB)) {
        if (out.supplier_id !== prevB.supplier_id) throw new ValidationError(`La reserva ${prevB.portal.folio || ''} tiene una solicitud abierta con ${prevB.supplier_name}: cancélala antes de cambiar de proveedor`.replace('  ', ' '));
        if (Number(b.portal?.rev || 0) !== Number(prevB.portal.rev || 0)) ['status', 'confirmation', 'cost', 'supplier_due', 'model'].forEach((k) => { out[k] = prevB[k]; });
      }
      // Fecha en que se pagó al proveedor (la ve el proveedor en su calendario de pagos).
      out.supplier_paid_at = out.supplier_paid ? (TPTrip.isDate(b.supplier_paid_at) ? b.supplier_paid_at : prevB?.supplier_paid_at || today) : '';
      // Quien no registra comisiones no cambia el modelo, el % ni el monto: se conservan los ya registrados
      // (en una reserva nueva se toman del catálogo del proveedor).
      if (!finance) {
        const prev = before.find((x) => x.id === out.id);
        if (prev) {
          Object.assign(out, { model: prev.model, commission_pct: prev.commission_pct ?? '', commission_amount: prev.commission_amount ?? '', commission_due: prev.commission_due || '' });
        } else {
          const pct = sup && sup.model === 'comision' && sup.commission !== '' && sup.commission != null ? Number(sup.commission) : '';
          Object.assign(out, { model: pct === '' ? 'neta' : 'comision', commission_pct: pct, commission_amount: pct !== '' && out.price !== '' && out.price != null ? Math.round(Number(out.price) * pct) / 100 : '', commission_due: '' });
        }
      }
      if (out.model === 'comision') {
        // TP-205: fecha de cobro por omisión = fin del servicio + días del proveedor.
        if (!out.commission_due) out.commission_due = TPTrip.commissionDueDefault(out, trip, sup);
        // El cobro de la comisión (estado, factura, fecha) solo lo cambian el administrador y Operaciones.
        if (!finance) {
          const prev = before.find((x) => x.id === out.id);
          Object.assign(out, { commission_status: prev?.model === 'comision' ? prev.commission_status : 'Pendiente', commission_invoice: prev?.commission_invoice || '', commission_paid_at: prev?.commission_paid_at || '' });
        }
      }
      return out;
    });
    const removedOpen = before.filter((p) => openPortal(p) && !list.some((b) => b.id === p.id));
    if (removedOpen.length) throw new ValidationError(`No quites la reserva ${removedOpen[0].portal.folio || ''} de ${removedOpen[0].supplier_name}: tiene una solicitud abierta en el portal del proveedor. Cancélala primero.`);
    const updated = await dataStore.updateRecord('trips', trip.id, { bookings: { list, updated_at: new Date().toISOString().slice(0, 19) } });
    const changes = [];
    list.forEach((b) => {
      const prev = before.find((x) => x.id === b.id);
      if (!prev) changes.push(`+ ${b.type} ${b.supplier_name || b.description}`.trim());
      else if (prev.status !== b.status) changes.push(`${b.type} ${b.supplier_name}: ${prev.status} → ${b.status}`);
      else if (!prev.supplier_paid && b.supplier_paid) changes.push(`${b.type} ${b.supplier_name}: pagada al proveedor`);
      else if (b.model === 'comision' && prev.commission_status !== b.commission_status) changes.push(`${b.type} ${b.supplier_name}: comisión ${b.commission_status}`);
    });
    before.filter((p) => !list.some((b) => b.id === p.id)).forEach((p) => changes.push(`− ${p.type} ${p.supplier_name || p.description}`.trim()));
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, {
      entity: 'trips', entityId: trip.id, summary: [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · '),
      note: `Reservas: ${changes.length ? changes.join(' · ').slice(0, 480) : 'sin cambios de estado'}`
    });
    res.json({ ok: true, record: updated, bookings: list });
  }));

  // TP-205: cobro de la comisión de una reserva (Pendiente → Facturada → Cobrada) desde el panel de Proveedores.
  router.patch('/trips/:id/bookings/:bid/commission', wrap(async (req, res) => {
    if (!FINANCE_ROLES.includes(req.session.user.role)) throw Object.assign(new Error('Solo el administrador y la Dirección registran el cobro de comisiones'), { status: 403, expose: true });
    const { trip, client } = await visibleTrip(req, false);
    const list = trip.bookings?.list || [];
    const prev = list.find((b) => b.id === String(req.params.bid));
    if (!prev || prev.model !== 'comision') throw Object.assign(new Error('Esa reserva no tiene comisión por cobrar'), { status: 404, expose: true });
    const b = req.body || {};
    const status = TPTrip.COMMISSION_STATUSES.includes(b.status) ? b.status : prev.commission_status;
    const today = nowCancun().slice(0, 10);
    const next = TPTrip.cleanBooking({
      ...prev, commission_status: status,
      commission_invoice: b.invoice !== undefined ? b.invoice : prev.commission_invoice,
      commission_amount: b.amount !== undefined && b.amount !== '' ? b.amount : prev.commission_amount,
      commission_due: b.due !== undefined ? b.due : prev.commission_due,
      commission_paid_at: status === 'Cobrada' ? (TPTrip.isDate(b.paid_at) && b.paid_at <= today ? b.paid_at : prev.commission_paid_at || today) : ''
    });
    const updatedList = list.map((x) => (x.id === prev.id ? next : x));
    const updated = await dataStore.updateRecord('trips', trip.id, { bookings: { ...(trip.bookings || {}), list: updatedList, updated_at: new Date().toISOString().slice(0, 19) } });
    const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, {
      entity: 'trips', entityId: trip.id, summary: [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · '),
      note: `Comisión ${next.supplier_name || next.type}: ${prev.commission_status} → ${next.commission_status} · ${money(TPTrip.bookingProfit(next))}${next.commission_invoice ? ` · factura ${next.commission_invoice}` : ''}`
    });
    res.json({ ok: true, record: updated, booking: next });
  }));

  return { router };
}

module.exports = { createBookings };
