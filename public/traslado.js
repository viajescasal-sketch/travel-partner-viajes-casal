'use strict';

/* =========================================================
   Solicitar traslado desde la ficha del cliente
   - Botón “🚐 Solicitar traslado” (solo si su cotización incluye traslados o su ficha dice “Incluye traslado”).
   - Un formulario: viaje (existente o nuevo), proveedor, datos del servicio, precio y tareas.
   - Crea la reserva de Traslado, envía la solicitud al portal del proveedor y programa las tareas.
   Usa las utilidades de app.js (db, api, send, loadAll, openModal, field, options…).
   ========================================================= */
(function () {
  const H = escapeHtml;
  const TT = window.TPTransfer;
  const PV = window.TPProv;
  let links = null;
  let moduleOn = true; // “Módulo de proveedor” (Configuración › Integraciones). Apagado = captura manual.
  const loadLinks = async () => { try { const r = await api('/api/supplier-portal/links'); links = r.suppliers || {}; moduleOn = r.enabled !== false; } catch { links = links || {}; } return links; };
  const hasPortal = (sid) => Boolean(moduleOn && sid && (links?.[sid] || []).some((u) => u.active));

  window.transferEligibility = (c) => TT.eligibility(c, db.quotes || []);
  window.transferButtonHtml = (c) => (canWrite('trips') && canWrite('followups') && TT.eligibility(c, db.quotes || []).ok
    ? `<button type="button" class="btn secondary small" data-transfer-client="${c.id}">🚐 Solicitar traslado</button>` : '');

  async function transferModal(clientId) {
    const c = clientById(clientId);
    if (!c) return;
    const elig = TT.eligibility(c, db.quotes || []);
    if (!elig.ok) { toast('Este cliente no tiene traslado incluido: márcalo en Datos del cliente › Incluye traslado'); return; }
    await loadLinks();
    const q = elig.quote;
    const det = q?.details || {};
    const lead = (q?.lead_id && db.leads.find((l) => l.id === q.lead_id)) || db.leads.find((l) => l.client_id === c.id);
    const trips = db.trips.filter((t) => t.client_id === c.id && t.status !== 'Cerrado').sort((a, b) => b.start_date.localeCompare(a.start_date));
    const firstTrip = trips[0];
    const start = det.startDate || lead?.start_date || firstTrip?.start_date || '';
    const end = det.endDate || lead?.end_date || firstTrip?.end_date || '';
    const paxNum = Number(String(det.pax || '').match(/\d+/)?.[0]) || Number(lead?.travelers) || 2;
    const sups = (db.suppliers || []).filter((s) => s.active !== false).sort((a, b) => (b.type === 'Traslados') - (a.type === 'Traslados') || a.name.localeCompare(b.name));
    const supDefault = sups.find((s) => s.type === 'Traslados' && hasPortal(s.id)) || sups.find((s) => s.type === 'Traslados') || sups[0];
    const destination = q?.destination || lead?.destination || firstTrip?.destination || '';

    const html = `<form class="modal-form tr-form">
      <p class="full muted-note">✓ ${H(elig.reason)}. ${moduleOn ? 'Se agrega la reserva de traslado al viaje, se pide el precio al proveedor y se programan las tareas de seguimiento.' : 'Se agrega la reserva de traslado al viaje con el precio que validaste con el proveedor (WhatsApp) y se crean la alerta de pago y la nota en el calendario.'}</p>
      <p class="full section-label">1 · Viaje</p>
      ${field('Viaje del cliente', `<select name="trip_choice">${trips.length ? options(trips.map((t) => [String(t.id), `${t.destination} · ${fmtDate(t.start_date)} al ${fmtDate(t.end_date)}`]), String(firstTrip.id)) : ''}<option value="new"${trips.length ? '' : ' selected'}>➕ Crear viaje nuevo</option></select>`, true)}
      <div class="full tr-new"${trips.length ? ' hidden' : ''}><div class="modal-form tr-grid">
        ${field('Destino*', `<input name="destination" maxlength="120" value="${H(destination)}" placeholder="Cancún">`)}
        ${field('Llegada*', `<input name="start_date" type="date" value="${H(start)}">`)}
        ${field('Regreso*', `<input name="end_date" type="date" value="${H(end)}">`)}
      </div></div>
      <p class="full section-label">2 · Proveedor</p>
      ${field('Proveedor de traslados*', `<select name="supplier_id" required>${sups.length ? options(sups.map((s) => [String(s.id), `${s.name} · ${s.type}${hasPortal(s.id) ? ' · con portal' : ''}`]), supDefault ? String(supDefault.id) : '') : '<option value="">Primero da de alta al proveedor en Proveedores</option>'}</select>`, true)}
      ${moduleOn ? `<label class="kb-check full"><input type="checkbox" name="send" data-tr-send> Enviar la solicitud de precio a su portal</label>
      <p class="full muted-note" data-tr-sendnote></p>` : ''}
      <p class="full section-label">3 · Servicio ${moduleOn ? '<small class="muted">(esto es lo único que ve el proveedor)</small>' : '<small class="muted">(datos del traslado)</small>'}</p>
      ${field('Tipo de servicio', `<select name="kind">${options(PV.SERVICE_KINDS, PV.SERVICE_KINDS[2])}</select>`)}
      ${field('Unidad o preferencia', '<input name="vehicle" maxlength="80" placeholder="Privado · Van · Suburban">')}
      ${field('Pasajero titular*', `<input name="passenger" required maxlength="120" value="${H(c.name)}">`)}
      ${field('WhatsApp del pasajero', `<input name="phone" maxlength="40" value="${H(c.phone || '')}">`)}
      ${field('Adultos', `<input name="adults" type="number" min="0" max="60" value="${paxNum}">`)}
      ${field('Menores', '<input name="minors" type="number" min="0" max="60" value="0">')}
      ${field('Fecha del servicio (llegada)*', `<input name="service_date" type="date" required value="${H(start)}">`)}
      ${field('Hora de recogida / llegada del vuelo', '<input name="pickup_time" type="time">')}
      ${field('Recoger en*', '<input name="pickup_place" required maxlength="160" value="Aeropuerto de Cancún (CUN)">')}
      ${field('Llevar a*', `<input name="dropoff_place" required maxlength="160" value="${H(q?.hotel && q.hotel !== 'Por definir' ? q.hotel : '')}" placeholder="Hotel">`)}
      ${field('Vuelo de llegada', '<input name="flight" maxlength="80" placeholder="Y4 123 · llega 13:40">', true)}
      ${field('Regreso: fecha', `<input name="return_date" type="date" value="${H(end)}">`)}
      ${field('Regreso: hora de recogida', '<input name="return_time" type="time">')}
      ${field('Vuelo de regreso', '<input name="return_flight" maxlength="80">', true)}
      ${field('Indicaciones para el proveedor', '<textarea name="notes" rows="2" maxlength="800" placeholder="Silla para bebé, equipaje extra, letrero con nombre…"></textarea>', true)}
      ${field('Precio de venta al cliente (MXN, opcional)', '<input name="price" inputmode="decimal" maxlength="14" placeholder="Para calcular tu utilidad">', true)}
      ${moduleOn ? '' : `<p class="full section-label">4 · Precio y pago <small class="muted">(valídalo con el proveedor por WhatsApp)</small></p>
      ${field('Costo del proveedor (MXN)*', '<input name="cost" inputmode="decimal" maxlength="14" required placeholder="Lo que le vas a pagar">')}
      ${field('Fecha de pago al proveedor', '<input name="supplier_due" type="date">')}
      ${field('Estado', `<select name="status">${options(['Confirmada', 'Solicitada', 'Por reservar'], 'Confirmada')}</select>`)}
      ${field('Clave / confirmación del proveedor', '<input name="confirmation" maxlength="60" placeholder="Opcional">')}
      <p class="full muted-note">Si dejas vacía la fecha de pago, se usa 5 días antes del viaje. La alerta de pago le llega al vendedor del cliente y a los administradores, y aparece en el calendario.</p>`}
      <p class="full section-label">${moduleOn ? '4' : '5'} · Tareas de seguimiento</p>
      ${TT.TASKS.filter((k) => moduleOn || k !== 'confirm').map((k) => `<label class="kb-check full"><input type="checkbox" name="task_${k}" checked> ${H(TT.TASK_LABELS[k])} <small class="muted">${k === 'confirm' ? '· mañana, si el proveedor no ha respondido' : k === 'pay' ? '· en la fecha de pago (5 días antes del viaje, editable)' : '· 2 días antes del servicio'}</small></label>`).join('')}
      <p class="full muted-note">Las tareas se cierran solas ${moduleOn ? 'cuando el proveedor responde, ' : ''}cuando marcas el traslado como pagado o si se cancela.</p>
      <div class="modal-actions"><button type="button" class="btn secondary" data-tr-back>Volver a la ficha</button><button type="submit" class="btn primary">${moduleOn ? '🚐 Solicitar traslado' : '🚐 Guardar traslado'}</button></div>
    </form>`;
    openModal('TRASLADO', `Solicitar traslado · ${c.name}`, html, { wide: true });
    const form = $('#modalBody form');
    const paintSend = () => {
      const sid = Number(form.supplier_id.value);
      const ok = hasPortal(sid);
      const box = form.querySelector('[data-tr-send]');
      box.disabled = !ok; box.checked = ok;
      const s = sups.find((x) => x.id === sid);
      form.querySelector('[data-tr-sendnote]').textContent = !s ? '' : ok ? `${s.name} recibirá la solicitud en su portal (y por correo). Cuando ponga su precio, lo aceptas desde Viajes › Reservas.` : `${s.name} no tiene acceso al portal: la reserva queda “Por reservar” y lo contactas tú.${isAdmin() ? ' Puedes darle acceso en Configuración › Usuarios (rol Proveedor).' : ''}`;
    };
    if (moduleOn) { paintSend(); form.supplier_id.onchange = paintSend; }
    form.trip_choice.onchange = () => {
      const isNew = form.trip_choice.value === 'new';
      form.querySelector('.tr-new').hidden = !isNew;
      const t = trips.find((x) => String(x.id) === form.trip_choice.value);
      if (t) { form.service_date.value = form.service_date.value || t.start_date; form.return_date.value = form.return_date.value || t.end_date; }
    };
    form.start_date.onchange = () => { if (!form.service_date.value) form.service_date.value = form.start_date.value; };
    form.end_date.onchange = () => { if (!form.return_date.value) form.return_date.value = form.end_date.value; };
    $('#modalBody [data-tr-back]').onclick = () => clientFile(c.id);
    bindForm(async (v) => {
      const isNew = v.trip_choice === 'new';
      if (isNew && (!v.destination.trim() || !v.start_date || !v.end_date)) { toast('Escribe el destino y las fechas del viaje nuevo'); return false; }
      const body = {
        trip_id: isNew ? null : Number(v.trip_choice),
        trip: isNew ? { destination: v.destination.trim(), start_date: v.start_date, end_date: v.end_date } : null,
        supplier_id: Number(v.supplier_id), send: moduleOn && Boolean(v.send), price: v.price,
        ...(moduleOn ? {} : { cost: v.cost, supplier_due: v.supplier_due, status: v.status, confirmation: v.confirmation }),
        details: { kind: v.kind, vehicle: v.vehicle, passenger: v.passenger, phone: v.phone, adults: Number(v.adults) || 0, minors: Number(v.minors) || 0, service_date: v.service_date, pickup_time: v.pickup_time, pickup_place: v.pickup_place, dropoff_place: v.dropoff_place, flight: v.flight, return_date: v.return_date, return_time: v.return_time, return_flight: v.return_flight, notes: v.notes },
        tasks: Object.fromEntries(TT.TASKS.filter((k) => moduleOn || k !== 'confirm').map((k) => [k, Boolean(v[`task_${k}`])]))
      };
      let r;
      try { r = await send('POST', `/api/clients/${c.id}/transfer`, body); } catch (e) { toast(e.message, 7000); return false; }
      await loadAll();
      doneModal(c, r);
      return false;
    });
  }

  function doneModal(c, r) {
    const folio = r.booking?.portal?.folio;
    const items = [
      r.created ? `✈️ Viaje creado: <b>${H(r.trip.destination)}</b> · ${H(fmtDate(r.trip.start_date))} al ${H(fmtDate(r.trip.end_date))}` : `✈️ Agregado al viaje <b>${H(r.trip.destination)}</b> · ${H(fmtDate(r.trip.start_date))}`,
      `🚐 Reserva de traslado con <b>${H(r.booking.supplier_name)}</b>${folio ? ` · folio <b>${H(folio)}</b>` : ''} · ${H(r.booking.status)}`,
      r.manual ? `💲 Costo ${H(String(r.booking.cost))} · pago al proveedor el ${H(fmtDate(r.booking.supplier_due))}` : r.sent ? '📨 Solicitud de precio enviada a su portal' : r.sendError ? `⚠️ No se pudo enviar al portal: ${H(r.sendError)}` : '📞 Sin portal: contacta tú al proveedor',
      ...(r.tasks || []).map((f) => `📌 ${H(f.title)} · <small>${H(fmtDue(f.due_at))}</small>`)
    ];
    openModal('TRASLADO', r.manual ? 'Traslado guardado' : 'Traslado solicitado', `<div class="modal-form"><ul class="full tr-done">${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      <div class="modal-actions"><button type="button" class="btn secondary" data-tr-file>Volver a la ficha</button><button type="button" class="btn primary" data-tr-bookings>Ver reservas del viaje</button></div></div>`);
    $('#modalBody [data-tr-file]').onclick = () => clientFile(c.id);
    $('#modalBody [data-tr-bookings]').onclick = () => { if (typeof bookingsModal === 'function') bookingsModal(r.trip.id); };
  }

  window.transferModal = transferModal;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-transfer-client]');
    if (el) transferModal(Number(el.dataset.transferClient));
  });
}());
