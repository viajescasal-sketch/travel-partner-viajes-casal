'use strict';

// TP-305: catálogo de proveedores (hoteles, mayoristas, operadores, traslados…).
// Todos los usuarios con sesión lo consultan; el administrador y Operaciones lo editan; solo el administrador elimina.

const express = require('express');
const TPTrip = require('../public/viaje-core');

const EDIT_ROLES = ['admin', 'direccion', 'operaciones'];
// La comisión del proveedor (modelo, %, días de cobro) solo la registran el Administrador y la Dirección.
const COMMISSION_ROLES = ['admin', 'direccion'];
const COMMISSION_FIELDS = ['model', 'commission', 'commission_days'];
const SEED = [
  { name: 'HotelDO', type: 'Mayorista', destinations: 'México y Caribe', notes: 'Mayorista de hotelería. Completa contacto, comisión y condiciones de pago.' },
  { name: 'Azabache', type: 'Mayorista', destinations: 'Riviera Maya', notes: 'Completa contacto, comisión y condiciones de pago.' },
  { name: 'Grupo Xcaret', type: 'Operador de tours', destinations: 'Riviera Maya', website: 'https://www.grupoxcaret.com', notes: 'Parques y tours (Xcaret, Xel-Há, Xplor…). Completa contacto y comisión.' },
  { name: 'Travel Shop', type: 'Mayorista', destinations: '', notes: 'Completa contacto, comisión y condiciones de pago.' }
];

function createSuppliers(dataStore) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

  // Precarga única de los mayoristas que ya usa la agencia.
  async function seed() {
    if (await dataStore.getSetting('suppliers_seeded')) return;
    if (!(await dataStore.listSuppliers()).length) for (const s of SEED) await dataStore.insertSupplier(TPTrip.cleanSupplier(s), null);
    await dataStore.setSetting('suppliers_seeded', { at: new Date().toISOString() });
  }
  const ready = seed().catch((error) => console.error('No se pudo precargar el catálogo de proveedores:', error.message));

  const canEdit = (req) => EDIT_ROLES.includes(req.session.user.role);
  async function find(id) {
    const supplier = (await dataStore.listSuppliers()).find((s) => s.id === Number(id));
    if (!supplier) throw fail(404, 'No se encontró el proveedor');
    return supplier;
  }
  const log = (req, supplier, note) => dataStore.logActivity(req.session.user.id, 'crm_suppliers_update', req, { entity: 'suppliers', entityId: supplier.id, summary: supplier.name, note });

  router.get('/suppliers', wrap(async (req, res) => { await ready; res.json({ ok: true, suppliers: await dataStore.listSuppliers(), canEdit: canEdit(req) }); }));
  router.post('/suppliers', wrap(async (req, res) => {
    if (!canEdit(req)) throw fail(403, 'Solo el administrador, la Dirección y Operaciones editan el catálogo');
    const data = TPTrip.cleanSupplier(req.body);
    if (!COMMISSION_ROLES.includes(req.session.user.role)) { const blank = TPTrip.cleanSupplier({ name: data.name }); COMMISSION_FIELDS.forEach((k) => { data[k] = blank[k]; }); }
    if ((await dataStore.listSuppliers()).some((s) => s.name.toLowerCase() === data.name.toLowerCase())) throw fail(409, `Ya existe un proveedor llamado ${data.name}`);
    const supplier = await dataStore.insertSupplier(data, req.session.user.id);
    await log(req, supplier, 'Proveedor agregado al catálogo');
    res.status(201).json({ ok: true, supplier });
  }));
  router.patch('/suppliers/:id', wrap(async (req, res) => {
    if (!canEdit(req)) throw fail(403, 'Solo el administrador y Operaciones editan el catálogo');
    const current = await find(req.params.id);
    const { id, created_at, updated_at, created_by, ...rest } = current;
    const data = TPTrip.cleanSupplier({ ...rest, ...req.body });
    if (!COMMISSION_ROLES.includes(req.session.user.role)) COMMISSION_FIELDS.forEach((k) => { data[k] = current[k]; });
    if ((await dataStore.listSuppliers()).some((s) => s.id !== current.id && s.name.toLowerCase() === data.name.toLowerCase())) throw fail(409, `Ya existe un proveedor llamado ${data.name}`);
    const supplier = await dataStore.updateSupplier(current.id, data);
    const changed = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(current[k]));
    await log(req, supplier, changed.length ? `Proveedor actualizado: ${changed.join(', ')}` : 'Proveedor revisado sin cambios');
    res.json({ ok: true, supplier });
  }));
  router.delete('/suppliers/:id', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw fail(403, 'Solo el administrador elimina proveedores');
    const current = await find(req.params.id);
    await dataStore.deleteSupplier(current.id);
    await log(req, current, 'Proveedor eliminado del catálogo');
    res.json({ ok: true });
  }));

  return { router, ready };
}

module.exports = { createSuppliers, SEED };
