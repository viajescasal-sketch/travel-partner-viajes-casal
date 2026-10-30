'use strict';

// Interruptor del módulo de proveedor (portal de proveedores de traslados, TP-009).
// - Encendido (por omisión): todo funciona como siempre.
// - Apagado: el proveedor no entra a su portal, no se envían solicitudes de precio desde el CRM y el
//   traslado se captura a mano (costo, precio, fecha de pago) con su alerta de pago. Los datos no se borran.
// - Lo enciende o apaga solo el administrador. Se guarda en crm_settings › supplier_module.

const express = require('express');

const SETTING = 'supplier_module';
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

async function isEnabled(dataStore) {
  const raw = await dataStore.getSetting(SETTING);
  return !(raw && raw.enabled === false);
}

// Middleware: con el módulo apagado, el usuario proveedor no usa su portal.
function createGate(dataStore) {
  return async function supplierModuleGate(req, res, next) {
    try {
      if (req.session?.user?.role !== 'proveedor' || !/^\/proveedor(\/|$)/.test(req.path)) return next();
      if (await isEnabled(dataStore)) return next();
      return res.status(403).json({ ok: false, error: 'El portal de proveedores está desactivado por ahora. Escribe a Viajes Casal.' });
    } catch (error) { return next(error); }
  };
}

function createSupplierModule(dataStore, { requireRole } = {}) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  router.get('/supplier-module', wrap(async (req, res) => {
    if (req.session.user.role === 'proveedor') throw fail(403, 'Acceso no autorizado');
    const raw = (await dataStore.getSetting(SETTING)) || {};
    res.json({ ok: true, enabled: await isEnabled(dataStore), changedAt: raw.changedAt || null });
  }));

  router.put('/supplier-module', requireRole('admin'), wrap(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw fail(400, 'Indica si el módulo queda activado o desactivado');
    const enabled = req.body.enabled;
    await dataStore.setSetting(SETTING, { enabled, changedAt: new Date().toISOString().slice(0, 19), changedBy: req.session.user.id });
    await dataStore.logActivity(req.session.user.id, 'crm_suppliers_update', req, { entity: 'suppliers', summary: 'Módulo de proveedor', note: enabled ? 'Módulo de proveedor activado' : 'Módulo de proveedor desactivado' });
    res.json({ ok: true, enabled });
  }));

  return { router, isEnabled: () => isEnabled(dataStore) };
}

module.exports = { createSupplierModule, createGate, isEnabled, SETTING };
