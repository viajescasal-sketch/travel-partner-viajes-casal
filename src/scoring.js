'use strict';

// Calificación automática de leads (TP-109).
// Puntaje 0–100 con: presupuesto por persona, cercanía de fechas, tamaño del grupo, respuesta del cliente
// y, si se contestaron, las preguntas de calificación. La prioridad (Alta/Media/Baja) sale del puntaje.

const { ValidationError } = require('./crm-schema');

const RESPONSES = { rapido: '⚡ Responde rápido', tarda: '🕒 Tarda en responder', no_responde: '😶 No responde' };
const DEFAULTS = {
  weights: { budget: 30, dates: 25, group: 15, response: 15, questions: 15 },
  hot: 70,
  warm: 40
};
const LABELS = { budget: 'Presupuesto por persona', dates: 'Cercanía de fechas', group: 'Tamaño del grupo', response: 'Respuesta del cliente', questions: 'Preguntas de calificación' };
const PRIORITY = { Caliente: 'Alta', Tibio: 'Media', 'Frío': 'Baja' };
const money = (n) => `$${Math.round(n).toLocaleString('es-MX')}`;

function cleanScoring(saved) {
  const cfg = { ...DEFAULTS, ...(saved || {}), weights: { ...DEFAULTS.weights, ...(saved?.weights || {}) } };
  for (const k of Object.keys(DEFAULTS.weights)) cfg.weights[k] = Math.min(Math.max(Math.round(Number(cfg.weights[k]) || 0), 0), 100);
  if (!Object.values(cfg.weights).some((w) => w > 0)) cfg.weights = { ...DEFAULTS.weights };
  cfg.hot = Math.min(Math.max(Math.round(Number(cfg.hot) || DEFAULTS.hot), 2), 100);
  cfg.warm = Math.min(Math.max(Math.round(Number(cfg.warm) || DEFAULTS.warm), 1), cfg.hot - 1);
  return cfg;
}
function sanitizeScoring(body) {
  const cfg = cleanScoring(body);
  if (Number(body?.warm) >= Number(body?.hot)) throw new ValidationError('El mínimo de “Tibio” debe ser menor que el de “Caliente”');
  return cfg;
}

const daysUntil = (today, iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

/**
 * lead: registro; ctx: { today, quotes (del lead), questionsScore (qualification) }.
 * Devuelve { score, level, priority, parts: [{ key, label, factor, points, max, detail }] }.
 */
function scoreLead(lead, { today, quotes = [], config } = {}) {
  const cfg = cleanScoring(config);
  const parts = [];
  const add = (key, factor, detail) => parts.push({ key, label: LABELS[key], factor: Math.max(0, Math.min(1, factor)), detail });
  const q = lead.qualification || {};
  const answers = q.answers || {};

  // Presupuesto por persona (del presupuesto del lead o de la respuesta de las preguntas)
  const travelers = Number(lead.travelers) || 0;
  const perPerson = lead.budget ? Number(lead.budget) / Math.max(travelers || 1, 1) : null;
  if (perPerson) add('budget', perPerson >= 25000 ? 1 : perPerson >= 15000 ? 0.8 : perPerson >= 8000 ? 0.55 : 0.3, `${money(perPerson)} por persona`);
  else if (answers.q_presupuesto) add('budget', /más de|mas de/i.test(answers.q_presupuesto) ? 1 : /15/.test(answers.q_presupuesto) ? 0.8 : /8 a/.test(answers.q_presupuesto) ? 0.55 : /menos/i.test(answers.q_presupuesto) ? 0.3 : 0.35, answers.q_presupuesto);
  else add('budget', 0.3, 'Sin presupuesto');

  // Cercanía de fechas
  if (lead.start_date && today) {
    const d = daysUntil(today, lead.start_date);
    if (d < 0) add('dates', 0.1, 'La fecha ya pasó');
    else add('dates', d <= 30 ? 1 : d <= 90 ? 0.8 : d <= 180 ? 0.5 : 0.3, d === 0 ? 'Sale hoy' : `Sale en ${d} ${d === 1 ? 'día' : 'días'}`);
  } else if (answers.q_cuando) add('dates', /este mes/i.test(answers.q_cuando) ? 1 : /1 a 3/.test(answers.q_cuando) ? 0.8 : /3 a 6/.test(answers.q_cuando) ? 0.5 : 0.25, answers.q_cuando);
  else add('dates', 0.25, 'Sin fechas');

  // Tamaño del grupo
  if (travelers) add('group', travelers >= 6 ? 1 : travelers >= 3 ? 0.85 : travelers === 2 ? 0.7 : 0.5, `${travelers} ${travelers === 1 ? 'viajero' : 'viajeros'}`);
  else add('group', 0.4, 'Sin dato de viajeros');

  // Respuesta del cliente: lo que marca el vendedor + señales (volvió a escribir, abrió la cotización)
  const viewed = quotes.some((x) => x.viewed_at);
  const signals = [lead.reengaged_at ? 'volvió a escribir' : '', viewed ? 'abrió la cotización' : ''].filter(Boolean);
  let factor = { rapido: 1, tarda: 0.5, no_responde: 0 }[lead.response];
  if (factor === undefined) factor = signals.length ? 0.85 : 0.45;
  else if (signals.length && lead.response !== 'rapido') factor = Math.min(1, factor + 0.2);
  add('response', factor, [RESPONSES[lead.response] || 'Sin marcar', ...signals].join(' · '));

  // Preguntas de calificación (solo si se contestaron)
  if (q.score != null && q.answered) add('questions', q.score / 100, `${q.score}% (${q.answered}/${q.total} respuestas)`);

  const totalWeight = parts.reduce((s, p) => s + (cfg.weights[p.key] || 0), 0) || 1;
  let sum = 0;
  for (const p of parts) {
    p.max = Math.round(((cfg.weights[p.key] || 0) / totalWeight) * 100);
    p.points = Math.round(p.factor * ((cfg.weights[p.key] || 0) / totalWeight) * 100);
    sum += p.factor * (cfg.weights[p.key] || 0);
  }
  const score = Math.round((sum / totalWeight) * 100);
  const level = score >= cfg.hot ? 'Caliente' : score >= cfg.warm ? 'Tibio' : 'Frío';
  return { score, level, priority: PRIORITY[level], parts: parts.filter((p) => p.max > 0) };
}

module.exports = { scoreLead, cleanScoring, sanitizeScoring, RESPONSES, DEFAULTS: DEFAULTS, PRIORITY };
