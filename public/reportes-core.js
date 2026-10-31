'use strict';

/* TP-311: reportes por vendedor y por origen (cálculo compartido entre la plataforma y las pruebas). */
(function (global) {
  const day = (v) => String(v || '').slice(0, 10);
  const inRange = (v, from, to) => { const d = day(v); return Boolean(d) && (!from || d >= from) && (!to || d <= to); };
  const hoursBetween = (a, b) => (Date.parse(`${String(b).slice(0, 19).replace(' ', 'T')}Z`) - Date.parse(`${String(a).slice(0, 19).replace(' ', 'T')}Z`)) / 3600000;
  const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
  const TT = typeof module !== 'undefined' && module.exports ? require('./viaje-core') : global.TPTrip;
  // Utilidad de una venta: reservas de sus viajes (TP-205: tarifa neta = venta − costo; comisionable = comisión del proveedor).
  // null si ninguna reserva tiene todavía costo o comisión.
  function saleProfit(q, trips) {
    if (!q) return null;
    // Comisión registrada a mano para la venta (% del total o monto): manda sobre las reservas.
    const m = q.agency_margin;
    if (m && (m.mode === 'pct' || m.mode === 'monto') && m.value !== '' && m.value != null && Number.isFinite(Number(m.value))) {
      const total = Number(q.payment_plan && q.payment_plan.total) || Number(q.price) || 0;
      return Math.round((m.mode === 'pct' ? (total * Number(m.value)) / 100 : Number(m.value)) * 100) / 100;
    }
    const profits = (trips || []).filter((t) => t.quote_id === q.id).flatMap((t) => (t.bookings?.list || []).filter((b) => b.status !== 'Cancelada')).map(TT.bookingProfit).filter((p) => p != null);
    return profits.length ? Math.round(profits.reduce((s, p) => s + p, 0) * 100) / 100 : null;
  }
  const originOf = (lead) => (lead.referral?.referrer_id ? 'Programa de referidos' : lead.source || 'Otro');

  /**
   * data: { leads, quotes, trips }. opts: { from, to (AAAA-MM-DD, opcionales), by: 'seller'|'origin', label(key) }.
   * Leads, contacto y conversión: leads creados en el periodo (la conversión es de esa camada).
   * Ventas, ingresos, perdidos y días al cierre: leads cerrados en el periodo. Utilidad: reservas de esas ventas.
   */
  function performance(data, { from = '', to = '', by = 'seller', label = (k) => String(k) } = {}) {
    const leads = data.leads || [], quotes = data.quotes || [], trips = data.trips || [];
    const keyOfLead = (l) => (by === 'origin' ? originOf(l) : l.owner_id ?? 'none');
    const groups = new Map();
    const g = (k) => {
      if (!groups.has(k)) groups.set(k, { key: k, label: label(k), leads: 0, contacted: 0, responses: [], cohortWon: 0, quotes: 0, quotesSent: 0, sales: 0, revenue: 0, lost: 0, closeDays: [], profit: 0, profitSales: 0 });
      return groups.get(k);
    };
    const accepted = (lead) => quotes.filter((q) => q.lead_id === lead.id && q.status === 'Aceptada').sort((a, b) => String(b.accepted_at).localeCompare(String(a.accepted_at)))[0] || null;
    for (const l of leads) {
      const x = g(keyOfLead(l));
      if (inRange(l.created_at, from, to)) {
        x.leads += 1;
        if (l.contacted_at) {
          x.contacted += 1;
          const h = hoursBetween(l.assigned_at || l.created_at, l.contacted_at);
          if (Number.isFinite(h) && h >= 0) x.responses.push(h);
        }
        if (l.stage === 'Vendido') x.cohortWon += 1;
      }
      if (inRange(l.closed_at, from, to)) {
        if (l.stage === 'Vendido') {
          const q = accepted(l);
          x.sales += 1;
          x.revenue += Number(q?.price) || 0;
          const d = hoursBetween(l.created_at, l.closed_at) / 24;
          if (Number.isFinite(d) && d >= 0) x.closeDays.push(d);
          const p = saleProfit(q, trips);
          if (p != null) { x.profit += p; x.profitSales += 1; }
        } else if (l.stage === 'Perdido') x.lost += 1;
      }
    }
    for (const q of quotes) {
      if (!inRange(q.created_at, from, to)) continue;
      const lead = q.lead_id ? leads.find((l) => l.id === q.lead_id) : null;
      const k = by === 'origin' ? (lead ? originOf(lead) : 'Otro') : (q.owner_id ?? lead?.owner_id ?? 'none');
      const x = g(k);
      x.quotes += 1;
      if (q.sent_at || ['Enviada', 'Aceptada', 'Rechazada'].includes(q.status)) x.quotesSent += 1;
    }
    const finish = (x) => ({
      key: x.key, label: x.label, leads: x.leads, contacted: x.contacted,
      contactRate: x.leads ? Math.round((x.contacted / x.leads) * 100) : null,
      responseHours: round(median(x.responses)), quotes: x.quotes, quotesSent: x.quotesSent,
      sales: x.sales, revenue: Math.round(x.revenue), ticket: x.sales ? Math.round(x.revenue / x.sales) : null,
      conversion: x.leads ? Math.round((x.cohortWon / x.leads) * 100) : null,
      lost: x.lost, winRate: x.sales + x.lost ? Math.round((x.sales / (x.sales + x.lost)) * 100) : null,
      closeDays: round(x.closeDays.length ? x.closeDays.reduce((a, b) => a + b, 0) / x.closeDays.length : null),
      profit: x.profitSales ? Math.round(x.profit) : null, profitSales: x.profitSales,
      _responses: x.responses, _closeDays: x.closeDays, _cohortWon: x.cohortWon, _profitRaw: x.profit
    });
    const rows = [...groups.values()].filter((x) => x.leads || x.sales || x.lost || x.quotes).map(finish).sort((a, b) => b.revenue - a.revenue || b.sales - a.sales || b.leads - a.leads);
    const all = { key: 'total', label: 'Total', leads: 0, contacted: 0, responses: [], cohortWon: 0, quotes: 0, quotesSent: 0, sales: 0, revenue: 0, lost: 0, closeDays: [], profit: 0, profitSales: 0 };
    rows.forEach((r) => { ['leads', 'contacted', 'quotes', 'quotesSent', 'sales', 'revenue', 'lost', 'profitSales'].forEach((k) => { all[k] += r[k]; }); all.responses.push(...r._responses); all.closeDays.push(...r._closeDays); all.cohortWon += r._cohortWon; all.profit += r._profitRaw; });
    const strip = (r) => { const { _responses, _closeDays, _cohortWon, _profitRaw, ...rest } = r; return rest; };
    return { rows: rows.map(strip), total: strip(finish(all)) };
  }

  // Periodos del reporte → { from, to }.
  function period(id, today) {
    const y = today.slice(0, 4), m = today.slice(0, 7);
    const back = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    if (id === 'month') return { from: `${m}-01`, to: today };
    if (id === 'prev') { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCDate(0); const e = d.toISOString().slice(0, 10); return { from: `${e.slice(0, 7)}-01`, to: e }; }
    if (id === '90') return { from: back(90), to: today };
    if (id === 'year') return { from: `${y}-01-01`, to: today };
    return { from: '', to: '' };
  }

  global.TPReports = { performance, period, originOf, saleProfit };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPReports;
}(typeof window !== 'undefined' ? window : globalThis));
