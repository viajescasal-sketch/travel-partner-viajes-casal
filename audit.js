'use strict';

const { ENTITIES } = require('./crm-schema');

// Nombres de los campos tal como se muestran en la bitácora.
const FIELD_LABELS = {
  name: 'Nombre', phone: 'WhatsApp', email: 'Correo', tags: 'Preferencias', notes: 'Notas',
  client_id: 'Cliente', lead_id: 'Lead', quote_id: 'Cotización',
  destination: 'Destino', start_date: 'Salida', end_date: 'Regreso', travelers: 'Viajeros', budget: 'Presupuesto',
  stage: 'Etapa', priority: 'Prioridad', source: 'Origen',
  hotel: 'Hotel / paquete', price: 'Precio', mode: 'Modalidad', valid_until: 'Vigencia', status: 'Estado', services: 'Servicios',
  type: 'Tipo', title: 'Actividad', details: 'Detalles', due_at: 'Fecha y hora', done: 'Hecho',
  owner_id: 'Vendedor'
};

const MAX_TEXT = 120;
const money = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n) || 0);
const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

// find(entity, id) devuelve el registro o null.
function describeRef(entity, id, find) {
  if (id == null) return null;
  const record = find(entity, id);
  if (!record) return `#${id}`;
  if (entity === 'clients') return record.name;
  if (entity === 'leads') return `${record.destination} (lead #${record.id})`;
  if (entity === 'quotes') return record.folio || `#${record.id}`;
  return `#${id}`;
}

function displayValue(entityName, field, value, find) {
  if (value == null || value === '') return null;
  const spec = ENTITIES[entityName].fields[field];
  if (!spec) return clip(String(value));
  switch (spec.type) {
    case 'ref': return describeRef(spec.entity, value, find);
    case 'money': return money(value);
    case 'bool': return value ? 'Sí' : 'No';
    case 'datetime': return String(value).slice(0, 16);
    default: return clip(String(value));
  }
}

// Resumen corto para identificar el registro aunque después se elimine.
function summaryFor(entityName, record, find) {
  if (!record) return null;
  const client = record.client_id ? find('clients', record.client_id)?.name : null;
  switch (entityName) {
    case 'clients': return record.name;
    case 'leads': return [client, record.destination].filter(Boolean).join(' · ');
    case 'quotes': return [record.folio, client, record.hotel].filter(Boolean).join(' · ');
    case 'trips': return [client, record.destination, record.start_date].filter(Boolean).join(' · ');
    case 'followups': return [record.title, client].filter(Boolean).join(' · ');
    default: return null;
  }
}

// Diferencias campo por campo entre la versión anterior y la nueva.
function diffChanges(entityName, before, after, find) {
  const changes = [];
  for (const field of Object.keys(ENTITIES[entityName].fields)) {
    if (!(field in FIELD_LABELS)) continue;
    const a = before?.[field] ?? null;
    const b = after?.[field] ?? null;
    const same = (typeof a === 'number' || typeof b === 'number') ? Number(a) === Number(b) && (a == null) === (b == null) : String(a ?? '') === String(b ?? '');
    if (same) continue;
    changes.push({ field, label: FIELD_LABELS[field], from: displayValue(entityName, field, a, find), to: displayValue(entityName, field, b, find) });
  }
  return changes;
}

module.exports = { FIELD_LABELS, summaryFor, diffChanges, displayValue };
