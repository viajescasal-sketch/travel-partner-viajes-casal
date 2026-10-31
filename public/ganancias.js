'use strict';

/* Venta, Neto y Ganancia por paquete (solo Administrador y Dirección).
   Venta = precio de la cotización. Ganancia = comisión de la agencia: un % de la venta o un monto manual (cambia según el proveedor).
   Neto = Venta − Ganancia (lo que se paga a proveedores o al mayorista). Si no hay comisión capturada se usa la utilidad de las reservas.
   El traslado (proveedor externo que se paga aparte) no entra en este cálculo: solo se calendariza su pago.
   Se ve en Viajes (“Por armar” y cada viaje), en Cotizaciones y en el Dashboard (“Ganancia del mes”). */
(function () {
  const H = escapeHtml;
  const R = window.TPReports;
  const canSee = () => typeof isManager === 'function' && isManager();
  const round2 = (n) => Math.round(n * 100) / 100;
  const totalOf = (q) => round2(Number(q.payment_plan?.total) || Number(q.price) || 0);
  // { total, profit, net, margin, manual } · profit null = falta capturar la comisión (o costos de las reservas)
  const info = (q) => {
    if (!q || !R) return null;
    const total = totalOf(q);
    const profit = R.saleProfit(q, db.trips || []);
    return { total, profit, net: profit == null ? null : round2(total - profit), margin: profit != null && total > 0 ? Math.round((profit / total) * 1000) / 10 : null, manual: Boolean(q.agency_margin) };
  };
  const cell = (i) => (!i ? '<span class="muted">—</span>' : i.profit == null ? '<span class="muted" title="Captura la comisión de la venta">Sin comisión</span>' : `<b class="${i.profit < 0 ? 'neg' : 'pos'}">${money(i.profit)}</b>${i.margin != null ? `<small>${i.margin}%</small>` : ''}`);

  window.quoteProfitInfo = (q) => (canSee() ? info(q) : null);
  window.quoteProfitCell = (q) => (canSee() && (q.status === 'Aceptada' || q.agency_margin) ? cell(info(q)) : canSee() ? '<span class="muted">—</span>' : '');
  // Cuadro Venta · Neto · Ganancia (tarjetas de Viajes)
  window.quoteMoneyHtml = (q) => {
    if (!canSee() || !q) return '';
    const i = info(q);
    return `<div class="tb-money"><span><small>Precio del paquete</small><b>${money(i.total)}</b></span><span><small>Comisión</small><b>${i.margin == null ? '—' : `${i.margin}%`}</b></span><span><small>Ganancia</small><b class="${i.profit != null && i.profit < 0 ? 'neg' : 'pos'}">${i.profit == null ? '—' : money(i.profit)}</b></span><span><small>Neto (proveedores)</small><b>${i.net == null ? '—' : money(i.net)}</b></span></div>`;
  };
  // Botón compacto para listas de cotizaciones (ficha del lead): muestra la ganancia o invita a capturarla.
  window.quoteMarginBtn = (q) => {
    if (!canSee() || !q || ['Rechazada', 'Vencida'].includes(q.status)) return '';
    const i = info(q);
    return `<button type="button" class="btn secondary small" data-margin="${q.id}" title="Comisión de esta cotización">💰 ${i && i.profit != null ? `${money(i.profit)} · ${i.margin ?? 0}%` : 'Comisión'}</button>`;
  };
  window.quoteProfitRow = (q) => {
    if (!canSee() || ['Rechazada', 'Vencida'].includes(q.status)) return '';
    const i = info(q);
    return `<div class="full qv-margin"><span>Precio del paquete · Comisión · Ganancia</span>${quoteMoneyHtml(q)}<button type="button" class="btn secondary small" data-margin="${q.id}">${i.manual ? 'Editar comisión' : 'Capturar comisión'}</button></div>`;
  };

  function marginModal(id) {
    const q = quoteById(id);
    if (!q || !canSee()) return;
    const total = totalOf(q);
    const m = q.agency_margin || { mode: 'pct', value: '' };
    const html = `<form class="modal-form" id="marginForm">
      <p class="full muted-note">${H(clientName(q.client_id))} · ${H(q.folio)} · ${H(q.destination)}. La venta es el precio que mandaste al cliente. Tu comisión cambia según el proveedor: captúrala en % o en monto.</p>
      ${field('Venta (total)', `<input value="${H(money(total))}" disabled>`)}
      <div class="full"><label class="kb-check"><input type="radio" name="mode" value="pct"${m.mode === 'pct' ? ' checked' : ''}> Comisión en % de la venta</label>
      <label class="kb-check"><input type="radio" name="mode" value="monto"${m.mode === 'monto' ? ' checked' : ''}> Comisión en monto (MXN)</label></div>
      ${field('Comisión*', `<input name="value" inputmode="decimal" maxlength="12" required value="${H(m.value)}" placeholder="20">`)}
      <div class="full tb-preview" id="marginPreview"></div>
      <div class="modal-actions">${q.agency_margin ? '<button type="button" class="link danger-link" data-margin-clear>Quitar comisión</button>' : ''}<button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Guardar</button></div></form>`;
    openModal('GANANCIA', `Comisión de la venta · ${clientName(q.client_id)}`, html);
    const form = $('#marginForm');
    const paint = () => {
      const val = Number(String(form.value.value).replace(/[^0-9.]/g, ''));
      const mode = form.mode.value;
      const profit = Number.isFinite(val) && form.value.value !== '' ? round2(mode === 'pct' ? (total * val) / 100 : val) : null;
      $('#marginPreview').innerHTML = profit == null ? '' : `<div class="tb-money"><span><small>Venta</small><b>${money(total)}</b></span><span><small>Neto (pago a proveedores)</small><b>${money(total - profit)}</b></span><span><small>Ganancia</small><b class="pos">${money(profit)}${total > 0 ? ` · ${Math.round((profit / total) * 1000) / 10}%` : ''}</b></span></div>`;
    };
    form.addEventListener('input', paint); paint();
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await send('PUT', `/api/quotes/${q.id}/agency-margin`, { mode: form.mode.value, value: form.value.value }); close(); toast('Comisión guardada'); await loadAll(); } catch (error) { toast(error.message, 6000); }
    };
    const clear = form.querySelector('[data-margin-clear]');
    if (clear) clear.onclick = async () => { try { await send('PUT', `/api/quotes/${q.id}/agency-margin`, { clear: true }); close(); toast('Comisión quitada'); await loadAll(); } catch (error) { toast(error.message, 6000); } };
  }
  document.addEventListener('click', (e) => { const el = e.target.closest('[data-margin]'); if (el) marginModal(Number(el.dataset.margin)); });

  /* ---------- Viajes: ventas aceptadas o vendidas que aún no tienen viaje armado ---------- */
  function toBuild() {
    const trips = db.trips || [];
    const covered = (clientId, quoteId) => trips.some((t) => t.client_id === clientId && (quoteId ? t.quote_id === quoteId || !t.quote_id : true));
    const out = [];
    const seen = new Set();
    db.quotes.filter((q) => q.status === 'Aceptada' && !covered(q.client_id, q.id)).forEach((q) => { out.push({ q, client_id: q.client_id }); seen.add(q.client_id); });
    // Lead vendido sin cotización marcada como aceptada: se usa su cotización más reciente para mostrar precio y comisión.
    db.leads.filter((l) => l.stage === 'Vendido' && !seen.has(l.client_id) && !trips.some((t) => t.client_id === l.client_id)).forEach((l) => {
      const mine = db.quotes.filter((x) => (x.lead_id === l.id || (!x.lead_id && x.client_id === l.client_id && x.destination === l.destination)) && !['Rechazada', 'Vencida'].includes(x.status)).sort((a, b) => b.id - a.id);
      out.push({ lead: l, q: mine.find((x) => x.status === 'Aceptada') || mine[0] || null, client_id: l.client_id, loose: true });
      seen.add(l.client_id);
    });
    return out;
  }
  window.tpToBuild = toBuild;
  window.renderToBuild = () => {
    const box = document.getElementById('toBuildPanel');
    if (!box) return;
    const list = toBuild();
    if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const write = canWrite('trips');
    const card = ({ q, lead, client_id }) => {
      const l = lead || (q && q.lead_id ? leadById(q.lead_id) : null);
      const armar = q ? `data-trip-from-quote="${q.id}"` : `data-new-trip-client="${client_id}"`;
      const dest = q ? q.destination : lead.destination;
      const dates = q && typeof qvDates === 'function' ? qvDates(q) : [l?.start_date, l?.end_date].filter(Boolean).map((d) => fmtDate(d)).join(' al ');
      const pay = q && typeof qvPay === 'function' ? qvPay(q) : '<span class="status qualified">Vendido</span>';
      return `<article class="trip-card tb-card"><small>${H(q && !lead ? `ACEPTADA · ${q.folio}` : q ? `VENDIDO · ${q.folio}` : 'VENDIDO')}</small><h4>${H(dest || 'Destino por definir')}</h4><p>${H(clientName(client_id))}${dates ? ` · ${H(dates)}` : ''}</p><div class="tb-pay">${pay}</div>${q ? `<p class="tb-price">Precio del paquete <b>${money(totalOf(q))}</b></p>` : ''}
        <div class="tb-acts">${write ? `<button type="button" class="btn primary small" ${armar}>Armar viaje</button>` : ''}${q && canSee() ? `<button type="button" class="btn secondary small" data-margin="${q.id}">${q.agency_margin ? 'Editar comisión' : 'Capturar comisión'}</button>` : ''}</div></article>`;
    };
    box.innerHTML = `<div class="panel-head"><div><h3>🧳 Por armar</h3><p>Ventas aceptadas (con pago en curso) y clientes vendidos que todavía no tienen su viaje en el sistema.</p></div><span class="tag-soon">${list.length}</span></div><div class="tb-grid">${list.slice(0, 24).map(card).join('')}</div>${list.length > 24 ? `<p class="muted-note">Mostrando 24 de ${list.length}.</p>` : ''}`;
  };

  /* ---------- Dashboard: Ganancia del mes ---------- */
  window.renderProfitPanel = () => {
    const box = document.getElementById('profitPanel');
    if (!box) return;
    if (!canSee() || !R) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const month = monthKey(todayStr());
    const sales = db.quotes.filter((q) => q.status === 'Aceptada' && q.accepted_at && monthKey(q.accepted_at) === month)
      .map((q) => ({ q, i: info(q) })).sort((a, b) => String(b.q.accepted_at).localeCompare(String(a.q.accepted_at)));
    if (!sales.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const known = sales.filter(({ i }) => i.profit != null);
    const sold = sales.reduce((s, { i }) => s + i.total, 0);
    const profit = known.reduce((s, { i }) => s + i.profit, 0);
    const soldKnown = known.reduce((s, { i }) => s + i.total, 0);
    const margin = soldKnown > 0 ? Math.round((profit / soldKnown) * 1000) / 10 : null;
    const missing = sales.length - known.length;
    box.innerHTML = `<div class="panel-head"><div><h3>💰 Ganancia del mes</h3><p>Venta, neto (pago a proveedores) y ganancia de cada venta aceptada este mes. Ganancia = tu comisión.</p></div></div>
      <div class="mini bk-kpis"><div>Venta total<b>${money(sold)}</b><small>${sales.length} ${sales.length === 1 ? 'venta' : 'ventas'}</small></div><div>Neto<b>${money(soldKnown - profit)}</b><small>${known.length} con comisión</small></div><div>Ganancia<b>${money(profit)}</b><small>${margin == null ? 'sin margen aún' : `${margin}% de lo vendido`}</small></div><div>Por capturar<b>${missing}</b><small>${missing ? 'ventas sin comisión' : 'todo capturado'}</small></div></div>
      <div class="table"><table><thead><tr><th>Venta</th><th>Total</th><th>Neto</th><th>Ganancia</th><th></th></tr></thead><tbody>
      ${sales.slice(0, 8).map(({ q, i }) => `<tr><td><b>${H(clientName(q.client_id))}</b><br><small>${H(q.folio)} · ${H(q.destination)} · ${H(userName(q.owner_id))}</small></td><td>${money(i.total)}</td><td>${i.net == null ? '<span class="muted">—</span>' : money(i.net)}</td><td>${cell(i)}</td><td><button type="button" class="link" data-margin="${q.id}">${q.agency_margin ? 'Editar' : 'Capturar'}</button></td></tr>`).join('')}
      </tbody></table></div>${sales.length > 8 ? `<p class="muted-note">Mostrando las 8 más recientes de ${sales.length}. El detalle completo está en Cotizaciones.</p>` : ''}`;
  };
}());
