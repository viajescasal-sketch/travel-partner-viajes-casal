'use strict';

/* =========================================================
   TP-302 Vista Canvas y TP-303 Pasajeros: reglas compartidas
   entre la plataforma (navegador) y el servidor (Node).
   - Pasajeros: tipo por edad, avisos de documentos.
   - Canvas: bloques por día → cotización, itinerario y confirmación.
   ========================================================= */
(function (global) {
  const str = (v) => String(v ?? '').trim();
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isDate = (v) => DATE_RE.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const MESES_CAP = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const shortDate = (iso) => (isDate(iso) ? `${iso.slice(8, 10)} ${MESES_CAP[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
  const numOr = (v) => { if (v === '' || v == null) return ''; const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : ''; };

  /* =========================================================
     TP-303 · PASAJEROS
     ========================================================= */
  const DOC_TYPES = ['Pasaporte', 'INE', 'Visa', 'Acta de nacimiento', 'Licencia', 'Otro'];
  const PAX_TYPES = ['Adulto', 'Menor', 'Infante'];
  const MAX_PASSENGERS = 60;

  // Edad cumplida en una fecha (null si falta algún dato).
  function ageOn(birth, ref) {
    if (!isDate(birth) || !isDate(ref)) return null;
    let age = Number(ref.slice(0, 4)) - Number(birth.slice(0, 4));
    if (ref.slice(5) < birth.slice(5)) age -= 1;
    return age;
  }
  // Tipo de pasajero como lo usan aerolíneas: infante < 2, menor 2–11, adulto 12+ (edad al salir).
  function paxType(birth, ref, fallback = 'Adulto') {
    const age = ageOn(birth, ref);
    if (age == null || age < 0) return PAX_TYPES.includes(fallback) ? fallback : 'Adulto';
    return age < 2 ? 'Infante' : age < 12 ? 'Menor' : 'Adulto';
  }

  // Limpia un pasajero; devuelve null si no trae nombre.
  function cleanPassenger(raw, i = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const name = str(raw.name).replace(/\s+/g, ' ').slice(0, 120);
    if (!name) return null;
    const doc = DOC_TYPES.includes(raw.doc_type) ? raw.doc_type : '';
    return {
      id: /^[a-z0-9]{4,24}$/i.test(String(raw.id || '')) ? String(raw.id) : `p${Date.now().toString(36)}${i}`,
      name,
      birth_date: isDate(raw.birth_date) ? raw.birth_date : '',
      type: PAX_TYPES.includes(raw.type) ? raw.type : 'Adulto',
      holder: raw.holder === true,
      relation: str(raw.relation).slice(0, 40),
      doc_type: doc,
      doc_number: doc ? str(raw.doc_number).toUpperCase().replace(/\s+/g, '').slice(0, 30) : '',
      doc_expiry: doc && isDate(raw.doc_expiry) ? raw.doc_expiry : '',
      nationality: str(raw.nationality).slice(0, 40),
      phone: str(raw.phone).slice(0, 40),
      notes: str(raw.notes).slice(0, 300)
    };
  }
  // Lista final: sin vacíos, sin repetidos (mismo nombre o mismo documento), tipo calculado con la fecha de salida
  // y un solo titular (el primero marcado; si no hay, el primer adulto).
  function cleanPassengers(list, startDate) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).slice(0, MAX_PASSENGERS * 2).forEach((raw, i) => {
      const p = cleanPassenger(raw, i);
      if (!p) return;
      const key = p.doc_number ? `d:${p.doc_type}:${p.doc_number}` : `n:${p.name.toLowerCase()}`;
      if (seen.has(key) || seen.has(`n:${p.name.toLowerCase()}`)) return;
      seen.add(key); seen.add(`n:${p.name.toLowerCase()}`);
      p.type = paxType(p.birth_date, startDate, p.type);
      out.push(p);
    });
    const list2 = out.slice(0, MAX_PASSENGERS);
    let holder = list2.findIndex((p) => p.holder);
    if (holder < 0) holder = Math.max(list2.findIndex((p) => p.type === 'Adulto'), 0);
    list2.forEach((p, i) => { p.holder = list2.length > 0 && i === holder; });
    return list2;
  }

  // Avisos de documentos para un pasajero en un viaje. level: danger | warn | info
  function passengerAlerts(p, trip = {}) {
    const alerts = [];
    const start = trip.start_date, end = trip.end_date || trip.start_date;
    if (!p.birth_date) alerts.push({ level: 'info', text: 'Falta fecha de nacimiento' });
    if (!p.doc_type) { alerts.push({ level: 'info', text: 'Sin documento de viaje' }); return alerts; }
    if (!p.doc_number) alerts.push({ level: 'info', text: `Falta el número de ${p.doc_type.toLowerCase()}` });
    if (['Pasaporte', 'Visa', 'INE', 'Licencia'].includes(p.doc_type)) {
      if (!p.doc_expiry) alerts.push({ level: 'info', text: `Falta la vigencia ${p.doc_type === 'INE' ? 'de la INE' : `del ${p.doc_type.toLowerCase()}`}` });
      else if (isDate(start) && p.doc_expiry < start) alerts.push({ level: 'danger', text: `${p.doc_type} vencido antes de la salida` });
      else if (isDate(end) && p.doc_expiry < end) alerts.push({ level: 'danger', text: `${p.doc_type} vence durante el viaje` });
      else if (p.doc_type === 'Pasaporte' && isDate(end) && p.doc_expiry < addMonths(end, 6)) alerts.push({ level: 'warn', text: 'Pasaporte con menos de 6 meses de vigencia al regreso' });
    }
    return alerts;
  }
  function tripPassengerSummary(list, trip = {}, expected) {
    const l = Array.isArray(list) ? list : [];
    const count = { Adulto: 0, Menor: 0, Infante: 0 };
    l.forEach((p) => { count[p.type] = (count[p.type] || 0) + 1; });
    const alerts = l.map((p) => ({ p, alerts: passengerAlerts(p, trip) }));
    const danger = alerts.filter((a) => a.alerts.some((x) => x.level === 'danger')).length;
    const warn = alerts.filter((a) => a.alerts.some((x) => x.level === 'warn')).length;
    const parts = [];
    if (count.Adulto) parts.push(`${count.Adulto} ${count.Adulto === 1 ? 'adulto' : 'adultos'}`);
    if (count.Menor) parts.push(`${count.Menor} ${count.Menor === 1 ? 'menor' : 'menores'}`);
    if (count.Infante) parts.push(`${count.Infante} ${count.Infante === 1 ? 'infante' : 'infantes'}`);
    const missing = Number(expected) > l.length ? Number(expected) - l.length : 0;
    return { total: l.length, count, text: parts.join(' + '), danger, warn, missing };
  }
  // Renglones para la confirmación de servicios: "Nombre (menor, 8 años)".
  function passengerLines(list, startDate) {
    return (Array.isArray(list) ? list : []).map((p) => {
      const age = ageOn(p.birth_date, startDate);
      const tag = p.type === 'Adulto' ? '' : ` (${p.type.toLowerCase()}${age != null ? `, ${age} ${age === 1 ? 'año' : 'años'}` : ''})`;
      return `${p.name}${tag}`;
    }).join('\n');
  }
  // Acompañantes frecuentes del cliente (se guardan sin datos del viaje).
  function companionFrom(p) {
    const c = cleanPassenger(p);
    if (!c) return null;
    delete c.holder; delete c.type;
    return c;
  }
  function mergeCompanions(current, passengers, clientName) {
    const list = (Array.isArray(current) ? current : []).map(companionFrom).filter(Boolean);
    const self = str(clientName).toLowerCase();
    for (const p of passengers || []) {
      const c = companionFrom(p);
      if (!c) continue;
      if (self && c.name.toLowerCase() === self) c.relation = c.relation || 'Titular';
      const i = list.findIndex((x) => (c.doc_number && x.doc_number === c.doc_number) || x.name.toLowerCase() === c.name.toLowerCase());
      if (i >= 0) list[i] = { ...list[i], ...Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== '' && k !== 'id')) };
      else list.push(c);
    }
    return list.slice(0, 40);
  }

  /* =========================================================
     TP-302 · CANVAS DEL VIAJE
     ========================================================= */
  const BLOCKS = {
    vuelo: { label: 'Vuelo', icon: '✈️' },
    traslado: { label: 'Traslado', icon: '🚐' },
    hotel: { label: 'Hotel', icon: '🏨' },
    tour: { label: 'Tour / actividad', icon: '🎟️' },
    seguro: { label: 'Seguro', icon: '🛡️' },
    nota: { label: 'Nota', icon: '📝' }
  };
  const BLOCK_TYPES = Object.keys(BLOCKS);
  const MAX_BLOCKS = 80;
  const MAX_DAYS = 45;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function newBlockId() { return `b${Math.random().toString(36).slice(2, 9)}`; }
  function canvasDays(c) {
    if (!isDate(c?.start_date) || !isDate(c?.end_date) || c.end_date < c.start_date) return 1;
    return Math.min(daysBetween(c.start_date, c.end_date) + 1, MAX_DAYS);
  }
  function cleanBlock(raw, maxDay) {
    if (!raw || typeof raw !== 'object' || !BLOCK_TYPES.includes(raw.type)) return null;
    const t = (k, n = 120) => str(raw[k]).slice(0, n);
    const b = {
      id: /^b[a-z0-9]{3,12}$/.test(String(raw.id || '')) ? raw.id : newBlockId(),
      type: raw.type,
      day: Math.min(Math.max(parseInt(raw.day, 10) || 0, 0), maxDay),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
      time: TIME_RE.test(str(raw.time)) ? str(raw.time) : '',
      title: t('title') || BLOCKS[raw.type].label,
      provider: t('provider'),
      notes: t('notes', 600),
      cost: numOr(raw.cost),
      price: numOr(raw.price),
      supplier_id: Number.isInteger(Number(raw.supplier_id)) && Number(raw.supplier_id) > 0 ? Number(raw.supplier_id) : null
    };
    if (b.type === 'vuelo') Object.assign(b, { airline: t('airline', 60), flight: t('flight', 20), from: t('from', 60), to: t('to', 60), arrival: TIME_RE.test(str(raw.arrival)) ? str(raw.arrival) : '' });
    if (b.type === 'traslado') Object.assign(b, { from: t('from', 80), to: t('to', 80) });
    if (b.type === 'hotel') Object.assign(b, { nights: Math.min(Math.max(parseInt(raw.nights, 10) || 1, 1), MAX_DAYS), room: t('room'), plan: t('plan', 80), stars: ['3', '4', '5'].includes(String(raw.stars)) ? String(raw.stars) : '5' });
    if (b.type === 'tour') b.place = t('place');
    return b;
  }
  function normalizeCanvas(raw, seed = {}) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const out = {
      version: 1,
      destination: str(c.destination || seed.destination).slice(0, 120),
      start_date: isDate(c.start_date) ? c.start_date : isDate(seed.start_date) ? seed.start_date : '',
      end_date: isDate(c.end_date) ? c.end_date : isDate(seed.end_date) ? seed.end_date : '',
      pax: str(c.pax ?? seed.pax).slice(0, 80),
      travelers: Math.min(Math.max(parseInt(c.travelers ?? seed.travelers, 10) || 0, 0), 500) || '',
      quote_id: Number.isInteger(Number(c.quote_id)) && Number(c.quote_id) > 0 ? Number(c.quote_id) : null,
      updated_at: str(c.updated_at).slice(0, 19)
    };
    if (out.end_date && out.start_date && out.end_date < out.start_date) out.end_date = out.start_date;
    const maxDay = canvasDays(out) - 1;
    out.blocks = (Array.isArray(c.blocks) ? c.blocks : []).slice(0, MAX_BLOCKS).map((b) => cleanBlock(b, maxDay)).filter(Boolean);
    sortBlocks(out);
    return out;
  }
  // Orden dentro del día: el que el vendedor dejó (order) y luego la hora.
  function sortBlocks(c) {
    c.blocks.sort((a, b) => a.day - b.day || a.order - b.order || (a.time || '99').localeCompare(b.time || '99'));
    let day = -1, n = 0;
    c.blocks.forEach((b) => { if (b.day !== day) { day = b.day; n = 0; } b.order = n++; });
    return c;
  }
  function canvasTotals(c) {
    const sum = (k) => c.blocks.reduce((s, b) => s + (Number(b[k]) || 0), 0);
    const cost = Math.round(sum('cost') * 100) / 100, price = Math.round(sum('price') * 100) / 100;
    const travelers = Number(c.travelers) || 0;
    return { cost, price, profit: Math.round((price - cost) * 100) / 100, margin: price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0, perPerson: travelers ? Math.round(price / travelers) : null, missingPrice: c.blocks.filter((b) => b.type !== 'nota' && b.price === '').length };
  }
  const dateOf = (c, day) => (isDate(c.start_date) ? addDays(c.start_date, day) : '');
  const byType = (c, type) => c.blocks.filter((b) => b.type === type);
  const blockLine = (b) => `${b.time ? `${b.time} ` : ''}${BLOCKS[b.type].icon} ${b.title}${b.provider ? ` · ${b.provider}` : ''}`;

  // Canvas → cotización en el formato del Cotizador (paquete).
  function canvasToQuote(raw, ctx = {}) {
    const c = normalizeCanvas(raw, ctx);
    const flights = byType(c, 'vuelo'), hotels = byType(c, 'hotel'), transfers = byType(c, 'traslado'), tours = byType(c, 'tour'), insurance = byType(c, 'seguro');
    const services = { vuelo: flights.length > 0, hotel: hotels.length > 0, traslados: transfers.length > 0, tours: tours.length > 0, seguro: insurance.length > 0 };
    const parts = {};
    if (services.vuelo) {
      const f = flights[0], r = flights.length > 1 ? flights[flights.length - 1] : null;
      parts.vuelo = { aerolinea: f.airline || f.provider || '', origen: f.from || '', equipaje: f.notes || '', hsIda: f.time, hlIda: f.arrival || '', hsReg: r?.time || '', hlReg: r?.arrival || '' };
    }
    if (services.hotel) {
      const stays = hotels.map((h) => `${h.title}: ${h.nights} ${h.nights === 1 ? 'noche' : 'noches'}${dateOf(c, h.day) ? ` desde el ${shortDate(dateOf(c, h.day))}` : ''}`);
      parts.hotel = { hotel: hotels.map((h) => h.title).join(' + ').slice(0, 120), stars: hotels[0].stars || '5', room: hotels[0].room || '', plan: hotels[0].plan || '', desc: [hotels.length > 1 ? stays.join('\n') : '', hotels.map((h) => h.notes).filter(Boolean).join('\n')].filter(Boolean).join('\n').slice(0, 600) };
    }
    if (services.traslados) {
      const tipo = transfers.length >= 2 ? 'Redondo' : transfers[0].day === 0 ? 'Solo llegada' : 'Solo regreso';
      parts.traslados = { tipo, desc: transfers.map((t) => [t.from, t.to].filter(Boolean).join(' → ') || t.title).join(' · ').slice(0, 200) };
    }
    if (services.tours) {
      const items = tours.slice(0, 3).map((t) => ({ nombre: t.title, precio: 'Incluido', desc: [dateOf(c, t.day) ? shortDate(dateOf(c, t.day)) : '', t.notes].filter(Boolean).join(' · ').slice(0, 200) }));
      if (tours.length > 3) items[2].desc = `${items[2].desc ? `${items[2].desc} · ` : ''}También: ${tours.slice(3).map((t) => t.title).join(', ')}`.slice(0, 200);
      parts.tours = { promo: 'Incluidos en tu paquete', items };
    }
    if (services.seguro) parts.seguro = { cobertura: insurance.map((s) => [s.title, s.provider, s.notes].filter(Boolean).join(' · ')).join('\n').slice(0, 600) };
    const varying = services.hotel ? 'hotel' : ['vuelo', 'traslados', 'tours', 'seguro'].find((k) => services[k]) || 'hotel';
    if (!services[varying]) services[varying] = true;
    const totals = canvasTotals(c);
    const fixed = {};
    Object.keys(parts).forEach((k) => { if (k !== varying) fixed[k] = parts[k]; });
    const travelers = Number(c.travelers) || 0;
    const details = {
      version: 1, pax: c.pax || (travelers ? `${travelers} ${travelers === 1 ? 'pasajero' : 'pasajeros'}` : ''),
      startDate: c.start_date, endDate: c.end_date, linkOnline: '', heroMediaId: null,
      services, varying, principal: 0, fixed,
      proposals: [{ [varying]: parts[varying] || {}, price: { total: totals.price ? String(totals.price) : '', pp: totals.perPerson ? String(totals.perPerson) : '', base: travelers ? `${travelers} ${travelers === 1 ? 'pasajero' : 'pasajeros'}` : '' }, pay: { esquema: 'anticipo' } }],
      canvas: c
    };
    const hotelLabel = services.hotel ? `${parts.hotel.hotel}${parts.hotel.plan ? ` — ${parts.hotel.plan}` : ''}` : 'Paquete armado en Canvas';
    const summary = [];
    for (let d = 0; d < canvasDays(c); d += 1) {
      const blocks = c.blocks.filter((b) => b.day === d);
      if (blocks.length) summary.push(`Día ${d + 1}${dateOf(c, d) ? ` (${shortDate(dateOf(c, d))})` : ''}: ${blocks.map((b) => `${BLOCKS[b.type].icon} ${b.title}`).join(', ')}`);
    }
    return { destination: c.destination || 'Destino por confirmar', hotel: hotelLabel.slice(0, 200), price: totals.price, services: summary.join('\n').slice(0, 4000), details };
  }

  // Canvas → itinerario día por día del viaje (mismas fechas que el viaje).
  function canvasToItinerary(raw, trip) {
    const c = normalizeCanvas(raw, trip);
    const start = trip?.start_date || c.start_date, end = trip?.end_date || c.end_date;
    if (!isDate(start) || !isDate(end) || end < start) return [];
    const total = Math.min(daysBetween(start, end), 60);
    const dest = c.destination || trip?.destination || '';
    const hotels = byType(c, 'hotel');
    const days = [];
    for (let i = 0; i <= total; i += 1) {
      const lines = [];
      let title = '', place = '';
      const blocks = c.blocks.filter((b) => b.day === i);
      hotels.filter((h) => h.day + h.nights === i && i > 0).forEach((h) => lines.push(`${BLOCKS.hotel.icon} Check-out de ${h.title}`));
      blocks.forEach((b) => {
        let line = blockLine(b);
        if (b.type === 'vuelo') line = `${b.time ? `${b.time} ` : ''}✈️ Vuelo ${[b.airline, b.flight].filter(Boolean).join(' ')}${b.from || b.to ? ` ${[b.from, b.to].filter(Boolean).join(' → ')}` : ''}${b.arrival ? ` · llegada ${b.arrival}` : ''}`.replace(/\s+/g, ' ').trim();
        if (b.type === 'hotel') line = `${b.time ? `${b.time} ` : ''}🏨 Check-in en ${b.title}${b.plan ? ` (${b.plan})` : ''} · ${b.nights} ${b.nights === 1 ? 'noche' : 'noches'}`;
        if (b.type === 'traslado' && (b.from || b.to)) line = `${b.time ? `${b.time} ` : ''}🚐 Traslado ${[b.from, b.to].filter(Boolean).join(' → ')}${b.provider ? ` · ${b.provider}` : ''}`;
        lines.push(line);
        if (b.notes && b.type !== 'seguro') lines.push(`   ${b.notes}`);
      });
      const tour = blocks.find((b) => b.type === 'tour');
      const checkIn = blocks.find((b) => b.type === 'hotel');
      const staying = hotels.find((h) => h.day <= i && i < h.day + h.nights) || hotels.find((h) => h.day + h.nights === i);
      if (tour) { title = tour.title; place = tour.place || tour.title; }
      else if (i === 0) title = `Llegada a ${dest}`.trim();
      else if (i === total && total > 0) title = 'Regreso a casa';
      else if (checkIn) title = `Cambio a ${checkIn.title}`;
      else title = `Día libre en ${dest}`.trim();
      if (!place && staying) place = staying.title;
      if (!lines.length) lines.push(staying?.plan ? `Disfruta tu hotel (${staying.plan}) o las actividades del destino.` : 'Disfruta el destino a tu ritmo.');
      days.push({ date: addDays(start, i), title: title.slice(0, 80), text: lines.join('\n').slice(0, 1500), place: place.slice(0, 120) });
    }
    return days;
  }

  // Canvas → campos de la Confirmación de servicios (solo los que el lienzo conoce).
  function canvasToConfirmation(raw, trip) {
    const c = normalizeCanvas(raw, trip);
    const start = trip?.start_date || c.start_date;
    const on = (day) => (isDate(start) ? addDays(start, day) : '');
    const withTime = (date, time) => [shortDate(date), time].filter(Boolean).join(' | ');
    const flights = byType(c, 'vuelo'), hotels = byType(c, 'hotel'), transfers = byType(c, 'traslado'), tours = byType(c, 'tour'), insurance = byType(c, 'seguro');
    const out = { services: { flight: flights.length > 0, hotel: hotels.length > 0, transfer: transfers.length > 0, activities: tours.length > 0, insurance: insurance.length > 0, partner: true } };
    if (c.travelers) out.travelers = c.travelers;
    if (flights.length) {
      const f = flights[0], r = flights.length > 1 ? flights[flights.length - 1] : null;
      const route = (b) => [b.flight, [b.from, b.to].filter(Boolean).join(' → ')].filter(Boolean).join(' ');
      Object.assign(out, { airline: f.airline || f.provider || '', outboundFlight: route(f), outboundDeparture: withTime(on(f.day), f.time), outboundArrival: withTime(on(f.day), f.arrival) });
      if (f.notes) out.baggage = f.notes;
      if (r) Object.assign(out, { returnFlight: route(r), returnDeparture: withTime(on(r.day), r.time), returnArrival: withTime(on(r.day), r.arrival) });
    }
    if (hotels.length) {
      const h = hotels[0], last = hotels[hotels.length - 1];
      Object.assign(out, {
        hotelName: hotels.map((x) => x.title).join(' + ').slice(0, 300), hotelStars: h.stars || '5', room: h.room || '', mealPlan: h.plan || '',
        checkin: withTime(on(h.day), h.time || '15:00 hrs'), checkout: withTime(on(last.day + last.nights), '12:00 hrs')
      });
      if (hotels.some((x) => x.notes)) out.hotelHighlights = hotels.map((x) => x.notes).filter(Boolean).join('\n').slice(0, 1500);
    }
    if (transfers.length) {
      const t = transfers[0], b = transfers.length > 1 ? transfers[transfers.length - 1] : null;
      Object.assign(out, { operator: t.provider || '', transferOutOrigin: t.from || 'Aeropuerto', transferOutDestination: t.to || hotels[0]?.title || '', transferOutDate: shortDate(on(t.day)), transferOutTime: t.time });
      if (b) Object.assign(out, { transferBackOrigin: b.from || hotels[hotels.length - 1]?.title || '', transferBackDestination: b.to || 'Aeropuerto', transferBackDate: shortDate(on(b.day)), transferBackTime: b.time });
    }
    if (tours.length) out.activitiesDetail = tours.map((t) => [shortDate(on(t.day)), t.time, `— ${t.title}`, t.provider ? `(${t.provider})` : '', t.place ? `· ${t.place}` : ''].filter(Boolean).join(' ')).join('\n').slice(0, 1500);
    if (insurance.length) Object.assign(out, { insuranceProvider: insurance[0].provider || '', insuranceDetail: insurance.map((s) => [s.title, s.notes].filter(Boolean).join(' · ')).join('\n').slice(0, 1500) });
    return out;
  }

  // Lienzo inicial a partir de una confirmación o cotización existente (para viajes que no se armaron en Canvas).
  function canvasFromTrip(trip, quoteDetails) {
    if (quoteDetails?.canvas) return normalizeCanvas({ ...quoteDetails.canvas, start_date: trip.start_date, end_date: trip.end_date, destination: trip.destination }, trip);
    const c = normalizeCanvas({}, trip);
    const conf = trip.confirmation || {};
    const last = canvasDays(c) - 1;
    const timeOf = (v) => { const m = String(v || '').match(/(\d{1,2}:\d{2})/); return m ? m[1].padStart(5, '0') : ''; };
    const push = (b) => c.blocks.push(cleanBlock({ ...b, order: c.blocks.length }, last));
    if (conf.services?.flight !== false && (conf.airline || conf.outboundFlight)) {
      push({ type: 'vuelo', day: 0, title: 'Vuelo de ida', airline: conf.airline, flight: '', from: '', to: '', time: timeOf(conf.outboundDeparture), arrival: timeOf(conf.outboundArrival), notes: conf.baggage });
      if (conf.returnFlight || conf.returnDeparture) push({ type: 'vuelo', day: last, title: 'Vuelo de regreso', airline: conf.airline, time: timeOf(conf.returnDeparture), arrival: timeOf(conf.returnArrival) });
    }
    if (conf.services?.transfer !== false && conf.transferOutOrigin) push({ type: 'traslado', day: 0, title: 'Traslado de llegada', from: conf.transferOutOrigin, to: conf.transferOutDestination, provider: conf.operator, time: timeOf(conf.transferOutTime) });
    if (conf.services?.hotel !== false && conf.hotelName) push({ type: 'hotel', day: 0, title: conf.hotelName, nights: Math.max(last, 1), room: conf.room, plan: conf.mealPlan, stars: conf.hotelStars });
    if (conf.services?.transfer !== false && conf.transferBackOrigin && last > 0) push({ type: 'traslado', day: last, title: 'Traslado de regreso', from: conf.transferBackOrigin, to: conf.transferBackDestination, provider: conf.operator, time: timeOf(conf.transferBackTime) });
    return sortBlocks(c);
  }


  /* =========================================================
     TP-305 · CATÁLOGO DE PROVEEDORES
     ========================================================= */
  const SUPPLIER_TYPES = ['Hotel', 'Mayorista', 'Operador de tours', 'Traslados', 'Aerolínea', 'Seguro', 'Otro'];
  // TP-205: tarifa neta (ganas venta − costo) o comisionable (el proveedor te paga un % después del viaje).
  const PROFIT_MODELS = ['neta', 'comision'];
  const PROFIT_MODEL_LABELS = { neta: 'Tarifa neta', comision: 'Comisionable' };
  const COMMISSION_STATUSES = ['Pendiente', 'Facturada', 'Cobrada', 'Cancelada'];
  const COMMISSION_DAYS_DEFAULT = 30;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function cleanSupplier(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const t = (k, n) => str(r[k]).slice(0, n);
    const name = t('name', 120).replace(/\s+/g, ' ');
    if (!name) throw Object.assign(new Error('El nombre del proveedor es obligatorio'), { status: 400, expose: true });
    const email = t('email', 160).toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw Object.assign(new Error('El correo del proveedor no es válido'), { status: 400, expose: true });
    const commission = r.commission === '' || r.commission == null ? '' : Number(String(r.commission).replace(/[^0-9.]/g, ''));
    if (commission !== '' && (!Number.isFinite(commission) || commission < 0 || commission > 100)) throw Object.assign(new Error('La comisión debe estar entre 0 y 100 %'), { status: 400, expose: true });
    const website = t('website', 200);
    // TP-205: cómo se gana con el proveedor y en cuántos días se cobra la comisión después del viaje.
    const days = r.commission_days === '' || r.commission_days == null ? '' : Math.round(Number(r.commission_days));
    if (days !== '' && (!Number.isFinite(days) || days < 0 || days > 365)) throw Object.assign(new Error('Los días para cobrar la comisión deben estar entre 0 y 365'), { status: 400, expose: true });
    return {
      name, type: SUPPLIER_TYPES.includes(r.type) ? r.type : 'Otro',
      model: PROFIT_MODELS.includes(r.model) ? r.model : 'neta',
      commission_days: days,
      destinations: t('destinations', 200), contact_name: t('contact_name', 120), phone: t('phone', 40), whatsapp: t('whatsapp', 40), email,
      website: website && !/^https?:\/\//i.test(website) ? `https://${website}` : website,
      commission: commission === '' ? '' : Math.round(commission * 100) / 100,
      rates: t('rates', 3000), payment_terms: t('payment_terms', 300), notes: t('notes', 2000),
      active: r.active !== false
    };
  }
  // Costo neto a partir del precio público y la comisión del proveedor.
  const netFromCommission = (price, commission) => (price === '' || commission === '' || commission == null ? '' : Math.round(Number(price) * (1 - Number(commission) / 100) * 100) / 100);
  const findSupplierByName = (suppliers, name) => { const n = str(name).toLowerCase(); return n ? (suppliers || []).find((x) => x.name.toLowerCase() === n) || null : null; };

  /* =========================================================
     TP-304 · RESERVAS CENTRALIZADAS
     ========================================================= */
  const BOOKING_TYPES = ['Vuelo', 'Hotel', 'Traslado', 'Tour', 'Seguro', 'Otro'];
  const BOOKING_STATUSES = ['Por reservar', 'Solicitada', 'Confirmada', 'Cancelada'];
  const BOOKING_ICONS = { Vuelo: '✈️', Hotel: '🏨', Traslado: '🚐', Tour: '🎟️', Seguro: '🛡️', Otro: '📌' };
  const MAX_BOOKINGS = 40;
  function cleanBooking(raw, i = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const t = (k, n = 120) => str(raw[k]).slice(0, n);
    const b = {
      id: /^r[a-z0-9]{3,16}$/i.test(String(raw.id || '')) ? String(raw.id) : `r${Date.now().toString(36)}${i}`,
      type: BOOKING_TYPES.includes(raw.type) ? raw.type : 'Otro',
      status: BOOKING_STATUSES.includes(raw.status) ? raw.status : 'Por reservar',
      supplier_id: Number.isInteger(Number(raw.supplier_id)) && Number(raw.supplier_id) > 0 ? Number(raw.supplier_id) : null,
      supplier_name: t('supplier_name'),
      confirmation: t('confirmation', 60),
      description: t('description', 300),
      start_date: isDate(raw.start_date) ? raw.start_date : '',
      end_date: isDate(raw.end_date) ? raw.end_date : '',
      time: TIME_RE.test(str(raw.time)) ? str(raw.time) : '',
      cost: numOr(raw.cost), price: numOr(raw.price),
      supplier_due: isDate(raw.supplier_due) ? raw.supplier_due : '',
      supplier_paid: raw.supplier_paid === true,
      voucher_ids: (Array.isArray(raw.voucher_ids) ? raw.voucher_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10),
      source: /^b[a-z0-9]{3,12}$/.test(String(raw.source || '')) ? raw.source : '',
      notes: t('notes', 1000),
      // TP-205: comisión del proveedor
      model: PROFIT_MODELS.includes(raw.model) ? raw.model : 'neta',
      commission_pct: '', commission_amount: '', commission_due: '', commission_status: 'Pendiente', commission_invoice: '', commission_paid_at: ''
    };
    if (b.end_date && b.start_date && b.end_date < b.start_date) b.end_date = b.start_date;
    if (b.model === 'comision') {
      const pct = numOr(raw.commission_pct);
      b.commission_pct = pct === '' ? '' : Math.min(pct, 100);
      b.commission_amount = numOr(raw.commission_amount);
      if (b.commission_amount === '' && b.commission_pct !== '' && b.price !== '') b.commission_amount = Math.round(b.price * b.commission_pct) / 100;
      b.commission_due = isDate(raw.commission_due) ? raw.commission_due : '';
      b.commission_status = COMMISSION_STATUSES.includes(raw.commission_status) ? raw.commission_status : 'Pendiente';
      b.commission_invoice = t('commission_invoice', 60);
      b.commission_paid_at = b.commission_status === 'Cobrada' && isDate(raw.commission_paid_at) ? raw.commission_paid_at : '';
    }
    if (!b.description && !b.supplier_name && !b.confirmation) return null;
    return b;
  }
  function cleanBookings(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_BOOKINGS).map(cleanBooking).filter(Boolean)
      .sort((a, b) => (a.start_date || '9999').localeCompare(b.start_date || '9999') || (a.time || '99').localeCompare(b.time || '99'));
  }
  // Avisos por reserva. today = AAAA-MM-DD (Cancún).
  function bookingAlerts(b, trip = {}, today = '') {
    const out = [];
    if (b.status === 'Cancelada') return out;
    const daysTo = (d) => (isDate(d) && isDate(today) ? daysBetween(today, d) : null);
    const toTrip = daysTo(trip.start_date);
    if (b.status === 'Por reservar') out.push({ level: toTrip != null && toTrip <= 30 ? 'danger' : 'warn', text: toTrip != null && toTrip <= 30 ? `Sin reservar y el viaje sale en ${Math.max(toTrip, 0)} días` : 'Sin reservar' });
    if (b.status === 'Solicitada') out.push({ level: toTrip != null && toTrip <= 15 ? 'danger' : 'info', text: 'Esperando confirmación del proveedor' });
    if (b.status === 'Confirmada' && !b.confirmation) out.push({ level: 'warn', text: 'Confirmada sin número de confirmación' });
    if (b.supplier_due && !b.supplier_paid) {
      const d = daysTo(b.supplier_due);
      if (d != null && d < 0) out.push({ level: 'danger', text: `Pago al proveedor vencido (${-d} ${d === -1 ? 'día' : 'días'})` });
      else if (d != null && d <= 7) out.push({ level: 'warn', text: d === 0 ? 'Pagar al proveedor hoy' : `Pagar al proveedor en ${d} ${d === 1 ? 'día' : 'días'}` });
    }
    const ca = commissionAlert(b, today);
    if (ca) out.push(ca);
    return out;
  }
  // TP-205: utilidad de una reserva. Tarifa neta: venta − costo. Comisionable: la comisión del proveedor.
  // null = todavía no hay datos para calcularla (falta costo o comisión).
  function bookingProfit(b) {
    if (!b || b.status === 'Cancelada') return 0;
    if (b.model === 'comision') {
      if (b.commission_status === 'Cancelada') return 0;
      if (b.commission_amount !== '' && b.commission_amount != null) return Number(b.commission_amount) || 0;
      if (b.commission_pct !== '' && b.commission_pct != null && b.price !== '' && b.price != null) return Math.round(Number(b.price) * Number(b.commission_pct)) / 100;
      return null;
    }
    if (b.cost === '' || b.cost == null) return null;
    return (Number(b.price) || 0) - (Number(b.cost) || 0);
  }
  // Comisión por cobrar al proveedor (comisionable, no cobrada ni cancelada).
  const commissionOpen = (b) => Boolean(b && b.status !== 'Cancelada' && b.model === 'comision' && !['Cobrada', 'Cancelada'].includes(b.commission_status));
  const commissionDueDefault = (b, trip = {}, supplier = null) => {
    const base = b.end_date || trip.end_date || b.start_date || trip.start_date;
    if (!isDate(base)) return '';
    const days = supplier && supplier.commission_days !== '' && supplier.commission_days != null ? Number(supplier.commission_days) : COMMISSION_DAYS_DEFAULT;
    return addDays(base, days);
  };
  function commissionAlert(b, today = '') {
    if (!commissionOpen(b) || !b.commission_due || !isDate(today)) return null;
    const d = daysBetween(today, b.commission_due);
    if (d < 0) return { level: 'warn', text: `Comisión por cobrar vencida (${-d} ${d === -1 ? 'día' : 'días'})` };
    return null;
  }
  function bookingsSummary(list, trip = {}, today = '') {
    const l = (Array.isArray(list) ? list : []).filter((b) => b.status !== 'Cancelada');
    const confirmed = l.filter((b) => b.status === 'Confirmada').length;
    const alerts = l.flatMap((b) => bookingAlerts(b, trip, today));
    const sum = (k) => Math.round(l.reduce((s, b) => s + (Number(b[k]) || 0), 0) * 100) / 100;
    const owed = Math.round(l.filter((b) => !b.supplier_paid).reduce((s, b) => s + (Number(b.cost) || 0), 0) * 100) / 100;
    const profits = l.map(bookingProfit);
    const known = profits.filter((p) => p != null);
    const commission = Math.round(l.filter((b) => b.model === 'comision').reduce((s, b) => s + (bookingProfit(b) || 0), 0) * 100) / 100;
    const toCollect = Math.round(l.filter(commissionOpen).reduce((s, b) => s + (bookingProfit(b) || 0), 0) * 100) / 100;
    return { total: l.length, confirmed, pending: l.length - confirmed, danger: alerts.filter((a) => a.level === 'danger').length, warn: alerts.filter((a) => a.level === 'warn').length, cost: sum('cost'), price: sum('price'), owed, profit: known.length ? Math.round(known.reduce((s, p) => s + p, 0) * 100) / 100 : null, profitMissing: profits.length - known.length, commission, toCollect };
  }
  const CANVAS_TO_BOOKING = { vuelo: 'Vuelo', hotel: 'Hotel', traslado: 'Traslado', tour: 'Tour', seguro: 'Seguro' };
  // Reservas a partir del lienzo del viaje (una por bloque; no repite las que ya existen).
  function bookingsFromCanvas(canvas, trip, existing = [], suppliers = []) {
    const c = normalizeCanvas(canvas, trip);
    const start = trip?.start_date || c.start_date;
    const on = (day) => (isDate(start) ? addDays(start, day) : '');
    const have = new Set((existing || []).map((b) => b.source).filter(Boolean));
    const out = [];
    c.blocks.filter((b) => CANVAS_TO_BOOKING[b.type] && !have.has(b.id)).forEach((b, i) => {
      const sup = (b.supplier_id && (suppliers || []).find((x) => x.id === b.supplier_id)) || findSupplierByName(suppliers, b.provider) || (b.type === 'vuelo' ? findSupplierByName(suppliers, b.airline) : null);
      const desc = b.type === 'vuelo' ? [b.title, b.airline, b.flight, [b.from, b.to].filter(Boolean).join(' → ')].filter(Boolean).join(' · ')
        : b.type === 'hotel' ? [b.title, b.room, b.plan, `${b.nights} ${b.nights === 1 ? 'noche' : 'noches'}`].filter(Boolean).join(' · ')
          : b.type === 'traslado' ? [b.title, [b.from, b.to].filter(Boolean).join(' → ')].filter(Boolean).join(' · ') : b.title;
      const bk = cleanBooking({
        id: `r${Date.now().toString(36)}c${i}`, type: CANVAS_TO_BOOKING[b.type], status: 'Por reservar',
        supplier_id: sup?.id || null, supplier_name: sup?.name || b.provider || (b.type === 'vuelo' ? b.airline : '') || (b.type === 'hotel' ? b.title : ''),
        description: desc, start_date: on(b.day), end_date: b.type === 'hotel' ? on(b.day + b.nights) : on(b.day), time: b.time,
        cost: b.cost, price: b.price, source: b.id, notes: b.notes
      }, i);
      if (bk) out.push(bk);
    });
    return out;
  }
  // Sin lienzo: reservas básicas desde la confirmación de servicios.
  function bookingsFromConfirmation(conf, trip) {
    const c = conf || {};
    const out = [];
    const push = (b) => { const x = cleanBooking({ ...b, status: 'Por reservar' }, out.length); if (x) out.push(x); };
    if (c.services?.flight !== false && (c.airline || c.outboundFlight)) {
      push({ type: 'Vuelo', supplier_name: c.airline, description: ['Vuelo de ida', c.outboundFlight].filter(Boolean).join(' · '), start_date: trip.start_date, confirmation: c.flightBooking });
      if (c.returnFlight || c.returnDeparture) push({ type: 'Vuelo', supplier_name: c.airline, description: ['Vuelo de regreso', c.returnFlight].filter(Boolean).join(' · '), start_date: trip.end_date, confirmation: c.flightBooking });
    }
    if (c.services?.hotel !== false && c.hotelName) push({ type: 'Hotel', supplier_name: c.hotelName, description: [c.hotelName, c.room, c.mealPlan].filter(Boolean).join(' · '), start_date: trip.start_date, end_date: trip.end_date });
    if (c.services?.transfer !== false && (c.operator || c.transferOutOrigin)) push({ type: 'Traslado', supplier_name: c.operator, description: `Traslado ${[c.transferOutOrigin, c.transferOutDestination].filter(Boolean).join(' → ')}${c.transferBackOrigin ? ' y regreso' : ''}`, start_date: trip.start_date, end_date: trip.end_date });
    if (c.services?.insurance && (c.insuranceProvider || c.insurancePolicy)) push({ type: 'Seguro', supplier_name: c.insuranceProvider, confirmation: c.insurancePolicy, description: 'Seguro de viaje', start_date: trip.start_date, end_date: trip.end_date });
    return out;
  }
  // Lo que el cliente puede ver en su itinerario: solo reservas confirmadas, sin costos.
  const publicBookings = (list) => (Array.isArray(list) ? list : []).filter((b) => b.status === 'Confirmada' && b.confirmation)
    .map((b) => ({ type: b.type, description: b.description, supplier: b.supplier_name, confirmation: b.confirmation, start_date: b.start_date, end_date: b.end_date, time: b.time }));

  global.TPTrip = {
    DOC_TYPES, PAX_TYPES, MAX_PASSENGERS, ageOn, paxType, cleanPassenger, cleanPassengers, passengerAlerts, tripPassengerSummary, passengerLines, mergeCompanions, companionFrom,
    BLOCKS, BLOCK_TYPES, MAX_BLOCKS, MAX_DAYS, newBlockId, canvasDays, cleanBlock, normalizeCanvas, sortBlocks, canvasTotals, canvasToQuote, canvasToItinerary, canvasToConfirmation, canvasFromTrip,
    shortDate, addDays, isDate,
    SUPPLIER_TYPES, cleanSupplier, netFromCommission, findSupplierByName,
    PROFIT_MODELS, PROFIT_MODEL_LABELS, COMMISSION_STATUSES, COMMISSION_DAYS_DEFAULT, bookingProfit, commissionOpen, commissionDueDefault, commissionAlert,
    BOOKING_TYPES, BOOKING_STATUSES, BOOKING_ICONS, MAX_BOOKINGS, cleanBooking, cleanBookings, bookingAlerts, bookingsSummary, bookingsFromCanvas, bookingsFromConfirmation, publicBookings
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPTrip;
}(typeof window !== 'undefined' ? window : globalThis));
