'use strict';

/* Ganancia que se lleva la agencia por venta (solo Administrador y Dirección).
   Ganancia = utilidad de las reservas del viaje: tarifa neta (venta − costo) o comisión del proveedor (TP-205).
   Se ve en la lista y ficha de cotizaciones, y en el Dashboard (panel “Ganancia del mes”). */
(function () {
  const H = escapeHtml;
  const R = window.TPReports;
  const canSee = () => typeof isManager === 'function' && isManager();
  // { profit, margin } de una venta (cotización aceptada). profit null = faltan costos o comisiones en las reservas.
  const info = (q) => {
    if (!q || q.status !== 'Aceptada' || !R) return null;
    const profit = R.saleProfit(q, db.trips || []);
    const price = Number(q.price) || 0;
    return { profit, margin: profit != null && price > 0 ? Math.round((profit / price) * 1000) / 10 : null };
  };
  const cell = (i) => (!i ? '<span class="muted">—</span>' : i.profit == null ? '<span class="muted" title="Faltan costos o comisiones en las reservas del viaje">Sin costos</span>' : `<b class="${i.profit < 0 ? 'neg' : 'pos'}">${money(i.profit)}</b>${i.margin != null ? `<small>${i.margin}%</small>` : ''}`);

  window.quoteProfitInfo = (q) => (canSee() ? info(q) : null);
  window.quoteProfitCell = (q) => (canSee() ? cell(info(q)) : '');
  window.quoteProfitRow = (q) => {
    if (!canSee() || q.status !== 'Aceptada') return '';
    const i = info(q);
    return `<div><span>Ganancia de la agencia</span><b>${i && i.profit != null ? `${money(i.profit)}${i.margin != null ? ` · ${i.margin}%` : ''}` : 'Sin costos capturados'}</b></div>`;
  };

  window.renderProfitPanel = () => {
    const box = document.getElementById('profitPanel');
    if (!box) return;
    if (!canSee() || !R) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const month = monthKey(todayStr());
    const sales = db.quotes.filter((q) => q.status === 'Aceptada' && q.accepted_at && monthKey(q.accepted_at) === month)
      .map((q) => ({ q, i: info(q) })).sort((a, b) => String(b.q.accepted_at).localeCompare(String(a.q.accepted_at)));
    if (!sales.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const known = sales.filter(({ i }) => i && i.profit != null);
    const total = known.reduce((s, { i }) => s + i.profit, 0);
    const soldKnown = known.reduce((s, { q }) => s + (Number(q.price) || 0), 0);
    const margin = soldKnown > 0 ? Math.round((total / soldKnown) * 1000) / 10 : null;
    const missing = sales.length - known.length;
    box.innerHTML = `<div class="panel-head"><div><h3>💰 Ganancia del mes</h3><p>Lo que se lleva la agencia por cada venta aceptada este mes: venta − costo, o la comisión del proveedor.</p></div></div>
      <div class="mini bk-kpis"><div>Ganancia<b>${money(total)}</b><small>${known.length} de ${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'} con costos</small></div><div>Margen<b>${margin == null ? '—' : `${margin}%`}</b><small>sobre lo vendido con costos</small></div><div>Por completar<b>${missing}</b><small>${missing ? 'ventas sin costos capturados' : 'todo capturado'}</small></div></div>
      <div class="table"><table><thead><tr><th>Venta</th><th>Vendido</th><th>Ganancia</th></tr></thead><tbody>
      ${sales.slice(0, 8).map(({ q, i }) => `<tr><td><b>${H(clientName(q.client_id))}</b><br><small>${H(q.folio)} · ${H(q.destination)} · ${H(userName(q.owner_id))}</small></td><td>${money(q.price)}</td><td>${cell(i)}</td></tr>`).join('')}
      </tbody></table></div>${sales.length > 8 ? `<p class="muted-note">Mostrando las 8 más recientes de ${sales.length}. El detalle completo está en Cotizaciones.</p>` : ''}`;
  };
}());
