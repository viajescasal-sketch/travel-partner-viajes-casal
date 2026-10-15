'use strict';

/* =========================================================
   TP-302 Vista Canvas del viaje · TP-303 Pasajeros y acompañantes
   Pantallas de la plataforma. Usa las utilidades de app.js
   (db, api, send, mutate, openModal, toast…) y las reglas de viaje-core.js.
   ========================================================= */
(function () {
  const T = window.TPTrip;
  const H = escapeHtml;
  const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
  const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const dayName = (iso) => (T.isDate(iso) ? `${WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${fmtDate(iso)}` : '');
  const leadOfTrip = (t) => { const q = t.quote_id ? quoteById(t.quote_id) : null; return (q?.lead_id && leadById(q.lead_id)) || db.leads.filter((l) => l.client_id === t.client_id).sort((a, b) => b.id - a.id)[0] || null; };
  const expectedTravelers = (t) => Number(t.confirmation?.travelers) || Number(leadOfTrip(t)?.travelers) || 0;
  const ALERT_ICON = { danger: '⛔', warn: '⚠', info: 'ⓘ' };

  /* ---------------- TP-303 · Pasajeros ---------------- */
  // Insignias para la tarjeta del viaje (Viajes) y el botón del viaje.
  window.tripBadges = (t) => {
    const list = t.passengers?.list || [];
    const s = T.tripPassengerSummary(list, t, expectedTravelers(t));
    const out = [];
    if (list.length) out.push(`<span class="tp-badge">👥 ${s.total}${s.missing ? ` de ${s.total + s.missing}` : ''}</span>`);
    else if (canWrite('trips')) out.push('<span class="tp-badge muted">👥 Sin pasajeros</span>');
    if (s.danger) out.push(`<span class="tp-badge danger">⛔ ${s.danger} documento${s.danger > 1 ? 's' : ''}</span>`);
    else if (s.warn) out.push(`<span class="tp-badge warn">⚠ ${s.warn} por vencer</span>`);
    if (t.canvas?.blocks?.length) out.push('<span class="tp-badge">🧩 Canvas</span>');
    return out.length ? `<span class="tp-badges">${out.join('')}</span>` : '';
  };
  window.tripPaxButtonLabel = (t) => { const n = t.passengers?.list?.length || 0; return `👥 Pasajeros${n ? ` (${n})` : ''}`; };

  function seedPassengers(t) {
    const client = clientById(t.client_id);
    const companions = client?.companions?.list || [];
    const me = companions.find((c) => c.name.toLowerCase() === String(client?.name || '').toLowerCase());
    return client ? [{ nationality: 'Mexicana', ...(me || {}), name: client.name, phone: me?.phone || client.phone || '', holder: true, relation: me?.relation || 'Titular' }] : [];
  }

  function passengersModal(tripId) {
    const t = tripById(tripId);
    if (!t) return;
    const client = clientById(t.client_id);
    const editable = canWrite('trips');
    let list = clone(t.passengers?.list?.length ? t.passengers.list : seedPassengers(t)).map((p, i) => T.cleanPassenger(p, i)).filter(Boolean);
    const skip = new Set();
    const expected = expectedTravelers(t);
    const blank = () => ({ id: `p${Date.now().toString(36)}${list.length}`, name: '', birth_date: '', type: 'Adulto', holder: false, relation: '', doc_type: '', doc_number: '', doc_expiry: '', nationality: 'Mexicana', phone: '', notes: '' });
    const companions = () => (client?.companions?.list || []).filter((c) => !list.some((p) => p.name.toLowerCase() === c.name.toLowerCase() || (c.doc_number && p.doc_number === c.doc_number)));

    const alertsHtml = (p) => { const a = p.name ? T.passengerAlerts(p, t) : []; return a.length ? `<div class="pax-alerts">${a.map((x) => `<span class="pax-alert ${x.level}">${ALERT_ICON[x.level]} ${H(x.text)}</span>`).join('')}</div>` : '<div class="pax-alerts"><span class="pax-alert ok">✓ Documentos en orden</span></div>'; };
    const typeHtml = (p) => { const age = T.ageOn(p.birth_date, t.start_date); return p.birth_date ? `<span class="pax-type">${H(T.paxType(p.birth_date, t.start_date))}${age != null && age >= 0 ? ` · ${age} ${age === 1 ? 'año' : 'años'} al salir` : ''}</span>` : `<select data-pf="type">${options(T.PAX_TYPES, p.type)}</select>`; };
    const card = (p, i) => `<div class="pax-card" data-pi="${i}">
      <div class="pax-head"><b>Pasajero ${i + 1}</b><label class="pax-holder"><input type="radio" name="paxHolder" data-pf="holder" ${p.holder ? 'checked' : ''}> Titular de la reserva</label>${editable ? `<button type="button" class="link danger-link" data-pax-del="${i}">Quitar</button>` : ''}</div>
      <div class="pax-grid">
        <label class="span2">Nombre completo (como en su identificación)*<input data-pf="name" maxlength="120" value="${H(p.name)}" placeholder="Ana Sofía López Martínez"></label>
        <label>Fecha de nacimiento<input type="date" data-pf="birth_date" value="${H(p.birth_date)}"></label>
        <label>Tipo<span data-pax-type>${typeHtml(p)}</span></label>
        <label>Documento<select data-pf="doc_type">${options(T.DOC_TYPES, p.doc_type, { blank: 'Sin documento' })}</select></label>
        <label>Número<input data-pf="doc_number" maxlength="30" value="${H(p.doc_number)}" placeholder="G12345678" autocomplete="off"></label>
        <label>Vigencia<input type="date" data-pf="doc_expiry" value="${H(p.doc_expiry)}"></label>
        <label>Nacionalidad<input data-pf="nationality" maxlength="40" value="${H(p.nationality)}"></label>
        <label>Parentesco o relación<input data-pf="relation" maxlength="40" value="${H(p.relation)}" placeholder="Esposa, hijo, amiga…"></label>
        <label>Celular (opcional)<input data-pf="phone" maxlength="40" value="${H(p.phone)}"></label>
        <label class="span2">Notas (alergias, asiento, necesidades especiales)<input data-pf="notes" maxlength="300" value="${H(p.notes)}"></label>
      </div>
      <div class="pax-foot">${alertsHtml(p)}<label class="pax-remember"><input type="checkbox" data-pax-remember ${skip.has(p.id) ? '' : 'checked'}> Recordar en los acompañantes del cliente</label></div>
    </div>`;
    const summaryHtml = () => {
      const named = list.filter((p) => p.name.trim());
      const s = T.tripPassengerSummary(named.map((p) => ({ ...p, type: T.paxType(p.birth_date, t.start_date, p.type) })), t, expected);
      return `<div class="pax-summary"><span><b>${s.total}</b> ${s.total === 1 ? 'pasajero' : 'pasajeros'}${s.text ? ` · ${H(s.text)}` : ''}</span>${expected ? `<span class="${s.missing ? 'warn' : 'ok'}">${s.missing ? `Faltan ${s.missing} de ${expected} viajeros del lead` : `✓ ${expected} viajeros del lead`}</span>` : ''}${s.danger ? `<span class="danger">⛔ ${s.danger} con documento vencido</span>` : ''}${s.warn ? `<span class="warn">⚠ ${s.warn} por vencer</span>` : ''}</div>`;
    };
    const compHtml = () => { const c = companions(); return c.length && editable ? `<div class="pax-comp"><small>Acompañantes frecuentes de ${H(client?.name || 'este cliente')}:</small>${c.map((x, i) => `<button type="button" class="chip-btn" data-pax-comp="${i}">+ ${H(x.name)}${x.relation ? ` · ${H(x.relation)}` : ''}</button>`).join('')}</div>` : ''; };

    function render() {
      openModal('PASAJEROS Y ACOMPAÑANTES', `${client?.name || ''} · ${t.destination} · ${fmtRange(t.start_date, t.end_date)}`, `<div class="pax">
        <p class="muted-note">El tipo (adulto, menor o infante) se calcula con la edad al día de salida. Los números de documento solo los ve tu equipo: no aparecen en el itinerario del cliente ni en la confirmación.</p>
        <div id="paxSummary">${summaryHtml()}</div>
        <div id="paxComp">${compHtml()}</div>
        <fieldset class="readonly"${editable ? '' : ' disabled'}><div id="paxList">${list.map(card).join('') || '<p class="empty-note">Aún no hay pasajeros.</p>'}</div></fieldset>
        ${editable ? '<button type="button" class="btn secondary small" id="paxAdd">+ Agregar pasajero</button>' : ''}
        <div class="modal-actions"><button type="button" class="btn secondary" data-pax-back>Volver al viaje</button>${editable ? '<button type="button" class="btn primary" id="paxSave">Guardar pasajeros</button>' : ''}</div>
      </div>`, { wide: true });
      const body = $('#modalBody');
      body.oninput = (e) => {
        const row = e.target.closest('[data-pi]');
        const f = e.target.dataset.pf;
        if (!row || !f) return;
        const p = list[Number(row.dataset.pi)];
        if (f === 'holder') { list.forEach((x) => { x.holder = false; }); p.holder = true; return; }
        p[f] = e.target.value;
        if (f === 'birth_date') { row.querySelector('[data-pax-type]').innerHTML = typeHtml(p); if (p.birth_date) p.type = T.paxType(p.birth_date, t.start_date); }
        if (['name', 'birth_date', 'doc_type', 'doc_number', 'doc_expiry'].includes(f)) { row.querySelector('.pax-alerts').outerHTML = alertsHtml(p); $('#paxSummary').innerHTML = summaryHtml(); }
      };
      body.onchange = (e) => {
        const row = e.target.closest('[data-pi]');
        if (row && e.target.matches('[data-pax-remember]')) { const id = list[Number(row.dataset.pi)].id; if (e.target.checked) skip.delete(id); else skip.add(id); return; }
        body.oninput(e);
      };
      body.onclick = (e) => {
        const del = e.target.closest('[data-pax-del]');
        const comp = e.target.closest('[data-pax-comp]');
        if (e.target.closest('[data-pax-back]')) { tripModal(t.id); return; }
        if (del) { const i = Number(del.dataset.paxDel); if (list[i].name && !confirm(`¿Quitar a ${list[i].name} de este viaje?`)) return; list.splice(i, 1); render(); return; }
        if (comp) { const c = companions()[Number(comp.dataset.paxComp)]; if (c) { list.push({ ...blank(), ...c, id: `p${Date.now().toString(36)}${list.length}`, holder: false }); render(); } return; }
        if (e.target.id === 'paxAdd') { list.push(blank()); render(); const last = $$('#paxList [data-pf="name"]').pop(); last?.focus(); return; }
        if (e.target.id === 'paxSave') save(e.target);
      };
    }
    async function save(btn) {
      const named = list.filter((p) => p.name.trim());
      if (named.length < list.length && !confirm('Hay pasajeros sin nombre; no se guardarán. ¿Continuar?')) return;
      btn.disabled = true;
      const ok = await mutate(() => send('PUT', `/api/trips/${t.id}/passengers`, { list: named, skipCompanions: [...skip] }), `Pasajeros guardados (${named.length})`);
      btn.disabled = false;
      if (ok) tripModal(t.id);
    }
    render();
  }

  // Ficha 360 › Datos del cliente: acompañantes frecuentes.
  window.paintCompanions = (c) => {
    const box = $('#c360Companions');
    if (!box) return;
    const list = c.companions?.list || [];
    const editable = canWrite('trips');
    const doc = (x) => (x.doc_type ? `${x.doc_type}${x.doc_number ? ` ···${H(x.doc_number.slice(-4))}` : ''}${x.doc_expiry ? ` · vence ${H(fmtDate(x.doc_expiry))} ${x.doc_expiry.slice(0, 4)}` : ''}` : 'Sin documento');
    box.innerHTML = `<b>👥 Acompañantes frecuentes</b><p class="muted-note">Se agregan solos al guardar los pasajeros de un viaje y se ofrecen en el siguiente.</p>${list.length ? list.map((x, i) => `<div class="comp-row"><span><b>${H(x.name)}</b>${x.relation ? ` · ${H(x.relation)}` : ''}<small>${x.birth_date ? `Nació el ${H(fmtDate(x.birth_date))} ${x.birth_date.slice(0, 4)} · ` : ''}${doc(x)}</small></span>${editable ? `<button type="button" class="link danger-link" data-comp-del="${i}">Quitar</button>` : ''}</span></div>`).join('') : '<p class="empty-note">Aún no hay acompañantes guardados.</p>'}`;
    box.onclick = async (e) => {
      const del = e.target.closest('[data-comp-del]');
      if (!del) return;
      e.stopPropagation();
      const x = list[Number(del.dataset.compDel)];
      if (!confirm(`¿Quitar a ${x.name} de los acompañantes frecuentes? No se borra de los viajes donde ya está.`)) return;
      try {
        const r = await send('PUT', `/api/clients/${c.id}/companions`, { list: list.filter((_, i) => i !== Number(del.dataset.compDel)) });
        c.companions = { list: r.companions };
        const local = clientById(c.id); if (local) local.companions = c.companions;
        window.paintCompanions(c); toast('Acompañante quitado');
      } catch (error) { toast(error.message); }
    };
  };

  /* ---------------- TP-302 · Canvas del viaje ---------------- */
  function canvasModal({ leadId, tripId }) {
    const lead = leadId ? leadById(leadId) : null;
    const trip = tripId ? tripById(tripId) : null;
    if (!lead && !trip) return;
    const clientId = (lead || trip).client_id;
    const client = clientById(clientId);
    const editable = trip ? canWrite('trips') : canWrite('leads') && canWrite('quotes');
    const quote = trip?.quote_id ? quoteById(trip.quote_id) : null;
    let cv;
    if (lead) cv = T.normalizeCanvas(lead.canvas, { destination: lead.destination, start_date: lead.start_date, end_date: lead.end_date, travelers: lead.travelers, pax: lead.travelers ? `${lead.travelers} ${lead.travelers === 1 ? 'pasajero' : 'pasajeros'}` : '' });
    else cv = trip.canvas?.blocks ? T.normalizeCanvas({ ...trip.canvas, start_date: trip.start_date, end_date: trip.end_date }, trip) : T.canvasFromTrip(trip, quote?.details);
    if (trip && !cv.travelers) cv.travelers = trip.passengers?.list?.length || expectedTravelers(trip) || '';
    if (trip && !cv.pax && trip.passengers?.list?.length) cv.pax = T.tripPassengerSummary(trip.passengers.list, trip).text;
    let selected = null;
    let dayFocus = 0;
    let dirty = false;

    const days = () => T.canvasDays(cv);
    const blockById = (id) => cv.blocks.find((b) => b.id === id);
    const fmtM = (n) => money(n);
    const blockCard = (b) => {
      const info = T.BLOCKS[b.type];
      const sub = b.type === 'vuelo' ? [b.airline, b.flight, [b.from, b.to].filter(Boolean).join('→')].filter(Boolean).join(' ') : b.type === 'hotel' ? `${b.nights} ${b.nights === 1 ? 'noche' : 'noches'}${b.plan ? ` · ${b.plan}` : ''}` : b.type === 'traslado' ? [b.from, b.to].filter(Boolean).join(' → ') : b.provider;
      return `<div class="cv-block t-${b.type}${selected === b.id ? ' sel' : ''}" data-cv-block="${b.id}" tabindex="0" role="button" aria-label="${H(info.label)}: ${H(b.title)}">
        <span class="cv-ico">${info.icon}</span><span class="cv-b-main"><b>${b.time ? `<time>${H(b.time)}</time> ` : ''}${H(b.title)}</b>${sub ? `<small>${H(sub)}</small>` : ''}</span>${b.price !== '' ? `<em>${fmtM(b.price)}</em>` : b.type !== 'nota' ? '<em class="nop">sin precio</em>' : ''}</div>`;
    };
    const ghosts = (d) => cv.blocks.filter((b) => b.type === 'hotel' && d > b.day && d < b.day + b.nights).map((b) => `<div class="cv-stay" data-cv-block="${b.id}">🏨 ${H(b.title)} · noche ${d - b.day + 1} de ${b.nights}</div>`).join('')
      + cv.blocks.filter((b) => b.type === 'hotel' && d === b.day + b.nights && d > 0).map((b) => `<div class="cv-stay out">🧳 Check-out · ${H(b.title)}</div>`).join('');
    const boardHtml = () => Array.from({ length: days() }, (_, d) => {
      const date = cv.start_date ? T.addDays(cv.start_date, d) : '';
      const list = cv.blocks.filter((b) => b.day === d);
      return `<section class="cv-day${dayFocus === d ? ' focus' : ''}" data-cv-day="${d}"><header data-cv-dayhead="${d}"><b>Día ${d + 1}</b><small>${H(dayName(date))}</small></header><div class="cv-drop">${ghosts(d)}${list.map(blockCard).join('')}<p class="cv-empty">${editable ? 'Arrastra aquí un bloque' : 'Libre'}</p></div></section>`;
    }).join('');
    const totalsHtml = () => {
      const s = T.canvasTotals(cv);
      return `<span><small>Costo</small><b>${fmtM(s.cost)}</b></span><span><small>Venta</small><b>${fmtM(s.price)}</b></span><span class="${s.profit < 0 ? 'neg' : 'pos'}"><small>Utilidad</small><b>${fmtM(s.profit)}${s.price ? ` · ${s.margin}%` : ''}</b></span>${s.perPerson ? `<span><small>Por persona</small><b>${fmtM(s.perPerson)}</b></span>` : ''}${s.missingPrice ? `<span class="warn"><small>Atención</small><b>${s.missingPrice} sin precio</b></span>` : ''}`;
    };
    const ed = (b, k, label, attrs = '', cls = '') => `<label class="${cls}">${label}<input data-cf="${k}" value="${H(b[k] ?? '')}" ${attrs}></label>`;
    const editorHtml = () => {
      const b = selected && blockById(selected);
      if (!b) return `<p class="muted-note">${editable ? 'Toca un bloque para editarlo. Arrastra los bloques de arriba a un día, o tócalos para agregarlos al día marcado (Día ' + (dayFocus + 1) + ').' : 'Toca un bloque para ver su detalle.'}</p>`;
      const info = T.BLOCKS[b.type];
      const dayOpts = Array.from({ length: days() }, (_, d) => [d, `Día ${d + 1}${cv.start_date ? ` · ${dayName(T.addDays(cv.start_date, d))}` : ''}`]);
      const extra = {
        vuelo: ed(b, 'airline', 'Aerolínea', 'maxlength="60" placeholder="Volaris"') + ed(b, 'flight', 'Vuelo', 'maxlength="20" placeholder="Y4 123"') + ed(b, 'from', 'Origen', 'maxlength="60" placeholder="CDMX"') + ed(b, 'to', 'Destino', 'maxlength="60" placeholder="CUN"') + ed(b, 'arrival', 'Llega', 'type="time"'),
        traslado: ed(b, 'from', 'Desde', 'maxlength="80" placeholder="Aeropuerto"') + ed(b, 'to', 'Hasta', 'maxlength="80" placeholder="Hotel"'),
        hotel: ed(b, 'nights', 'Noches', 'type="number" min="1" max="45"') + ed(b, 'room', 'Habitación', 'maxlength="120"') + ed(b, 'plan', 'Plan', 'maxlength="80" placeholder="Todo incluido"') + `<label>Estrellas<select data-cf="stars">${options(['5', '4', '3'], b.stars)}</select></label>`,
        tour: ed(b, 'place', 'Lugar (para el mapa)', 'maxlength="120"'),
        seguro: '', nota: ''
      }[b.type];
      return `<div class="cv-editor-in"><div class="cv-ed-head"><b>${info.icon} ${H(info.label)}</b>${editable ? '<span><button type="button" class="btn secondary small" data-cv-dup>Duplicar</button><button type="button" class="btn ghost-danger small" data-cv-del>Eliminar</button></span>' : ''}</div>
        <fieldset class="readonly"${editable ? '' : ' disabled'}><div class="cv-ed-grid">
        ${ed(b, 'title', b.type === 'hotel' ? 'Hotel' : b.type === 'nota' ? 'Nota' : 'Nombre', 'maxlength="120"', 'span2')}
        <label>Día<select data-cf="day">${options(dayOpts, b.day)}</select></label>
        ${ed(b, 'time', b.type === 'hotel' ? 'Check-in' : b.type === 'vuelo' ? 'Sale' : 'Hora', 'type="time"')}
        ${extra}
        ${b.type === 'nota' ? '' : ed(b, 'provider', `Proveedor u operador${b.supplier_id && typeof supplierCommission === 'function' ? supplierCommission(b.supplier_id) : ''}`, 'maxlength="120" list="tpSupList" placeholder="Elige del catálogo de proveedores"', 'span2')}
        ${b.type === 'nota' ? '' : ed(b, 'cost', 'Costo neto (MXN)', 'inputmode="decimal" maxlength="14"') + ed(b, 'price', 'Precio de venta (MXN)', 'inputmode="decimal" maxlength="14"')}
        <label class="full">${b.type === 'vuelo' ? 'Equipaje y notas' : 'Notas'}<textarea data-cf="notes" rows="2" maxlength="600">${H(b.notes)}</textarea></label>
        </div></fieldset></div>`;
    };
    const quoteLinked = () => (cv.quote_id ? quoteById(cv.quote_id) : null);
    const actionsHtml = () => {
      if (!editable) return '<button type="button" class="btn secondary close">Cerrar</button>';
      const closeBtn = '<button type="button" class="btn secondary" data-cv-close>Cerrar</button>';
      if (lead) {
        const q = quoteLinked();
        return `${closeBtn}<button type="button" class="btn secondary" data-cv-save>Guardar lienzo</button>${q && q.status === 'Borrador' ? `<button type="button" class="btn secondary" data-cv-quote="update">↻ Actualizar ${H(q.folio)}</button>` : ''}<button type="button" class="btn coral-btn" data-cv-quote="new">📄 ${q ? 'Crear otra cotización' : 'Crear cotización'}</button>`;
      }
      return `${closeBtn}<button type="button" class="btn secondary" data-cv-save>Guardar lienzo</button><button type="button" class="btn primary" data-cv-apply>Aplicar al itinerario y confirmación</button>`;
    };
    const headHtml = () => `<div class="cv-head">
        <label>Destino<input data-cv-meta="destination" maxlength="120" value="${H(cv.destination)}"${trip ? ' readonly' : ''}></label>
        <label>Salida<input type="date" data-cv-meta="start_date" value="${H(cv.start_date)}"${trip ? ' readonly' : ''}></label>
        <label>Regreso<input type="date" data-cv-meta="end_date" value="${H(cv.end_date)}"${trip ? ' readonly' : ''}></label>
        <label>Viajeros<input type="number" min="1" max="500" data-cv-meta="travelers" value="${H(cv.travelers)}"></label>
        <label class="grow">Pasajeros (texto para la cotización)<input data-cv-meta="pax" maxlength="80" value="${H(cv.pax)}" placeholder="2 adultos + 1 menor"></label>
      </div>`;

    function paintBoard() { $('#cvBoard').innerHTML = boardHtml(); $('#cvTotals').innerHTML = totalsHtml(); }
    function paintEditor() { $('#cvEditor').innerHTML = editorHtml(); }
    function paintActions() { $('#cvActions').innerHTML = actionsHtml(); }
    function changed() { dirty = true; T.sortBlocks(cv); paintBoard(); }

    openModal('CANVAS DEL VIAJE', `${client?.name || ''} · ${cv.destination || (lead || trip).destination}`, `<div class="cv">
      ${trip ? '<p class="muted-note">Fechas y destino del viaje. Al aplicar, el lienzo arma el día por día del itinerario digital y llena vuelos, hotel, traslados, actividades y seguro de la confirmación.</p>' : '<p class="muted-note">Arma el viaje por días y conviértelo en cotización. Cuando se venda, este lienzo pasa al viaje y llena el itinerario digital.</p>'}
      ${headHtml()}
      ${editable ? `<div class="cv-palette" aria-label="Bloques">${T.BLOCK_TYPES.map((k) => `<button type="button" class="cv-new t-${k}" data-cv-new="${k}">${T.BLOCKS[k].icon} ${H(T.BLOCKS[k].label)}</button>`).join('')}<small>Arrastra a un día o toca para agregar al día marcado</small></div>` : ''}
      <div class="cv-board" id="cvBoard"></div>
      <div class="cv-totals" id="cvTotals"></div>
      <div class="cv-editor" id="cvEditor"></div>
      <div class="modal-actions" id="cvActions"></div>
    </div>`, { wide: true, xwide: true });
    if (!cv.start_date || !cv.end_date) toast('Pon las fechas de salida y regreso para ver los días.', 5000);
    paintBoard(); paintEditor(); paintActions();

    const body = $('#modalBody');
    const addBlock = (type, day, index) => {
      const b = T.cleanBlock({ type, day, title: type === 'hotel' ? '' : T.BLOCKS[type].label, nights: type === 'hotel' ? Math.max(days() - 1 - day, 1) : undefined }, days() - 1);
      const list = cv.blocks.filter((x) => x.day === day);
      b.order = index == null ? list.length : index - 0.5;
      cv.blocks.push(b);
      selected = b.id; dayFocus = day;
      changed(); paintEditor();
      const first = $('#cvEditor [data-cf="title"]'); if (first) { first.focus(); first.select(); }
    };
    body.oninput = (e) => {
      const el = e.target;
      if (el.dataset.cvMeta) {
        const k = el.dataset.cvMeta;
        cv[k] = k === 'travelers' ? (parseInt(el.value, 10) || '') : el.value;
        if (k === 'start_date' || k === 'end_date') { if (!el.value) return; const keep = cv.blocks; Object.assign(cv, T.normalizeCanvas(cv)); if (keep.length !== cv.blocks.length) toast('Algunos bloques no eran válidos'); dayFocus = Math.min(dayFocus, days() - 1); }
        dirty = true; paintBoard(); return;
      }
      const f = el.dataset.cf;
      const b = f && blockById(selected);
      if (!b) return;
      if (f === 'day') { b.day = Number(el.value); b.order = 999; dayFocus = b.day; }
      else if (f === 'nights') b.nights = Math.min(Math.max(parseInt(el.value, 10) || 1, 1), 45);
      else if (f === 'cost' || f === 'price') b[f] = el.value.trim() === '' ? '' : Math.max(Number(el.value.replace(/[^0-9.]/g, '')) || 0, 0);
      else b[f] = el.value;
      // TP-305: proveedor del catálogo y costo neto con su comisión.
      if (f === 'provider' && typeof matchSupplier === 'function') { const sup = matchSupplier(b.provider); b.supplier_id = sup ? sup.id : null; }
      if ((f === 'provider' || f === 'price') && b.cost === '' && b.supplier_id) {
        const sup = (db.suppliers || []).find((x) => x.id === b.supplier_id);
        const net = T.netFromCommission(b.price, sup?.commission);
        if (net !== '') { b.cost = net; const c = $('#cvEditor [data-cf="cost"]'); if (c) c.value = net; }
      }
      changed();
    };
    body.onchange = (e) => { if (e.target.dataset.cf === 'day' || e.target.dataset.cf === 'stars') body.oninput(e); };
    body.onclick = async (e) => {
      const t = e.target;
      if (t.closest('[data-cv-dayhead]')) { dayFocus = Number(t.closest('[data-cv-dayhead]').dataset.cvDayhead); paintBoard(); paintEditor(); return; }
      if (t.closest('[data-cv-dup]')) { const b = blockById(selected); if (b) { const c = { ...clone(b), id: T.newBlockId(), order: b.order + 0.5 }; cv.blocks.push(c); selected = c.id; changed(); paintEditor(); } return; }
      if (t.closest('[data-cv-del]')) { cv.blocks = cv.blocks.filter((b) => b.id !== selected); selected = null; changed(); paintEditor(); return; }
      if (t.closest('[data-cv-close]')) { if (dirty && !confirm('Tienes cambios sin guardar en el lienzo. ¿Cerrar de todos modos?')) return; cleanup(); close(); return; }
      if (t.closest('[data-cv-save]')) { await save(t.closest('button')); return; }
      if (t.closest('[data-cv-quote]')) { await toQuote(t.closest('[data-cv-quote]').dataset.cvQuote, t.closest('button')); return; }
      if (t.closest('[data-cv-apply]')) { await apply(t.closest('button')); }
    };
    body.onkeydown = (e) => { const el = e.target.closest('[data-cv-block]'); if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selected = el.dataset.cvBlock; dayFocus = blockById(selected)?.day ?? dayFocus; paintBoard(); paintEditor(); } };

    // Arrastrar con mouse o con el dedo (pointer events): bloques nuevos de la paleta o bloques del lienzo.
    let drag = null;
    body.onpointerdown = (e) => {
      if (!editable || e.button > 0) return;
      const src = e.target.closest('[data-cv-new],[data-cv-block]');
      if (!src || e.target.closest('input,select,textarea')) return;
      drag = { src, x: e.clientX, y: e.clientY, active: false, type: src.dataset.cvNew, id: src.dataset.cvBlock, pointerId: e.pointerId };
    };
    const dropTarget = (x, y, skipId) => {
      const under = document.elementFromPoint(x, y);
      const col = under?.closest('[data-cv-day]');
      if (!col) return null;
      const cards = [...col.querySelectorAll('.cv-block')].filter((c) => c.dataset.cvBlock !== skipId);
      let index = cards.length;
      for (let i = 0; i < cards.length; i += 1) { const r = cards[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { index = i; break; } }
      return { day: Number(col.dataset.cvDay), index, col, cards };
    };
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
        drag.active = true;
        drag.ghost = drag.src.cloneNode(true);
        drag.ghost.classList.add('cv-ghost');
        document.body.appendChild(drag.ghost);
        drag.src.classList.add('cv-dragging');
        document.body.classList.add('cv-noselect');
      }
      e.preventDefault();
      drag.ghost.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`;
      $$('.cv-day.over').forEach((c) => c.classList.remove('over'));
      $$('.cv-line').forEach((c) => c.remove());
      const target = dropTarget(e.clientX, e.clientY, drag.id);
      if (target) {
        target.col.classList.add('over');
        const line = document.createElement('div'); line.className = 'cv-line';
        const ref = target.cards[target.index];
        if (ref) ref.before(line); else target.col.querySelector('.cv-drop').insertBefore(line, target.col.querySelector('.cv-empty'));
      }
      const board = $('#cvBoard');
      if (board) { const r = board.getBoundingClientRect(); if (e.clientX > r.right - 40) board.scrollLeft += 14; else if (e.clientX < r.left + 40) board.scrollLeft -= 14; }
    };
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const d = drag; drag = null;
      document.body.classList.remove('cv-noselect');
      if (!d.active) {
        if (d.type) addBlock(d.type, dayFocus);
        else if (d.id) { selected = d.id; dayFocus = blockById(d.id)?.day ?? dayFocus; paintBoard(); paintEditor(); }
        return;
      }
      d.ghost.remove(); d.src.classList.remove('cv-dragging');
      const target = dropTarget(e.clientX, e.clientY, d.id);
      $$('.cv-line').forEach((c) => c.remove());
      if (!target) { paintBoard(); return; }
      if (d.type) { addBlock(d.type, target.day, target.index); return; }
      const b = blockById(d.id);
      if (!b) return;
      const others = cv.blocks.filter((x) => x.day === target.day && x.id !== b.id).sort((a, c) => a.order - c.order);
      others.forEach((x, i) => { x.order = i < target.index ? i : i + 1; });
      b.day = target.day; b.order = target.index; selected = b.id; dayFocus = b.day;
      changed(); paintEditor();
    };
    const cleanup = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('pointercancel', onUp); };
    if (window._cvCleanup) window._cvCleanup();
    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window._cvCleanup = cleanup;

    const payload = () => ({ ...cv, updated_at: nowLocalStr() });
    async function save(btn, quiet) {
      if (btn) btn.disabled = true;
      const url = lead ? `/api/leads/${lead.id}` : `/api/trips/${trip.id}`;
      const ok = await mutate(() => send('PATCH', url, { canvas: payload() }), quiet ? '' : 'Lienzo guardado');
      if (btn) btn.disabled = false;
      if (ok) dirty = false;
      return ok;
    }
    async function toQuote(mode, btn) {
      const q = T.canvasToQuote(cv, { destination: lead.destination });
      if (!cv.blocks.length) { toast('Agrega al menos un bloque al lienzo'); return; }
      if (!q.price && !confirm('Ningún bloque tiene precio de venta: la cotización quedará en $0. ¿Continuar?')) return;
      btn.disabled = true;
      const fields = { destination: q.destination, hotel: q.hotel, price: q.price, services: q.services, details: q.details };
      try {
        let record;
        if (mode === 'update') record = (await send('PATCH', `/api/quotes/${cv.quote_id}`, fields)).record;
        else record = (await send('POST', '/api/quotes', { client_id: lead.client_id, lead_id: lead.id, status: 'Borrador', ...fields })).record;
        cv.quote_id = record.id;
        await send('PATCH', `/api/leads/${lead.id}`, { canvas: payload() });
        await loadAll();
        dirty = false;
        toast(mode === 'update' ? `Cotización ${record.folio} actualizada` : `Cotización ${record.folio} creada en borrador`);
        if (confirm(`Cotización ${record.folio} lista. ¿Abrirla en el cotizador para revisar fotos, vigencia y pagos?`)) { cleanup(); quoteModal(record.id); } else paintActions();
      } catch (error) { toast(error.message, 6000); }
      btn.disabled = false;
    }
    async function apply(btn) {
      if (!cv.blocks.length) { toast('Agrega al menos un bloque al lienzo'); return; }
      if (trip.itinerary?.days?.length && !confirm('Se reemplaza el día por día del itinerario digital y se actualizan vuelos, hotel, traslados, actividades y seguro de la confirmación. ¿Continuar?')) return;
      btn.disabled = true;
      try {
        const doc = await api(`/api/documents/trip/${trip.id}`);
        const base = TPDocs.mergeConfirmation(doc.trip.confirmation, TPDocs.confirmationDefaults(doc));
        const over = T.canvasToConfirmation(cv, trip);
        const confirmation = { ...base, ...over, services: { ...base.services, ...over.services } };
        delete confirmation._pax;
        const itDays = T.canvasToItinerary(cv, trip);
        const ok = await mutate(() => send('PATCH', `/api/trips/${trip.id}`, { canvas: payload(), itinerary: { days: itDays, updated_at: nowLocalStr(), source: 'canvas' }, confirmation }), 'Itinerario y confirmación actualizados con el lienzo');
        if (ok) { dirty = false; if (confirm('Listo. ¿Ver el itinerario digital?')) { cleanup(); itineraryModal(trip.id); } }
      } catch (error) { toast(error.message, 6000); }
      btn.disabled = false;
    }
  }

  window.passengersModal = passengersModal;
  window.canvasModal = canvasModal;

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-pax-trip],[data-cv-lead],[data-cv-trip]');
    if (!el) return;
    if (el.dataset.paxTrip) passengersModal(Number(el.dataset.paxTrip));
    else if (el.dataset.cvLead) canvasModal({ leadId: Number(el.dataset.cvLead) });
    else if (el.dataset.cvTrip) canvasModal({ tripId: Number(el.dataset.cvTrip) });
  });
}());
