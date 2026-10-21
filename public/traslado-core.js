'use strict';

/* Solicitar traslado desde la ficha del cliente (reglas compartidas entre la plataforma, el servidor y las pruebas).
   - El botón aparece si alguna cotización del cliente incluye traslados (o lo menciona) o si su ficha dice “Incluye traslado”.
   - Al solicitarlo se crean hasta 3 tareas ligadas a la reserva (followups.auto = { kind:'traslado', trip_id, booking_id, task }):
       confirm → confirmar con el proveedor (24 h después; se cierra sola cuando el proveedor responde o la reserva se confirma)
       pay     → pagar al proveedor en la fecha de pago (se cierra sola al marcar la reserva como pagada)
       client  → enviar al cliente los datos del traslado 2 días antes del servicio
   - Si la reserva o la solicitud se cancela, sus tareas abiertas se cierran solas. */
(function (global) {
  const KIND = 'traslado';
  const TASKS = ['confirm', 'pay', 'client'];
  const TASK_LABELS = { confirm: 'Confirmar con el proveedor', pay: 'Pagar al proveedor', client: 'Enviar datos del traslado al cliente' };
  const TASK_HOUR = '10:00';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
  const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  const RESPONDED = ['Cotizada', 'Aceptada', 'Confirmada'];
  const CLOSED = ['Rechazada', 'No disponible', 'Cancelada'];

  /** ¿La cotización incluye traslado? (paquete con el servicio marcado, o lo menciona en sus servicios). */
  function quoteIncludesTransfer(q) {
    if (!q || q.status === 'Rechazada') return false;
    const s = q.details && q.details.services;
    if (s && s.traslados === true) return true;
    if (q.details && q.details.kind === 'circuito' && q.details.circuit && String(q.details.circuit.tipoTraslado || '').trim()) return true;
    return /traslado/i.test(String(q.services || ''));
  }
  /** ¿Se muestra “Solicitar traslado” para este cliente? → { ok, quote, reason } */
  function eligibility(client, quotes) {
    if (!client) return { ok: false, quote: null, reason: '' };
    const mine = (quotes || []).filter((q) => q.client_id === client.id && quoteIncludesTransfer(q))
      .sort((a, b) => (b.status === 'Aceptada') - (a.status === 'Aceptada') || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (mine.length) return { ok: true, quote: mine[0], reason: `La cotización ${mine[0].folio || ''} incluye traslados`.replace('  ', ' ') };
    if (client.includes_transfer) return { ok: true, quote: null, reason: 'Marcado en la ficha: incluye traslado' };
    return { ok: false, quote: null, reason: '' };
  }

  const folioOf = (b) => (b && b.portal && b.portal.folio) || '';
  const routeOf = (b) => {
    const d = (b && b.portal && b.portal.details) || {};
    return [d.pickup_place, d.dropoff_place].filter(Boolean).join(' → ') || (b && b.description) || 'Traslado';
  };

  /** Lo que debe decir cada tarea según la reserva: { title, due (AAAA-MM-DD HH:MM) | '', done } */
  function desiredTask(task, b, trip, client, now) {
    const today = String(now || '').slice(0, 10);
    const who = (client && client.name) || 'cliente';
    const sup = (b && b.supplier_name) || 'proveedor';
    const tag = folioOf(b) ? ` ${folioOf(b)}` : '';
    const cancelled = !b || b.status === 'Cancelada' || (b.portal && b.portal.state === 'Cancelada');
    if (cancelled) return { done: true, closeNote: 'Se cerró sola: el traslado se canceló.' };
    const service = isDate(b.start_date) ? b.start_date : (trip && trip.start_date) || today;
    if (task === 'confirm') {
      const answered = (b.portal && RESPONDED.includes(b.portal.state)) || b.status === 'Confirmada' || (!b.portal && Boolean(b.confirmation));
      return { done: answered, closeNote: 'Se cerró sola: el proveedor ya respondió.', title: `Confirmar traslado${tag} con ${sup} · ${who}` };
    }
    if (task === 'pay') {
      if (b.supplier_paid) return { done: true, closeNote: 'Se cerró sola: el traslado ya está pagado al proveedor.' };
      const due = isDate(b.supplier_due) ? b.supplier_due : '';
      const amount = b.cost !== '' && b.cost != null ? ` · ${money(b.cost)}` : '';
      return { done: false, title: `Pagar traslado${tag} a ${sup}${amount} · ${who}`, due: due ? `${due < today ? today : due} ${TASK_HOUR}` : '' };
    }
    if (task === 'client') {
      let day = addDays(service, -2);
      if (today && day < today) day = today;
      return { done: false, title: `Enviar datos del traslado a ${who}${tag} (chofer, hora y punto de encuentro)`, due: `${day} ${TASK_HOUR}` };
    }
    return { done: false };
  }

  /** Fecha de las tareas al crearlas. */
  function initialDue(task, b, trip, now) {
    const n = String(now || '').slice(0, 16);
    if (task === 'confirm') {
      const d = new Date(Date.parse(`${n.slice(0, 10)}T${n.slice(11, 16) || '09:00'}:00Z`) + 86400000).toISOString();
      return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
    }
    const want = desiredTask(task, b, trip, null, now);
    return want.due || `${n.slice(0, 10)} ${TASK_HOUR}`;
  }

  /** Texto de las tareas (para el seguimiento). */
  function taskDetails(task, b, trip, client) {
    const d = (b && b.portal && b.portal.details) || {};
    const lines = [`🚐 ${routeOf(b)}${d.service_date || b.start_date ? ` · ${d.service_date || b.start_date}${d.pickup_time || b.time ? ` ${d.pickup_time || b.time}` : ''}` : ''}`];
    if (trip) lines.push(`Viaje: ${(client && client.name) || ''} · ${trip.destination} (${trip.start_date})`);
    if (task === 'confirm') lines.push('Si el proveedor no ha respondido, márcale o escríbele. Se marca como hecha sola cuando responda en su portal.');
    if (task === 'pay') lines.push('Paga y marca la reserva como “Pagada al proveedor” en Viajes › Reservas: esta tarea se cierra sola.');
    if (task === 'client') lines.push('Mándale al cliente el nombre y WhatsApp del chofer, la hora y el punto de encuentro.');
    return lines.join('\n').slice(0, 2000);
  }

  const api = { KIND, TASKS, TASK_LABELS, TASK_HOUR, CLOSED, quoteIncludesTransfer, eligibility, desiredTask, initialDue, taskDetails, routeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TPTransfer = api;
}(typeof window !== 'undefined' ? window : globalThis));
