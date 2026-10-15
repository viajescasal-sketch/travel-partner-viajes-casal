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
  ['vigencia', 'Vigencia de la cotización'], ['liga_cotizacion', 'Liga privada para ver la cotización'], ['vendedor', 'Tu nombre'], ['agencia', 'Nombre de la agencia'], ['liga_resenas', 'Liga para dejar reseña'],
  ['liga_pago', 'Liga de pago del cliente (plan de pagos)'], ['concepto_pago', 'Siguiente pago: Anticipo, Pago 2…'], ['monto_pago', 'Monto del siguiente pago'], ['fecha_pago', 'Fecha límite del siguiente pago'], ['saldo', 'Saldo pendiente total'], ['liga_itinerario', 'Liga del itinerario digital del viaje'],
  ['liga_encuesta', 'Liga de la encuesta postviaje'], ['codigo_referido', 'Código de referido del cliente'], ['liga_referido', 'Liga para invitar a sus amigos'], ['beneficio_referido', 'Lo que gana quien refiere'], ['descuento_referido', 'Descuento de bienvenida del referido']
];

const DEFAULT_TEMPLATES = [
  { id: 'pc1', stage: 'primer_contacto', name: 'Bienvenida', body: '¡Hola {nombre}! 👋 Soy {vendedor}, tu Travel Partner de {agencia}. Vi que te interesa viajar a {destino} y me encantaría ayudarte a armar tu viaje. ¿Me compartes tus fechas y cuántas personas viajan?' },
  { id: 'pc2', stage: 'primer_contacto', name: 'Sin respuesta', body: 'Hola {nombre}, te escribo de nuevo por tu viaje a {destino} ✈️. Cuando tengas un momento, cuéntame qué tienes en mente y te preparo opciones a tu medida.' },
  { id: 'co1', stage: 'cotizacion', name: 'Envío de cotización', body: 'Hola {nombre}, ya tengo lista tu cotización {folio} para {destino} ({fechas}) 🏝️\n\n🏨 {hotel}\n💰 {precio}\n📅 Vigente hasta {vigencia}\n\nAquí puedes verla completa: {liga_cotizacion}\n¿La revisamos juntos?' },
  { id: 'se1', stage: 'seguimiento', name: '¿Pudiste revisarla?', body: 'Hola {nombre} 😊 ¿Pudiste revisar la cotización de {destino}? Si quieres cambiar fechas, hotel o presupuesto, lo ajustamos sin problema.' },
  { id: 'se2', stage: 'seguimiento', name: 'Vigencia por terminar', body: 'Hola {nombre}, te aviso que los precios de tu cotización {folio} para {destino} están vigentes hasta {vigencia}. ¿Quieres que te ayude a apartarlo antes de que cambien? 🙌' },
  { id: 'ci1', stage: 'cierre', name: 'Apartar el viaje', body: '¡Qué emoción, {nombre}! 🎉 Para apartar tu viaje a {destino} ({fechas}) solo necesito el anticipo. Te paso los datos de pago y en cuanto lo recibamos te envío tu confirmación.' },
  { id: 'ci3', stage: 'cierre', name: 'Liga para apartar', body: '¡Qué emoción, {nombre}! 🎉 Para apartar tu viaje a {destino} el anticipo es de {monto_pago} y la fecha límite es el {fecha_pago}.\n\nAquí puedes pagarlo y ver tu plan de pagos: {liga_pago}\n\nEn cuanto se refleje te envío tu confirmación ✈️' },
  { id: 'ci4', stage: 'cierre', name: 'Recordatorio de pago', body: 'Hola {nombre} 😊 Te recuerdo que tu {concepto_pago} de {monto_pago} para tu viaje a {destino} vence el {fecha_pago}.\n\nAquí puedes pagarlo y ver lo que llevas abonado: {liga_pago}\n\nSi ya lo realizaste, mándame tu comprobante por aquí. ¡Gracias!' },
  { id: 'ci5', stage: 'cierre', name: 'Itinerario digital', body: '¡Hola {nombre}! ✈️ Aquí tienes tu itinerario digital para tu viaje a {destino} ({fechas}): día por día, vuelos, hotel, traslados, tus vouchers y mis datos de contacto, todo en tu celular 📱\n\n{liga_itinerario}\n\nGuárdalo en favoritos y cualquier duda aquí estoy.' },
  { id: 'ci2', stage: 'cierre', name: 'Reserva confirmada', body: '¡Listo, {nombre}! ✅ Tu viaje a {destino} del {fechas} quedó confirmado. Te comparto tu confirmación de servicios. Cualquier duda, aquí estoy.' },
  { id: 'pv1', stage: 'postviaje', name: '¿Cómo te fue?', body: '¡Bienvenido de vuelta, {nombre}! 🌴 ¿Qué tal estuvo {destino}? Me encantaría saber cómo te fue.' },
  { id: 'pv2', stage: 'postviaje', name: 'Pedir reseña', body: 'Gracias por viajar con {agencia}, {nombre} 💙 Si te gustó el servicio, ¿nos regalas una reseña? Nos ayuda muchísimo: {liga_resenas}' },
  { id: 'pv3', stage: 'postviaje', name: 'Encuesta postviaje', body: '¡Bienvenido de vuelta, {nombre}! 🌴 Espero que {destino} haya sido increíble. ¿Me ayudas con una encuesta de 1 minuto? Tu opinión me ayuda a mejorar cada viaje ⭐\n\n{liga_encuesta}' },
  { id: 'pv4', stage: 'postviaje', name: 'Invitar a referir', body: '{nombre}, gracias por confiar en mí 💙 Si alguien de tu familia o amigos quiere viajar, compárteles tu liga: ellos reciben {descuento_referido} de descuento en su primer viaje y tú ganas {beneficio_referido} para tu próxima aventura ✈️\n\n{liga_referido}\n(Tu código: {codigo_referido})' }
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
  return { templates, reviewLink, known: DEFAULT_TEMPLATES.map((t) => t.id) };
}

// Plantillas que se agregaron después (TP-202): aparecen también en listas ya personalizadas,
// a menos que el administrador las haya borrado después de verlas.
const ORIGINAL_IDS = ['pc1', 'pc2', 'co1', 'se1', 'se2', 'ci1', 'ci2', 'pv1', 'pv2'];
function readTemplates(saved) {
  if (!saved || !Array.isArray(saved.templates)) return { templates: DEFAULT_TEMPLATES, reviewLink: saved?.reviewLink || '', custom: false };
  const known = new Set(Array.isArray(saved.known) ? saved.known : ORIGINAL_IDS);
  const have = new Set(saved.templates.map((t) => t.id));
  const added = DEFAULT_TEMPLATES.filter((t) => !known.has(t.id) && !have.has(t.id));
  return { templates: [...saved.templates, ...added], reviewLink: saved.reviewLink || '', custom: true };
}

module.exports = { STAGES, VARIABLES, DEFAULT_TEMPLATES, sanitizeTemplates, readTemplates };
