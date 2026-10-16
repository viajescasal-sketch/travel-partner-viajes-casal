'use strict';

/* =========================================================
   Avatar del agente (foto o animal ilustrado) y recorrido guiado de capacitación
   - Recorrido general automático la primera vez (por rol), con “No volver a mostrar”.
   - Botón “?” en cada página con la guía de esa sección; “Abrir guía” reinicia el recorrido.
   - El administrador puede volver a mostrarlo a todo el equipo (Configuración › Usuarios).
   ========================================================= */
(function () {
  const H = escapeHtml;
  const AV = window.TPAvatars;

  /* ---------------- Avatares ---------------- */
  const userInfo = (id) => (db.users || []).find((u) => u.id === Number(id)) || (currentUser && currentUser.id === Number(id) ? { id: currentUser.id, name: currentUser.name } : { id, name: '' });
  window.userAvatarHtml = (id, size = 28, opts = {}) => (AV ? AV.html(userInfo(id), { size, still: opts.still !== false }) : '');
  function paintMyAvatar() {
    const box = $('#profileInitial');
    if (!box || !AV || !currentUser) return;
    const me = { ...userInfo(currentUser.id), avatar: db.prefs?.avatar ?? userInfo(currentUser.id).avatar };
    box.innerHTML = AV.html(me, { size: 40 });
    box.classList.add('has-av');
  }

  async function avatarModal() {
    let profile;
    try { profile = (await api('/api/profile')).profile; } catch (error) { toast(error.message); return; }
    const state = { avatar: db.prefs?.avatar || null, photo: profile.photoUrl ? Number(profile.photoUrl.split('/').pop()) : null, photoUrl: profile.photoUrl };
    const paint = () => {
      const me = { id: currentUser.id, name: currentUser.name, photoUrl: state.photoUrl, avatar: state.avatar };
      openModal('MI AVATAR', 'Tu foto o tu animal', `<div class="av-pick">
        <div class="av-current">${AV.html(me, { size: 112 })}<div><b>${H(currentUser.name)}</b><p class="muted-note">Tu foto aparece en el menú, en el equipo y en “Conoce a tu Travel Partner” de las cotizaciones. Si no subes foto, se usa el animal que elijas.</p>
          <div class="av-actions"><label class="btn primary small"><input type="file" id="avFile" accept="image/jpeg,image/png,image/webp" hidden>${icon('camera')} ${state.photoUrl ? 'Cambiar foto' : 'Subir mi foto'}</label>${state.photoUrl ? '<button type="button" class="btn secondary small" id="avNoPhoto">Quitar foto y usar animal</button>' : ''}</div></div></div>
        <p class="section-label">Elige tu animal</p>
        <div class="av-grid">${AV.ANIMALS.map((a) => `<button type="button" class="av-opt${(state.avatar || AV.defaultFor(currentUser.id)) === a.key ? ' on' : ''}" data-av="${a.key}" title="${H(a.name)}">${AV.svg(a.key, { size: 64 })}<small>${H(a.name)}</small></button>`).join('')}</div>
        <div class="modal-actions"><button type="button" class="btn primary close">Listo</button></div></div>`);
      $('#modalBody').onclick = async (e) => {
        const opt = e.target.closest('[data-av]');
        if (opt) {
          try { const r = await send('PUT', '/api/me/avatar', { avatar: opt.dataset.av }); db.prefs = { ...(db.prefs || {}), avatar: r.avatar }; state.avatar = r.avatar; if (state.photoUrl) toast('Animal guardado. Se verá cuando quites tu foto.'); else toast('Avatar actualizado'); paintMyAvatar(); paint(); } catch (error) { toast(error.message); }
          return;
        }
        if (e.target.closest('#avNoPhoto')) {
          try { await send('PUT', '/api/profile', { photoMediaId: null }); state.photo = null; state.photoUrl = null; await loadAll(); paint(); toast('Foto quitada'); } catch (error) { toast(error.message); }
        }
      };
      $('#avFile').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const id = await uploadImage(file, 600);
          await send('PUT', '/api/profile', { photoMediaId: id });
          state.photo = id; state.photoUrl = `/api/media/${id}`;
          await loadAll(); paint(); toast('Foto actualizada');
        } catch (error) { toast(error.message, 6000); }
      };
    };
    paint();
  }
  $('#profileAvatar')?.addEventListener('click', avatarModal);
  window.avatarModal = avatarModal;

  /* ---------------- Motor del recorrido ---------------- */
  let tour = null; // { steps, i, onEnd, kind }
  const visible = (el) => el && el.offsetParent !== null && el.getClientRects().length;
  const mobile = () => window.innerWidth <= 800;

  function endTour(reason) {
    const t = tour;
    tour = null;
    $('#tourLayer')?.remove();
    document.body.classList.remove('tour-on');
    $('#sidebar')?.classList.remove('tour-open');
    if (mobile()) $('#sidebar')?.classList.remove('open');
    if (t?.kind === 'main') {
      const off = t.off;
      send('POST', '/api/me/tour', { action: off ? 'off' : 'seen' }).then((r) => { db.prefs = { ...(db.prefs || {}), tour: r.tour }; }).catch(() => {});
      if (reason === 'done') toast('¡Listo! Puedes repetir el recorrido con “Abrir guía” y ver la guía de cada página con el botón ?.', 6000);
    }
  }
  function placeCard(card, rect) {
    const pad = 14, w = card.offsetWidth, h = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    if (!rect || mobile()) { card.style.left = `${Math.max(12, (vw - w) / 2)}px`; card.style.top = !rect ? `${Math.max(12, (vh - h) / 2)}px` : rect.top + rect.height / 2 > vh / 2 ? '12px' : `${Math.max(12, vh - h - 12)}px`; return; }
    let left = rect.right + pad, top = rect.top;
    if (left + w > vw - 12) { left = Math.max(12, rect.left - w - pad); }
    if (left < 12 || (rect.width > vw * 0.5)) { left = Math.min(Math.max(12, rect.left), vw - w - 12); top = rect.bottom + pad; if (top + h > vh - 12) top = Math.max(12, rect.top - h - pad); }
    top = Math.min(Math.max(12, top), vh - h - 12);
    card.style.left = `${left}px`; card.style.top = `${top}px`;
  }
  async function showStep() {
    if (!tour) return;
    const s = tour.steps[tour.i];
    if (s.page && typeof navigate === 'function') navigate(s.page);
    if (s.before) await s.before();
    const inNav = s.el && String(s.el).startsWith('#nav') || String(s.el || '').startsWith('#sidebar') || String(s.el || '').startsWith('.side-bottom') || String(s.el || '').startsWith('#profile') || String(s.el || '').startsWith('#tourStart');
    $('#sidebar')?.classList.toggle('tour-open', Boolean(inNav));
    if (mobile()) $('#sidebar')?.classList.toggle('open', Boolean(inNav));
    await new Promise((r) => setTimeout(r, mobile() && inNav ? 280 : 60));
    let el = s.el ? document.querySelector(s.el) : null;
    if (el && !visible(el)) el = null;
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((r) => setTimeout(r, 40));
    let layer = $('#tourLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'tourLayer';
      layer.innerHTML = '<div class="tour-hole"></div><div class="tour-card" role="dialog" aria-modal="true" aria-live="polite"></div>';
      document.body.append(layer);
      document.body.classList.add('tour-on');
    }
    const hole = layer.querySelector('.tour-hole'), card = layer.querySelector('.tour-card');
    const rect = el ? el.getBoundingClientRect() : null;
    if (rect) Object.assign(hole.style, { display: 'block', left: `${rect.left - 6}px`, top: `${rect.top - 6}px`, width: `${rect.width + 12}px`, height: `${rect.height + 12}px` });
    else Object.assign(hole.style, { display: 'block', left: '50%', top: '50%', width: '0px', height: '0px' });
    const n = tour.steps.length, i = tour.i;
    card.innerHTML = `<div class="tour-top">${s.icon ? icon(s.icon) : ''}<span>${tour.kind === 'main' ? 'Recorrido guiado' : 'Guía de la sección'} · ${i + 1} de ${n}</span><button type="button" class="tour-x" data-tour="close" aria-label="Cerrar">×</button></div>
      <h3>${H(s.title)}</h3><p>${s.html || H(s.text)}</p>
      <div class="tour-dots">${tour.steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('')}</div>
      ${tour.kind === 'main' && i === 0 ? `<label class="tour-off"><input type="checkbox" data-tour="off" ${tour.off ? 'checked' : ''}> No volver a mostrar al entrar</label>` : ''}
      <div class="tour-acts">${i > 0 ? '<button type="button" class="btn secondary small" data-tour="prev">Anterior</button>' : `<button type="button" class="btn secondary small" data-tour="close">${tour.kind === 'main' ? 'Ahora no' : 'Cerrar'}</button>`}<button type="button" class="btn primary small" data-tour="next">${i === n - 1 ? 'Terminar' : 'Siguiente'}</button></div>`;
    placeCard(card, rect);
    card.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  }
  function startTour(steps, kind = 'section') {
    if (tour) endTour('switch');
    if (!$('#modalBg').classList.contains('hidden')) close();
    const list = steps.filter((s) => !s.when || s.when());
    if (!list.length) return;
    tour = { steps: list, i: 0, kind, off: Boolean(db.prefs?.tour?.off) };
    showStep();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tour]');
    if (!b || !tour) return;
    const a = b.dataset.tour;
    if (a === 'off') { tour.off = b.checked; return; }
    if (a === 'close') endTour('closed');
    if (a === 'prev') { tour.i = Math.max(0, tour.i - 1); showStep(); }
    if (a === 'next') { if (tour.i >= tour.steps.length - 1) endTour('done'); else { tour.i += 1; showStep(); } }
  });
  document.addEventListener('keydown', (e) => {
    if (!tour) return;
    if (e.key === 'Escape') endTour('closed');
    if (e.key === 'ArrowRight') $('#tourLayer [data-tour="next"]')?.click();
    if (e.key === 'ArrowLeft') $('#tourLayer [data-tour="prev"]')?.click();
  });
  window.addEventListener('resize', () => { if (tour) showStep(); });

  /* ---------------- Contenido ---------------- */
  const admin = () => isAdmin(), ops = () => isOps(), sales = () => !isOps();
  const MAIN = () => [
    { icon: 'sparkles', title: `¡Hola${currentUser?.name ? `, ${currentUser.name.split(' ')[0]}` : ''}! Bienvenido a Travel Partner`, text: 'Te muestro en 2 minutos para qué sirve cada parte de la plataforma. Puedes salir cuando quieras y repetirlo con el botón “Abrir guía”.' },
    { el: '#nav [data-page="dashboard"]', icon: 'home', title: 'Dashboard', text: 'Tu resumen del día: indicadores del mes, tu meta y comisión, el embudo de ventas, las prioridades de hoy y las oportunidades recientes.' },
    { el: '#nav [data-page="leads"]', icon: 'target', when: sales, title: 'Leads', text: 'Todas las oportunidades (del bot de WhatsApp, del formulario web o que registras tú) en un tablero por etapa: Nuevo → Calificado → Cotizado → Negociación → Vendido. Arrástralos para avanzar; cada lead tiene su calificación automática.' },
    { el: '#nav [data-page="quotes"]', icon: 'file', title: 'Cotizaciones', text: 'Arma cotizaciones con hasta 4 opciones, mándalas por WhatsApp con su liga privada y el cliente las acepta en línea. Al aceptar se arma el plan de pagos, el contrato con firma y la liga para pagar.' },
    { el: '#nav [data-page="clients"]', icon: 'users', title: 'Clientes', text: 'La ficha 360 de cada cliente: su línea de tiempo (mensajes, cotizaciones, pagos, viajes y reseñas), datos, acompañantes y referidos.' },
    { el: '#nav [data-page="trips"]', icon: 'plane', title: 'Viajes', text: 'Los viajes vendidos: confirmación de servicios, itinerario digital para el celular, pasajeros, reservas con proveedores, Canvas del viaje y encuesta al regresar.' },
    { el: '#nav [data-page="suppliers"]', icon: 'building', title: 'Proveedores', text: 'El catálogo de hoteles, mayoristas y operadores con su contacto, tarifas y comisión, y las comisiones por cobrar a cada proveedor.' },
    { el: '#nav [data-page="campaigns"]', icon: 'megaphone', when: sales, title: 'Campañas', text: 'Cada día te dice a qué clientes anteriores escribirles: aniversario de su viaje, cumpleaños y temporadas. Con un toque mandas el WhatsApp ya escrito.' },
    { el: '#nav [data-page="followups"]', icon: 'calendar', title: 'Seguimientos', text: 'Tu agenda de llamadas, mensajes y cobros en vista de día, semana o mes. Se sincroniza con Google Calendar y te avisa si algo se vence.' },
    { el: '#nav [data-page="reports"]', icon: 'chart', when: admin, title: 'Reportes', text: 'Ingresos, ticket, desempeño por vendedor y por origen, comisiones de vendedores, motivos de pérdida y satisfacción de los clientes.' },
    { el: '#nav [data-page="activity"]', icon: 'history', when: admin, title: 'Bitácora', text: 'Quién hizo qué y cuándo: altas, cambios, pagos, inicios de sesión y automatizaciones.' },
    { el: '#nav [data-page="settings"]', icon: 'settings', when: admin, title: 'Configuración', text: 'Usuarios, plantillas PDF y de WhatsApp, cobros, contrato, metas y comisiones, campos personalizables, automatizaciones y más.' },
    { el: '#globalSearch', icon: 'search', title: 'Búsqueda rápida', text: 'Escribe un nombre, folio o destino para encontrar clientes, leads y cotizaciones desde cualquier página.' },
    { el: '#bellBtn', icon: 'bell', title: 'Avisos', text: 'La campanita junta todo lo que necesita tu atención: leads nuevos, cotizaciones vistas, pagos recibidos, contratos firmados y seguimientos vencidos.' },
    { el: 'header [data-action="lead"]', icon: 'plus', when: sales, title: 'Registrar un lead', text: 'Desde aquí das de alta una oportunidad nueva en segundos.' },
    { el: '#profileAvatar', icon: 'camera', title: 'Tu avatar', text: 'Toca tu imagen para subir tu foto o elegir un animal. Tu foto también aparece en las cotizaciones que envías.' },
    { el: '#tourStart', icon: 'compass', title: '¿Dudas? Aquí está la guía', html: 'Con <b>Abrir guía</b> repites este recorrido, y en cada página el botón <b>?</b> te explica esa sección paso a paso.' }
  ];
  const SECTIONS = {
    dashboard: [
      { el: '#dashboard .kpis', title: 'Indicadores del mes', text: 'Leads activos, cotizaciones enviadas, ventas y conversión del mes en curso.' },
      { el: '#goalPanel', title: 'Meta y comisión', text: 'Tu avance contra la meta del mes y tu comisión por liberar, por pagar y pagada. Toca “Ver comisiones” para el detalle por venta.' },
      { el: '#funnel', when: sales, title: 'Embudo comercial', text: 'Cuántas oportunidades llegaron a cada etapa este mes.' },
      { el: '#todayTasks', title: 'Prioridades de hoy', text: 'Los seguimientos del día y los vencidos. Márcalos como hechos con la casilla.' }
    ],
    leads: [
      { el: '#leads [data-lead-view]', title: 'Tablero o lista', text: 'Cambia entre el tablero por etapas y la lista con filtros.' },
      { el: '#leadBoard', title: 'Tablero de oportunidades', text: 'Arrastra cada tarjeta a su nueva etapa. En rojo, las que llevan demasiados días en una etapa. Toca una tarjeta para ver la ficha del lead, programar seguimientos o cotizar.' },
      { el: '#leadSearch', title: 'Buscar', text: 'Busca por nombre, teléfono, destino, notas o campos personalizados.' },
      { el: '#reassignLeads', when: admin, title: 'Reasignar', text: 'El administrador mueve varios leads a otro vendedor de una vez.' }
    ],
    quotes: [
      { el: '#quotes .mini', title: 'Estado de tus cotizaciones', text: 'Cuántas están en elaboración, listas, enviadas y aceptadas.' },
      { el: '#payDue', title: 'Por cobrar esta semana', text: 'Pagos que vencen pronto o ya vencieron. Toca uno para registrar el pago o recordarle al cliente.' },
      { el: '#quoteGrid', title: 'Tus cotizaciones', text: 'Cada tarjeta muestra si el cliente ya la abrió, si la aceptó en línea, su plan de pagos y el contrato. Ábrela para editar, compartir la liga o crear el viaje.' },
      { el: '#multiSend', title: 'Envío múltiple', text: 'Manda varias opciones al mismo cliente en un solo mensaje.' }
    ],
    clients: [
      { el: '#clientSearch', title: 'Buscar clientes', text: 'Por nombre, WhatsApp o correo.' },
      { el: '#clientGrid', title: 'Ficha 360', text: 'Toca un cliente para ver su línea de tiempo, registrar pagos, reseñas y notas, editar sus datos y campos personalizados, acompañantes y código de referido.' }
    ],
    trips: [
      { el: '#upcoming', title: 'Próximas salidas', text: 'Los viajes que vienen. Ábrelos para la confirmación de servicios, itinerario digital, pasajeros, reservas y Canvas.' },
      { el: '#activeTrips', title: 'De viaje hoy', text: 'Clientes que están viajando: ten a la mano su itinerario y contactos.' },
      { el: '#bookingsPanel', title: 'Reservas', text: 'Todas las reservas con su proveedor, clave, estado y pago al proveedor. Filtra lo que requiere atención.' }
    ],
    suppliers: [
      { el: '#supCommissions', title: 'Comisiones por cobrar', text: 'Cuánto te debe cada proveedor comisionable, qué está vencido y qué ya cobraste.' },
      { el: '#supplierGrid', title: 'Catálogo', text: 'Cada proveedor con contacto, tarifas de referencia, comisión y si es tarifa neta o comisionable.' }
    ],
    campaigns: [{ el: '#campaignsBody', title: 'Bandeja de recompra', text: 'Clientes a contactar hoy. “WhatsApp” abre el mensaje listo; márcalo Enviado u Omitir.' }],
    followups: [
      { el: '#calendar', title: 'Calendario', text: 'Arrastra un seguimiento para reprogramarlo. Cambia entre día, semana y mes.' },
      { el: '#timeline', title: 'Agenda', text: 'Lo que toca en el día seleccionado, con acceso directo a WhatsApp y llamada.' },
      { el: '#calGoogle', title: 'Google Calendar', text: 'Suscríbete para ver tus seguimientos en tu calendario de Google.' }
    ],
    reports: [
      { el: '#reports .kpis', title: 'Resumen', text: 'Ingresos, ticket promedio, días al cierre y satisfacción.' },
      { el: '#performanceReport', title: 'Desempeño', text: 'Por vendedor o por origen: leads, contacto, conversión, ventas, utilidad y comisión. Descárgalo en CSV.' },
      { el: '#sellerCommissions', title: 'Comisiones de vendedores', text: 'Marca como pagadas las comisiones que ya se liberaron.' },
      { el: '#lostReport', title: 'Motivos de pérdida', text: 'Por qué se pierden las ventas, por vendedor y por origen.' }
    ],
    activity: [{ el: '#actRows', title: 'Bitácora', text: 'Filtra por usuario, tipo, registro o fechas y exporta lo que necesites.' }],
    settings: [
      { el: '#settingsNav', title: 'Secciones de configuración', text: 'Usuarios y roles, plantillas, cobros, contrato, metas, campos personalizables, automatizaciones, integraciones y respaldos.' },
      { el: '#settingsNav [data-settings-tab="automationsPanel"]', title: 'Automatizaciones', text: 'Reglas “si pasa X, haz Y” para seguimientos, plantillas de WhatsApp, correos y avisos sin programar.' },
      { el: '#settingsNav [data-settings-tab="usersPanel"]', title: 'Usuarios y recorrido', text: 'Aquí creas accesos y puedes volver a mostrar este recorrido a todo el equipo.' }
    ]
  };
  window.startMainTour = () => startTour(MAIN(), 'main');
  window.startSectionGuide = (page) => startTour((SECTIONS[page] || []).map((s) => ({ ...s, page })), 'section');
  $('#tourStart')?.addEventListener('click', () => { if (mobile()) $('#sidebar')?.classList.remove('open'); window.startMainTour(); });

  // Botón “?” en el encabezado de cada página.
  $$('#platform .page').forEach((sec) => {
    if (!SECTIONS[sec.id]) return;
    const h = sec.querySelector('.heading h2');
    if (!h || h.querySelector('.guide-btn')) return;
    h.insertAdjacentHTML('beforeend', `<button type="button" class="guide-btn" data-guide="${sec.id}" title="Guía de esta sección" aria-label="Guía de esta sección">${icon('help')}</button>`);
  });
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-guide]'); if (g) window.startSectionGuide(g.dataset.guide); });

  // Administrador: volver a mostrar el recorrido a todo el equipo.
  function paintTourAdmin() {
    const panel = $('#usersPanel');
    if (!panel || !admin() || $('#tourReset')) return;
    panel.insertAdjacentHTML('beforeend', `<div class="tour-admin"><div><b>${icon('compass')} Recorrido guiado</b><small>Aparece solo la primera vez que alguien entra. Si hay personal nuevo o funciones nuevas, muéstralo otra vez a todos.</small></div><button type="button" class="btn secondary small" id="tourReset">Mostrar el recorrido otra vez a todos</button></div>`);
    $('#tourReset').onclick = async () => {
      if (!confirm('¿Mostrar el recorrido otra vez a todo el equipo la próxima vez que entren?')) return;
      try { await send('POST', '/api/tour/reset'); toast('Listo: todos verán el recorrido al entrar'); } catch (error) { toast(error.message); }
    };
  }

  let autoChecked = false;
  window.onDataLoaded = () => {
    paintMyAvatar();
    paintTourAdmin();
    if (!autoChecked && db.prefs?.tour?.show && !(typeof passwordChangeRequired !== 'undefined' && passwordChangeRequired)) {
      autoChecked = true;
      setTimeout(() => { if (!tour && !$('#modalBg:not(.hidden)')) window.startMainTour(); }, 900);
    }
    autoChecked = true;
  };
}());
