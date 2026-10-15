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
    const blank = () => ({ id: `r${Date.now().toString(36)}${list.length}`, type: 'Hotel', status: 'Por reservar', supplier_id: null, supplier_name: '', confirmation: '', description: '', start_date: t.start_date, end_date: t.end_date, time: '', cost: '', price: '', supplier_due: '', supplier_paid: false, voucher_ids: [], source: '', notes: '' });

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
        <label>Costo neto (MXN)<input data-bf="cost" inputmode="decimal" maxlength="14" value="${H(b.cost)}"></label>
        <label>Precio de venta (MXN)<input data-bf="price" inputmode="decimal" maxlength="14" value="${H(b.price)}"></label>
        <label>Pagar al proveedor antes de<input type="date" data-bf="supplier_due" value="${H(b.supplier_due)}"></label>
        <label class="bk-paid"><span>Pago al proveedor</span><span><input type="checkbox" data-bf="supplier_paid" ${b.supplier_paid ? 'checked' : ''}> Pagado</span></label>
        <label class="full">Notas internas<input data-bf="notes" maxlength="1000" value="${H(b.notes)}"></label>
      </div>
      <div data-bk-sup>${supInfo(b)}</div>
      ${docsHtml(b)}
      <div class="pax-foot">${alertsHtml(b)}</div>
    </div>`;
    const summaryHtml = () => {
      const s = T.bookingsSummary(list, t, today);
      return `<div class="pax-summary"><span><b>${s.total}</b> ${s.total === 1 ? 'reserva' : 'reservas'} · ${s.confirmed} confirmada${s.confirmed === 1 ? '' : 's'}</span>${s.pending ? `<span class="warn">${s.pending} por confirmar</span>` : s.total ? '<span class="ok">✓ Todo confirmado</span>' : ''}${s.danger ? `<span class="danger">⛔ ${s.danger} urgente${s.danger > 1 ? 's' : ''}</span>` : ''}<span>Costo ${money(s.cost)} · Venta ${money(s.price)} · Utilidad ${money(s.price - s.cost)}</span>${s.owed ? `<span class="warn">Por pagar a proveedores ${money(s.owed)}</span>` : ''}</div>`;
    };
    const canGenerate = () => t.canvas?.blocks?.length || t.confirmation;

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
        else if (f === 'cost' || f === 'price') b[f] = e.target.value.trim() === '' ? '' : Math.max(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0, 0);
        else b[f] = e.target.value;
        if (f === 'supplier_name') {
          const s = matchSupplier(b.supplier_name);
          b.supplier_id = s ? s.id : null;
          row.querySelector('[data-bk-sup]').innerHTML = supInfo(b);
        }
        if ((f === 'price' || f === 'supplier_name') && b.cost === '' && b.supplier_id) {
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

  // Panel central de reservas en Viajes.
  const rv = { status: '', supplier: '', pending: true };
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
    const view = rows.filter(({ b, t }) => (!rv.status || b.status === rv.status) && (!rv.supplier || b.supplier_name === rv.supplier) && (!rv.pending || T.bookingAlerts(b, t, today).some((a) => a.level !== 'info') || b.status === 'Por reservar' || b.status === 'Solicitada'))
      .sort((a, c) => (a.b.start_date || a.t.start_date || '').localeCompare(c.b.start_date || c.t.start_date || ''));
    const tripsWithout = db.trips.filter((t) => t.status !== 'Cerrado' && t.end_date >= today && !(t.bookings?.list || []).length).length;
    box.innerHTML = `<div class="panel-head"><div><h3>🧾 Reservas</h3><p>Todas las reservas de los viajes abiertos, con su proveedor, clave y pago al proveedor.</p></div></div>
      <div class="mini bk-kpis"><div>Por reservar<b>${count('Por reservar')}</b></div><div>Solicitadas<b>${count('Solicitada')}</b></div><div>Confirmadas<b>${count('Confirmada')}</b></div><div>Por pagar a proveedores<b>${money(owed)}</b><small>${dueSoon.length ? `${dueSoon.length} vence${dueSoon.length > 1 ? 'n' : ''} en 7 días` : ''}</small></div></div>
      ${tripsWithout ? `<p class="note-warn">${tripsWithout} viaje${tripsWithout > 1 ? 's' : ''} próximo${tripsWithout > 1 ? 's' : ''} sin reservas registradas.</p>` : ''}
      <div class="toolbar"><select id="rvStatus"><option value="">Todos los estados</option>${options(T.BOOKING_STATUSES, rv.status)}</select><select id="rvSupplier"><option value="">Todos los proveedores</option>${options(suppliersUsed, rv.supplier)}</select><label class="kb-check"><input type="checkbox" id="rvPending" ${rv.pending ? 'checked' : ''}> Solo lo que requiere atención</label></div>
      <div class="table"><table><thead><tr><th>Viaje</th><th>Servicio</th><th>Proveedor</th><th>Clave</th><th>Estado</th><th>Pago proveedor</th><th>Avisos</th></tr></thead><tbody>
      ${view.map(({ b, t }) => { const al = T.bookingAlerts(b, t, today); return `<tr class="clickable" data-bk-trip="${t.id}"><td><b>${H(clientName(t.client_id))}</b><br><small>${H(t.destination)} · ${H(fmtDate(t.start_date))}</small></td><td>${T.BOOKING_ICONS[b.type]} ${H(b.description || b.type)}<br><small>${H(b.start_date ? fmtDate(b.start_date) : '')}${b.time ? ` ${H(b.time)}` : ''}</small></td><td>${H(b.supplier_name || '—')}</td><td>${H(b.confirmation || '—')}</td><td><span class="bk-pill ${STATUS_CLASS[b.status]}">${H(b.status)}</span></td><td>${b.supplier_paid ? '✓ Pagado' : b.cost !== '' ? `${money(b.cost)}${b.supplier_due ? `<br><small>antes del ${H(fmtDate(b.supplier_due))}</small>` : ''}` : '—'}</td><td>${al.map((a) => `<span class="pax-alert ${a.level}">${ALERT_ICON[a.level]} ${H(a.text)}</span>`).join(' ')}</td></tr>`; }).join('') || `<tr><td colspan="7" class="empty-note">${rows.length ? 'Nada pendiente con estos filtros.' : 'Aún no hay reservas. Ábrelas desde cada viaje con 🧾 Reservas.'}</td></tr>`}
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
    return { rows, total: live.length, owed: live.filter(({ b }) => !b.supplier_paid).reduce((x, { b }) => x + (Number(b.cost) || 0), 0), sold: live.reduce((x, { b }) => x + (Number(b.price) || 0), 0) };
  }
  function renderSuppliers() {
    const grid = $('#supplierGrid');
    if (!grid) return;
    $('#newSupplier')?.classList.toggle('hidden', !canEditSup());
    const q = sp.q.trim().toLowerCase();
    const list = (db.suppliers || []).filter((s) => (sp.inactive || s.active !== false) && (!sp.type || s.type === sp.type) && (!q || `${s.name} ${s.destinations} ${s.contact_name} ${s.notes} ${s.type}`.toLowerCase().includes(q)));
    grid.innerHTML = list.map((s) => {
      const st = supplierStats(s);
      return `<article class="card sup-card clickable${s.active === false ? ' off' : ''}" data-sup="${s.id}"><div class="card-top"><span class="status qualified">${H(s.type)}</span>${s.commission !== '' && s.commission != null ? `<b class="sup-com">${s.commission}%</b>` : '<small class="muted">Sin comisión</small>'}</div>
        <h3>${H(s.name)}${s.active === false ? ' <small>(inactivo)</small>' : ''}</h3><p>${H(s.destinations || 'Destinos por definir')}</p>
        ${s.contact_name || s.phone || s.email ? `<p>${H([s.contact_name, s.phone, s.email].filter(Boolean).join(' · '))}</p>` : '<p class="muted">Sin datos de contacto</p>'}
        <div class="meta"><div><span>Reservas</span><b>${st.total}</b></div><div><span>Por pagar</span><b>${money(st.owed)}</b></div></div></article>`;
    }).join('') || `<p class="empty-note">${(db.suppliers || []).length ? 'Ningún proveedor coincide con la búsqueda.' : 'Aún no hay proveedores.'}</p>`;
    $('#supTypeFilter').innerHTML = `<option value="">Todos los tipos</option>${options(T.SUPPLIER_TYPES, sp.type)}`;
  }
  window.renderSuppliers = renderSuppliers;

  function supplierModal(id) {
    const s = id ? supById(id) : null;
    const editable = canEditSup();
    const v = s || { name: '', type: 'Hotel', destinations: '', contact_name: '', phone: '', whatsapp: '', email: '', website: '', commission: '', rates: '', payment_terms: '', notes: '', active: true };
    const st = s ? supplierStats(s) : null;
    const upcoming = st ? st.rows.filter(({ b }) => b.status !== 'Cancelada').sort((a, c) => (a.b.start_date || '').localeCompare(c.b.start_date || '')).slice(0, 8) : [];
    const html = `<form class="modal-form"><fieldset class="readonly"${editable ? '' : ' disabled'}>
      ${field('Nombre*', `<input name="name" required maxlength="120" value="${H(v.name)}">`)}
      ${field('Tipo', `<select name="type">${options(T.SUPPLIER_TYPES, v.type)}</select>`)}
      ${field('Destinos o zonas', `<input name="destinations" maxlength="200" value="${H(v.destinations)}" placeholder="Cancún, Riviera Maya, Tulum">`)}
      ${field('Comisión (%)', `<input name="commission" inputmode="decimal" maxlength="6" value="${H(v.commission)}" placeholder="10">`)}
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
      ${s ? `<div class="full lead-fups"><b>Reservas con este proveedor (${st.total}) · por pagar ${money(st.owed)} · vendido ${money(st.sold)}</b>${upcoming.map(({ b, t }) => `<button type="button" class="lead-fup" data-bk-trip="${t.id}"><span>${T.BOOKING_ICONS[b.type]} ${H(clientName(t.client_id))} · ${H(b.description || b.type)}</span><small>${H(b.status)}${b.start_date ? ` · ${H(fmtDate(b.start_date))}` : ''}</small></button>`).join('') || '<p class="lead-fups-empty">Sin reservas todavía.</p>'}</div>` : ''}
      ${s && isAdmin() ? '<div class="danger-zone full"><button type="button" class="btn ghost-danger small" id="supDel">Eliminar proveedor</button></div>' : ''}
      <div class="modal-actions"><button type="button" class="btn secondary close">${editable ? 'Cancelar' : 'Cerrar'}</button>${editable ? `<button type="submit" class="btn primary">${s ? 'Guardar cambios' : 'Agregar proveedor'}</button>` : ''}</div></form>`;
    openModal('CATÁLOGO DE PROVEEDORES', s ? s.name : 'Nuevo proveedor', html);
    if (editable) bindForm((f) => {
      const body = { name: f.name, type: f.type, destinations: f.destinations, commission: f.commission, contact_name: f.contact_name, phone: f.phone, whatsapp: f.whatsapp, email: f.email, website: f.website, rates: f.rates, payment_terms: f.payment_terms, notes: f.notes, active: Boolean(f.active) };
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
