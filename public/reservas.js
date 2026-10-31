'use strict';

/* =========================================================
   TP-304 Reservas centralizadas · TP-305 Catálogo de proveedores
   Usa las utilidades de app.js y las reglas de viaje-core.js.
   ========================================================= */
(function () {
  const T = window.TPTrip;
  const H = escapeHtml;
  const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
  const canEditSup = () => ['admin', 'operaciones'].includes(currentUser?.role);
  const supById = (id) => (db.suppliers || []).find((s) => s.id === Number(id));
  const ALERT_ICON = { danger: '⛔', warn: '⚠', info: 'ⓘ' };
  const STATUS_CLASS = { 'Por reservar': 'bk-todo', Solicitada: 'bk-req', Confirmada: 'bk-ok', Cancelada: 'bk-off' };
  const waUrl = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length === 10 ? `52${d}` : d}` : ''; };
  const contactLinks = (s) => [
    s.whatsapp || s.phone ? `<a class="link" href="${H(waUrl(s.whatsapp || s.phone))}" target="_blank" rel="noopener">💬 WhatsApp</a>` : '',
    s.phone ? `<a class="link" href="tel:${H(String(s.phone).replace(/[^\d+]/g, ''))}">📞 ${H(s.phone)}</a>` : '',
    s.email ? `<a class="link" href="mailto:${H(s.email)}">✉️ ${H(s.email)}</a>` : '',
    s.website ? `<a class="link" href="${H(s.website)}" target="_blank" rel="noopener">🌐 Sitio</a>` : ''
  ].filter((x) => x && !x.includes('href=""')).join('');

  // Lista de nombres para elegir proveedor al cotizar y reservar.
  function paintDatalist() {
    let dl = $('#tpSupList');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'tpSupList'; document.body.appendChild(dl); }
    dl.innerHTML = (db.suppliers || []).filter((s) => s.active !== false).map((s) => `<option value="${H(s.name)}">${H(s.type)}${s.commission !== '' && s.commission != null ? ` · ${s.commission}% comisión` : ''}</option>`).join('');
  }
  window.supplierCommission = (id) => { const s = supById(id); return s ? ` <small class="muted">· ${H(s.type)}${s.commission !== '' && s.commission != null ? ` · ${s.commission}% comisión` : ''}</small>` : ''; };
  window.matchSupplier = (name) => T.findSupplierByName((db.suppliers || []).filter((s) => s.active !== false), name);

  /* ---------------- TP-009 · Portal del proveedor (desde la reserva) ---------------- */
  const PV = window.TPProv;
  const PT_CLASS = { Solicitada: 'bk-req', Cotizada: 'pt-quoted', Aceptada: 'bk-req', Confirmada: 'bk-ok', Rechazada: 'bk-off', 'No disponible': 'bk-off', Cancelada: 'bk-off' };
  let moduleOn = true; // Módulo de proveedor activo (Configuración › Integraciones)
  let portalLinks = null; // { [supplierId]: [{ id, name, active }] }
  async function loadPortalLinks(force) {
    if (portalLinks && !force) return portalLinks;
    try { const r = await api('/api/supplier-portal/links'); portalLinks = r.suppliers || {}; moduleOn = r.enabled !== false; } catch { portalLinks = portalLinks || {}; }
    return portalLinks;
  }
  window.loadPortalLinks = loadPortalLinks;
  const hasPortal = (sid) => Boolean(sid && (portalLinks?.[sid] || []).some((u) => u.active));
  function portalHtml(b, saved, editable) {
    const p = b.portal;
    const sup = b.supplier_id ? supById(b.supplier_id) : null;
    if (!p) {
      if (!sup || b.status === 'Cancelada' || !moduleOn) return '';
      if (!hasPortal(sup.id)) return sup.type === 'Traslados' ? `<div class="pt-box muted">🚐 ${H(sup.name)} aún no tiene acceso al portal del proveedor${isAdmin() ? ' · créalo en Configuración › Usuarios (rol Proveedor)' : ''}.</div>` : '';
      return `<div class="pt-box"><span>🚐 <b>Portal del proveedor</b> · ${H(sup.name)} puede cotizar y confirmar en línea.</span>${editable ? (saved ? '<button type="button" class="btn primary small" data-pt-request>📨 Pedir precio al proveedor</button>' : '<small class="muted">Guarda las reservas para poder enviarle la solicitud.</small>') : ''}</div>`;
    }
    const d = p.details || {};
    const q = p.quote;
    const actions = !editable ? '' : [
      p.state === 'Cotizada' ? '<button type="button" class="btn primary small" data-pt-accept>✓ Aceptar precio</button><button type="button" class="btn secondary small" data-pt-reject>Rechazar</button>' : '',
      p.state === 'Solicitada' ? '<button type="button" class="btn secondary small" data-pt-request>Editar solicitud</button>' : '',
      PV.CLOSED.includes(p.state) && b.status !== 'Cancelada' ? '<button type="button" class="btn secondary small" data-pt-request>📨 Volver a pedir precio</button>' : '',
      !PV.CLOSED.includes(p.state) ? '<button type="button" class="link danger-link" data-pt-cancel>Cancelar solicitud</button>' : ''
    ].join('');
    return `<div class="pt-box ${PT_CLASS[p.state] || ''}">
      <div class="pt-row"><span class="bk-pill ${PT_CLASS[p.state] || ''}">🚐 ${H(PV.TEAM_LABELS[p.state] || p.state)}</span><b>${H(p.folio || '')}</b><small class="muted">${H(d.kind || '')} · ${H(d.service_date ? fmtDate(d.service_date) : '')}${d.pickup_time ? ` ${H(d.pickup_time)}` : ''} · ${H(PV.paxText(d))}</small></div>
      ${q ? `<div class="pt-row">Precio del proveedor: <b>${money(q.amount)}</b>${q.notes ? ` · <span class="muted">${H(q.notes)}</span>` : ''}${b.price !== '' && b.price != null ? ` · <small class="muted">venta ${money(b.price)} → utilidad ${money(Number(b.price) - Number(q.amount))}</small>` : ''}</div>` : ''}
      ${p.decision_note ? `<div class="pt-row muted">Nota: ${H(p.decision_note)}</div>` : ''}
      ${p.driver && (p.driver.name || p.driver.unit) ? `<div class="pt-row">Chofer: <b>${H(p.driver.name || '—')}</b>${p.driver.phone ? ` · ${H(p.driver.phone)}` : ''}${p.driver.unit ? ` · ${H(p.driver.unit)}` : ''}${p.driver.notes ? ` · <span class="muted">${H(p.driver.notes)}</span>` : ''}</div>` : ''}
      ${actions ? `<div class="pt-row pt-actions">${actions}</div>` : ''}
      ${(p.log || []).length ? `<details class="pt-log"><summary>Historial (${p.log.length})</summary>${p.log.slice().reverse().map((l) => `<div><small>${H(fmtStamp(l.at))} · ${H(l.who)}</small> ${H(l.text)}</div>`).join('')}</details>` : ''}
    </div>`;
  }
  // Formulario con los datos operativos que verá el proveedor (se llena con lo que ya sabe el viaje).
  function portalRequestModal(t, b) {
    const pax = t.passengers?.list || [];
    const holder = pax.find((x) => x.holder) || pax[0];
    const client = clientById(t.client_id);
    const lead = db.leads.find((l) => l.client_id === t.client_id && l.destination === t.destination) || db.leads.find((l) => l.client_id === t.client_id);
    const hotel = (t.bookings?.list || []).find((x) => x.type === 'Hotel' && x.status !== 'Cancelada');
    const flight = (t.bookings?.list || []).find((x) => x.type === 'Vuelo' && x.status !== 'Cancelada');
    const d = b.portal?.details || {
      kind: PV.SERVICE_KINDS[0], passenger: holder?.name || client?.name || '', phone: holder?.phone || client?.phone || '',
      adults: pax.length ? pax.filter((x) => x.type === 'Adulto').length : Number(lead?.travelers) || 2, minors: pax.filter((x) => x.type !== 'Adulto').length,
      service_date: b.start_date || t.start_date, pickup_time: b.time || '', pickup_place: 'Aeropuerto de Cancún (CUN)', dropoff_place: hotel ? (hotel.supplier_name || hotel.description) : '',
      flight: flight ? [flight.description, flight.time].filter(Boolean).join(' · ') : '', return_date: '', return_time: '', return_flight: '', vehicle: '', notes: b.description || ''
    };
    const html = `<form class="modal-form">
      <p class="full muted-note">${H(b.supplier_name)} verá <b>solo</b> estos datos para cotizar y operar el servicio. Nunca ve tu precio de venta, comisiones ni el correo del cliente.</p>
      ${field('Tipo de servicio', `<select name="kind">${options(PV.SERVICE_KINDS, d.kind)}</select>`)}
      ${field('Unidad o preferencia', `<input name="vehicle" maxlength="80" value="${H(d.vehicle)}" placeholder="Privado · Van · Suburban">`)}
      ${field('Pasajero titular*', `<input name="passenger" required maxlength="120" value="${H(d.passenger)}">`)}
      ${field('WhatsApp del pasajero', `<input name="phone" maxlength="40" value="${H(d.phone)}" placeholder="Para el chofer el día del servicio">`)}
      ${field('Adultos', `<input name="adults" type="number" min="0" max="60" value="${H(d.adults)}">`)}
      ${field('Menores', `<input name="minors" type="number" min="0" max="60" value="${H(d.minors)}">`)}
      ${field('Fecha del servicio*', `<input name="service_date" type="date" required value="${H(d.service_date)}">`)}
      ${field('Hora de recogida / llegada del vuelo', `<input name="pickup_time" type="time" value="${H(d.pickup_time)}">`)}
      ${field('Recoger en*', `<input name="pickup_place" required maxlength="160" value="${H(d.pickup_place)}">`)}
      ${field('Llevar a*', `<input name="dropoff_place" required maxlength="160" value="${H(d.dropoff_place)}">`)}
      ${field('Vuelo de llegada', `<input name="flight" maxlength="80" value="${H(d.flight)}" placeholder="Y4 123 · llega 13:40">`, true)}
      ${field('Regreso: fecha', `<input name="return_date" type="date" value="${H(d.return_date)}">`)}
      ${field('Regreso: hora de recogida', `<input name="return_time" type="time" value="${H(d.return_time)}">`)}
      ${field('Vuelo de regreso', `<input name="return_flight" maxlength="80" value="${H(d.return_flight)}">`, true)}
      ${field('Indicaciones para el proveedor', `<textarea name="notes" rows="3" maxlength="800" placeholder="Silla para bebé, equipaje extra, letrero con nombre…">${H(d.notes)}</textarea>`, true)}
      <div class="modal-actions"><button type="button" class="btn secondary" data-pt-back>Volver a reservas</button><button type="submit" class="btn primary">${b.portal?.state === 'Solicitada' ? 'Actualizar solicitud' : 'Enviar solicitud de precio'}</button></div></form>`;
    openModal('PORTAL DEL PROVEEDOR', `${b.portal?.folio ? `${b.portal.folio} · ` : ''}Solicitud a ${b.supplier_name}`, html);
    $('#modalBody [data-pt-back]').onclick = () => bookingsModal(t.id);
    bindForm(async (v) => {
      const ok = await mutate(() => send('POST', `/api/trips/${t.id}/bookings/${b.id}/portal/request`, { details: { ...v, adults: Number(v.adults) || 0, minors: Number(v.minors) || 0 } }), `Solicitud enviada a ${b.supplier_name}`);
      if (ok) bookingsModal(t.id);
      return false;
    });
  }

  /* ---------------- TP-304 · Reservas del viaje ---------------- */
  const allBookings = () => db.trips.flatMap((t) => (t.bookings?.list || []).map((b) => ({ b, t })));
  window.tripBookingBadge = (t) => {
    const list = t.bookings?.list || [];
    if (!list.length) return '';
    const s = T.bookingsSummary(list, t, todayStr());
    return `<span class="tp-badges"><span class="tp-badge${s.pending ? ' warn' : ''}">🧾 ${s.confirmed}/${s.total} confirmadas</span>${s.danger ? `<span class="tp-badge danger">⛔ ${s.danger} urgente${s.danger > 1 ? 's' : ''}</span>` : ''}</span>`;
  };
  window.tripBookingLabel = (t) => { const n = (t.bookings?.list || []).filter((b) => b.status !== 'Cancelada').length; return `🧾 Reservas${n ? ` (${n})` : ''}`; };

  function bookingsModal(tripId) {
    const t = tripById(tripId);
    if (!t) return;
    const editable = canWrite('trips');
    const client = clientById(t.client_id);
    let list = clone(t.bookings?.list || []);
    let vouchers = clone(t.vouchers || []);
    const today = todayStr();
    const blank = () => ({ id: `r${Date.now().toString(36)}${list.length}`, type: 'Hotel', status: 'Por reservar', supplier_id: null, supplier_name: '', confirmation: '', description: '', start_date: t.start_date, end_date: t.end_date, time: '', cost: '', price: '', supplier_due: '', supplier_paid: false, voucher_ids: [], source: '', notes: '', model: 'neta', commission_pct: '', commission_amount: '', commission_due: '', commission_status: 'Pendiente', commission_invoice: '', commission_paid_at: '' });
    const finance = canEditSup();
    // TP-205: datos de la comisión del proveedor.
    const commHtml = (b) => (b.model === 'comision' ? `<div class="pax-grid bk-comm">
        <label>% comisión<input data-bf="commission_pct" inputmode="decimal" maxlength="6" value="${H(b.commission_pct)}" placeholder="10"></label>
        <label>Comisión esperada (MXN)<input data-bf="commission_amount" inputmode="decimal" maxlength="14" value="${H(b.commission_amount)}" placeholder="${b.price !== '' && b.commission_pct !== '' ? H(Math.round(Number(b.price) * Number(b.commission_pct)) / 100) : ''}"></label>
        <label>Cobrar comisión el<input type="date" data-bf="commission_due" value="${H(b.commission_due)}"></label>
        <label>Estado del cobro${finance ? `<select data-bf="commission_status">${options(T.COMMISSION_STATUSES, b.commission_status)}</select>` : `<input value="${H(b.commission_status)}" disabled>`}</label>
        ${finance ? `<label>Factura / referencia<input data-bf="commission_invoice" maxlength="60" value="${H(b.commission_invoice)}"></label>` : ''}
        ${b.commission_status === 'Cobrada' ? `<label>Cobrada el<input type="date" data-bf="commission_paid_at" value="${H(b.commission_paid_at)}"${finance ? '' : ' disabled'}></label>` : ''}
      </div>` : '');
    const commDefault = (b) => { if (b.model !== 'comision' || b.commission_due) return; b.commission_due = T.commissionDueDefault(b, t, b.supplier_id ? supById(b.supplier_id) : null); };

    const alertsHtml = (b) => { const a = T.bookingAlerts(b, t, today); return `<div class="pax-alerts">${a.length ? a.map((x) => `<span class="pax-alert ${x.level}">${ALERT_ICON[x.level]} ${H(x.text)}</span>`).join('') : b.status === 'Cancelada' ? '<span class="pax-alert">Cancelada</span>' : '<span class="pax-alert ok">✓ En orden</span>'}</div>`; };
    const supInfo = (b) => { const s = b.supplier_id ? supById(b.supplier_id) : null; return s ? `<div class="bk-sup">${s.contact_name ? `<b>${H(s.contact_name)}</b>` : ''}${contactLinks(s)}${s.commission !== '' && s.commission != null ? `<span class="muted">Comisión ${s.commission}%</span>` : ''}${s.payment_terms ? `<span class="muted">${H(s.payment_terms)}</span>` : ''}</div>` : (b.supplier_name ? '<div class="bk-sup muted">No está en el catálogo de proveedores</div>' : ''); };
    const docsHtml = (b) => `<div class="bk-docs">${b.voucher_ids.map((id) => { const v = vouchers.find((x) => Number(x.id) === id); return v ? `<span class="chip-btn">${v.mime === 'application/pdf' ? '📄' : '🖼'} <a class="link" href="/api/media/${v.id}" target="_blank" rel="noopener">${H(v.name)}</a>${editable ? ` <button type="button" class="link danger-link" data-bk-unlink="${id}">✕</button>` : ''}</span>` : ''; }).join('')}${editable ? `<label class="btn secondary small">📎 Adjuntar<input type="file" data-bk-file accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label>${vouchers.filter((v) => !b.voucher_ids.includes(Number(v.id))).length ? `<select data-bk-link><option value="">Ligar documento del viaje…</option>${vouchers.filter((v) => !b.voucher_ids.includes(Number(v.id))).map((v) => `<option value="${v.id}">${H(v.name)}</option>`).join('')}</select>` : ''}` : ''}</div>`;
    const card = (b, i) => `<div class="pax-card bk-card ${STATUS_CLASS[b.status] || ''}" data-bi="${i}">
      <div class="pax-head"><b>${T.BOOKING_ICONS[b.type]} ${H(b.type)}${b.supplier_name ? ` · ${H(b.supplier_name)}` : ''}</b><select data-bf="status" class="bk-status">${options(T.BOOKING_STATUSES, b.status)}</select>${editable ? `<button type="button" class="link danger-link" data-bk-del="${i}">Quitar</button>` : ''}</div>
      <div class="pax-grid">
        <label>Servicio<select data-bf="type">${options(T.BOOKING_TYPES, b.type)}</select></label>
        <label>Proveedor<input data-bf="supplier_name" list="tpSupList" maxlength="120" value="${H(b.supplier_name)}" placeholder="Elige del catálogo o escribe"></label>
        <label>Número de confirmación<input data-bf="confirmation" maxlength="60" value="${H(b.confirmation)}" placeholder="ABC123"></label>
        <label>Hora<input type="time" data-bf="time" value="${H(b.time)}"></label>
        <label class="span2">Descripción<input data-bf="description" maxlength="300" value="${H(b.description)}" placeholder="Junior Suite · Todo incluido · 2 adultos"></label>
        <label>${b.type === 'Hotel' ? 'Check-in' : 'Fecha'}<input type="date" data-bf="start_date" value="${H(b.start_date)}"></label>
        <label>${b.type === 'Hotel' ? 'Check-out' : 'Hasta'}<input type="date" data-bf="end_date" value="${H(b.end_date)}"></label>
        <label>Cómo ganas<select data-bf="model">${options(T.PROFIT_MODELS.map((m) => [m, T.PROFIT_MODEL_LABELS[m]]), b.model || 'neta')}</select></label>
        <label>Precio de venta (MXN)<input data-bf="price" inputmode="decimal" maxlength="14" value="${H(b.price)}"></label>
        <label>${b.model === 'comision' ? 'Pago al proveedor (MXN)' : 'Costo neto (MXN)'}<input data-bf="cost" inputmode="decimal" maxlength="14" value="${H(b.cost)}"${b.model === 'comision' ? ' placeholder="Si tú le pagas"' : ''}></label>
        <label>Pagar al proveedor antes de<input type="date" data-bf="supplier_due" value="${H(b.supplier_due)}"></label>
        <label class="bk-paid"><span>Pago al proveedor</span><span><input type="checkbox" data-bf="supplier_paid" ${b.supplier_paid ? 'checked' : ''}> Pagado</span></label>
        <label class="full">Notas internas<input data-bf="notes" maxlength="1000" value="${H(b.notes)}"></label>
      </div>
      <div data-bk-comm>${commHtml(b)}</div>
      <div data-bk-sup>${supInfo(b)}</div>
      <div data-bk-portal>${portalHtml(b, isSaved(b), editable)}</div>
      ${docsHtml(b)}
      <div class="pax-foot">${alertsHtml(b)}</div>
    </div>`;
    const summaryHtml = () => {
      const s = T.bookingsSummary(list, t, today);
      return `<div class="pax-summary"><span><b>${s.total}</b> ${s.total === 1 ? 'reserva' : 'reservas'} · ${s.confirmed} confirmada${s.confirmed === 1 ? '' : 's'}</span>${s.pending ? `<span class="warn">${s.pending} por confirmar</span>` : s.total ? '<span class="ok">✓ Todo confirmado</span>' : ''}${s.danger ? `<span class="danger">⛔ ${s.danger} urgente${s.danger > 1 ? 's' : ''}</span>` : ''}<span>Venta ${money(s.price)} · Utilidad ${s.profit == null ? '—' : money(s.profit)}${s.profitMissing ? ` <small>(${s.profitMissing} sin costo o comisión)</small>` : ''}</span>${s.toCollect ? `<span class="ok">Comisiones por cobrar ${money(s.toCollect)}</span>` : ''}${s.owed ? `<span class="warn">Por pagar a proveedores ${money(s.owed)}</span>` : ''}</div>`;
    };
    const canGenerate = () => t.canvas?.blocks?.length || t.confirmation;
    // TP-009: la solicitud al proveedor sale de la reserva ya guardada (sin cambios pendientes).
    const savedList = t.bookings?.list || [];
    const isSaved = (b) => { const s = savedList.find((x) => x.id === b.id); return Boolean(s) && JSON.stringify(s) === JSON.stringify(b); };
    const dirty = () => JSON.stringify(list) !== JSON.stringify(savedList);
    if (!portalLinks) loadPortalLinks().then(() => { if ($('#bkList')) $$('#bkList [data-bi]').forEach((row) => { const b = list[Number(row.dataset.bi)]; row.querySelector('[data-bk-portal]').innerHTML = portalHtml(b, isSaved(b), editable); }); });

    function render() {
      paintDatalist();
      openModal('RESERVAS DEL VIAJE', `${client?.name || ''} · ${t.destination} · ${fmtRange(t.start_date, t.end_date)}`, `<div class="pax">
        <p class="muted-note">Un renglón por servicio reservado con el proveedor. Los costos y pagos al proveedor solo los ve tu equipo; el cliente ve en su itinerario la clave de las reservas <b>confirmadas</b>. Los documentos adjuntos también quedan en el itinerario del cliente.</p>
        <div id="bkSummary">${summaryHtml()}</div>
        ${editable && canGenerate() ? `<div class="pax-comp"><button type="button" class="btn secondary small" id="bkGen">✨ Crear reservas desde ${t.canvas?.blocks?.length ? 'el Canvas' : 'la confirmación'}</button><small>Solo agrega los servicios que aún no tienen reserva.</small></div>` : ''}
        <fieldset class="readonly"${editable ? '' : ' disabled'}><div id="bkList">${list.map(card).join('') || '<p class="empty-note">Aún no hay reservas para este viaje.</p>'}</div></fieldset>
        ${editable ? '<button type="button" class="btn secondary small" id="bkAdd">+ Agregar reserva</button>' : ''}
        <div class="modal-actions"><button type="button" class="btn secondary" data-bk-back>Volver al viaje</button>${editable ? '<button type="button" class="btn primary" id="bkSave">Guardar reservas</button>' : ''}</div>
      </div>`, { wide: true });
      const body = $('#modalBody');
      const rowOf = (el) => { const r = el.closest('[data-bi]'); return r ? { row: r, b: list[Number(r.dataset.bi)] } : null; };
      const refresh = (row, b) => { row.querySelector('.pax-alerts').outerHTML = alertsHtml(b); $('#bkSummary').innerHTML = summaryHtml(); };
      body.oninput = (e) => {
        const f = e.target.dataset.bf; const r = rowOf(e.target);
        if (!f || !r) return;
        const { row, b } = r;
        if (f === 'supplier_paid') b.supplier_paid = e.target.checked;
        else if (['cost', 'price', 'commission_pct', 'commission_amount'].includes(f)) b[f] = e.target.value.trim() === '' ? '' : Math.max(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0, 0);
        else b[f] = e.target.value;
        if (f === 'commission_pct' && b.commission_pct > 100) b.commission_pct = 100;
        if (f === 'commission_status' && b.commission_status === 'Cobrada' && !b.commission_paid_at) b.commission_paid_at = today;
        if (f === 'supplier_name') {
          const s = matchSupplier(b.supplier_name);
          b.supplier_id = s ? s.id : null;
          row.querySelector('[data-bk-sup]').innerHTML = supInfo(b);
          // TP-205: el proveedor define cómo se gana con él (tarifa neta o comisionable) y su %.
          if (s && s.model === 'comision' && b.model !== 'comision' && b.cost === '') { b.model = 'comision'; if (b.commission_pct === '' && s.commission !== '') b.commission_pct = s.commission; commDefault(b); render(); toast(`${s.name} es comisionable: se registrará la comisión por cobrar`); return; }
        }
        if (f === 'model') { if (b.model === 'comision') { const sp = b.supplier_id ? supById(b.supplier_id) : null; if (b.commission_pct === '' && sp && sp.commission !== '') b.commission_pct = sp.commission; commDefault(b); } render(); return; }
        if (['commission_pct', 'price'].includes(f) && b.model === 'comision') { const inp = row.querySelector('[data-bf="commission_amount"]'); if (inp) inp.placeholder = b.price !== '' && b.commission_pct !== '' ? Math.round(Number(b.price) * Number(b.commission_pct)) / 100 : ''; }
        if (['end_date', 'start_date'].includes(f) && b.model === 'comision' && !b.commission_due) { commDefault(b); const inp = row.querySelector('[data-bf="commission_due"]'); if (inp) inp.value = b.commission_due; }
        if (f === 'commission_status') { row.querySelector('[data-bk-comm]').innerHTML = commHtml(b); }
        if ((f === 'price' || f === 'supplier_name') && b.cost === '' && b.supplier_id && b.model !== 'comision') {
          const net = T.netFromCommission(b.price, supById(b.supplier_id)?.commission);
          if (net !== '') { b.cost = net; row.querySelector('[data-bf="cost"]').value = net; toast(`Costo neto calculado con la comisión de ${b.supplier_name}`); }
        }
        if (f === 'status') { row.className = `pax-card bk-card ${STATUS_CLASS[b.status] || ''}`; }
        refresh(row, b);
      };
      body.onchange = async (e) => {
        const r = rowOf(e.target);
        if (r && e.target.matches('[data-bk-link]')) { const id = Number(e.target.value); if (id) { r.b.voucher_ids.push(id); render(); } return; }
        if (r && e.target.matches('[data-bk-file]')) {
          const file = e.target.files[0];
          if (!file) return;
          if (file.size > 4 * 1024 * 1024) { toast(`${file.name} pesa más de 4 MB`); return; }
          try {
            const res = await fetch(`/api/trips/${t.id}/vouchers`, { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) }, body: file });
            const out = await res.json();
            if (!res.ok) throw new Error(out.error || 'No se pudo subir');
            vouchers = out.vouchers;
            const added = vouchers[vouchers.length - 1];
            if (added) r.b.voucher_ids.push(Number(added.id));
            toast(`Adjuntado: ${file.name}. Guarda las reservas para conservar la liga.`);
            render();
          } catch (error) { toast(`${file.name}: ${error.message}`, 6000); }
          return;
        }
        if (e.target.dataset.bf) body.oninput(e);
      };
      body.onclick = (e) => {
        const del = e.target.closest('[data-bk-del]');
        const unlink = e.target.closest('[data-bk-unlink]');
        if (e.target.closest('[data-bk-back]')) { tripModal(t.id); return; }
        const pt = e.target.closest('[data-pt-request],[data-pt-accept],[data-pt-reject],[data-pt-cancel]');
        if (pt) {
          const r = rowOf(pt);
          if (!r) return;
          if (dirty()) { toast('Primero guarda los cambios de las reservas'); return; }
          const b = r.b;
          if (pt.matches('[data-pt-request]')) { portalRequestModal(t, b); return; }
          const go = async (path, body, msg) => { pt.disabled = true; const ok = await mutate(() => send('POST', `/api/trips/${t.id}/bookings/${b.id}/portal/${path}`, body), msg); if (ok) bookingsModal(t.id); else pt.disabled = false; };
          if (pt.matches('[data-pt-accept]')) { if (confirm(`¿Aceptar ${money(b.portal.quote?.amount)} de ${b.supplier_name}? Se registra como costo neto y se le pide confirmar el servicio.`)) go('decision', { accept: true }, 'Precio aceptado: el proveedor ya puede confirmar'); return; }
          if (pt.matches('[data-pt-reject]')) { const note = prompt('¿Por qué no se acepta? (lo verá el proveedor)', ''); if (note !== null) go('decision', { accept: false, note }, 'Precio rechazado'); return; }
          if (pt.matches('[data-pt-cancel]')) { const note = prompt(`Se avisará a ${b.supplier_name} que el servicio se cancela. Motivo (opcional):`, ''); if (note !== null) go('cancel', { note }, 'Solicitud cancelada'); return; }
        }
        if (unlink) { const r = rowOf(unlink); r.b.voucher_ids = r.b.voucher_ids.filter((x) => x !== Number(unlink.dataset.bkUnlink)); render(); return; }
        if (del) { const i = Number(del.dataset.bkDel); if ((list[i].confirmation || list[i].supplier_name) && !confirm('¿Quitar esta reserva del viaje? Si ya existe con el proveedor, mejor márcala como Cancelada.')) return; list.splice(i, 1); render(); return; }
        if (e.target.id === 'bkAdd') { list.push(blank()); render(); $$('#bkList [data-bf="supplier_name"]').pop()?.focus(); return; }
        if (e.target.id === 'bkGen') {
          const add = t.canvas?.blocks?.length ? T.bookingsFromCanvas(t.canvas, t, list, db.suppliers) : T.bookingsFromConfirmation(t.confirmation, t).filter((n) => !list.some((b) => b.type === n.type && b.description === n.description));
          if (!add.length) { toast('Todos los servicios ya tienen reserva'); return; }
          list.push(...add); render(); toast(`${add.length} reserva${add.length > 1 ? 's' : ''} agregada${add.length > 1 ? 's' : ''}. Completa claves y guarda.`);
          return;
        }
        if (e.target.id === 'bkSave') save(e.target);
      };
    }
    async function save(btn) {
      const keep = list.filter((b) => b.description || b.supplier_name || b.confirmation);
      if (keep.length < list.length && !confirm('Hay reservas vacías; no se guardarán. ¿Continuar?')) return;
      btn.disabled = true;
      const ok = await mutate(() => send('PUT', `/api/trips/${t.id}/bookings`, { list: keep }), `Reservas guardadas (${keep.length})`);
      btn.disabled = false;
      if (ok) tripModal(t.id);
    }
    render();
  }
  window.bookingsModal = bookingsModal;

  // Ventas: una fila por cada viaje vendido (con o sin viaje armado), con su precio y, para Administrador y Dirección, la comisión.
  function salesHtml(today) {
    const mgr = typeof isManager === 'function' && isManager() && typeof quoteProfitInfo === 'function';
    const trips = db.trips.filter((t) => t.status !== 'Cerrado');
    const taken = new Set();
    const rows = trips.map((t) => {
      let q = t.quote_id ? quoteById(t.quote_id) : null;
      if (!q) { const mine = db.quotes.filter((x) => x.client_id === t.client_id && x.status === 'Aceptada' && !trips.some((o) => o.quote_id === x.id)); if (mine.length === 1) q = mine[0]; }
      if (q) taken.add(q.id);
      return { t, q, client_id: t.client_id, key: `1${t.start_date || '9'}` };
    });
    (typeof tpToBuild === 'function' ? tpToBuild() : []).filter((p) => !p.q || !taken.has(p.q.id))
      .forEach((p) => rows.push({ q: p.q, lead: p.lead, client_id: p.client_id, key: `0${String(p.q ? p.q.id : p.client_id).padStart(8, '0')}` }));
    rows.sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0)); // por armar primero, luego por fecha de salida
    const info = (q) => (mgr && q ? quoteProfitInfo(q) : null);
    const total = (r) => (r.q ? Number(r.q.payment_plan?.total) || Number(r.q.price) || 0 : 0);
    const sold = rows.reduce((x, r) => x + total(r), 0);
    const known = rows.map((r) => info(r.q)).filter((i) => i && i.profit != null);
    const profit = known.reduce((x, i) => x + i.profit, 0);
    const missing = rows.filter((r) => r.q && (!info(r.q) || info(r.q).profit == null)).length;
    const kpis = mgr ? `<div class="mini bk-kpis"><div>Ventas<b>${rows.length}</b><small>${trips.length} con viaje armado</small></div><div>Vendido<b>${money(sold)}</b></div><div>Ganancia (comisión)<b>${money(profit)}</b><small>${sold > 0 ? `${Math.round((profit / sold) * 1000) / 10}% de lo vendido` : ''}</small></div><div>Por capturar<b>${missing}</b><small>${missing ? 'ventas sin comisión' : 'todo capturado'}</small></div></div>`
      : `<div class="mini bk-kpis"><div>Ventas<b>${rows.length}</b><small>${trips.length} con viaje armado</small></div><div>Vendido<b>${money(sold)}</b></div></div>`;
    const write = canWrite('trips');
    const line = (r) => {
      const { t, q, lead } = r;
      const l = lead || (q && q.lead_id ? leadById(q.lead_id) : null);
      const dest = t ? t.destination : q ? q.destination : lead?.destination;
      const dates = t ? fmtRange(t.start_date, t.end_date) : q && typeof qvDates === 'function' ? qvDates(q) : l ? fmtRange(l.start_date, l.end_date) : '';
      const bk = t ? (t.bookings?.list || []) : [];
      const sum = t && bk.length ? T.bookingsSummary(bk, t, today) : null;
      const i = info(q);
      const comm = !mgr ? '' : !q ? '<td><span class="muted">Sin cotización</span></td>'
        : `<td>${i && i.profit != null ? `<b class="${i.profit < 0 ? 'neg' : 'pos'}">${money(i.profit)}</b><br><small>${i.margin == null ? '' : `${i.margin}%`}${i.net != null ? ` · neto ${money(i.net)}` : ''}</small>` : '<span class="muted">Sin comisión</span>'}<br><button type="button" class="link" data-margin="${q.id}">${q.agency_margin ? 'Editar' : 'Capturar'}</button></td>`;
      const open = t ? `<button type="button" class="link" data-bk-trip="${t.id}">🧾 Reservas</button>` : write ? (q ? `<button type="button" class="btn primary small" data-trip-from-quote="${q.id}">Armar viaje</button>` : `<button type="button" class="btn primary small" data-new-trip-client="${r.client_id}">Armar viaje</button>`) : '';
      return `<tr><td><b>${H(clientName(r.client_id))}</b><br><small>${H(dest || 'Destino por definir')}${dates ? ` · ${H(dates)}` : ''}</small></td>
        <td>${t ? `<span class="status qualified">${H(t.status)}</span>` : '<span class="status quoted">Por armar</span>'}${q ? `<br><small>${H(q.folio)}${r.lead && q.status !== 'Aceptada' ? ' · sin marcar aceptada' : ''}</small>` : ''}</td>
        <td>${sum ? `${sum.confirmed}/${sum.total} confirmadas${sum.danger ? ` · ⛔ ${sum.danger}` : ''}` : '<span class="muted">Sin reservas</span>'}</td>
        <td>${q && typeof qvPay === 'function' ? qvPay(q) : '—'}</td>
        <td>${q ? `<b>${money(total(r))}</b>` : '—'}</td>${comm}<td>${open}</td></tr>`;
    };
    return `<div class="panel-head"><div><h3>🧾 Reservas vendidas</h3><p>Todos los viajes que ya vendimos: con viaje armado y los que aún están por armar.${mgr ? ' La comisión es la ganancia de cada venta.' : ''}</p></div></div>${kpis}
      <div class="table bk-sales"><table><thead><tr><th>Cliente y viaje</th><th>Estado</th><th>Servicios</th><th>Pago del cliente</th><th>Precio</th>${mgr ? '<th>Comisión</th>' : ''}<th></th></tr></thead><tbody>
      ${rows.map(line).join('') || `<tr><td colspan="${mgr ? 7 : 6}" class="empty-note">Aún no hay ventas. Aparecen solas cuando el cliente acepta la cotización o el lead pasa a Vendido.</td></tr>`}
      </tbody></table></div>`;
  }

  // Panel central de reservas en Viajes.
  const rv = { status: '', supplier: '', pending: false };
  window.renderReservas = () => {
    paintDatalist();
    renderSuppliers();
    const box = $('#bookingsPanel');
    if (!box) return;
    const today = todayStr();
    const rows = allBookings().filter(({ t }) => t.status !== 'Cerrado');
    const count = (st) => rows.filter(({ b }) => b.status === st).length;
    const dueSoon = rows.filter(({ b }) => b.status !== 'Cancelada' && b.supplier_due && !b.supplier_paid && b.supplier_due <= T.addDays(today, 7));
    const owed = rows.filter(({ b }) => b.status !== 'Cancelada' && !b.supplier_paid).reduce((s, { b }) => s + (Number(b.cost) || 0), 0);
    const suppliersUsed = [...new Set(rows.map(({ b }) => b.supplier_name).filter(Boolean))].sort();
    const view = rows.filter(({ b, t }) => (!rv.status || b.status === rv.status) && (!rv.supplier || b.supplier_name === rv.supplier) && (!rv.pending || T.bookingAlerts(b, t, today).some((a) => a.level !== 'info') || b.status === 'Por reservar' || b.status === 'Solicitada' || b.portal?.state === 'Cotizada'))
      .sort((a, c) => (a.b.start_date || a.t.start_date || '').localeCompare(c.b.start_date || c.t.start_date || ''));
    const toReview = rows.filter(({ b }) => b.portal?.state === 'Cotizada');
    const tripsWithout = db.trips.filter((t) => t.status !== 'Cerrado' && t.end_date >= today && !(t.bookings?.list || []).length).length;
    box.innerHTML = `${salesHtml(today)}<div class="panel-head bk-sub"><div><h3>🛎 Servicios con proveedores</h3><p>Cada servicio reservado de los viajes abiertos, con su proveedor, clave y pago al proveedor.</p></div></div>
      <div class="mini bk-kpis"><div>Por reservar<b>${count('Por reservar')}</b></div><div>Solicitadas<b>${count('Solicitada')}</b></div><div>Confirmadas<b>${count('Confirmada')}</b></div><div>Por pagar a proveedores<b>${money(owed)}</b><small>${dueSoon.length ? `${dueSoon.length} vence${dueSoon.length > 1 ? 'n' : ''} en 7 días` : ''}</small></div></div>
      ${toReview.length ? `<p class="note-warn">🚐 ${toReview.length} precio${toReview.length > 1 ? 's' : ''} del portal de proveedores por aceptar o rechazar: ${toReview.slice(0, 4).map(({ b, t }) => `<button type="button" class="link" data-bk-trip="${t.id}">${H(b.portal.folio)} · ${H(clientName(t.client_id))}</button>`).join(' · ')}</p>` : ''}
      ${tripsWithout ? `<p class="note-warn">${tripsWithout} viaje${tripsWithout > 1 ? 's' : ''} próximo${tripsWithout > 1 ? 's' : ''} sin reservas registradas.</p>` : ''}
      <div class="toolbar"><select id="rvStatus"><option value="">Todos los estados</option>${options(T.BOOKING_STATUSES, rv.status)}</select><select id="rvSupplier"><option value="">Todos los proveedores</option>${options(suppliersUsed, rv.supplier)}</select><label class="kb-check"><input type="checkbox" id="rvPending" ${rv.pending ? 'checked' : ''}> Solo lo que requiere atención</label></div>
      <div class="table"><table><thead><tr><th>Viaje</th><th>Servicio</th><th>Proveedor</th><th>Clave</th><th>Estado</th><th>Pago proveedor</th><th>Avisos</th></tr></thead><tbody>
      ${view.map(({ b, t }) => { const al = T.bookingAlerts(b, t, today); return `<tr class="clickable" data-bk-trip="${t.id}"><td><b>${H(clientName(t.client_id))}</b><br><small>${H(t.destination)} · ${H(fmtDate(t.start_date))}</small></td><td>${T.BOOKING_ICONS[b.type]} ${H(b.description || b.type)}<br><small>${H(b.start_date ? fmtDate(b.start_date) : '')}${b.time ? ` ${H(b.time)}` : ''}</small></td><td>${H(b.supplier_name || '—')}</td><td>${H(b.confirmation || '—')}</td><td><span class="bk-pill ${STATUS_CLASS[b.status]}">${H(b.status)}</span>${b.portal ? `<br><small class="muted">🚐 ${H(b.portal.folio)} · ${H(PV.TEAM_LABELS[b.portal.state] || b.portal.state)}</small>` : ''}</td><td>${b.supplier_paid ? '✓ Pagado' : b.cost !== '' ? `${money(b.cost)}${b.supplier_due ? `<br><small>antes del ${H(fmtDate(b.supplier_due))}</small>` : ''}` : '—'}</td><td>${al.map((a) => `<span class="pax-alert ${a.level}">${ALERT_ICON[a.level]} ${H(a.text)}</span>`).join(' ')}</td></tr>`; }).join('') || `<tr><td colspan="7" class="empty-note">${rows.length ? 'Nada pendiente con estos filtros.' : 'Aún no hay reservas. Ábrelas desde cada viaje con 🧾 Reservas.'}</td></tr>`}
      </tbody></table></div>`;
    $('#rvStatus').onchange = (e) => { rv.status = e.target.value; if (rv.status) rv.pending = false; renderReservas(); };
    $('#rvSupplier').onchange = (e) => { rv.supplier = e.target.value; renderReservas(); };
    $('#rvPending').onchange = (e) => { rv.pending = e.target.checked; renderReservas(); };
  };

  /* ---------------- TP-305 · Catálogo de proveedores ---------------- */
  const sp = { q: '', type: '', inactive: false };
  function supplierStats(s) {
    const rows = allBookings().filter(({ b }) => b.supplier_id === s.id || (!b.supplier_id && b.supplier_name.toLowerCase() === s.name.toLowerCase()));
    const live = rows.filter(({ b }) => b.status !== 'Cancelada');
    return { rows, total: live.length, owed: live.filter(({ b }) => !b.supplier_paid).reduce((x, { b }) => x + (Number(b.cost) || 0), 0), sold: live.reduce((x, { b }) => x + (Number(b.price) || 0), 0), toCollect: live.filter(({ b }) => T.commissionOpen(b)).reduce((x, { b }) => x + (T.bookingProfit(b) || 0), 0) };
  }
  function renderSuppliers() {
    const grid = $('#supplierGrid');
    if (!grid) return;
    $('#newSupplier')?.classList.toggle('hidden', !canEditSup());
    const q = sp.q.trim().toLowerCase();
    const list = (db.suppliers || []).filter((s) => (sp.inactive || s.active !== false) && (!sp.type || s.type === sp.type) && (!q || `${s.name} ${s.destinations} ${s.contact_name} ${s.notes} ${s.type}`.toLowerCase().includes(q)));
    grid.innerHTML = list.map((s) => {
      const st = supplierStats(s);
      return `<article class="card sup-card clickable${s.active === false ? ' off' : ''}" data-sup="${s.id}"><div class="card-top"><span class="status qualified">${H(s.type)}</span>${s.commission !== '' && s.commission != null ? `<b class="sup-com" title="${H(T.PROFIT_MODEL_LABELS[s.model || 'neta'])}">${s.model === 'comision' ? 'Comisión ' : 'Neta · '}${s.commission}%</b>` : `<small class="muted">${H(T.PROFIT_MODEL_LABELS[s.model || 'neta'])}</small>`}</div>
        <h3>${H(s.name)}${s.active === false ? ' <small>(inactivo)</small>' : ''}</h3><p>${H(s.destinations || 'Destinos por definir')}</p>
        ${s.contact_name || s.phone || s.email ? `<p>${H([s.contact_name, s.phone, s.email].filter(Boolean).join(' · '))}</p>` : '<p class="muted">Sin datos de contacto</p>'}
        <div class="meta"><div><span>Reservas</span><b>${st.total}</b></div><div><span>Por pagar</span><b>${money(st.owed)}</b></div>${st.toCollect ? `<div><span>Comisión por cobrar</span><b>${money(st.toCollect)}</b></div>` : ''}</div></article>`;
    }).join('') || `<p class="empty-note">${(db.suppliers || []).length ? 'Ningún proveedor coincide con la búsqueda.' : 'Aún no hay proveedores.'}</p>`;
    $('#supTypeFilter').innerHTML = `<option value="">Todos los tipos</option>${options(T.SUPPLIER_TYPES, sp.type)}`;
    renderSupCommissions();
  }
  window.renderSuppliers = renderSuppliers;

  /* ---------------- TP-205 · Comisiones por cobrar a proveedores ---------------- */
  const cm = { view: 'open', supplier: '' };
  function renderSupCommissions() {
    const box = $('#supCommissions');
    if (!box) return;
    const today = todayStr();
    const all = allBookings().filter(({ b }) => b.model === 'comision' && b.status !== 'Cancelada');
    if (!all.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const amt = (b) => T.bookingProfit(b) || 0;
    const open = all.filter(({ b }) => T.commissionOpen(b));
    const late = open.filter(({ b }) => b.commission_due && b.commission_due < today);
    const month = today.slice(0, 7);
    const collected = all.filter(({ b }) => b.commission_status === 'Cobrada' && String(b.commission_paid_at).slice(0, 7) === month);
    const view = all.filter(({ b }) => (cm.view === 'open' ? T.commissionOpen(b) : cm.view === 'all' ? true : b.commission_status === cm.view) && (!cm.supplier || (b.supplier_name || '—') === cm.supplier));
    const groups = new Map();
    view.forEach((x) => { const k = x.b.supplier_name || '—'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
    const finance = canEditSup();
    const sum = (l) => l.reduce((x, { b }) => x + amt(b), 0);
    box.innerHTML = `<div class="panel-head"><div><h3>💰 Comisiones por cobrar a proveedores</h3><p>Reservas comisionables: cuánto te debe cada proveedor, cuándo cobrarlo y su estado.</p></div></div>
      <div class="mini bk-kpis"><div>Por cobrar<b>${money(sum(open))}</b><small>${open.length} reserva${open.length === 1 ? '' : 's'}</small></div><div>Vencidas<b>${money(sum(late))}</b><small>${late.length ? `${late.length} pasada${late.length > 1 ? 's' : ''} de su fecha` : 'Al día'}</small></div><div>Cobradas este mes<b>${money(sum(collected))}</b></div></div>
      <div class="toolbar"><select id="cmView">${options([['open', 'Por cobrar (pendientes y facturadas)'], ['Pendiente', 'Pendientes'], ['Facturada', 'Facturadas'], ['Cobrada', 'Cobradas'], ['all', 'Todas']], cm.view)}</select><select id="cmSupplier"><option value="">Todos los proveedores</option>${options([...new Set(all.map(({ b }) => b.supplier_name || '—'))].sort(), cm.supplier)}</select></div>
      ${groups.size ? [...groups.entries()].sort((a, c) => sum(c[1]) - sum(a[1])).map(([name, rows]) => `<div class="cm-group"><div class="cm-head"><b>${H(name)}</b><span>${rows.length} reserva${rows.length === 1 ? '' : 's'} · ${money(sum(rows))}</span></div>
        <div class="table"><table><thead><tr><th>Viaje</th><th>Servicio</th><th>Venta</th><th>Comisión</th><th>Cobrar el</th><th>Estado</th></tr></thead><tbody>
        ${rows.sort((a, c) => String(a.b.commission_due || '9').localeCompare(String(c.b.commission_due || '9'))).map(({ b, t }) => { const overdue = T.commissionOpen(b) && b.commission_due && b.commission_due < today; return `<tr data-cm-trip="${t.id}" data-cm-bk="${H(b.id)}"><td><button type="button" class="link" data-bk-trip="${t.id}"><b>${H(clientName(t.client_id))}</b></button><br><small>${H(t.destination)} · ${H(fmtDate(t.start_date))}</small></td><td>${T.BOOKING_ICONS[b.type]} ${H(b.description || b.type)}${b.confirmation ? `<br><small>${H(b.confirmation)}</small>` : ''}</td><td>${b.price !== '' ? money(b.price) : '—'}</td><td><b>${T.bookingProfit(b) == null ? '—' : money(amt(b))}</b>${b.commission_pct !== '' ? `<br><small>${b.commission_pct}%</small>` : ''}</td><td class="${overdue ? 'danger-text' : ''}">${b.commission_due ? H(fmtDate(b.commission_due)) : '—'}${overdue ? '<br><small>Vencida</small>' : ''}</td><td>${finance ? `<select data-cm-status>${options(T.COMMISSION_STATUSES, b.commission_status)}</select>` : `<span class="bk-pill">${H(b.commission_status)}</span>`}${b.commission_invoice ? `<br><small>Fact. ${H(b.commission_invoice)}</small>` : ''}${b.commission_status === 'Cobrada' && b.commission_paid_at ? `<br><small>${H(fmtDate(b.commission_paid_at))}</small>` : ''}</td></tr>`; }).join('')}
        </tbody></table></div></div>`).join('') : '<p class="empty-note">Nada con estos filtros.</p>'}`;
    $('#cmView').onchange = (e) => { cm.view = e.target.value; renderSupCommissions(); };
    $('#cmSupplier').onchange = (e) => { cm.supplier = e.target.value; renderSupCommissions(); };
    box.querySelectorAll('[data-cm-status]').forEach((sel) => {
      sel.onchange = async () => {
        const tr = sel.closest('[data-cm-trip]');
        const body = { status: sel.value };
        if (sel.value === 'Facturada') { const inv = prompt('Número de factura o referencia (opcional)', ''); if (inv === null) { renderSupCommissions(); return; } body.invoice = inv; }
        sel.disabled = true;
        await mutate(() => send('PATCH', `/api/trips/${tr.dataset.cmTrip}/bookings/${tr.dataset.cmBk}/commission`, body), `Comisión ${sel.value.toLowerCase()}`);
      };
    });
  }
  window.renderSupCommissions = renderSupCommissions;

  function supplierModal(id) {
    const s = id ? supById(id) : null;
    const editable = canEditSup();
    const v = s || { name: '', type: 'Hotel', model: 'neta', destinations: '', contact_name: '', phone: '', whatsapp: '', email: '', website: '', commission: '', commission_days: '', rates: '', payment_terms: '', notes: '', active: true };
    const st = s ? supplierStats(s) : null;
    const upcoming = st ? st.rows.filter(({ b }) => b.status !== 'Cancelada').sort((a, c) => (a.b.start_date || '').localeCompare(c.b.start_date || '')).slice(0, 8) : [];
    const html = `<form class="modal-form"><fieldset class="readonly"${editable ? '' : ' disabled'}>
      ${field('Nombre*', `<input name="name" required maxlength="120" value="${H(v.name)}">`)}
      ${field('Tipo', `<select name="type">${options(T.SUPPLIER_TYPES, v.type)}</select>`)}
      ${field('Destinos o zonas', `<input name="destinations" maxlength="200" value="${H(v.destinations)}" placeholder="Cancún, Riviera Maya, Tulum">`)}
      ${field('Cómo ganas con este proveedor', `<select name="model">${options(T.PROFIT_MODELS.map((m) => [m, m === 'neta' ? 'Tarifa neta (venta − costo)' : 'Comisionable (me paga comisión)']), v.model || 'neta')}</select>`)}
      ${field('Comisión (%)', `<input name="commission" inputmode="decimal" maxlength="6" value="${H(v.commission)}" placeholder="10">`)}
      ${field('Días para cobrar la comisión', `<input name="commission_days" type="number" min="0" max="365" value="${H(v.commission_days ?? '')}" placeholder="${T.COMMISSION_DAYS_DEFAULT} (después del viaje)">`)}
      ${field('Contacto', `<input name="contact_name" maxlength="120" value="${H(v.contact_name)}" placeholder="Nombre del ejecutivo">`)}
      ${field('Teléfono', `<input name="phone" maxlength="40" value="${H(v.phone)}">`)}
      ${field('WhatsApp', `<input name="whatsapp" maxlength="40" value="${H(v.whatsapp)}">`)}
      ${field('Correo', `<input name="email" type="email" maxlength="160" value="${H(v.email)}">`)}
      ${field('Sitio o portal de reservas', `<input name="website" maxlength="200" value="${H(v.website)}" placeholder="https://…">`, true)}
      ${field('Tarifas de referencia', `<textarea name="rates" rows="3" maxlength="3000" placeholder="Ej. Junior Suite TI desde $3,800 por noche (temporada baja)">${H(v.rates)}</textarea>`, true)}
      ${field('Condiciones de pago', `<input name="payment_terms" maxlength="300" value="${H(v.payment_terms)}" placeholder="Pago total 15 días antes de la llegada">`, true)}
      ${field('Notas', `<textarea name="notes" rows="2" maxlength="2000">${H(v.notes)}</textarea>`, true)}
      <label class="full kb-check"><input type="checkbox" name="active" ${v.active !== false ? 'checked' : ''}> Activo (aparece al cotizar y reservar)</label>
      </fieldset>
      ${s && contactLinks(s) ? `<div class="full bk-sup">${contactLinks(s)}</div>` : ''}
      <p class="full muted-note">Tarifa neta: le pagas el costo y tu utilidad es la diferencia (si pones %, el costo se calcula solo con el precio de venta). Comisionable: el proveedor te paga el % después del viaje; la reserva queda en “Comisiones por cobrar” con su fecha de cobro.</p>
      ${s ? `<div class="full lead-fups"><b>Reservas con este proveedor (${st.total}) · por pagar ${money(st.owed)} · vendido ${money(st.sold)}${st.toCollect ? ` · comisión por cobrar ${money(st.toCollect)}` : ''}</b>${upcoming.map(({ b, t }) => `<button type="button" class="lead-fup" data-bk-trip="${t.id}"><span>${T.BOOKING_ICONS[b.type]} ${H(clientName(t.client_id))} · ${H(b.description || b.type)}</span><small>${H(b.status)}${b.start_date ? ` · ${H(fmtDate(b.start_date))}` : ''}</small></button>`).join('') || '<p class="lead-fups-empty">Sin reservas todavía.</p>'}</div>` : ''}
      ${s && isAdmin() ? '<div class="danger-zone full"><button type="button" class="btn ghost-danger small" id="supDel">Eliminar proveedor</button></div>' : ''}
      <div class="modal-actions"><button type="button" class="btn secondary close">${editable ? 'Cancelar' : 'Cerrar'}</button>${editable ? `<button type="submit" class="btn primary">${s ? 'Guardar cambios' : 'Agregar proveedor'}</button>` : ''}</div></form>`;
    openModal('CATÁLOGO DE PROVEEDORES', s ? s.name : 'Nuevo proveedor', html);
    if (editable) bindForm((f) => {
      const body = { name: f.name, type: f.type, model: f.model, commission_days: f.commission_days, destinations: f.destinations, commission: f.commission, contact_name: f.contact_name, phone: f.phone, whatsapp: f.whatsapp, email: f.email, website: f.website, rates: f.rates, payment_terms: f.payment_terms, notes: f.notes, active: Boolean(f.active) };
      return s ? mutate(() => send('PATCH', `/api/suppliers/${s.id}`, body), 'Proveedor actualizado') : mutate(() => send('POST', '/api/suppliers', body), 'Proveedor agregado');
    });
    const del = $('#supDel');
    if (del) del.onclick = async () => {
      const used = st.rows.length;
      if (!confirm(used ? `${s.name} aparece en ${used} reserva${used > 1 ? 's' : ''}. Las reservas conservan el nombre, pero ya no se ligan al catálogo. Recomendado: márcalo como inactivo. ¿Eliminarlo de todos modos?` : `¿Eliminar ${s.name} del catálogo?`)) return;
      if (await mutate(() => send('DELETE', `/api/suppliers/${s.id}`), 'Proveedor eliminado')) close();
    };
  }
  window.supplierModal = supplierModal;

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-bk-trip],[data-sup],#newSupplier');
    if (!el) return;
    if (el.id === 'newSupplier') supplierModal();
    else if (el.dataset.bkTrip) bookingsModal(Number(el.dataset.bkTrip));
    else if (el.dataset.sup) supplierModal(Number(el.dataset.sup));
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'supSearch') { sp.q = e.target.value; renderSuppliers(); } });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'supTypeFilter') { sp.type = e.target.value; renderSuppliers(); }
    if (e.target.id === 'supInactive') { sp.inactive = e.target.checked; renderSuppliers(); }
  });
}());
