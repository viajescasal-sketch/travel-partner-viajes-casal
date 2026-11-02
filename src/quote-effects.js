'use strict';

// Efectos de cambiar el estado de una cotización (los usa el CRM y la aceptación en línea del cliente, TP-203).

const { nowCancun, sanitize } = require('./crm-schema');
const hooks = require('./hooks');

const str = (v) => String(v ?? '').trim();
const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : 0; const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };

// Igual que TPDocs.optionLabel (public/docs/documents.js).
function optionLabel(varying, d) {
  if (varying === 'hotel') return d.hotel?.hotel ? d.hotel.hotel + (d.hotel.plan ? ` — ${d.hotel.plan}` : '') : 'Hotel por confirmar';
  if (varying === 'vuelo') return d.vuelo?.aerolinea ? `Vuelo ${d.vuelo.aerolinea}` : 'Vuelo';
  if (varying === 'traslados') return `Traslados${d.traslados?.tipo ? ` — ${d.traslados.tipo}` : ''}`;
  if (varying === 'seguro') return 'Seguro de viaje';
  if (varying === 'tours') return (d.tours?.items || []).find((t) => t && str(t.nombre))?.nombre || 'Tours';
  return 'Propuesta';
}

/** Opciones que el cliente puede elegir: [{ index, label, total }]. Circuitos y cotizaciones simples: una sola. */
function quoteOptions(quote) {
  const det = quote.details;
  if (!det || det.kind === 'circuito' || !Array.isArray(det.proposals) || !det.proposals.length) return [{ index: 0, label: quote.hotel, total: Number(quote.price) || 0, single: true }];
  const varying = det.varying || 'hotel';
  return det.proposals.map((p, index) => {
    const merged = { ...(det.fixed || {}), [varying]: p?.[varying] || {} };
    const label = merged.hotel?.hotel ? `${merged.hotel.hotel}${merged.hotel.plan ? ` — ${merged.hotel.plan}` : ''}` : optionLabel(varying, merged);
    return { index, label: label || `Paquete a ${quote.destination}`, total: num(p?.price?.total) };
  });
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Al aceptarse la cotización se crea el viaje (si no existe) para que el cliente lo vea en su portal como "Pendiente de pago". */
async function ensureTripForQuote(dataStore, quote) {
  const trips = (await dataStore.listRecords('trips')).filter((t) => t.quote_id === quote.id);
  if (trips.length) return trips[0];
  const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
  const start = [quote.details?.startDate, lead?.start_date].find((d) => ISO.test(String(d || '')));
  if (!start) return null; // sin fecha de salida no se puede armar el viaje: lo crea el vendedor a mano
  let end = [quote.details?.endDate, lead?.end_date].find((d) => ISO.test(String(d || ''))) || start;
  if (end < start) end = start;
  const paid = Number(quote.payment_plan?.paid) > 0;
  const data = sanitize('trips', { client_id: quote.client_id, quote_id: quote.id, destination: String(quote.destination || '').trim() || 'Por definir', start_date: start, end_date: end, status: paid ? 'Confirmado' : 'Pendiente de pago' });
  const trip = await dataStore.insertRecord('trips', data, quote.owner_id || lead?.owner_id || null);
  const client = await dataStore.getRecord('clients', quote.client_id);
  await dataStore.logActivity(null, 'crm_trips_create', null, { entity: 'trips', entityId: trip.id, summary: [client?.name, trip.destination, trip.start_date].filter(Boolean).join(' · '), note: 'Viaje creado al aceptar la cotización (pendiente de pago)' });
  return trip;
}

function createQuoteEffects(dataStore, { payments = null, onLeadUpdate = null } = {}) {
  return async function applyQuoteEffects(quote, ctx = null) {
    // TP-106: fecha de envío para el recordatorio de 48 h (se reinicia si se vuelve a enviar).
    if (quote.status === 'Enviada' && !quote.sent_at) quote = await dataStore.updateRecord('quotes', quote.id, { sent_at: nowCancun(), reminder_at: null });
    else if (quote.status !== 'Enviada' && (quote.sent_at || quote.reminder_at)) quote = await dataStore.updateRecord('quotes', quote.id, { sent_at: null, reminder_at: null });
    if (quote.status === 'Aceptada' && !quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: nowCancun() });
    } else if (quote.status !== 'Aceptada' && quote.accepted_at) {
      quote = await dataStore.updateRecord('quotes', quote.id, { accepted_at: null });
    }
    if (quote.lead_id) {
      const lead = await dataStore.getRecord('leads', quote.lead_id);
      if (lead) {
        let updated = null;
        if (quote.status === 'Aceptada' && lead.stage !== 'Vendido') {
          updated = await dataStore.updateRecord('leads', lead.id, { stage: 'Vendido', closed_at: nowCancun(), stage_changed_at: nowCancun(), lost_reason: null, ...(lead.contacted_at ? {} : { contacted_at: nowCancun() }) });
        } else if (['Nuevo', 'Calificado'].includes(lead.stage) && quote.status !== 'Rechazada') {
          updated = await dataStore.updateRecord('leads', lead.id, { stage: 'Cotizado', stage_changed_at: nowCancun(), ...(lead.contacted_at ? {} : { contacted_at: nowCancun() }) });
        }
        if (updated && onLeadUpdate) await onLeadUpdate(lead, updated, quote, ctx);
        if (updated?.stage === 'Vendido') await hooks.emit(dataStore, 'leadSold', updated); // TP-309
        if (updated && updated.stage !== lead.stage) await hooks.emit(dataStore, 'leadStage', { before: lead, lead: updated }); // TP-307
      }
    }
    // TP-201: al aceptarse se arma el plan de pagos (anticipo + parcialidades) y la liga de pago.
    if (payments && quote.status === 'Aceptada' && !quote.payment_plan) {
      try { quote = await payments.ensurePlan(quote); } catch (error) { console.error('Plan de pagos:', error.message); }
    }
    // El viaje aparece en el portal del cliente desde que acepta, marcado como "Pendiente de pago" hasta su primer pago.
    if (quote.status === 'Aceptada') {
      try { await ensureTripForQuote(dataStore, quote); } catch (error) { console.error('Viaje automático:', error.message); }
    }
    return quote;
  };
}

module.exports = { createQuoteEffects, quoteOptions, optionLabel, ensureTripForQuote };
