'use strict';

// TP-206: metas mensuales y comisiones por vendedor.
//  - El administrador define por vendedor su meta mensual (con ajustes por mes) y su % de comisión sobre la utilidad.
//  - La comisión se libera cuando el cliente liquida su plan de pagos ("Por pagar") y el administrador la marca "Pagada".

const express = require('express');
const { ENTITY_ORDER, ValidationError, nowCancun } = require('./crm-schema');
const TPComm = require('../public/comisiones-core');
const { isManager } = require('./access');

const SETTING = 'goals';
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;

/** Lo que cada usuario puede ver de las metas: el administrador todo; los demás solo lo suyo. */
async function goalsFor(dataStore, user) {
  const goals = TPComm.cleanGoals(await dataStore.getSetting(SETTING));
  if (isManager(user)) return goals;
  // El equipo ve su propia meta, pero no el % de comisión ni lo que se paga (por ahora no se habilita para ellos).
  const mine = goals.sellers[String(user.id)];
  return { base: goals.base, sellers: mine ? { [String(user.id)]: { ...mine, pct: '' } } : {} };
}

function createCommissions(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const adminOnly = (req) => { if (!isManager(req.session.user)) throw Object.assign(new Error('Solo el administrador y la Dirección'), { status: 403, expose: true }); };

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

  // Comisión de la agencia por venta: % del total o monto manual. Neto (pago a proveedores) = venta − comisión.
  router.put('/quotes/:id/agency-margin', wrap(async (req, res) => {
    adminOnly(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError('Identificador inválido');
    const quote = (await dataStore.listRecords('quotes')).find((q) => q.id === id);
    if (!quote) throw Object.assign(new Error('No se encontró la cotización'), { status: 404, expose: true });
    const total = Number(quote.payment_plan?.total) || Number(quote.price) || 0;
    const body = req.body || {};
    let margin = null;
    let note = 'Comisión de la venta quitada (se usan las reservas)';
    if (!body.clear) {
      const value = Number(String(body.value ?? '').replace(/[^0-9.]/g, ''));
      if (!['pct', 'monto'].includes(body.mode) || body.value === '' || body.value == null || !Number.isFinite(value)) throw new ValidationError('Elige % o monto y escribe el valor');
      if (body.mode === 'pct' && (value < 0 || value > 100)) throw new ValidationError('El porcentaje debe estar entre 0 y 100');
      if (body.mode === 'monto' && (value < 0 || value > total)) throw new ValidationError('La comisión no puede ser mayor al total de la venta');
      margin = { mode: body.mode, value: Math.round(value * 100) / 100 };
      const amount = body.mode === 'pct' ? Math.round(total * value) / 100 : value;
      note = `Comisión de la venta ${margin.mode === 'pct' ? `${margin.value}%` : 'manual'}: ${money(amount)} de ${money(total)} (neto ${money(total - amount)})`;
    }
    const updated = await dataStore.updateRecord('quotes', quote.id, { agency_margin: margin });
    await dataStore.logActivity(req.session.user.id, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: note.slice(0, 480) });
    res.json({ ok: true, record: updated });
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
