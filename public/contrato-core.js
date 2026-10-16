'use strict';

/* TP-204: contrato de servicios turísticos con firma electrónica antes del anticipo.
   Arma el contrato (mismo texto en la plataforma, en la página del cliente y en las pruebas) con:
   datos del viaje, precio y plan de pagos, y las cláusulas editables en Configuración › Contrato. */
(function (global) {
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const str = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const longDate = (iso) => (ISO.test(String(iso || '')) ? `${Number(iso.slice(8, 10))} de ${MONTHS[Number(iso.slice(5, 7)) - 1]} de ${iso.slice(0, 4)}` : '');
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const DEFAULT_TITLE = 'Contrato de prestación de servicios turísticos';
  const DEFAULT_CLAUSES = [
    'OBJETO. {agencia} ("LA AGENCIA") se obliga a gestionar y reservar, como intermediaria entre EL CLIENTE y los prestadores finales (hoteles, aerolíneas, operadores y demás proveedores), los servicios turísticos descritos en este contrato y en la cotización {folio}.',
    'PRECIO Y FORMA DE PAGO. EL CLIENTE pagará {total} MXN conforme al plan de pagos de este contrato. El precio y la disponibilidad quedan garantizados al recibir el anticipo de {anticipo}. Si un pago no se cubre en su fecha límite, LA AGENCIA podrá cancelar las reservas y se aplicarán los cargos que fije cada proveedor.',
    'CAMBIOS, CANCELACIONES Y REEMBOLSOS. Cualquier cambio o cancelación debe solicitarse por escrito (WhatsApp o correo) a LA AGENCIA. {politicas}',
    'RESPONSABILIDAD. {terminos}',
    'DOCUMENTACIÓN DEL VIAJERO. EL CLIENTE es responsable de contar con pasaporte, visas, permisos de menores, vacunas y demás documentos vigentes que exijan el destino y la aerolínea, así como de presentarse a tiempo a sus vuelos y servicios.',
    'DATOS DE LOS PASAJEROS. EL CLIENTE confirma que los nombres y datos de los pasajeros que entregó son correctos. Los cambios de nombre o correcciones están sujetos a las políticas y cargos de cada proveedor.',
    'SEGURO DE VIAJE. LA AGENCIA recomienda contratar un seguro de viaje. Si EL CLIENTE decide no contratarlo, asume los gastos derivados de enfermedad, accidente, pérdida de equipaje o cancelación.',
    'DATOS PERSONALES. LA AGENCIA usa los datos de EL CLIENTE y sus acompañantes solo para gestionar su viaje y darle seguimiento, conforme a su aviso de privacidad.',
    'FIRMA ELECTRÓNICA. EL CLIENTE acepta este contrato con su firma electrónica, que tiene la misma validez que su firma autógrafa. LA AGENCIA conserva el registro de la firma: nombre, fecha y hora, dirección IP, dispositivo y huella digital (SHA-256) del documento firmado.',
    'JURISDICCIÓN. Para la interpretación y cumplimiento de este contrato, las partes se someten a las leyes y tribunales de {ciudad}, sin perjuicio de la competencia de la Procuraduría Federal del Consumidor (PROFECO) en la vía administrativa.'
  ].join('\n\n');
  const DEFAULTS = { enabled: true, title: DEFAULT_TITLE, clauses: DEFAULT_CLAUSES, city: 'Cancún, Quintana Roo' };
  const PLACEHOLDERS = [
    ['{agencia}', 'Nombre de la agencia'], ['{cliente}', 'Nombre del cliente'], ['{folio}', 'Folio de la cotización'], ['{destino}', 'Destino'],
    ['{fechas}', 'Fechas del viaje'], ['{total}', 'Total del viaje'], ['{anticipo}', 'Monto del anticipo'], ['{ciudad}', 'Ciudad del contrato'],
    ['{politicas}', 'Políticas de la Confirmación (Plantilla PDF)'], ['{terminos}', 'Términos de la Confirmación (Plantilla PDF)'], ['{politicas_cotizacion}', 'Políticas de la Cotización (Plantilla PDF)']
  ];

  function cleanSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const title = str(r.title).slice(0, 120) || DEFAULT_TITLE;
    const clauses = String(r.clauses ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 15000) || DEFAULT_CLAUSES;
    return { enabled: r.enabled !== false, title, clauses, city: str(r.city).slice(0, 80) || DEFAULTS.city };
  }

  // Estado del contrato de una cotización (campo interno quote.contract).
  const state = (quote) => {
    const c = quote?.contract || null;
    if (!c || !c.required) return 'none';
    if (c.signed) return 'signed';
    if (c.waived) return 'waived';
    return 'pending';
  };
  const pending = (quote) => state(quote) === 'pending';

  /**
   * Contrato listo para mostrar y firmar.
   * input: { cfg, documents, agency, quote, client, lead, plan }
   * → { title, intro, blocks: [{ h, rows? [[k, v]], items? [texto] }] }
   */
  function build({ cfg, documents = {}, agency = {}, quote = {}, client = {}, lead = null, plan = null }) {
    const c = cleanSettings(cfg);
    const agencyName = str(agency.name) || 'Viajes Casal';
    const start = lead?.start_date || quote.details?.startDate || '';
    const end = lead?.end_date || quote.details?.endDate || '';
    const fechas = start ? `${longDate(start)}${end && end !== start ? ` al ${longDate(end)}` : ''}` : 'Por definir';
    const total = plan?.total ?? Number(quote.price) ?? 0;
    const anticipo = plan?.installments?.[0]?.amount;
    const vars = {
      '{agencia}': agencyName, '{cliente}': str(client.name) || 'EL CLIENTE', '{folio}': str(quote.folio), '{destino}': str(quote.destination),
      '{fechas}': fechas, '{total}': money(total), '{anticipo}': anticipo != null ? `${money(anticipo)} MXN` : 'el anticipo', '{ciudad}': c.city,
      '{politicas}': str(documents.resPolicies).replace(/\n+/g, ' '), '{terminos}': str(documents.resTerms).replace(/\n+/g, ' '), '{politicas_cotizacion}': str(documents.quotePolicies).replace(/\n+/g, ' ')
    };
    const fill = (text) => String(text).replace(/\{[a-z_]+\}/g, (k) => (k in vars ? vars[k] : k)).replace(/[ \t]+/g, ' ').trim();
    const agencyContact = [agency.whatsapp ? `WhatsApp ${str(agency.whatsapp)}` : '', agency.email ? str(agency.email) : '', agency.website ? str(agency.website) : ''].filter(Boolean).join(' · ');
    const travelers = Number(lead?.travelers) || Number(quote.details?.travelers) || null;
    const services = str(quote.services).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12).join(' · ').slice(0, 1200);
    const blocks = [
      { h: 'Partes', rows: [['La agencia', `${agencyName}${agencyContact ? ` · ${agencyContact}` : ''}`], ['El cliente', str(client.name) || '—']] },
      { h: 'Viaje contratado', rows: [['Folio', str(quote.folio)], ['Destino', str(quote.destination)], ['Fechas', fechas], ...(travelers ? [['Viajeros', String(travelers)]] : []), ['Servicio', str(quote.hotel)], ...(services ? [['Incluye', services]] : [])] },
      { h: 'Precio y plan de pagos', rows: [['Total', `${money(total)} MXN`], ...((plan?.installments || []).map((i) => [i.label, `${money(i.amount)} MXN · antes del ${longDate(i.due)}`]))] },
      { h: 'Cláusulas', items: c.clauses.split(/\n\s*\n/).map(fill).filter(Boolean).slice(0, 40) }
    ];
    return {
      title: c.title,
      intro: fill(`Contrato que celebran ${agencyName} ("LA AGENCIA") y {cliente} ("EL CLIENTE") para el viaje a {destino} del {fechas}, de acuerdo con lo siguiente:`),
      blocks
    };
  }
  // Texto canónico (lo que se firma y se resume con SHA-256).
  const canonical = (doc) => JSON.stringify({ title: doc.title, intro: doc.intro, blocks: doc.blocks });
  // Texto plano para copiar o imprimir.
  const plainText = (doc) => [doc.title.toUpperCase(), '', doc.intro, ...doc.blocks.flatMap((b) => ['', b.h.toUpperCase(), ...(b.rows || []).map(([k, v]) => `${k}: ${v}`), ...(b.items || []).map((t, i) => `${i + 1}. ${t}`)])].join('\n');

  global.TPContract = { DEFAULTS, DEFAULT_TITLE, DEFAULT_CLAUSES, PLACEHOLDERS, cleanSettings, state, pending, build, canonical, plainText, longDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPContract;
}(typeof window !== 'undefined' ? window : globalThis));
