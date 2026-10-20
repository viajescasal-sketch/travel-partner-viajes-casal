'use strict';

/* =========================================================
   TP-009 · Portal del proveedor (traslados)
   Reglas compartidas por el servidor, el portal del proveedor y la pantalla de Reservas.
   ========================================================= */
(function (global) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const num = (v) => { if (v === '' || v == null) return ''; const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : ''; };
  const int = (v, max = 60) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };

  // Estados de la solicitud al proveedor.
  // Solicitada → (proveedor cotiza) Cotizada → (nosotros) Aceptada | Rechazada → (proveedor) Confirmada.
  // El proveedor puede responder "No disponible"; nosotros podemos cancelar en cualquier momento.
  const STATES = ['Solicitada', 'Cotizada', 'Aceptada', 'Confirmada', 'Rechazada', 'No disponible', 'Cancelada'];
  const STATE_LABELS = {
    Solicitada: 'Por cotizar', Cotizada: 'Precio enviado', Aceptada: 'Por confirmar', Confirmada: 'Confirmado',
    Rechazada: 'Precio no aceptado', 'No disponible': 'No disponible', Cancelada: 'Cancelado'
  };
  // Cómo lo ve el equipo en Reservas.
  const TEAM_LABELS = {
    Solicitada: 'Esperando precio del proveedor', Cotizada: 'Precio recibido: acepta o rechaza', Aceptada: 'Aceptado: esperando confirmación',
    Confirmada: 'Confirmado por el proveedor', Rechazada: 'Precio rechazado', 'No disponible': 'El proveedor no tiene disponibilidad', Cancelada: 'Solicitud cancelada'
  };
  const CLOSED = ['Rechazada', 'No disponible', 'Cancelada'];
  const SERVICE_KINDS = ['Llegada (aeropuerto → hotel)', 'Salida (hotel → aeropuerto)', 'Redondo (llegada y salida)', 'Interhotel', 'Tour / por horas', 'Otro'];
  const MAX_LOG = 30;

  // Datos operativos que el equipo comparte con el proveedor (nunca precio de venta ni correo del cliente).
  function cleanDetails(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const t = (k, n = 120) => str(r[k]).slice(0, n);
    const d = {
      kind: SERVICE_KINDS.includes(r.kind) ? r.kind : SERVICE_KINDS[0],
      passenger: t('passenger'),
      phone: t('phone', 40),
      adults: int(r.adults), minors: int(r.minors),
      service_date: isDate(r.service_date) ? r.service_date : '',
      pickup_time: TIME_RE.test(str(r.pickup_time)) ? str(r.pickup_time) : '',
      pickup_place: t('pickup_place', 160),
      dropoff_place: t('dropoff_place', 160),
      flight: t('flight', 80),
      return_date: isDate(r.return_date) ? r.return_date : '',
      return_time: TIME_RE.test(str(r.return_time)) ? str(r.return_time) : '',
      return_flight: t('return_flight', 80),
      vehicle: t('vehicle', 80),
      notes: t('notes', 800)
    };
    if (d.return_date && d.service_date && d.return_date < d.service_date) d.return_date = d.service_date;
    return d;
  }
  function detailsError(d) {
    if (!d.passenger) return 'Escribe el nombre del pasajero titular';
    if (!d.service_date) return 'Indica la fecha del servicio';
    if (!d.adults && !d.minors) return 'Indica cuántos pasajeros son';
    if (!d.pickup_place || !d.dropoff_place) return 'Indica el lugar de recogida y el destino';
    return '';
  }

  // Una línea legible del recorrido.
  const route = (d) => [d.pickup_place, d.dropoff_place].filter(Boolean).join(' → ');
  const paxText = (d) => [d.adults ? `${d.adults} adulto${d.adults === 1 ? '' : 's'}` : '', d.minors ? `${d.minors} menor${d.minors === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' y ');

  // Vista del servicio para el proveedor: solo datos operativos y lo que se le paga a él.
  function providerView(trip, b) {
    const p = b.portal || {};
    const d = p.details || {};
    const accepted = ['Aceptada', 'Confirmada'].includes(p.state);
    return {
      key: `${trip.id}:${b.id}`, trip_id: trip.id, booking_id: b.id,
      state: p.state, label: STATE_LABELS[p.state] || p.state,
      folio: p.folio || '', requested_at: p.requested_at || '', updated_at: p.updated_at || '',
      details: d,
      date: d.service_date || b.start_date || '', time: d.pickup_time || b.time || '',
      quote: p.quote ? { amount: p.quote.amount, notes: p.quote.notes || '', at: p.quote.at || '' } : null,
      decision_note: p.decision_note || '',
      confirmation: p.state === 'Confirmada' ? b.confirmation || '' : '',
      driver: p.driver || null,
      amount: accepted ? (b.cost === '' || b.cost == null ? (p.quote ? p.quote.amount : '') : b.cost) : '',
      due: accepted ? b.supplier_due || '' : '',
      paid: accepted && b.supplier_paid === true, paid_at: accepted && b.supplier_paid ? b.supplier_paid_at || '' : '',
      log: (p.log || []).slice(-MAX_LOG)
    };
  }

  // Agrupa los servicios del proveedor en las secciones del portal. today = AAAA-MM-DD (Cancún).
  function sections(list, today) {
    const l = Array.isArray(list) ? list : [];
    const byDate = (a, c) => (a.date || '9999').localeCompare(c.date || '9999') || (a.time || '99').localeCompare(c.time || '99');
    const live = l.filter((s) => s.state === 'Confirmada'); // los aceptados sin confirmar van en toConfirm
    return {
      toQuote: l.filter((s) => s.state === 'Solicitada').sort(byDate),
      quoted: l.filter((s) => s.state === 'Cotizada').sort(byDate),
      toConfirm: l.filter((s) => s.state === 'Aceptada').sort(byDate),
      upcoming: live.filter((s) => !s.date || s.date >= today).sort(byDate),
      done: live.filter((s) => s.date && s.date < today).sort((a, c) => byDate(c, a)),
      closed: l.filter((s) => CLOSED.includes(s.state)).sort((a, c) => byDate(c, a))
    };
  }

  // Pagos al proveedor: por pagar, vencido, pagado en el mes y calendario por fecha de pago.
  function payments(list, today) {
    const rows = (Array.isArray(list) ? list : []).filter((s) => ['Aceptada', 'Confirmada'].includes(s.state) && s.amount !== '' && s.amount != null);
    const sum = (l) => Math.round(l.reduce((x, s) => x + (Number(s.amount) || 0), 0) * 100) / 100;
    const open = rows.filter((s) => !s.paid);
    const late = open.filter((s) => s.due && s.due < today);
    const month = String(today).slice(0, 7);
    const paidMonth = rows.filter((s) => s.paid && String(s.paid_at).slice(0, 7) === month);
    const noDate = open.filter((s) => !s.due);
    const byDay = {};
    rows.forEach((s) => { const k = s.paid ? s.paid_at || s.due : s.due; if (!k) return; (byDay[k] = byDay[k] || []).push(s); });
    return { rows, open: sum(open), openCount: open.length, late: sum(late), lateCount: late.length, paidMonth: sum(paidMonth), paidMonthCount: paidMonth.length, noDate: noDate.length, byDay };
  }

  // Semanas (lunes a domingo) del mes AAAA-MM para el calendario.
  function monthGrid(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const start = new Date(first.getTime() - offset * 86400000);
    const days = [];
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
      days.push({ date: d, inMonth: d.slice(0, 7) === ym });
    }
    while (days.length > 35 && days.slice(-7).every((x) => !x.inMonth)) days.splice(-7);
    return days;
  }
  const shiftMonth = (ym, n) => { const [y, m] = String(ym).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

  // Fecha de pago al proveedor por omisión al aceptar su precio: 5 días antes del viaje
  // (si ya pasó esa fecha, queda hoy). Sin fecha de viaje se usa la del servicio.
  const PAY_DAYS_BEFORE = 5;
  function defaultPayDue(tripStart, serviceDate, today) {
    const base = isDate(tripStart) ? tripStart : isDate(serviceDate) ? serviceDate : '';
    if (!base) return '';
    const due = new Date(Date.parse(`${base}T12:00:00Z`) - PAY_DAYS_BEFORE * 86400000).toISOString().slice(0, 10);
    return isDate(today) && due < today ? today : due;
  }

  const addLog = (portal, who, text, at) => { portal.log = [...(portal.log || []), { at, who: str(who).slice(0, 80), text: str(text).slice(0, 300) }].slice(-MAX_LOG); };

  global.TPProv = {
    STATES, STATE_LABELS, TEAM_LABELS, CLOSED, SERVICE_KINDS, cleanDetails, detailsError, route, paxText,
    providerView, sections, payments, monthGrid, shiftMonth, addLog, num, isDate, PAY_DAYS_BEFORE, defaultPayDue
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPProv;
}(typeof window !== 'undefined' ? window : globalThis));
