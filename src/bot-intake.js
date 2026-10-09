'use strict';

// Lectura de las respuestas del bot de WhatsApp (Botpress): fechas, personas y presupuesto
// llegan como texto libre o como opciones de botón; aquí se convierten a datos del CRM.

const MONTHS = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');

function validIso(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
// Sin año: la próxima vez que llega esa fecha a partir de hoy.
function withYear(d, m, y, today) {
  if (y) return validIso(y < 100 ? 2000 + y : y, m, d);
  const year = Number(today.slice(0, 4));
  const candidate = validIso(year, m, d);
  if (candidate && candidate >= today) return candidate;
  return validIso(year + 1, m, d);
}

// Devuelve { start, end, matched } o null. today = 'YYYY-MM-DD' (Cancún).
function parseDates(text, today) {
  const t = norm(text);
  let m;
  // 2026-12-10 (al 2026-12-15)
  m = /(\d{4})-(\d{2})-(\d{2})(?:\D+(\d{4})-(\d{2})-(\d{2}))?/.exec(t);
  if (m) {
    const start = validIso(+m[1], +m[2], +m[3]);
    const end = m[4] ? validIso(+m[4], +m[5], +m[6]) : null;
    if (start) return { start, end: end && end >= start ? end : null, matched: m[0] };
  }
  // 10/12 al 15/12/2026  ·  10/12/2026 - 15/12/2026
  m = /(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\s*(?:al|a|-|–|hasta)\s*(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/.exec(t);
  if (m) {
    const y2 = m[6] ? +m[6] : m[3] ? +m[3] : null;
    const start = withYear(+m[1], +m[2], m[3] ? +m[3] : y2, today);
    let end = withYear(+m[4], +m[5], y2, today);
    if (start && end && end < start && !y2) end = withYear(+m[4], +m[5], Number(start.slice(0, 4)) + 1, today);
    if (start) return { start, end: end && end >= start ? end : null, matched: m[0] };
  }
  // del 10 de diciembre al 2 de enero (de 2027)
  m = new RegExp(`(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}))?\\s*(?:al|a|-|–|hasta)\\s*(?:el\\s+)?(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}))?`).exec(t);
  if (m) {
    const y2 = m[6] ? +m[6] : null;
    const start = withYear(+m[1], MONTHS[m[2]], m[3] ? +m[3] : null, today);
    let end = withYear(+m[4], MONTHS[m[5]], y2, today);
    if (start && end && end < start) end = validIso(Number(start.slice(0, 4)) + 1, MONTHS[m[5]], +m[4]);
    if (start) return { start, end: end && end >= start ? end : null, matched: m[0] };
  }
  // del 10 al 15 de diciembre (de 2026)
  m = new RegExp(`(\\d{1,2})\\s*(?:al|a|-|–|hasta)\\s*(?:el\\s+)?(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}))?`).exec(t);
  if (m) {
    const start = withYear(+m[1], MONTHS[m[3]], m[4] ? +m[4] : null, today);
    const end = start ? validIso(Number(start.slice(0, 4)), MONTHS[m[3]], +m[2]) : null;
    if (start) return { start, end: end && end >= start ? end : null, matched: m[0] };
  }
  // 10 de diciembre (una sola fecha)
  m = new RegExp(`(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}))?`).exec(t);
  if (m) {
    const start = withYear(+m[1], MONTHS[m[2]], m[3] ? +m[3] : null, today);
    if (start) return { start, end: null, matched: m[0] };
  }
  return null;
}

// "Cancún del 10 al 15 de diciembre" → "Cancún"
function destinationFrom(text, matched) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let dest = raw;
  if (matched) {
    const idx = norm(raw).indexOf(matched);
    if (idx > 0) dest = raw.slice(0, idx);
  }
  dest = dest.replace(/\s+(del|el|los|en|para|de|a partir del?)\s*$/i, '').replace(/[\s,.;:–-]+$/, '').trim();
  return (dest || raw).slice(0, 120);
}

// "2 adultos y 1 niño" → 3
function peopleFrom(text) {
  const t = norm(text);
  if (!t) return null;
  const nums = (t.match(/\d+/g) || []).map(Number).filter((n) => n > 0 && n <= 60);
  if (nums.length) return Math.min(nums.reduce((a, b) => a + b, 0), 500);
  const words = { uno: 1, una: 1, solo: 1, sola: 1, dos: 2, pareja: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  if (/\bpareja\b/.test(t)) delete words.una, delete words.uno;
  const found = Object.entries(words).filter(([w]) => new RegExp(`\\b${w}\\b`).test(t)).map(([, n]) => n);
  return found.length ? found.reduce((a, b) => a + b, 0) : null;
}

// "De $8,000 a $15,000" → 15000 · "Menos de $3,000" → 3000 · "15 mil" → 15000 · "Que me orienten" → null
function budgetFrom(text) {
  const t = norm(text).replace(/(\d),(\d{3})/g, '$1$2');
  const values = [];
  const re = /(\d+(?:\.\d+)?)\s*(mil|k)?/g;
  let m;
  while ((m = re.exec(t))) {
    let n = Number(m[1]);
    if (m[2]) n *= 1000;
    if (n >= 100) values.push(n);
  }
  return values.length ? Math.max(...values) : null;
}

// Opción de presupuesto del CRM que corresponde al presupuesto por persona.
function budgetOption(perPerson, question, text = '') {
  if (!question) return null;
  const over = /mas de|arriba de|mayor a/.test(norm(text));
  const above = (limit) => perPerson > limit || (over && perPerson >= limit);
  const labels = question.options.map((o) => o.label);
  const pick = (re) => labels.find((l) => re.test(norm(l))) || null;
  if (perPerson == null) return pick(/no lo sabe|no sabe|orient/);
  if (above(25000)) return pick(/mas de \$?25/);
  if (above(15000)) return pick(/15 a \$?25/);
  if (above(8000)) return pick(/8 a \$?15/);
  return pick(/menos de \$?8/);
}

const PHONE_RE = /^\+?[\d\s()-]{7,25}$/;
function cleanPhone(value) {
  const v = String(value || '').trim();
  if (!PHONE_RE.test(v)) return '';
  const digits = v.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  // Formato legible: +52 998 123 4567 (WhatsApp de México llega como 521XXXXXXXXXX o 52XXXXXXXXXX)
  const mx = /^52(1)?(\d{10})$/.exec(digits);
  if (mx) return `+52 ${mx[2].slice(0, 3)} ${mx[2].slice(3, 6)} ${mx[2].slice(6)}`;
  return `+${digits}`;
}

module.exports = { parseDates, destinationFrom, peopleFrom, budgetFrom, budgetOption, cleanPhone, norm };
