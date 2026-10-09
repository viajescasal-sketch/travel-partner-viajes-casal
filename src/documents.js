'use strict';

const crypto = require('node:crypto');
const { ValidationError } = require('./crm-schema');

// Textos y enlaces de la Plantilla PDF (cotización y confirmación de servicios).
// Cada campo indica su largo máximo; los enlaces deben empezar con http(s).
const DOCUMENT_FIELDS = {
  brandName: { max: 60 },
  tagline: { max: 160 },
  supportWhatsapp: { max: 40 },
  emergencyPhone: { max: 40 },
  website: { max: 200, url: true },
  facebook: { max: 300, url: true },
  instagram: { max: 300, url: true },
  tiktok: { max: 300, url: true },
  youtube: { max: 300, url: true },
  reviewsUrl: { max: 300, url: true },
  blogUrl: { max: 300, url: true },
  quoteImportant: { max: 600 },
  quotePolicies: { max: 600 },
  quoteNote: { max: 600 },
  circImportant: { max: 600 },
  circPolicies: { max: 600 },
  partnerBenefits: { max: 1200 },
  paymentInstructions: { max: 1200 },
  resSanitation: { max: 1200 },
  resConsiderations: { max: 1200 },
  resPolicies: { max: 2000 },
  resTerms: { max: 2000 },
  resTermsUrl: { max: 300, url: true },
  resDocuments: { max: 1200 },
  resFlightTips: { max: 1200 },
  resPartnerDetail: { max: 1200 }
};

const DEFAULT_DOCUMENTS = {
  brandName: 'VIAJES CASAL',
  tagline: 'Viajar tranquilo también se planea.',
  supportWhatsapp: '',
  emergencyPhone: '',
  website: 'https://viajescasal.com',
  facebook: 'https://www.facebook.com/share/1GjFtGYqvk/',
  instagram: 'https://www.instagram.com/viaja.pau',
  tiktok: 'https://www.tiktok.com/@viajes_bumeran_casal',
  youtube: 'https://www.youtube.com/@inspirateaviajar',
  reviewsUrl: 'https://g.page/r/CdrMmhT2jbS5EBM/review',
  blogUrl: 'https://paulina.viajescasal.com/blog/index.html',
  quoteImportant: 'Tarifas sujetas a disponibilidad. Impuestos locales pueden pagarse directamente en destino cuando corresponda.',
  quotePolicies: 'Cambios, cancelaciones y reembolsos están sujetos a las condiciones de cada proveedor.',
  quoteNote: 'La tarifa no queda garantizada hasta confirmar disponibilidad y realizar el pago correspondiente.',
  circImportant: 'Tarifas por persona, sujetas a disponibilidad y tipo de cambio al momento de confirmar la reserva.',
  circPolicies: 'Cambios, cancelaciones y reembolsos sujetos a las condiciones de cada proveedor y categoría de hospedaje.',
  partnerBenefits: [
    'Atención personalizada, sin presión para decidir.',
    'Precios claros y reales, sin sorpresas ni letras chiquitas.',
    'Acompañamiento antes, durante y después de tu viaje.',
    'Conocimiento directo de destinos y proveedores, para recomendarte lo que de verdad te conviene.'
  ].join('\n'),
  paymentInstructions: '',
  resSanitation: 'Este impuesto deberá pagarse directamente en el hotel al momento del check-in o check-out. El monto puede variar según el municipio y la categoría del hospedaje. Este importe no está incluido en el paquete.',
  resConsiderations: 'Algunos destinos cobran impuestos o cuotas locales que se pagan directamente en el hotel o en destino y no están incluidos en el paquete.',
  resPolicies: [
    'Cancelaciones: aplican cargos según la política del proveedor.',
    'Modificaciones: sujetas a disponibilidad y cargos adicionales.',
    'No Show: en caso de no presentarse, no habrá reembolso.',
    'Reembolsos: sujetos a las políticas de cada proveedor.',
    'Documentación: es responsabilidad del pasajero contar con documentos vigentes.'
  ].join('\n'),
  resTerms: 'Al confirmar este viaje, el titular acepta los términos y condiciones de Viajes Casal y de cada proveedor involucrado en los servicios contratados. Viajes Casal actúa únicamente como intermediario y no se hace responsable por cambios, demoras, cancelaciones o pérdidas derivadas de situaciones ajenas a su control.',
  resTermsUrl: '',
  resDocuments: ['Pasaporte vigente', 'INE o identificación oficial', 'Pase de abordar', 'Confirmación de hotel', 'Tarjeta bancaria', 'Seguro de viaje'].join('\n'),
  resFlightTips: [
    'Llega al aeropuerto 3 horas antes de tu vuelo.',
    'Lleva tu identificación oficial vigente.',
    'Descarga tu pase de abordar en la app.',
    'Revisa las políticas de equipaje de la aerolínea.'
  ].join('\n'),
  resPartnerDetail: 'Tu Travel Partner es tu aliado de viaje: conoce tu itinerario, da seguimiento a tus servicios y te acompaña antes, durante y después.\nAnte cualquier duda o imprevisto, tendrás atención personalizada por WhatsApp 24/7 para viajar con más tranquilidad.'
};

const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

function sanitizeDocuments(body) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const [field, spec] of Object.entries(DOCUMENT_FIELDS)) {
    const value = String(input[field] ?? '').replace(/\r/g, '').trim();
    if (value.length > spec.max) throw new ValidationError(`El texto de ${field} es demasiado largo (máximo ${spec.max})`);
    if (spec.url && value && !URL_RE.test(value)) throw new ValidationError(`El enlace de ${field} debe empezar con https://`);
    out[field] = value;
  }
  if (!out.brandName) throw new ValidationError('El nombre de la marca es obligatorio');
  return out;
}

