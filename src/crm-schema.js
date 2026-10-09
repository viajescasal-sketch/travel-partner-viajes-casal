'use strict';

// Definición de las entidades comerciales del CRM.
// Cada campo indica su tipo para validar lo que llega desde la página
// y para crear las tablas en MySQL.

const LEAD_STAGES = ['Nuevo', 'Calificado', 'Cotizado', 'Negociación', 'Vendido', 'Perdido'];
const PRIORITIES = ['Alta', 'Media', 'Baja'];
const LEAD_SOURCES = ['WhatsApp', 'Instagram', 'Facebook', 'Sitio web', 'Referido', 'Otro'];
const QUOTE_STATUSES = ['Borrador', 'PDF generado', 'Enviada', 'Aceptada', 'Rechazada'];
const QUOTE_MODES = ['Total', 'Por persona', 'Por noche'];
const TRIP_STATUSES = ['Confirmado', 'Documentación pendiente', 'En viaje', 'Solicitar reseña', 'Postventa', 'Cerrado'];
const FOLLOWUP_TYPES = ['Llamada', 'WhatsApp', 'Cotización', 'Pago', 'Otro'];

const ENTITIES = {
  clients: {
    table: 'crm_clients',
    label: 'cliente',
    fields: {
      name: { type: 'string', max: 120, required: true },
      phone: { type: 'string', max: 40 },
      email: { type: 'email', max: 254 },
      tags: { type: 'string', max: 255 },
      notes: { type: 'text', max: 4000 }
    }
  },
  leads: {
    table: 'crm_leads',
    label: 'lead',
    fields: {
      client_id: { type: 'ref', entity: 'clients', required: true, onDelete: 'CASCADE' },
      destination: { type: 'string', max: 120, required: true },
      start_date: { type: 'date' },
      end_date: { type: 'date' },
      travelers: { type: 'int', min: 1, max: 500 },
      budget: { type: 'money' },
      stage: { type: 'enum', values: LEAD_STAGES, default: 'Nuevo' },
      priority: { type: 'enum', values: PRIORITIES, default: 'Media' },
      source: { type: 'enum', values: LEAD_SOURCES, default: 'WhatsApp' },
      notes: { type: 'text', max: 4000 },
      qualification: { type: 'json', max: 20000 },
      closed_at: { type: 'datetime', internal: true }
    }
  },
  quotes: {
    table: 'crm_quotes',
    label: 'cotización',
    fields: {
      folio: { type: 'string', max: 20, internal: true, unique: true },
      client_id: { type: 'ref', entity: 'clients', required: true, onDelete: 'CASCADE' },
      lead_id: { type: 'ref', entity: 'leads', onDelete: 'SET NULL' },
      destination: { type: 'string', max: 120, required: true },
      hotel: { type: 'string', max: 200, required: true },
      price: { type: 'money', required: true },
      mode: { type: 'enum', values: QUOTE_MODES, default: 'Total' },
      valid_until: { type: 'date' },
      status: { type: 'enum', values: QUOTE_STATUSES, default: 'Borrador' },
      services: { type: 'text', max: 4000 },
      details: { type: 'json', max: 120000 },
      accepted_at: { type: 'datetime', internal: true }
    }
  },
  trips: {
    table: 'crm_trips',
    label: 'viaje',
    fields: {
      client_id: { type: 'ref', entity: 'clients', required: true, onDelete: 'CASCADE' },
      quote_id: { type: 'ref', entity: 'quotes', onDelete: 'SET NULL' },
      destination: { type: 'string', max: 120, required: true },
      start_date: { type: 'date', required: true },
      end_date: { type: 'date', required: true },
      status: { type: 'enum', values: TRIP_STATUSES, default: 'Confirmado' },
      notes: { type: 'text', max: 4000 },
      confirmation: { type: 'json', max: 60000 }
    }
  },
  followups: {
    table: 'crm_followups',
    label: 'seguimiento',
    fields: {
      client_id: { type: 'ref', entity: 'clients', onDelete: 'CASCADE' },
      lead_id: { type: 'ref', entity: 'leads', onDelete: 'CASCADE' },
      type: { type: 'enum', values: FOLLOWUP_TYPES, default: 'Llamada' },
      title: { type: 'string', max: 160, required: true },
      details: { type: 'text', max: 2000 },
      due_at: { type: 'datetime', required: true },
      done: { type: 'bool', default: false }
    }
  }
};

