'use strict';

// Roles y visibilidad del CRM.
// Todas las reglas viven aquí para que el servidor sea quien decide qué ve cada usuario.

// Cadena de mando: Administrador (CEO) › Dirección (Travel Partner, gerencia) › Travel Partner (gestiona viajes) › Vendedor (solo vende).
const ROLE_LABELS = {
  admin: 'Administrador',
  direccion: 'Dirección',
  travel_partner: 'Travel Partner',
  vendedor: 'Vendedor',
  operaciones: 'Operaciones',
  consulta: 'Consulta',
  proveedor: 'Proveedor'
};
const ROLES = Object.keys(ROLE_LABELS);
// Roles que pueden tener leads asignados.
const SELLER_ROLES = ['admin', 'direccion', 'travel_partner', 'vendedor'];
// Quienes entran por defecto al reparto de leads (turnos): el equipo que vende y gestiona viajes.
const DEFAULT_ASSIGNEE_ROLES = ['travel_partner', 'vendedor'];
// Dirección y Administrador: ven a todo el equipo, reasignan leads y registran comisiones.
const MANAGER_ROLES = ['admin', 'direccion'];
// Quién ve costos, utilidad y comisiones (el Vendedor no).
const COST_ROLES = ['admin', 'direccion', 'travel_partner', 'operaciones', 'consulta'];
const isManager = (user) => MANAGER_ROLES.includes(user?.role);
const canSeeCosts = (user) => COST_ROLES.includes(user?.role);

// Qué entidades puede crear o editar cada rol (eliminar es solo del administrador).
const WRITE_RULES = {
  admin: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  direccion: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  travel_partner: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  vendedor: ['clients', 'leads', 'quotes', 'followups'],
  operaciones: ['trips', 'followups'],
  consulta: [],
  proveedor: []
};

const canWrite = (user, entity) => (WRITE_RULES[user.role] || []).includes(entity);

// Devuelve, por entidad, el conjunto de ids visibles o null cuando ve todo.
function buildScope(user, data) {
  const me = user.id;
  // TP-009: el proveedor no ve nada del CRM; solo su portal (/api/proveedor).
  if (user.role === 'proveedor') {
    return { clients: new Set(), leads: new Set(), quotes: new Set(), trips: new Set(), followups: new Set() };
  }
  if (user.role === 'admin' || user.role === 'direccion' || user.role === 'consulta') {
    return { clients: null, leads: null, quotes: null, trips: null, followups: null };
  }
  if (user.role === 'operaciones') {
    return {
      clients: null,
      leads: new Set(),
      quotes: null,
      trips: null,
      followups: new Set(data.followups.filter((f) => f.owner_id === me && !f.lead_id).map((f) => f.id))
    };
  }
  // Vendedor: lo suyo y lo que cuelga de sus leads.
  const leads = new Set(data.leads.filter((l) => l.owner_id === me).map((l) => l.id));
  const clients = new Set([
    ...data.clients.filter((c) => c.owner_id === me).map((c) => c.id),
    ...data.leads.filter((l) => leads.has(l.id)).map((l) => l.client_id)
  ]);
  const quotes = new Set(data.quotes.filter((q) => (q.lead_id ? leads.has(q.lead_id) : q.owner_id === me && clients.has(q.client_id))).map((q) => q.id));
  const trips = new Set(data.trips.filter((t) => clients.has(t.client_id) || t.owner_id === me).map((t) => t.id));
  const followups = new Set(data.followups.filter((f) => (f.lead_id ? leads.has(f.lead_id) : f.owner_id === me)).map((f) => f.id));
  return { clients, leads, quotes, trips, followups };
}

const isVisible = (scope, entity, id) => id == null || scope[entity] === null || scope[entity].has(Number(id));

// El Vendedor ve el estado de sus viajes pero no costos, utilidad, comisiones ni lo que cotizó el proveedor.
const COST_FIELDS = ['cost', 'model', 'supplier_due', 'supplier_paid', 'supplier_paid_at', 'commission_pct', 'commission_amount', 'commission_due', 'commission_status', 'commission_invoice', 'commission_paid_at'];
function redactBooking(b) {
  const out = { ...b };
  for (const k of COST_FIELDS) delete out[k];
  if (out.portal) { out.portal = { ...out.portal }; delete out.portal.quote; }
  return out;
}
function redactTrip(trip) {
  if (!trip?.bookings?.list) return trip;
  return { ...trip, bookings: { ...trip.bookings, list: trip.bookings.list.map(redactBooking) } };
}

function filterData(scope, data, user) {
  const out = {};
  for (const entity of ['clients', 'leads', 'quotes', 'trips', 'followups']) {
    out[entity] = scope[entity] === null ? data[entity] : data[entity].filter((row) => scope[entity].has(row.id));
  }
  if (user && !canSeeCosts(user)) out.trips = out.trips.map(redactTrip);
  return out;
}

module.exports = { ROLE_LABELS, ROLES, SELLER_ROLES, DEFAULT_ASSIGNEE_ROLES, MANAGER_ROLES, COST_ROLES, isManager, canSeeCosts, redactBooking, redactTrip, canWrite, buildScope, isVisible, filterData };
