'use strict';

/* TP-306: campos personalizables en leads, clientes y viajes.
   El administrador define los campos (Configuración › Campos personalizables); los valores se guardan
   en record.custom = { clave: valor }. Mismas reglas en la plataforma, el servidor y las pruebas. */
(function (global) {
  const ENTITIES = { leads: 'Leads', clients: 'Clientes', trips: 'Viajes' };
  const TYPES = { text: 'Texto corto', longtext: 'Texto largo', number: 'Número', date: 'Fecha', select: 'Lista (una opción)', multi: 'Lista (varias opciones)', bool: 'Sí / No' };
  const MAX_FIELDS = 30;
  const MAX_OPTIONS = 40;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const str = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const fail = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

  // "Aerolínea preferida" → "aerolinea_preferida"
  function slug(label) {
    return str(label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'campo';
  }

  function cleanDef(raw, taken) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = str(r.label).slice(0, 60);
    if (!label) return null;
    const type = TYPES[r.type] ? r.type : 'text';
    let key = /^[a-z0-9_]{1,40}$/.test(String(r.key || '')) ? String(r.key) : slug(label);
    if (taken.has(key)) { let n = 2; while (taken.has(`${key.slice(0, 37)}_${n}`)) n += 1; key = `${key.slice(0, 37)}_${n}`; }
    taken.add(key);
    const options = ['select', 'multi'].includes(type)
      ? [...new Set((Array.isArray(r.options) ? r.options : String(r.options || '').split(/[\n,]/)).map((o) => str(o).slice(0, 60)).filter(Boolean))].slice(0, MAX_OPTIONS)
      : [];
    if (['select', 'multi'].includes(type) && !options.length) throw fail(`Agrega las opciones de “${label}”`);
    return { key, label, type, options, required: r.required === true, active: r.active !== false, card: r.card === true, help: str(r.help).slice(0, 160) };
  }

  /** { leads: [...], clients: [...], trips: [...] } */
  function cleanDefs(raw) {
    const out = {};
    for (const entity of Object.keys(ENTITIES)) {
      const list = Array.isArray(raw?.[entity]) ? raw[entity] : [];
      if (list.length > MAX_FIELDS) throw fail(`Máximo ${MAX_FIELDS} campos en ${ENTITIES[entity]}`);
      const taken = new Set();
      out[entity] = list.map((d) => cleanDef(d, taken)).filter(Boolean);
    }
    return out;
  }

  /** Valor limpio de un campo ('' = vacío). Lanza error si no es válido. */
  function cleanValue(def, v) {
    if (v == null || v === '') return '';
    switch (def.type) {
      case 'text': return str(v).slice(0, 300);
      case 'longtext': return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 3000);
      case 'number': {
        const t = String(v).replace(/[\s,$]/g, '');
        const n = Number(t);
        if (!t || !Number.isFinite(n)) throw fail(`“${def.label}” debe ser un número`);
        return Math.round(n * 100) / 100;
      }
      case 'date':
        if (!ISO.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw fail(`“${def.label}” debe ser una fecha`);
        return String(v);
      case 'select': {
        const s = str(v);
        if (!def.options.includes(s)) throw fail(`Elige una opción válida en “${def.label}”`);
        return s;
      }
      case 'multi': {
        const list = (Array.isArray(v) ? v : String(v).split(',')).map(str).filter(Boolean);
        const bad = list.find((x) => !def.options.includes(x));
        if (bad) throw fail(`“${bad}” no es una opción de “${def.label}”`);
        return list.length ? [...new Set(list)] : '';
      }
      case 'bool': return v === true || v === 'true' || v === 'on' || v === 'Sí' ? true : v === false || v === 'false' || v === 'No' ? false : '';
      default: return '';
    }
  }

  /**
   * Mezcla los valores nuevos con los anteriores.
   * - Solo se aceptan campos activos; los de campos desactivados se conservan tal cual.
   * - missing: etiquetas de campos obligatorios vacíos.
   */
  function cleanValues(defs, input, previous = {}) {
    const list = Array.isArray(defs) ? defs : [];
    const known = new Set(list.map((d) => d.key));
    const values = {};
    for (const [k, v] of Object.entries(previous && typeof previous === 'object' ? previous : {})) if (known.has(k)) values[k] = v;
    const src = input && typeof input === 'object' ? input : {};
    for (const def of list.filter((d) => d.active)) {
      if (!(def.key in src)) continue;
      const v = cleanValue(def, src[def.key]);
      if (v === '' || (def.type === 'bool' && v === '')) delete values[def.key];
      else values[def.key] = v;
    }
    const missing = list.filter((d) => d.active && d.required && (values[d.key] === undefined || values[d.key] === '' || (d.type === 'bool' && values[d.key] !== true && values[d.key] !== false))).map((d) => d.label);
    return { values, missing };
  }

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function display(def, v) {
    if (v == null || v === '') return '';
    if (def?.type === 'bool') return v ? 'Sí' : 'No';
    if (def?.type === 'date' && ISO.test(String(v))) return `${Number(v.slice(8, 10))} ${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
    if (Array.isArray(v)) return v.join(', ');
    if (def?.type === 'number') return Number(v).toLocaleString('es-MX', { maximumFractionDigits: 2 });
    return String(v);
  }
  // Texto para la exportación a Excel/CSV.
  const plain = (def, v) => (v == null || v === '' ? '' : def?.type === 'bool' ? (v ? 'Sí' : 'No') : Array.isArray(v) ? v.join(', ') : v);
  // Etiqueta legible a partir de la clave (para la bitácora).
  const humanize = (key) => { const s = String(key).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

  global.TPFields = { ENTITIES, TYPES, MAX_FIELDS, slug, cleanDefs, cleanValue, cleanValues, display, plain, humanize };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPFields;
}(typeof window !== 'undefined' ? window : globalThis));
