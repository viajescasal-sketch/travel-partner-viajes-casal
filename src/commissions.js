'use strict';

// TP-206: metas mensuales y comisiones por vendedor.
//  - El administrador define por vendedor su meta mensual (con ajustes por mes) y su % de comisión sobre la utilidad.
//  - La comisión se libera cuando el cliente liquida su plan de pagos ("Por pagar") y el administrador la marca "Pagada".

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const TPComm = require('../public/comisiones-core');

const SETTING = 'goals';
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;

/** Lo que cada usuario puede ver de las metas: el administrador todo; los demás solo lo suyo. */
async function goalsFor(dataStore, user) {
  const goals = TPComm.cleanGoals(await dataStore.getSetting(SETTING));
  if (user.role === 'admin') return goals;
  const mine = goals.sellers[String(user.id)];
  return { base: goals.base, sellers: mine ? { [String(user.id)]: mine } : {} };
}

function createCommissions(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const adminOnly = (req) => { if (req.session.user.role !== 'admin') throw Object.assign(new Error('Solo el administrador'), { status: 403, expose: true }); };

  router.get('/goals', wrap(async (req, res) => { res.json({ ok: true, ...(await goalsFor(dataStore, req.session.user)) }); }));

  router.put('/goals', wrap(async (req, res) => {
    adminOnly(req);
    const users = await dataStore.listUsers();
    const goals = TPComm.cleanGoals(req.body || {});
    for (const id of Object.keys(goals.sellers)) if (!users.some((u) => String(u.id) === id)) delete goals.sellers[id];
    await dataStore.setSetting(SETTING, goals);
    const summary = Object.entries(goals.sellers).map(([id, v]) => `${users.find((u) => String(u.id) === id)?.name || id}: meta ${v.goal === '' ? '—' : money(v.goal)} · ${v.pct === '' ? '—' : `${v.pct}%`}`).join(' · ');
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Metas y comisiones (${TPComm.GOAL_BASE_LABELS[goals.base].toLowerCase()}): ${summary || 'sin vendedores'}`.slice(0, 480) });
    res.json({ ok: true, ...goals });
  }));

  // Marcar la comisión de una venta como pagada al vendedor (o deshacerlo).
  router.post('/quotes/:id/seller-commission', wrap(async (req, res) => {
    adminOnly(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const quote = data.quotes.find((q) => q.id === id);
    if (!quote || quote.status !== 'Aceptada') throw Object.assign(new Error('No se encontró la venta'), { status: 404, expose: true });
    const goals = TPComm.cleanGoals(await dataStore.getSetting(SETTING));
    const sale = TPComm.sales({ ...data, quotes: [quote] }, { goals })[0];
    const seller = (await dataStore.listUsers()).find((u) => String(u.id) === String(sale?.seller));
    let update, note;
    if (req.body?.action === 'undo') {
      if (sale.status !== 'Pagada') throw new ValidationError('Esa comisión no está marcada como pagada');
      update = null;
      note = `Comisión del vendedor regresada a pendiente (${money(sale.commission)})`;
    } else if (req.body?.action === 'pay') {
      if (sale.status === 'Pagada') throw new ValidationError('Esa comisión ya está pagada');
      if (sale.status !== 'Por pagar') throw new ValidationError('El cliente aún no liquida su viaje: la comisión se libera al pagar todo');
      if (sale.commission == null) throw new ValidationError(sale.pct == null ? 'Define el % de comisión del vendedor en Configuración › Metas y comisiones' : 'Faltan costos o comisiones en las reservas del viaje para calcular la utilidad');
      update = { status: 'Pagada', amount: sale.commission, pct: sale.pct, profit: sale.profit, seller_id: sale.seller, paid_at: nowCancun(), by: req.session.user.id };
      note = `Comisión pagada a ${seller?.name || 'vendedor'}: ${money(sale.commission)} (${sale.pct}% de ${money(sale.profit)} de utilidad)`;
    } else throw new ValidationError('Acción no válida');
    const updated = await dataStore.updateRecord('quotes', quote.id, { seller_commission: update });
    await dataStore.logActivity(req.session.user.id, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note });
    res.json({ ok: true, record: updated });
  }));

  return { router };
}

module.exports = { createCommissions, goalsFor };
