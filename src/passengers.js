'use strict';

// TP-303: pasajeros y acompañantes por viaje.
// Cada viaje guarda su lista (nombre, nacimiento, tipo por edad y documento de viaje).
// Los acompañantes se recuerdan en el cliente para el siguiente viaje.
// Los números de documento solo los ve el equipo: nunca salen en ligas públicas ni en la bitácora.

const express = require('express');
const { ENTITY_ORDER, ValidationError } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const TPTrip = require('../public/viaje-core');

function createPassengers(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const notFound = (what) => Object.assign(new Error(`No se encontró el ${what}`), { status: 404, expose: true });

  async function visible(req, entity, what) {
    const user = req.session.user;
    if (!canWrite(user, entity === 'clients' ? 'trips' : entity)) throw Object.assign(new Error('Tu rol no permite esta acción'), { status: 403, expose: true });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const record = data[entity].find((r) => r.id === id);
    if (!record || !isVisible(buildScope(user, data), entity, id)) throw notFound(what);
    return { record, data };
  }
  const listOf = (body) => {
    const list = body?.list;
    if (!Array.isArray(list)) throw new ValidationError('Envía la lista de pasajeros');
    if (list.length > TPTrip.MAX_PASSENGERS) throw new ValidationError(`Máximo ${TPTrip.MAX_PASSENGERS} pasajeros por viaje`);
    return list;
  };
  const response = (trip) => {
    const list = trip.passengers?.list || [];
    return { ok: true, record: trip, passengers: list, alerts: list.map((p) => ({ id: p.id, name: p.name, alerts: TPTrip.passengerAlerts(p, trip) })) };
  };

  router.get('/trips/:id/passengers', wrap(async (req, res) => {
    const { record } = await visible(req, 'trips', 'viaje');
    res.json(response(record));
  }));

  router.put('/trips/:id/passengers', wrap(async (req, res) => {
    const { record: trip, data } = await visible(req, 'trips', 'viaje');
    const list = TPTrip.cleanPassengers(listOf(req.body), trip.start_date);
    const updated = await dataStore.updateRecord('trips', trip.id, { passengers: { list, updated_at: new Date().toISOString().slice(0, 19) } });
    const client = data.clients.find((c) => c.id === trip.client_id);
    // Recordar acompañantes en el cliente (salvo los que el vendedor desmarcó).
    if (client && req.body.saveCompanions !== false) {
      const skip = new Set((Array.isArray(req.body.skipCompanions) ? req.body.skipCompanions : []).map(String));
      const merged = TPTrip.mergeCompanions(client.companions?.list, list.filter((p) => !skip.has(p.id)), client.name);
      if (JSON.stringify(merged) !== JSON.stringify(client.companions?.list || [])) await dataStore.updateRecord('clients', client.id, { companions: { list: merged } });
    }
    const summary = TPTrip.tripPassengerSummary(list, trip);
    await dataStore.logActivity(req.session.user.id, 'crm_trips_update', req, {
      entity: 'trips', entityId: trip.id, summary: [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · '),
      note: `Pasajeros actualizados: ${summary.total ? `${summary.total} (${summary.text})` : 'sin pasajeros'}`
    });
    res.json(response(updated));
  }));

  // Acompañantes frecuentes del cliente: editar o quitar desde la ficha.
  router.put('/clients/:id/companions', wrap(async (req, res) => {
    const { record: client } = await visible(req, 'clients', 'cliente');
    if (!canWrite(req.session.user, 'clients') && !canWrite(req.session.user, 'trips')) throw Object.assign(new Error('Tu rol no permite esta acción'), { status: 403, expose: true });
    const list = TPTrip.mergeCompanions([], listOf(req.body), client.name);
    const updated = await dataStore.updateRecord('clients', client.id, { companions: { list } });
    await dataStore.logActivity(req.session.user.id, 'crm_clients_update', req, { entity: 'clients', entityId: client.id, summary: client.name, note: `Acompañantes frecuentes: ${list.length}` });
    res.json({ ok: true, record: updated, companions: list });
  }));

  return { router };
}

module.exports = { createPassengers };
