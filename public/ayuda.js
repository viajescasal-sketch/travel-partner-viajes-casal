'use strict';

/* =========================================================
   Centro de ayuda ("¿Necesitas ayuda?" › Abrir guía)
   Menú con todas las funciones del CRM. Cada guía tiene:
   - el paso a paso por escrito,
   - "Guíame en pantalla": recorrido interactivo que resalta los botones reales (usa recorrido.js),
   - "Ir ahora": te lleva directo a la pantalla.
   Usa las utilidades de app.js.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isSales = () => !isOps();
  // Datos de ejemplo para abrir las pantallas reales durante la guía.
  const openLead = () => db.leads.filter((l) => !['Vendido', 'Perdido'].includes(l.stage)).sort((a, b) => b.id - a.id)[0] || db.leads[0];
  const acceptedQuote = () => db.quotes.find((q) => q.status === 'Aceptada');
  const sentQuote = () => db.quotes.find((q) => ['Enviada', 'PDF generado', 'Aceptada'].includes(q.status)) || db.quotes[0];
  const anyTrip = () => db.trips.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0];
  const anyClient = () => db.clients[0];
  const settings = (tab) => async () => { close(); navigate('settings'); showSettingsTab(tab); await wait(500); };
  const modal = (fn) => async () => { await fn(); await wait(450); };
  // Paso sin elemento (tarjeta centrada) para explicar qué falta.
  const note = (title, text) => ({ title, text });

  /* ---------------- Catálogo de guías ---------------- */
  const G = [
    /* ===== Primeros pasos ===== */
    { id: 'recorrido', cat: 'Primeros pasos', icon: '🧭', title: 'Recorrido general de la plataforma', summary: 'Para qué sirve cada sección del menú, en 2 minutos.',
      steps: ['Toca <b>Guíame en pantalla</b> y sigue las tarjetas con <b>Siguiente</b>.', 'En cada página también tienes el botón <b>?</b> junto al título con la guía de esa sección.'],
      go: () => window.startMainTour(), tour: null },
    { id: 'app', cat: 'Primeros pasos', icon: '📱', title: 'Instalar la app en el celular y activar notificaciones', badge: 'Nuevo', summary: 'Travel Partner como app, con avisos al celular aunque esté cerrada.',
      steps: ['Toca el botón <b>📱</b> de la barra superior (junto a la luna).', '<b>Android / computadora (Chrome):</b> “📲 Instalar Travel Partner”. <b>iPhone (Safari):</b> Compartir ⬆️ → “Agregar a inicio” y abre la app desde el ícono.', 'En el mismo botón: <b>🔔 Activar notificaciones en este equipo</b> → acepta el permiso → <b>Enviar prueba</b>.', 'Mantén presionado el ícono de la app para los atajos: Nuevo lead, Seguimientos de hoy y Cotizaciones.', 'Sin internet puedes consultar lo último que cargaste (solo lectura).'],
      go: () => appModal(),
      tour: () => [{ el: '#appBtn', title: 'Botón de la app', text: 'Aquí instalas Travel Partner en tu celular o computadora y activas las notificaciones push.' }, { before: modal(() => appModal()), el: '#modalBody .modal-form', title: 'Instalar y notificaciones', text: 'Paso 1: instalar. Paso 2: activar notificaciones en este equipo y enviar una prueba. Paso 3: atajos del ícono.' }] },
    { id: 'gcal', cat: 'Primeros pasos', icon: '📅', title: 'Conectar Google Calendar (dos vías)', badge: 'Nuevo', summary: 'Tus seguimientos, viajes y pagos en un calendario “Travel Partner”.',
      steps: ['Ve a <b>Seguimientos</b> y toca <b>📅 Google Calendar</b>.', 'Toca <b>Conectar con Google</b>, elige tu cuenta y acepta el permiso (si dice “no verificada”: Configuración avanzada → Ir a Travel Partner).', 'Se crea el calendario <b>“Travel Partner”</b> con seguimientos, viajes, pagos por cobrar y pagos a proveedores.', 'En Google: mover un evento cambia la fecha en el CRM; borrarlo lo marca como hecho; un evento nuevo en ese calendario se vuelve seguimiento.', 'Si algo no aparece, usa <b>Sincronizar ahora</b> en la misma ventana.'],
      go: () => { navigate('followups'); googleCalendarModal(); },
      tour: () => [{ page: 'followups', el: '#calGoogle', title: 'Google Calendar', text: 'Abre la conexión con tu cuenta de Google desde aquí.' }, { before: modal(() => googleCalendarModal()), el: '#modalBody .gcal', title: 'Conectar', text: 'Toca “Conectar con Google”. Ya conectado, aquí ves la última sincronización y puedes sincronizar o desconectar.' }] },
    { id: 'perfil', cat: 'Primeros pasos', icon: '🙂', title: 'Mi foto, contraseña y verificación en dos pasos', summary: 'Tu avatar para cotizaciones y la seguridad de tu cuenta.',
      steps: ['Toca tu <b>foto o avatar</b> abajo a la izquierda para subir tu foto o elegir un animal (sale en tus cotizaciones).', 'El botón <b>⚙ Mi cuenta</b> (junto a tu nombre) te deja cambiar tu contraseña y activar la verificación en dos pasos (correo o app de autenticación).'],
      go: () => avatarModal(),
      tour: () => [{ el: '#profileAvatar', title: 'Tu avatar', text: 'Sube tu foto o elige un animal.' }, { el: '#myAccount', title: 'Mi cuenta', text: 'Contraseña, verificación en dos pasos y equipos recordados.' }] },
    { id: 'avisos', cat: 'Primeros pasos', icon: '🔔', title: 'Avisos (campanita)', summary: 'Leads nuevos, cotizaciones vistas, pagos, contratos y vencidos.',
      steps: ['La <b>🔔</b> de arriba muestra el número de avisos sin leer.', 'Toca un aviso para abrir directo el lead, cotización, viaje o seguimiento.', 'Pestañas <b>Todos / Sin leer</b>. Con la app instalada, también llegan como notificación al celular.'],
      go: () => toggleBell(true), tour: () => [{ el: '#bellBtn', title: 'Avisos', text: 'Todo lo que necesita tu atención llega aquí.' }] },

    /* ===== Leads ===== */
    { id: 'lead-nuevo', cat: 'Leads', icon: '➕', who: isSales, title: 'Registrar un lead nuevo', summary: 'Dar de alta una oportunidad en segundos.',
      steps: ['Toca <b>+ Nuevo lead</b> (arriba a la derecha) o <b>+ Registrar lead</b> en Leads.', 'Escribe <b>nombre y WhatsApp</b> (si ya existe el cliente, el CRM te avisa para no duplicarlo) y el <b>destino</b>.', 'Opcional: fechas, viajeros, presupuesto, origen, notas y las preguntas de calificación.', 'Puedes programar el <b>primer seguimiento</b> desde el mismo formulario → <b>Guardar lead</b>.', 'Desde el celular (Android) también puedes <b>Compartir</b> un chat de WhatsApp a Travel Partner y se abre este formulario con el texto.'],
      go: () => { navigate('leads'); leadModal(null); },
      tour: () => [{ el: 'header [data-action="lead"]', title: 'Nuevo lead', text: 'Desde cualquier pantalla das de alta una oportunidad aquí.' }, { before: modal(() => { navigate('leads'); leadModal(null); }), el: '#modalBody form', title: 'Formulario del lead', text: 'Nombre, WhatsApp y destino son obligatorios. El resto ayuda a calificar el lead.' }] },
    { id: 'lead-ficha', cat: 'Leads', icon: '🗂️', who: isSales, title: 'Ficha del lead: etapas, acciones y pestañas', badge: 'Nuevo', summary: 'Toda la información y acciones del lead en un tablero.',
      need: () => (openLead() ? '' : 'Primero registra un lead.'),
      steps: ['En <b>Leads</b>, toca la tarjeta del cliente.', 'Arriba: WhatsApp, Llamar, Correo, Ficha 360 y 🌐 Portal del cliente.', '<b>Barra de etapas:</b> un clic para mover el lead (Nuevo → Calificado → Cotizado → Negociación → Vendido / Perdido).', '<b>Acciones rápidas:</b> plantilla de WhatsApp, nueva cotización, adjuntar cotización, programar llamada o seguimiento y Canvas.', '<b>Pestañas:</b> Resumen (siguiente paso sugerido) · Viaje y datos (editar) · Cotizaciones · Seguimientos · Calificación · Historial.'],
      go: () => { navigate('leads'); const l = openLead(); if (l) leadModal(l.id); },
      tour: () => { const l = openLead(); if (!l) return [note('Aún no hay leads', 'Registra tu primer lead con “+ Nuevo lead” y vuelve a esta guía.')]; const open = modal(() => { navigate('leads'); leadModal(l.id); }); return [
        { before: open, el: '.lf-head', title: 'Encabezado', text: 'Cliente, etapa, puntaje y botones para escribirle, llamarle, ver su Ficha 360 o su portal.' },
        { el: '.lf-stages', title: 'Barra de etapas', text: 'Toca una etapa para mover el lead. Vendido y Perdido te piden el dato que falta (cotización o motivo).' },
        { el: '.lf-actions', title: 'Acciones rápidas', text: 'Lo que más haces con un lead, a un clic.' },
        { el: '.lf-tabs', title: 'Pestañas', text: 'Resumen, datos del viaje (para editar), cotizaciones, seguimientos, calificación e historial.' }]; } },
    { id: 'lead-contacto', cat: 'Leads', icon: '✅', who: isSales, title: 'Primer contacto y calificación', summary: 'Marcar “Ya lo contacté” y cómo se calcula el puntaje.',
      steps: ['Los leads nuevos tienen un tiempo para el primer contacto (aviso ⏰ / ⚠ Sin contacto).', 'En la ficha del lead toca <b>✅ Ya lo contacté</b> (o mueve el lead de Nuevo).', 'En la pestaña <b>Calificación</b> marca cómo responde (⚡ rápido / 🕒 tarda / 😶 no responde) y las preguntas de calificación → <b>Guardar calificación</b>.', 'El puntaje (🔥 Caliente / Tibio / Frío) define la prioridad solo.'],
      go: () => { navigate('leads'); const l = openLead(); if (l) leadFile(l.id, 'qual'); },
      tour: () => { const l = openLead(); if (!l) return [note('Aún no hay leads', 'Registra un lead primero.')]; return [{ before: modal(() => { navigate('leads'); leadFile(l.id, 'summary'); }), el: '.lf-panel', title: 'Primer contacto', text: 'Si falta el primer contacto, aquí aparece el botón “✅ Ya lo contacté”.' }, { before: modal(() => leadFile(l.id, 'qual')), el: '.lf-panel', title: 'Calificación', text: 'Cómo responde el cliente y preguntas de calificación. Guarda al terminar.' }]; } },
    { id: 'lead-cierre', cat: 'Leads', icon: '🏆', who: isSales, title: 'Marcar un lead como Vendido o Perdido', summary: 'Cerrar oportunidades con su venta o su motivo.',
      steps: ['<b>Vendido:</b> en la barra de etapas toca 🏆 Vendido. Si no hay cotización aceptada, el CRM te pide crearla para que cuente en ventas y reportes.', 'Lo normal: marca la cotización como <b>Aceptada</b> y el lead pasa solo a Vendido.', '<b>Perdido:</b> toca ✖ Perdido, elige el motivo (obligatorio) y si quieres programa un recontacto en 1, 3, 6 o 12 meses.', 'En el tablero también puedes arrastrar la tarjeta a la columna o a “🗑 Perdido”.'],
      go: () => navigate('leads'), tour: () => [{ page: 'leads', el: '#leadBoard', title: 'Tablero', text: 'Arrastra la tarjeta a Vendido o a la franja “Perdido”.' }] },

    /* ===== Seguimientos ===== */
    { id: 'seg-nuevo', cat: 'Seguimientos', icon: '📞', title: 'Programar un seguimiento', summary: 'Llamadas, WhatsApp, cotización, pago u otros, con fecha y hora.',
      steps: ['Desde la ficha del lead: <b>Programar llamada</b> o <b>Programar seguimiento</b>; o en <b>Seguimientos › + Nuevo seguimiento</b>.', 'Elige tipo, fecha y hora (atajos: en 1 hora, mañana 10:00, lunes…), cliente/lead y detalles → Guardar.', 'Te llega aviso si se vence. Ábrelo para <b>Abrir WhatsApp</b>, <b>Llamar</b> o marcarlo como hecho.'],
      go: () => { navigate('followups'); followupModal(); },
      tour: () => [{ page: 'followups', el: '#followups [data-action="followup"]', title: 'Nuevo seguimiento', text: 'Crea uno desde aquí o desde la ficha del lead.' }, { before: modal(() => followupModal()), el: '#modalBody form', title: 'Datos del seguimiento', text: 'Tipo, fecha y hora, cliente o lead y lo que vas a hacer.' }] },
    { id: 'seg-cal', cat: 'Seguimientos', icon: '🗓️', title: 'Calendario: reprogramar y agenda del día', summary: 'Vista día, semana o mes y arrastrar para mover.',
      steps: ['En <b>Seguimientos</b> cambia entre Día, Semana y Mes.', '<b>Arrastra</b> un seguimiento para reprogramarlo; doble clic en un horario vacío crea uno nuevo.', 'A la derecha, la <b>Agenda</b> del día con WhatsApp y llamada a un toque.'],
      go: () => navigate('followups'),
      tour: () => [{ page: 'followups', el: '#calendar', title: 'Calendario', text: 'Arrastra para reprogramar. Colores por tipo; vencidos en rojo.' }, { page: 'followups', el: '#timeline', title: 'Agenda', text: 'Lo que toca en el día seleccionado.' }] },
    { id: 'wa-plantillas', cat: 'Seguimientos', icon: '💬', who: isSales, title: 'Enviar WhatsApp con plantilla', summary: 'Mensajes listos por etapa con los datos del cliente.',
      steps: ['En la ficha del lead toca <b>💬 Plantilla WhatsApp</b> (también en viajes y Ficha 360).', 'La etapa se sugiere sola; el mensaje se llena con nombre, destino, fechas, folio, liga de cotización o de pago…', 'Retoca el texto y toca <b>Abrir WhatsApp</b> (o Copiar). Queda registrado en la Ficha 360.', 'El administrador edita las plantillas en <b>Configuración › Plantillas WhatsApp</b>.'],
      go: () => { const l = openLead(); if (l) waModal({ clientId: l.client_id, leadId: l.id }); else waModal({}); },
      tour: () => { const l = openLead(); return [{ before: modal(() => (l ? waModal({ clientId: l.client_id, leadId: l.id }) : waModal({}))), el: '#modalBody', title: 'Plantilla de WhatsApp', text: 'Elige la etapa y la plantilla, revisa el texto y ábrelo en WhatsApp.' }]; } },

    /* ===== Cotizaciones ===== */
    { id: 'cot-nueva', cat: 'Cotizaciones', icon: '📄', who: isSales, title: 'Crear una cotización (paquete o circuito)', summary: 'Hasta 4 propuestas con el diseño de Viajes Casal.',
      steps: ['Desde la ficha del lead: <b>📄 Nueva cotización</b>; o en <b>Cotizaciones › + Nueva cotización</b> (o <b>+ Nuevo circuito</b>).', 'Elige cliente y lead, los servicios (vuelo, hotel, traslados, tours, seguro) y llena cada propuesta.', 'En cada propuesta define el <b>esquema de pago</b>: anticipo + liquidación o plan de pagos (montos y fechas).', 'Guarda. Con <b>Ver PDF</b> la revisas; el lead pasa solo a <b>Cotizado</b>.'],
      go: () => { navigate('quotes'); quoteModal(null); },
      tour: () => [{ page: 'quotes', el: '#quotes [data-action="quote"]', title: 'Nueva cotización', text: 'Arma la cotización con el diseño de la agencia.' }, { page: 'quotes', el: '#quoteGrid', title: 'Tus cotizaciones', text: 'Cada tarjeta: estado, si el cliente la vio o aceptó, su plan de pagos y botones para PDF, liga y WhatsApp.' }] },
    { id: 'cot-adjuntar', cat: 'Cotizaciones', icon: '📎', who: isSales, title: 'Adjuntar una cotización ya trabajada (PDF o link)', badge: 'Nuevo', summary: 'Para clientes que cotizaste antes del CRM.',
      steps: ['Toca <b>📎 Adjuntar cotización</b> en Cotizaciones, en la ficha del lead o en la Ficha 360.', 'Elige cliente (y lead), y <b>sube el PDF o foto</b> (máx. 5 MB, puedes arrastrarlo) o <b>pega el link</b>.', 'Completa destino, monto, estado y vigencia → <b>Guardar cotización</b>.', 'Queda como cotización real (📎 Adjunta): cuenta en reportes y, si se acepta, sigue el flujo de plan de pagos y viaje.'],
      go: () => externalQuoteModal(null, {}),
      tour: () => [{ page: 'quotes', el: '#quotes [data-attach-quote]', title: 'Adjuntar cotización', text: 'Sube el PDF o pega el link de una cotización que ya tenías.' }, { before: modal(() => externalQuoteModal(null, {})), el: '#modalBody form', title: 'Datos de la cotización', text: 'Archivo o link, destino, monto y estado.' }] },
    { id: 'cot-enviar', cat: 'Cotizaciones', icon: '🔗', who: isSales, title: 'Enviar la cotización al cliente (liga y WhatsApp)', summary: 'Liga privada para verla y aceptarla en línea.',
      need: () => (db.quotes.length ? '' : 'Primero crea una cotización.'),
      steps: ['En la tarjeta de la cotización toca <b>🔗 Liga</b> para activar su liga privada y copiarla.', 'Toca <b>WhatsApp</b>: se arma el mensaje con la liga; ábrelo en WhatsApp y márcala como <b>Enviada</b>.', 'Te avisamos cuando el cliente la abre (👀 Vista) y cuando la <b>acepta en línea</b> (✅ En línea).', '<b>Enviar varias propuestas:</b> marca “Seleccionar PDF” en hasta 3 cotizaciones del mismo cliente y toca “Enviar varias propuestas”.'],
      go: () => navigate('quotes'),
      tour: () => (db.quotes.length ? [{ page: 'quotes', el: '#quoteGrid [data-share-quote]', title: 'Liga privada', text: 'Actívala y cópiala para el cliente.' }, { page: 'quotes', el: '#quoteGrid [data-whatsapp]', title: 'WhatsApp', text: 'Mensaje listo con la liga; márcala como Enviada.' }, { page: 'quotes', el: '#multiSend', title: 'Varias propuestas', text: 'Hasta 3 opciones del mismo cliente en un mensaje.' }] : [note('Aún no hay cotizaciones', 'Crea una cotización y vuelve a esta guía.')]) },

    /* ===== Cobros ===== */
    { id: 'pago-plan', cat: 'Cobros y pagos', icon: '💳', who: isSales, title: 'Plan de pagos y registrar un pago (total o parcial)', summary: 'Anticipo, parcialidades, abonos y recibos.',
      need: () => (acceptedQuote() ? '' : 'El plan de pagos aparece cuando una cotización está <b>Aceptada</b>. Hoy no tienes ninguna aceptada: cambia el estado de una cotización a “Aceptada” (en su tarjeta) o espera a que el cliente la acepte en línea.'),
      steps: ['La cotización debe estar <b>Aceptada</b> (en la tarjeta: Estado → Aceptada, o el cliente la acepta en línea).', 'En la tarjeta toca <b>💳 Armar plan de pagos y liga</b> (o la barra de avance si ya existe). El plan sale del esquema de pago de la cotización.', 'En la parcialidad que corresponda toca <b>Registrar pago</b>: monto (si es menor queda como abono), forma de pago, fecha y nota → <b>Registrar pago</b>.', 'Se actualiza el saldo, la Ficha 360, la liga del cliente y su portal; el cliente recibe su recibo por correo.', '<b>✎ Editar plan:</b> cambiar montos/fechas, agregar o quitar pagos. <b>Deshacer</b> quita el último pago (administrador).'],
      go: () => { navigate('quotes'); const q = acceptedQuote(); if (q) payPlanModal(q.id); },
      tour: () => { const q = acceptedQuote(); if (!q) return [{ page: 'quotes', el: '#quoteGrid [data-quote-status]', title: 'Primero: cotización Aceptada', text: 'Cambia aquí el estado de la cotización a “Aceptada”. Entonces aparece el botón “💳 Armar plan de pagos y liga”.' }]; return [
        { page: 'quotes', el: `#quoteGrid [data-pay-plan="${q.id}"]`, title: 'Plan de pagos', text: 'Desde la tarjeta de la cotización aceptada abres su plan.' },
        { before: modal(() => payPlanModal(q.id)), el: '#modalBody .pp-sum', title: 'Total, pagado y saldo', text: 'Siempre al día con cada pago registrado.' },
        { el: '#modalBody .pp-list', title: 'Parcialidades', text: 'En cada una: “Registrar pago” y “💬 Recordar” por WhatsApp.' },
        { el: '#ppUrl', title: 'Liga de pago', text: 'Cópiala para el cliente: ve su plan, lo pagado y cómo pagar.' }]; } },
    { id: 'pago-liga', cat: 'Cobros y pagos', icon: '🔗', who: isSales, title: 'Enviar la liga de pago y recordatorios', summary: 'El cliente ve su plan y cómo pagar; recordatorios automáticos.',
      steps: ['Abre el <b>plan de pagos</b> de la cotización aceptada.', 'Copia la <b>Liga de pago</b> o toca el botón de WhatsApp: las plantillas “Liga para apartar” y “Recordatorio de pago” la incluyen.', 'Cada parcialidad tiene <b>💬 Recordar</b>.', 'Automático: aviso unos días antes y el día del vencimiento, y correo al cliente si tiene.'],
      go: () => { navigate('quotes'); const q = acceptedQuote(); if (q) payPlanModal(q.id); else toast('Necesitas una cotización Aceptada para tener liga de pago', 5000); },
      tour: () => [{ page: 'quotes', el: '#payDue', title: 'Por cobrar', text: 'Aquí ves los pagos por vencer y vencidos de tus clientes; tócalos para registrar o recordar.' }] },
    { id: 'pago-config', cat: 'Cobros y pagos', icon: '🏦', who: isAdmin, title: 'Configurar cobros: datos bancarios, anticipo y Mercado Pago', summary: 'Lo que ve el cliente en su liga de pago.',
      steps: ['Ve a <b>Configuración › Cobros</b>.', 'Captura banco, titular y CLABE (aparecen en la liga de pago).', 'Define el <b>% de anticipo</b>, días para pagarlo, días antes del viaje para liquidar y días de recordatorio.', 'Para cobrar en línea (tarjeta, OXXO, SPEI) agrega en Hostinger la variable <b>MP_ACCESS_TOKEN</b> de Mercado Pago.'],
      go: () => settings('paymentsPanel')(), tour: () => [{ before: settings('paymentsPanel'), el: '#paymentsBody', title: 'Cobros', text: 'Datos bancarios, anticipo y recordatorios.' }] },
    { id: 'contrato', cat: 'Cobros y pagos', icon: '✍️', title: 'Contrato con firma del cliente', summary: 'El cliente firma en línea antes del anticipo.',
      steps: ['Activa y edita el texto en <b>Configuración › Contrato</b> (administrador).', 'Al armar el plan de pagos, la liga de pago pide primero <b>firmar el contrato</b> (con el dedo o el mouse).', 'En el plan de pagos ves el estado: pendiente, firmado, “Pedir firma al cliente” o “Lo firmó en papel”.'],
      go: () => (isAdmin() ? settings('contractPanel')() : navigate('quotes')), tour: () => (isAdmin() ? [{ before: settings('contractPanel'), el: '#contractSettingsBody', title: 'Contrato', text: 'Activa, título, ciudad, cláusulas y vista previa.' }] : [note('Contrato', 'Lo verás dentro del plan de pagos de una cotización aceptada.')]) },
    { id: 'pago-360', cat: 'Cobros y pagos', icon: '💰', who: isSales, title: 'Registrar un pago desde la Ficha 360', summary: 'Pagos sueltos ligados a un viaje o cotización.',
      steps: ['Abre <b>Clientes</b> → toca el cliente (Ficha 360).', 'Toca <b>💰 Registrar pago</b>: monto, concepto, forma de pago, fecha y viaje o cotización.', 'Si la venta tiene plan de pagos, mejor regístralo en el plan para que cuente en el saldo.'],
      go: () => { navigate('clients'); const c = anyClient(); if (c) clientFile(c.id); },
      tour: () => { const c = anyClient(); if (!c) return [note('Sin clientes', 'Registra un lead y vuelve.')]; return [{ before: modal(async () => { navigate('clients'); await clientFile(c.id); }), el: '#modalBody [data-c360="payment"]', title: 'Registrar pago', text: 'Pagos, reseñas y notas desde la ficha del cliente.' }]; } },

    /* ===== Clientes ===== */
    { id: 'cliente-360', cat: 'Clientes', icon: '👤', title: 'Ficha 360 del cliente', summary: 'Línea de tiempo, datos, acompañantes y referidos.',
      steps: ['En <b>Clientes</b> toca la tarjeta (o “👤 Ficha 360” desde el lead).', 'Arriba: vendido, pagado, saldo, viajes y reseñas.', 'Línea de tiempo con filtros; botones Registrar pago, reseña y nota.', 'Pestaña <b>Datos del cliente</b>: datos, preferencias, cumpleaños, “No contactar”, acompañantes y código de referido.'],
      go: () => { navigate('clients'); const c = anyClient(); if (c) clientFile(c.id); },
      tour: () => [{ page: 'clients', el: '#clientGrid', title: 'Clientes', text: 'Toca uno para abrir su Ficha 360.' }] },
    { id: 'portal-cliente', cat: 'Clientes', icon: '🌐', title: 'Portal del cliente: activar y enviar la liga', badge: 'Nuevo', summary: 'Una liga con sus cotizaciones, pagos, viajes y su asesor.',
      steps: ['En la Ficha 360 toca <b>🌐 Portal del cliente</b> (o “🌐 Portal” en la ficha del lead).', 'Toca <b>Activar portal</b> y luego <b>💬 Enviar por WhatsApp</b> (mensaje listo) o Copiar liga.', 'La primera vez el cliente confirma con un <b>código de 6 dígitos</b> que le llega por correo; si no tiene correo, te llega a ti en la campanita para que se lo mandes.', 'Ve sus pagos (y paga/firma), viajes con itinerario, cotizaciones para aceptar, pedir nueva cotización y su liga de referidos.', '“Generar liga nueva” invalida la anterior.'],
      go: () => { const c = anyClient(); if (c) portalModal(c.id); },
      tour: () => { const c = anyClient(); if (!c) return [note('Sin clientes', 'Registra un lead y vuelve.')]; return [{ before: modal(() => portalModal(c.id)), el: '#modalBody .modal-form', title: 'Portal del cliente', text: 'Actívalo, mándalo por WhatsApp y revisa su último acceso.' }]; } },
    { id: 'referidos', cat: 'Clientes', icon: '🤝', title: 'Programa de referidos', summary: 'Código del cliente, descuento de bienvenida y crédito.',
      steps: ['Cada cliente tiene un código <b>VC-…</b> y liga en su Ficha 360 › Datos del cliente (“Invitar por WhatsApp”).', 'Si un lead viene recomendado, en su ficha (Resumen) usa “🤝 ¿Viene recomendado?”.', 'Al venderse, quien refirió gana su crédito. Montos en <b>Configuración › Postviaje y referidos</b>.'],
      go: () => navigate('clients'), tour: null },

    /* ===== Viajes ===== */
    { id: 'viaje-nuevo', cat: 'Viajes', icon: '✈️', title: 'Crear el viaje y la confirmación de servicios', summary: 'De la cotización aceptada al viaje.',
      steps: ['En la cotización aceptada toca <b>Crear viaje con esta cotización</b> (o Viajes › + Nuevo viaje).', 'Abre el viaje → <b>Preparar confirmación de servicios</b> (vuelo, hotel, traslados, actividades) y <b>Ver PDF</b>.', 'Desde el viaje: Pasajeros, Reservas, Canvas, Itinerario digital, Encuesta y WhatsApp.'],
      go: () => navigate('trips'), tour: () => [{ page: 'trips', el: '#trips [data-action="trip"]', title: 'Nuevo viaje', text: 'O créalo desde la cotización aceptada.' }, { page: 'trips', el: '#upcoming', title: 'Próximas salidas', text: 'Abre un viaje para trabajarlo.' }] },
    { id: 'itinerario', cat: 'Viajes', icon: '🗺️', title: 'Itinerario digital: enviar la liga al cliente', summary: 'Día a día, vouchers y contactos en su celular.',
      need: () => (anyTrip() ? '' : 'Primero crea un viaje.'),
      steps: ['Abre el viaje → <b>📱 Itinerario digital</b>.', 'Activa la liga y mándala por WhatsApp; el cliente la ve sin cuenta.', 'Muestra día a día, reservas confirmadas, documentos y tu contacto. También aparece en el portal del cliente.'],
      go: () => { const t = anyTrip(); if (t) itineraryModal(t.id); else navigate('trips'); },
      tour: () => { const t = anyTrip(); if (!t) return [note('Sin viajes', 'Crea un viaje y vuelve a esta guía.')]; return [{ before: modal(() => { navigate('trips'); tripModal(t.id); }), el: `#modalBody [data-itinerary="${t.id}"]`, title: 'Itinerario digital', text: 'Desde aquí activas y compartes la liga del itinerario.' }]; } },
    { id: 'pasajeros', cat: 'Viajes', icon: '👥', title: 'Pasajeros y documentos', summary: 'Nombres, edades, pasaportes y avisos de vigencia.',
      steps: ['Abre el viaje → <b>👥 Pasajeros</b>.', 'Captura nombre como en su identificación, fecha de nacimiento, documento y vigencia; marca al titular.', 'Te avisa de documentos vencidos o pasaportes con menos de 6 meses. Se recuerdan como acompañantes frecuentes.'],
      go: () => navigate('trips'), tour: null },
    { id: 'reservas', cat: 'Viajes', icon: '🧾', title: 'Reservas con proveedores y pago al proveedor', summary: 'Claves de confirmación, estados y fechas de pago.',
      need: () => (anyTrip() ? '' : 'Primero crea un viaje.'),
      steps: ['Abre el viaje → <b>🧾 Reservas</b> (o “✨ Crear reservas desde el Canvas”).', 'Por servicio: proveedor del catálogo, clave, estado (Por reservar → Solicitada → Confirmada), costo, precio de venta y <b>Pagar al proveedor antes de</b>.', 'Al pagarle, marca <b>Pagado</b> (el proveedor de traslados lo ve en su portal).', '<b>Viajes › Reservas</b> junta todo lo que requiere atención.'],
      go: () => { const t = anyTrip(); if (t) bookingsModal(t.id); else navigate('trips'); },
      tour: () => [{ page: 'trips', el: '#bookingsPanel', title: 'Panel de reservas', text: 'Todas las reservas de los viajes abiertos, con filtros y “Solo lo que requiere atención”.' }] },
    { id: 'solicitar-traslado', cat: 'Viajes', icon: '🚐', badge: 'Nuevo', title: 'Solicitar traslado desde la ficha del cliente', summary: 'Reserva, solicitud al proveedor y tareas de pago y seguimiento en un paso.',
      need: () => (db.clients.some((c) => window.transferEligibility?.(c).ok) ? '' : 'El botón aparece cuando la cotización del cliente incluye Traslados o cuando marcas “🚐 Incluye traslado” en Datos del cliente.'),
      steps: ['Abre la <b>ficha del cliente</b> (Clientes › Ficha 360).', 'Si su cotización no se hizo en el CRM: pestaña <b>Datos del cliente</b> → marca <b>🚐 Incluye traslado</b> → Guardar.', 'Toca <b>🚐 Solicitar traslado</b>: elige su viaje (o “Crear viaje nuevo” con destino y fechas) y el proveedor.', 'Revisa los datos del servicio (pasajero, vuelo, hotel, horario) y, si quieres, el precio de venta para calcular tu utilidad.', 'Deja marcadas las tareas: <b>Confirmar con el proveedor</b> (mañana), <b>Pagar al proveedor</b> (5 días antes del viaje) y <b>Enviar datos al cliente</b> (2 días antes).', 'Las tareas se cierran solas: cuando el proveedor responde, cuando marcas el traslado como pagado o si se cancela.'],
      go: () => { navigate('clients'); const c = db.clients.find((x) => window.transferEligibility?.(x).ok) || anyClient(); if (c) clientFile(c.id); },
      tour: () => { const c = db.clients.find((x) => window.transferEligibility?.(x).ok); if (!c) return [note('Marca “Incluye traslado”', 'Abre la ficha del cliente › Datos del cliente › 🚐 Incluye traslado, guarda y vuelve.')]; return [{ before: modal(async () => { navigate('clients'); await clientFile(c.id); }), el: '#modalBody [data-transfer-client]', title: 'Solicitar traslado', text: 'Crea la reserva, pide el precio al proveedor y programa las tareas de pago y seguimiento.' }]; } },
    { id: 'utilidad', cat: 'Cobros y pagos', icon: '💹', title: '¿Cuánto ganamos por cada venta? (utilidad y comisiones)', summary: 'Dónde ver la utilidad de cada venta y la comisión de cada vendedor.',
      steps: ['La utilidad sale de las <b>reservas del viaje</b>: tarifa neta = venta − costo; comisionable = % del proveedor.', 'Por viaje: <b>Viajes</b> › abre el viaje › <b>🧾 Reservas</b> → arriba ves <b>Venta · Utilidad · Comisiones por cobrar · Por pagar a proveedores</b>.', 'Por venta y vendedor: <b>Dashboard › Meta y comisión › Ver comisiones</b> (total, utilidad, comisión y estado).', 'Totales por vendedor u origen: <b>Reportes › Desempeño</b> (columna Utilidad).', 'Lo que te deben los proveedores comisionables: <b>Proveedores › Comisiones por cobrar</b>.', 'Si una venta no muestra utilidad, le falta su viaje con reservas (costo y precio, o % de comisión).'],
      go: () => navigate('trips'), tour: null },
    { id: 'traslado', cat: 'Viajes', icon: '🚐', title: 'Pedir precio de traslado al proveedor (portal)', badge: 'Nuevo', summary: 'El proveedor cotiza, tú aceptas y él confirma.',
      need: () => (anyTrip() ? '' : 'Necesitas un viaje con una reserva de Traslado y un proveedor con acceso al portal.'),
      steps: ['Una vez: crea al proveedor en <b>Proveedores</b> (tipo Traslados) y su usuario en <b>Configuración › Usuarios</b> con rol <b>Proveedor</b>.', 'En el viaje → <b>🧾 Reservas</b>: agrega la reserva tipo <b>Traslado</b> con ese proveedor y <b>Guarda</b>.', 'Toca <b>📨 Pedir precio al proveedor</b>, revisa los datos (pasajero, vuelo, hotel, horario) → Enviar.', 'Cuando llega su precio: <b>✓ Aceptar precio</b> (queda como costo; fecha de pago 5 días antes del viaje) o Rechazar.', 'El proveedor confirma con folio y chofer; la reserva queda Confirmada.'],
      go: () => { const t = anyTrip(); if (t) bookingsModal(t.id); else navigate('suppliers'); }, tour: null },
    { id: 'encuesta', cat: 'Viajes', icon: '⭐', title: 'Encuesta postviaje y reseñas', summary: 'Se envía sola al regresar el cliente.',
      steps: ['Un día después del regreso se genera la liga de encuesta (correo, aviso y seguimiento de WhatsApp).', 'En el viaje, <b>⭐ Encuesta</b> muestra la liga, el estado y las respuestas.', 'Con 4★ o más le ofrecemos dejar reseña en Google; con 3★ o menos te avisamos para recuperarlo.'],
      go: () => navigate('trips'), tour: null },
    { id: 'canvas', cat: 'Viajes', icon: '🧩', title: 'Armar el viaje en Canvas', summary: 'Lienzo por días con costo, venta y utilidad.',
      steps: ['Desde la ficha del lead: <b>🧩 Canvas</b>.', 'Arrastra bloques (vuelo, traslado, hotel, tour, seguro, nota) a cada día y captura costo y venta.', '<b>📄 Crear cotización</b> genera la cotización con el lienzo; desde el viaje lo aplicas al itinerario.'],
      go: () => { const l = openLead(); if (l) leadModal(l.id); }, tour: null },

    /* ===== Proveedores ===== */
    { id: 'proveedores', cat: 'Proveedores', icon: '🏢', title: 'Catálogo de proveedores y comisiones', summary: 'Contactos, tarifa neta o comisionable y comisiones por cobrar.',
      steps: ['En <b>Proveedores</b> toca <b>+ Nuevo proveedor</b>: tipo, contacto, WhatsApp, tarifas de referencia, condiciones de pago.', 'Define si es <b>Tarifa neta</b> o <b>Comisionable</b> (%, días para cobrar).', 'Arriba, <b>Comisiones por cobrar</b>: cambia el estado a Facturada o Cobrada.'],
      go: () => navigate('suppliers'), tour: () => [{ page: 'suppliers', el: '#newSupplier', title: 'Nuevo proveedor', text: 'Agrega hoteles, mayoristas, operadores y traslados.' }, { page: 'suppliers', el: '#supplierGrid', title: 'Catálogo', text: 'Cada proveedor con reservas y lo que se le debe.' }] },
    { id: 'proveedor-acceso', cat: 'Proveedores', icon: '🔑', who: isAdmin, title: 'Dar acceso al portal al proveedor de traslados', summary: 'Su propio usuario para cotizar, confirmar y ver pagos.',
      steps: ['<b>Configuración › Usuarios › Nuevo usuario</b>.', 'Rol <b>Proveedor</b> y elige su ficha del catálogo.', 'Comparte el mensaje con su contraseña temporal; entra al mismo sitio y lo lleva a su portal.'],
      go: () => settings('usersPanel')(), tour: () => [{ before: settings('usersPanel'), el: '#newUser', title: 'Nuevo usuario', text: 'Elige el rol Proveedor y su ficha del catálogo.' }] },

    /* ===== Campañas y reportes ===== */
    { id: 'campanas', cat: 'Campañas y reportes', icon: '📣', who: isSales, title: 'Campañas de recompra', summary: 'A quién escribirle hoy: aniversarios, cumpleaños y temporadas.',
      steps: ['En <b>Campañas</b> ves los clientes a contactar hoy.', 'Toca <b>💬 WhatsApp</b> (mensaje listo) y se marca Enviado; o <b>Omitir</b>.', 'Configura fechas en <b>Configuración › Campañas de recompra</b>.'],
      go: () => navigate('campaigns'), tour: () => [{ page: 'campaigns', el: '#campaignsBody', title: 'Bandeja', text: 'Clientes para contactar hoy.' }] },
    { id: 'reportes', cat: 'Campañas y reportes', icon: '📊', who: isAdmin, title: 'Reportes, metas y comisiones de vendedores', summary: 'Ingresos, desempeño, comisiones y motivos de pérdida.',
      steps: ['En <b>Reportes</b>: ingresos, ticket, días al cierre, satisfacción.', '<b>Desempeño</b> por vendedor u origen (CSV).', '<b>Comisiones de vendedores:</b> márcalas como pagadas.', 'Metas y % de comisión en <b>Configuración › Metas y comisiones</b>.'],
      go: () => navigate('reports'), tour: () => [{ page: 'reports', el: '#performanceReport', title: 'Desempeño', text: 'Por vendedor o por origen.' }, { page: 'reports', el: '#sellerCommissions', title: 'Comisiones', text: 'Liberadas por pagar y pagadas.' }] },
    { id: 'exportar', cat: 'Campañas y reportes', icon: '⬇️', title: 'Exportar a Excel y respaldos', summary: 'Descarga tus datos y copia diaria automática.',
      steps: ['El botón <b>⬇</b> de la barra superior exporta a Excel o CSV.', 'Respaldo automático diario a las 2:00 a.m. en <b>Configuración › Respaldos</b> (administrador).'],
      go: () => document.getElementById('exportBtn')?.click(), tour: () => [{ el: '#exportBtn', title: 'Exportar', text: 'Leads, clientes, cotizaciones, ventas, viajes y seguimientos.' }] },

    /* ===== Configuración ===== */
    { id: 'usuarios', cat: 'Configuración', icon: '👥', who: isAdmin, title: 'Usuarios y roles', summary: 'Administrador, Dirección, Travel Partner, Vendedor, Operaciones y Proveedor.',
      steps: ['<b>Configuración › Usuarios › Nuevo usuario</b>: nombre, correo y rol.', '<b>Administrador</b>: control total. <b>Dirección</b>: ve a todo el equipo, reasigna leads y registra comisiones. <b>Travel Partner</b>: gestiona los viajes de sus clientes. <b>Vendedor</b>: solo vende y ve el estado de sus clientes, sin costos ni comisiones.', 'Comparte el mensaje con la contraseña temporal (se cambia al primer acceso).', '“Nueva contraseña” y “Quitar app” para recuperar accesos.'],
      go: () => settings('usersPanel')(), tour: () => [{ before: settings('usersPanel'), el: '#userRows', title: 'Usuarios', text: 'Edita rol, estado y contraseñas.' }] },
    { id: 'automatizaciones', cat: 'Configuración', icon: '🤖', who: isAdmin, title: 'Automatizaciones', summary: 'Reglas “Cuando… Si… Entonces…”.',
      steps: ['<b>Configuración › Automatizaciones</b>.', 'Elige el disparador (lead nuevo, cambio de etapa, pago, días antes del viaje…), condiciones y acciones (seguimiento, WhatsApp con plantilla, correo, aviso…).', '<b>Probar sin hacer cambios</b> antes de activarla.'],
      go: () => settings('automationsPanel')(), tour: () => [{ before: settings('automationsPanel'), el: '#automationsBody', title: 'Automatizaciones', text: 'Activa, duplica o prueba cada regla.' }] },
    { id: 'campos', cat: 'Configuración', icon: '🧷', who: isAdmin, title: 'Campos personalizables y plantillas', summary: 'Tus propios campos y textos de WhatsApp/PDF.',
      steps: ['<b>Campos personalizables</b>: agrega campos a leads, clientes y viajes.', '<b>Plantillas WhatsApp</b>: edita los mensajes por etapa con variables como {nombre}, {liga_pago}.', '<b>Plantilla PDF</b>: textos y datos de las cotizaciones y confirmaciones.'],
      go: () => settings('fieldsPanel')(), tour: () => [{ before: settings('templatesPanel'), el: '#templatesBody', title: 'Plantillas', text: 'Mensajes por etapa con vista previa.' }] },
    { id: 'integraciones', cat: 'Configuración', icon: '🔌', who: isAdmin, title: 'Integraciones: bot, formulario web y Google', summary: 'Cómo entran los leads solos y conexiones externas.',
      steps: ['<b>Configuración › Integraciones</b>: correo de la plataforma, bot de WhatsApp, formulario web (liga, QR y código para tu sitio) y Google Calendar.', '<b>Asignación de leads</b>: turnos o vendedor fijo para los que llegan solos.'],
      go: () => settings('integrationsPanel')(), tour: () => [{ before: settings('integrationsPanel'), el: '#integrationCards', title: 'Integraciones', text: 'Cada tarjeta con su estado y configuración.' }] }
  ];

  /* ---------------- Pantalla del centro de ayuda ---------------- */
  const state = { q: '', cat: '' };
  const visibleGuides = () => G.filter((g) => !g.who || g.who());
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function list() {
    const guides = visibleGuides();
    const cats = [...new Set(guides.map((g) => g.cat))];
    const q = norm(state.q);
    const shown = guides.filter((g) => (!state.cat || g.cat === state.cat) && (!q || norm(`${g.title} ${g.summary} ${g.cat} ${g.steps.join(' ')}`).includes(q)));
    const groups = cats.map((c) => [c, shown.filter((g) => g.cat === c)]).filter(([, l]) => l.length);
    return `<div class="hc">
      <div class="hc-top"><input id="hcSearch" type="search" placeholder="¿Qué quieres hacer? Ej. registrar pago, enviar liga, traslado…" value="${H(state.q)}" autocomplete="off"></div>
      <div class="hc-cats"><button type="button" data-hc-cat="" class="${state.cat ? '' : 'on'}">Todas</button>${cats.map((c) => `<button type="button" data-hc-cat="${H(c)}" class="${state.cat === c ? 'on' : ''}">${H(c)}</button>`).join('')}</div>
      ${groups.map(([c, l]) => `<p class="hc-cat">${H(c)}</p><div class="hc-list">${l.map((g) => `<button type="button" class="hc-item" data-hc="${g.id}"><span class="hc-ico">${g.icon}</span><span><b>${H(g.title)}</b>${g.badge ? ` <em class="hc-badge">${H(g.badge)}</em>` : ''}<small>${H(g.summary)}</small></span><span class="hc-go">›</span></button>`).join('')}</div>`).join('') || '<p class="empty-note">No encontramos una guía con esa búsqueda. Prueba con otra palabra.</p>'}
    </div>`;
  }
  function detail(g) {
    const need = g.need ? g.need() : '';
    return `<div class="hc hc-detail">
      <button type="button" class="link" data-hc-back>‹ Todas las guías</button>
      <div class="hc-head"><span class="hc-ico big">${g.icon}</span><div><small>${H(g.cat)}</small><h3>${H(g.title)}</h3><p class="muted-note">${H(g.summary)}</p></div></div>
      ${need ? `<p class="note-warn">${need}</p>` : ''}
      <ol class="hc-steps">${g.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <div class="modal-actions">${g.tour ? '<button type="button" class="btn secondary" data-hc-tour>▶ Guíame en pantalla</button>' : ''}${g.go ? '<button type="button" class="btn primary" data-hc-go>Ir ahora</button>' : ''}</div>
    </div>`;
  }
  function paint(id) {
    const g = id ? G.find((x) => x.id === id) : null;
    openModal('¿NECESITAS AYUDA?', g ? 'Guía paso a paso' : 'Centro de ayuda', g ? detail(g) : list(), { wide: true });
    const body = $('#modalBody');
    const search = $('#hcSearch');
    if (search) { search.oninput = () => { state.q = search.value; const pos = search.selectionStart; paint(); const s2 = $('#hcSearch'); s2.focus(); s2.setSelectionRange(pos, pos); }; if (!g && !('ontouchstart' in window)) search.focus(); }
    body.onclick = async (e) => {
      const cat = e.target.closest('[data-hc-cat]');
      if (cat) { state.cat = cat.dataset.hcCat; paint(); return; }
      const item = e.target.closest('[data-hc]');
      if (item) { paint(item.dataset.hc); return; }
      if (e.target.closest('[data-hc-back]')) { paint(); return; }
      if (g && e.target.closest('[data-hc-go]')) { close(); await wait(50); g.go(); return; }
      if (g && e.target.closest('[data-hc-tour]')) {
        if (g.id === 'recorrido') { close(); window.startMainTour(); return; }
        const steps = (typeof g.tour === 'function' ? g.tour() : []) || [];
        close();
        if (steps.length && typeof window.tpTour === 'function') window.tpTour(steps);
      }
    };
  }
  window.helpCenter = (id) => paint(id || null);
  window.HELP_GUIDES = G;
}());