// Orden de creación de tablas (las referenciadas primero).
const ENTITY_ORDER = ['clients', 'leads', 'quotes', 'trips', 'followups'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function coerceField(name, spec, raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') {
    if (spec.required) throw new ValidationError(`El campo ${name} es obligatorio`);
    return spec.type === 'bool' ? false : null;
  }
  switch (spec.type) {
    case 'string':
    case 'text': {
      const value = String(raw).trim();
      if (!value && spec.required) throw new ValidationError(`El campo ${name} es obligatorio`);
      if (value.length > spec.max) throw new ValidationError(`El campo ${name} admite máximo ${spec.max} caracteres`);
      return value || null;
    }
    case 'email': {
      const value = String(raw).trim().toLowerCase();
      if (!value) return null;
      if (!EMAIL_RE.test(value) || value.length > spec.max) throw new ValidationError('El correo no es válido');
      return value;
    }
    case 'enum': {
      const value = String(raw);
      if (!spec.values.includes(value)) throw new ValidationError(`Valor no permitido en ${name}`);
      return value;
    }
    case 'int':
    case 'ref': {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < (spec.min ?? 1) || (spec.max && value > spec.max)) {
        throw new ValidationError(`El campo ${name} no es válido`);
      }
      return value;
    }
    case 'money': {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 999999999) throw new ValidationError(`El monto de ${name} no es válido`);
      return Math.round(value * 100) / 100;
    }
    case 'date': {
      const value = String(raw).trim();
      if (!validDate(value)) throw new ValidationError(`La fecha de ${name} no es válida`);
      return value;
    }
    case 'datetime': {
      const match = DATETIME_RE.exec(String(raw).trim());
      if (!match || !validDate(match[1])) throw new ValidationError(`La fecha y hora de ${name} no son válidas`);
      return `${match[1]} ${match[2]}:00`;
    }
    case 'bool':
      return raw === true || raw === 1 || raw === '1' || raw === 'true';
    case 'json': {
      // Datos estructurados (cotizador, confirmación, calificación): objeto simple con tamaño máximo.
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`El campo ${name} no es válido`);
      const text = JSON.stringify(raw);
      if (text.length > spec.max) throw new ValidationError(`El contenido de ${name} es demasiado grande`);
      return JSON.parse(text);
    }
    default:
      throw new ValidationError(`Campo desconocido ${name}`);
  }
}

// Limpia y valida el cuerpo recibido. En creación aplica valores por defecto
// y exige los campos obligatorios; en edición solo toma lo que llegó.
function sanitize(entityName, body, { partial = false } = {}) {
  const entity = ENTITIES[entityName];
  const input = body && typeof body === 'object' ? body : {};
  const output = {};
  for (const [name, spec] of Object.entries(entity.fields)) {
    if (spec.internal) continue;
    const value = coerceField(name, spec, input[name]);
    if (value !== undefined) output[name] = value;
    else if (!partial) {
      if (spec.required) throw new ValidationError(`El campo ${name} es obligatorio`);
      if (spec.default !== undefined) output[name] = spec.default;
    }
  }
  return output;
}

function checkDateRange(record) {
  if (record.start_date && record.end_date && record.end_date < record.start_date) {
    throw new ValidationError('La fecha de regreso no puede ser anterior a la de salida');
  }
}

// Fecha y hora actual en Cancún (UTC-5 todo el año) con formato MySQL.
function nowCancun(date = new Date()) {
  const local = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

function columnSql(name, spec) {
  const notNull = spec.required ? ' NOT NULL' : ' NULL';
  switch (spec.type) {
    case 'string':
    case 'email':
      return `\`${name}\` VARCHAR(${spec.max})${notNull}${spec.unique ? ' UNIQUE' : ''}`;
    case 'text':
      return `\`${name}\` TEXT NULL`;
    case 'enum':
      return `\`${name}\` VARCHAR(40) NOT NULL DEFAULT '${spec.default}'`;
    case 'int':
      return `\`${name}\` INT UNSIGNED NULL`;
    case 'ref':
      return `\`${name}\` BIGINT UNSIGNED${notNull}`;
    case 'money':
      return `\`${name}\` DECIMAL(12,2)${notNull}`;
    case 'date':
      return `\`${name}\` DATE${notNull}`;
    case 'datetime':
      return `\`${name}\` DATETIME${notNull}`;
    case 'bool':
      return `\`${name}\` BOOLEAN NOT NULL DEFAULT FALSE`;
    case 'json':
      return `\`${name}\` MEDIUMTEXT NULL`;
    default:
      throw new Error(`Tipo sin columna: ${spec.type}`);
  }
}

function createTableSql(entityName) {
  const entity = ENTITIES[entityName];
  const columns = ['`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY'];
  const extras = [];
  for (const [name, spec] of Object.entries(entity.fields)) {
    columns.push(columnSql(name, spec));
    if (spec.type === 'ref') {
      extras.push(`INDEX \`idx_${entity.table}_${name}\` (\`${name}\`)`);
      extras.push(`CONSTRAINT \`fk_${entity.table}_${name}\` FOREIGN KEY (\`${name}\`) REFERENCES \`${ENTITIES[spec.entity].table}\`(\`id\`) ON DELETE ${spec.onDelete}`);
    }
  }
  columns.push('`owner_id` BIGINT UNSIGNED NULL');
  columns.push('`created_at` DATETIME NOT NULL');
  columns.push('`updated_at` DATETIME NOT NULL');
  extras.push(`CONSTRAINT \`fk_${entity.table}_owner\` FOREIGN KEY (\`owner_id\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL`);
  return `CREATE TABLE IF NOT EXISTS \`${entity.table}\` (\n  ${[...columns, ...extras].join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

module.exports = {
  ENTITIES,
  ENTITY_ORDER,
  LEAD_STAGES,
  PRIORITIES,
  LEAD_SOURCES,
  QUOTE_STATUSES,
  QUOTE_MODES,
  TRIP_STATUSES,
  FOLLOWUP_TYPES,
  ValidationError,
  sanitize,
  checkDateRange,
  nowCancun,
  columnSql,
  createTableSql
};