// ---- Preguntas para calificar leads ----
// Cada pregunta se responde con un botón; cada respuesta suma puntos.
// La calificación es el porcentaje de puntos obtenidos sobre el máximo posible.
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 6;
const opt = (label, points) => ({ label, points });
const DEFAULT_LEAD_QUESTIONS = [
  { id: 'q_cuando', label: '¿Para cuándo planea viajar?', options: [opt('Este mes', 25), opt('En 1 a 3 meses', 20), opt('En 3 a 6 meses', 12), opt('Más de 6 meses o sin fecha', 4)] },
  { id: 'q_decision', label: '¿Qué tan decidido está?', options: [opt('Listo para reservar', 25), opt('Comparando opciones', 15), opt('Solo está explorando', 5)] },
  { id: 'q_presupuesto', label: 'Presupuesto por persona', options: [opt('Más de $25 mil', 20), opt('$15 a $25 mil', 16), opt('$8 a $15 mil', 10), opt('Menos de $8 mil', 5), opt('Aún no lo sabe', 6)] },
  { id: 'q_fechas', label: '¿Tiene fechas definidas?', options: [opt('Sí, fijas', 15), opt('Flexibles', 10), opt('Aún no', 3)] },
  { id: 'q_quien', label: '¿Quién toma la decisión?', options: [opt('El mismo cliente', 15), opt('Lo decide con su pareja o familia', 10), opt('Cotiza para alguien más', 4)] }
];
const LEVELS = [[70, 'Caliente'], [40, 'Tibio'], [0, 'Frío']];

function normalizeQuestions(list) {
  return (Array.isArray(list) ? list : []).map((q) => ({
    id: q.id,
    label: q.label,
    options: (q.options || []).map((o) => (typeof o === 'object' ? { label: String(o.label), points: Number(o.points) || 0 } : { label: String(o), points: 0 }))
  })).filter((q) => q.id && q.label && q.options.length);
}

function sanitizeQuestions(body) {
  const list = Array.isArray(body?.questions) ? body.questions : null;
  if (!list) throw new ValidationError('Lista de preguntas inválida');
  if (list.length > MAX_QUESTIONS) throw new ValidationError(`Máximo ${MAX_QUESTIONS} preguntas para que el cuestionario sea rápido`);
  const ids = new Set();
  return list.map((item, index) => {
    const label = String(item?.label ?? '').trim();
    if (!label) throw new ValidationError(`La pregunta ${index + 1} no tiene texto`);
    if (label.length > 120) throw new ValidationError(`La pregunta ${index + 1} es demasiado larga`);
    const options = (Array.isArray(item.options) ? item.options : []).map((o) => ({
      label: String(o?.label ?? '').trim().slice(0, 60),
      points: Math.round(Number(o?.points))
    })).filter((o) => o.label);
    if (options.length < 2) throw new ValidationError(`La pregunta “${label}” necesita al menos 2 respuestas`);
    if (options.length > MAX_OPTIONS) throw new ValidationError(`La pregunta “${label}” admite máximo ${MAX_OPTIONS} respuestas`);
    if (options.some((o) => !Number.isInteger(o.points) || o.points < 0 || o.points > 100)) throw new ValidationError(`Los puntos de “${label}” deben ser de 0 a 100`);
    if (new Set(options.map((o) => o.label)).size !== options.length) throw new ValidationError(`La pregunta “${label}” tiene respuestas repetidas`);
    let id = /^q_[\w-]{1,40}$/.test(item.id || '') ? item.id : `q_${crypto.randomBytes(4).toString('hex')}`;
    while (ids.has(id)) id = `q_${crypto.randomBytes(4).toString('hex')}`;
    ids.add(id);
    return { id, label, options };
  });
}

// Calcula la calificación con las preguntas vigentes. Solo guarda respuestas válidas.
function scoreQualification(input, questionList) {
  const questions = normalizeQuestions(questionList);
  const given = input && typeof input.answers === 'object' && input.answers ? input.answers : {};
  const answers = {};
  let points = 0;
  let max = 0;
  for (const q of questions) {
    max += Math.max(0, ...q.options.map((o) => o.points));
    const chosen = q.options.find((o) => o.label === given[q.id]);
    if (chosen) { answers[q.id] = chosen.label; points += chosen.points; }
  }
  const answered = Object.keys(answers).length;
  const score = answered && max ? Math.round((points / max) * 100) : null;
  return {
    answers,
    answered,
    total: questions.length,
    score,
    level: score == null ? null : LEVELS.find(([min]) => score >= min)[1]
  };
}

// ---- Imágenes ----
const IMAGE_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP'
};
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function checkImage(mime, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ValidationError('No llegó ninguna imagen');
  if (buffer.length > MAX_IMAGE_BYTES) throw new ValidationError('La imagen pesa más de 3 MB');
  const check = IMAGE_TYPES[mime];
  if (!check || !check(buffer)) throw new ValidationError('Formato no permitido. Usa JPG, PNG o WebP');
}

const mediaUrl = (id) => (id ? `/api/media/${Number(id)}` : null);

// Datos del vendedor que aparecen en los documentos.
function sellerInfo(user) {
  if (!user) return null;
  return {
    id: Number(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    bio: user.bio || '',
    website: user.website || '',
    photoUrl: mediaUrl(user.photo_media_id)
  };
}

module.exports = {
  DOCUMENT_FIELDS,
  DEFAULT_DOCUMENTS,
  DEFAULT_LEAD_QUESTIONS,
  sanitizeDocuments,
  sanitizeQuestions,
  normalizeQuestions,
  scoreQualification,
  checkImage,
  MAX_IMAGE_BYTES,
  mediaUrl,
  sellerInfo
};
