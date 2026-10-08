'use strict';

// Roles y visibilidad del CRM.
// Todas las reglas viven aquí para que el servidor sea quien decide qué ve cada usuario.

const ROLE_LABELS = {
  admin: 'Administrador',
  travel_partner: 'Vendedor',
  operaciones: 'Operaciones',
  consulta: 'Consulta'
};
const ROLES = Object.keys(ROLE_LABELS);
// Roles que pueden tener leads asignados.
const SELLER_ROLES = ['admin', 'travel_partner'];

// Qué entidades puede crear o editar cada rol (eliminar es solo del administrador).
const WRITE_RULES = {
  admin: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  travel_partner: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  operaciones: ['trips', 'followups'],
  consulta: []
};

const canWrite = (user, entity) => (WRITE_RULES[user.role] || []).includes(entity);

// Devuelve, por entidad, el conjunto de ids visibles o null cuando ve todo.
function buildScope(user, data) {
  const me = user.id;
  if (user.role === 'admin' || user.role === 'consulta') {
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

function filterData(scope, data) {
  const out = {};
  for (const entity of ['clients', 'leads', 'quotes', 'trips', 'followups']) {
    out[entity] = scope[entity] === null ? data[entity] : data[entity].filter((row) => scope[entity].has(row.id));
  }
  return out;
}

module.exports = { ROLE_LABELS, ROLES, SELLER_ROLES, canWrite, buildScope, isVisible, filterData };
