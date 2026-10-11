'use strict';

// Plantillas de WhatsApp por etapa (TP-107). El administrador las edita; el vendedor las usa y puede
// retocar el texto antes de enviarlo. Variables entre llaves: {nombre}, {destino}, {fechas}…

const { ValidationError } = require('./crm-schema');

const STAGES = [
  { id: 'primer_contacto', label: 'Primer contacto' },
  { id: 'cotizacion', label: 'Envío de cotización' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'cierre', label: 'Cierre' },
  { id: 'postviaje', label: 'Postviaje' }
];
const VARIABLES = [
  ['nombre', 'Primer nombre del cliente'], ['nombre_completo', 'Nombre completo'], ['destino', 'Destino'], ['fechas', 'Fechas del viaje'],
  ['viajeros', 'Número de viajeros'], ['folio', 'Folio de la cotización'], ['hotel', 'Hotel o paquete'], ['precio', 'Precio de la cotización'],
  ['vigencia', 'Vigencia de la cotización'], ['vendedor', 'Tu nombre'], ['agencia', 'Nombre de la agencia'], ['liga_resenas', 'Liga para dejar reseña']
];

const DEFAULT_TEMPLATES = [
  { id: 'pc1', stage: 'primer_contacto', name: 'Bienvenida', body: '¡Hola {nombre}! 👋 Soy {vendedor}, tu Travel Partner de {agencia}. Vi que te interesa viajar a {destino} y me encantaría ayudarte a armar tu viaje. ¿Me compartes tus fechas y cuántas personas viajan?' },
  { id: 'pc2', stage: 'primer_contacto', name: 'Sin respuesta', body: 'Hola {nombre}, te escribo de nuevo por tu viaje a {destino} ✈️. Cuando tengas un momento, cuéntame qué tienes en mente y te preparo opciones a tu medida.' },
  { id: 'co1', stage: 'cotizacion', name: 'Envío de cotización', body: 'Hola {nombre}, ya tengo lista tu cotización {folio} para {destino} ({fechas}) 🏝️\n\n🏨 {hotel}\n💰 {precio}\n📅 Vigente hasta {vigencia}\n\nTe comparto el PDF con todos los detalles. ¿Lo revisamos juntos?' },
  { id: 'se1', stage: 'seguimiento', name: '¿Pudiste revisarla?', body: 'Hola {nombre} 😊 ¿Pudiste revisar la cotización de {destino}? Si quieres cambiar fechas, hotel o presupuesto, lo ajustamos sin problema.' },
  { id: 'se2', stage: 'seguimiento', name: 'Vigencia por terminar', body: 'Hola {nombre}, te aviso que los precios de tu cotización {folio} para {destino} están vigentes hasta {vigencia}. ¿Quieres que te ayude a apartarlo antes de que cambien? 🙌' },
  { id: 'ci1', stage: 'cierre', name: 'Apartar el viaje', body: '¡Qué emoción, {nombre}! 🎉 Para apartar tu viaje a {destino} ({fechas}) solo necesito el anticipo. Te paso los datos de pago y en cuanto lo recibamos te envío tu confirmación.' },
  { id: 'ci2', stage: 'cierre', name: 'Reserva confirmada', body: '¡Listo, {nombre}! ✅ Tu viaje a {destino} del {fechas} quedó confirmado. Te comparto tu confirmación de servicios. Cualquier duda, aquí estoy.' },
  { id: 'pv1', stage: 'postviaje', name: '¿Cómo te fue?', body: '¡Bienvenido de vuelta, {nombre}! 🌴 ¿Qué tal estuvo {destino}? Me encantaría saber cómo te fue.' },
  { id: 'pv2', stage: 'postviaje', name: 'Pedir reseña', body: 'Gracias por viajar con {agencia}, {nombre} 💙 Si te gustó el servicio, ¿nos regalas una reseña? Nos ayuda muchísimo: {liga_resenas}' }
];

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

function sanitizeTemplates(input) {
  const list = Array.isArray(input?.templates) ? input.templates : [];
  if (list.length > 60) throw new ValidationError('Máximo 60 plantillas');
  const ids = new Set();
  const templates = list.map((t, i) => {
    const stage = STAGES.some((s) => s.id === t?.stage) ? t.stage : null;
    if (!stage) throw new ValidationError('Etapa de plantilla inválida');
    const name = text(t.name, 60);
    const body = String(t.body ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 1500);
    if (!name) throw new ValidationError('Cada plantilla necesita un nombre');
    if (!body) throw new ValidationError(`La plantilla "${name}" está vacía`);
    let id = text(t.id, 20).replace(/[^\w-]/g, '') || `t${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    return { id, stage, name, body };
  });
  const reviewLink = text(input?.reviewLink, 300);
  if (reviewLink && !/^https:\/\/\S+$/i.test(reviewLink)) throw new ValidationError('La liga de reseñas debe empezar con https://');
  return { templates, reviewLink };
}

function readTemplates(saved) {
  if (!saved || !Array.isArray(saved.templates)) return { templates: DEFAULT_TEMPLATES, reviewLink: saved?.reviewLink || '', custom: false };
  return { templates: saved.templates, reviewLink: saved.reviewLink || '', custom: true };
}

module.exports = { STAGES, VARIABLES, DEFAULT_TEMPLATES, sanitizeTemplates, readTemplates };
