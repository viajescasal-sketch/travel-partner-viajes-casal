'use strict';

// Itinerario digital del viaje (TP-301): /viaje/<token>
(function () {
  const D = window.TPDocs;
  const token = (location.pathname.match(/\/viaje\/([a-f0-9]{40})/) || [])[1];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const WD = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const fmt = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : '');
  const fmtY = (iso) => (iso ? `${fmt(iso)} ${iso.slice(0, 4)}` : '');
  const wd = (iso) => WD[new Date(`${iso}T12:00:00Z`).getUTCDay()];
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const file = (id) => (Number(id) > 0 ? `/api/public/trip/${token}/file/${Number(id)}` : '');
  const mapUrl = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const tel = (p) => { const d = String(p || '').replace(/[^\d+]/g, ''); return d.replace(/\D/g, '').length >= 7 ? `tel:${d}` : ''; };
  const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const timeOf = (v) => { const t = String(v || '').split('|').pop().trim(); return t && t !== String(v || '').trim() ? t : ''; };

  async function load() {
    if (!token) return fail('Liga incompleta. Pide a tu Travel Partner una liga nueva.');
    try {
      const r = await fetch(`/api/public/trip/${token}`, { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || !data.ok) return fail(data.error || 'Este itinerario ya no está disponible.');
      render(data);
    } catch { fail('No pudimos cargar tu itinerario. Revisa tu conexión e intenta de nuevo.'); }
  }
  function fail(msg) {
    $('#heroTitle').textContent = 'Itinerario';
    $('#app').innerHTML = `<div class="err"><p>${esc(msg)}</p></div>`;
  }

  function render(p) {
    const trip = p.trip;
    const c = D.mergeConfirmation(trip.confirmation, D.confirmationDefaults({ ...p, seller: p.seller || {}, client: p.client }));
    const on = (k) => !!c.services?.[k];
    const saved = Array.isArray(trip.itinerary?.days) && trip.itinerary.days.length ? trip.itinerary.days : null;
    const plan = saved || D.buildItinerary(c, p);
    const today = p.today;
    const total = days(trip.start_date, trip.end_date) + 1;
    const first = String(p.client.name || '').trim().split(/\s+/)[0];

    // Encabezado
    document.title = `Mi viaje a ${trip.destination}`;
    $('#heroEyebrow').textContent = first ? `${first}, este es tu viaje` : 'Tu viaje';
    $('#heroTitle').textContent = trip.destination;
    $('#heroSub').textContent = `${fmt(trip.start_date)} al ${fmtY(trip.end_date)} · ${total} ${total === 1 ? 'día' : 'días'}${c.reservation ? ` · Reserva ${c.reservation}` : ''}`;
    const until = days(today, trip.start_date);
    const dayNo = days(trip.start_date, today) + 1;
    $('#heroCount').textContent = until > 1 ? `✈️ Faltan ${until} días` : until === 1 ? '✈️ ¡Mañana sales de viaje!' : until === 0 ? '🎉 ¡Hoy empieza tu viaje!' : dayNo <= total ? `🌴 Día ${dayNo} de ${total} · ¡Disfruta!` : '💙 Esperamos que lo hayas disfrutado';
    const cover = file(c.coverMediaId);
    if (cover) { $('#hero').classList.add('photo'); $('#hero').style.setProperty('--cover', `url("${cover}")`); }

    const sections = [];
    const add = (id, label, html) => { if (html) sections.push({ id, label, html }); };

    // Pagos pendientes
    let payHtml = '';
    if (p.payment) {
      const n = p.payment.next;
      payHtml = `<div class="card pay"><b>💳 Saldo pendiente: ${money(p.payment.balance)}</b><p class="muted" style="margin:4px 0 0">Pagado ${money(p.payment.paid)} de ${money(p.payment.total)}${n ? ` · Siguiente: ${esc(n.label)} ${money(n.amount)} antes del ${esc(fmtY(n.due))}` : ''}</p>${p.payment.url ? `<a class="btn coral" href="${esc(p.payment.url)}">Ver mi plan y pagar</a>` : ''}</div>`;
    }

    // Día por día
    add('dias', 'Día por día', plan.map((d, i) => {
      const cls = d.date === today ? ' today' : d.date < today ? ' past' : '';
      const body = lines(d.text).map((l) => { const m = /^(\d{1,2}:\d{2}(?:\s*(?:hrs|h|am|pm))?)\s+(.*)$/i.exec(l); return m ? `<div class="line"><time>${esc(m[1])}</time><span>${esc(m[2])}</span></div>` : `<div class="line nt"><span>${esc(l)}</span></div>`; }).join('');
      return `<article class="card day${cls}" id="dia-${i + 1}"><div class="day-h"><small>${d.date === today ? 'Hoy · ' : ''}Día ${i + 1}</small><span>${esc(wd(d.date))} ${esc(fmt(d.date))}</span></div><h3>${esc(d.title || `Día ${i + 1}`)}</h3>${body}${d.place ? `<a class="map" href="${esc(mapUrl(`${d.place} ${trip.destination}`))}" target="_blank" rel="noopener">📍 ${esc(d.place)} en el mapa</a>` : ''}</article>`;
    }).join(''));

    // Vuelos
    if (on('flight') && (c.outboundFlight || c.airline || c.flightBooking)) {
      const leg = (label, route, dep, arr) => `<div class="card flight"><small class="muted">${label}</small><div class="ft"><b>${esc(route || 'Por confirmar')}</b><span class="arrow">✈</span></div><div class="kv"><dt>Sale</dt><dd>${esc(dep || 'Por confirmar')}</dd><dt>Llega</dt><dd>${esc(arr || 'Por confirmar')}</dd></div></div>`;
      add('vuelos', 'Vuelos', `${c.airline || c.flightBooking ? `<div class="card"><div class="kv">${c.airline ? `<dt>Aerolínea</dt><dd>${esc(c.airline)}</dd>` : ''}${c.flightBooking ? `<dt>Clave de reservación</dt><dd>${esc(c.flightBooking)}</dd>` : ''}${c.baggage ? `<dt>Equipaje</dt><dd>${esc(c.baggage)}</dd>` : ''}</div>${c.flightTips ? `<p class="tip">${esc(c.flightTips)}</p>` : ''}</div>` : ''}${leg('Ida', c.outboundFlight, c.outboundDeparture, c.outboundArrival)}${leg('Regreso', c.returnFlight, c.returnDeparture, c.returnArrival)}`);
    }

    // Hotel
    if (on('hotel') && c.hotelName) {
      const img = file(c.hotelMediaId);
      add('hotel', 'Hotel', `<div class="card">${img ? `<img class="hotel-img" src="${esc(img)}" alt="${esc(c.hotelName)}">` : ''}<h3 style="margin:0 0 2px">${esc(c.hotelName)}</h3>${Number(c.hotelStars) ? `<div class="stars">${'★'.repeat(Math.min(5, Number(c.hotelStars)))}</div>` : ''}
        <div class="kv" style="margin-top:10px">${c.room ? `<dt>Habitación</dt><dd>${esc(c.room)}</dd>` : ''}${c.mealPlan ? `<dt>Plan</dt><dd>${esc(c.mealPlan)}</dd>` : ''}${c.checkin ? `<dt>Check-in</dt><dd>${esc(c.checkin)}</dd>` : ''}${c.checkout ? `<dt>Check-out</dt><dd>${esc(c.checkout)}</dd>` : ''}</div>
        ${c.hotelHighlights ? `<p class="tip">${esc(c.hotelHighlights)}</p>` : ''}
        <div class="row2"><a class="btn alt" href="${esc(mapUrl(`${c.hotelName} ${trip.destination}`))}" target="_blank" rel="noopener">📍 Cómo llegar</a>${tel(c.hotelPhone) ? `<a class="btn alt" href="${esc(tel(c.hotelPhone))}">📞 Llamar al hotel</a>` : ''}</div></div>`);
    }

    // Traslados, actividades y seguro
    if (on('transfer')) {
      const t = (label, o, d, date, time) => `<dt>${label}</dt><dd>${esc([o, d].filter(Boolean).join(' → ') || 'Por confirmar')}${date || time ? `\n${esc([date, time].filter(Boolean).join(' · '))}` : ''}</dd>`;
      add('traslados', 'Traslados', `<div class="card"><div class="kv">${t('Llegada', c.transferOutOrigin, c.transferOutDestination, c.transferOutDate, c.transferOutTime)}${t('Regreso', c.transferBackOrigin, c.transferBackDestination, c.transferBackDate, c.transferBackTime)}${c.operator ? `<dt>Operador</dt><dd>${esc(c.operator)}</dd>` : ''}${c.transferContact ? `<dt>Contacto</dt><dd>${esc(c.transferContact)}</dd>` : ''}</div></div>`);
    }
    if (on('activities') && lines(c.activitiesDetail).length) add('actividades', 'Actividades', `<div class="card"><ul class="list">${lines(c.activitiesDetail).map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`);
    if (on('insurance') && (c.insuranceProvider || c.insurancePolicy || c.insuranceDetail)) add('seguro', 'Seguro', `<div class="card"><div class="kv">${c.insuranceProvider ? `<dt>Aseguradora</dt><dd>${esc(c.insuranceProvider)}</dd>` : ''}${c.insurancePolicy ? `<dt>Póliza</dt><dd>${esc(c.insurancePolicy)}</dd>` : ''}</div>${c.insuranceDetail ? `<p class="tip">${esc(c.insuranceDetail)}</p>` : ''}</div>`);

    // Documentos
    if (p.vouchers.length) add('documentos', 'Documentos', `<div class="card">${p.vouchers.map((v) => `<div class="doc"><span>${v.mime === 'application/pdf' ? '📄' : '🖼'} ${esc(v.name)}</span><span><a href="${esc(file(v.id))}" target="_blank" rel="noopener">Ver</a><a href="${esc(file(v.id))}?download=1">Descargar</a></span></div>`).join('')}<p class="muted" style="margin:10px 0 0">Tip: descárgalos antes de salir por si no tienes señal.</p></div>`);

    // Contactos
    const s = p.seller;
    const sellerWa = D.waLink(s?.phone || p.agency.whatsapp, `Hola${s ? ` ${s.name.split(' ')[0]}` : ''}, te escribo por mi viaje a ${trip.destination}.`);
    const photo = s?.photoUrl ? s.photoUrl.replace(/^\/api\/media\/(\d+)$/, (_m, id) => file(id)) : '';
    const phones = [['Emergencias 24 h', c.emergencyPhone], ['Hotel', c.hotelPhone], ['Aerolínea', c.airlinePhone], ['Traslados', c.transferContact], ['Agencia', p.agency.whatsapp]].filter(([, v]) => v && tel(v));
    add('contacto', 'Contacto', `<div class="card">${s ? `<div class="contact">${photo ? `<img src="${esc(photo)}" alt="${esc(s.name)}">` : `<span class="av">${esc(s.name.slice(0, 1))}</span>`}<div><b>${esc(s.name)}</b><div class="muted">Tu Travel Partner · antes, durante y después de tu viaje</div></div></div>` : ''}${sellerWa ? `<a class="btn wa" href="${esc(sellerWa)}" target="_blank" rel="noopener">💬 Escribir por WhatsApp</a>` : ''}
      ${phones.map(([k, v]) => `<div class="phone"><span>${esc(k)}</span><a href="${esc(tel(v))}">${esc(v)}</a></div>`).join('')}</div>`);

    $('#chips').innerHTML = sections.map((x) => `<a href="#${x.id}">${esc(x.label)}</a>`).join('');
    $('#app').innerHTML = payHtml + sections.map((x) => `<section id="${x.id}"><h2>${esc(x.label)}</h2>${x.html}</section>`).join('');
    $('#foot').textContent = `${p.agency.name || 'Viajes Casal'}${p.agency.website ? ` · ${p.agency.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : ''}`;
    const todayCard = document.querySelector('.day.today');
    if (todayCard) setTimeout(() => todayCard.scrollIntoView({ block: 'center' }), 300);
  }

  load();
})();
