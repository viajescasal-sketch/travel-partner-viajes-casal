'use strict';

/* =========================================================
   TP-206 Metas y comisiones por vendedor
   Avance de la meta en el Dashboard, detalle de comisiones (Reportes) y Configuración › Metas y comisiones.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const K = window.TPComm;
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const STATUS_CLASS = { 'Por liberar': 'bk-req', 'Por pagar': 'bk-due', Pagada: 'bk-ok' };
  const sellerUsers = () => (db.users || []).filter((u) => u.active !== false && u.role !== 'operaciones');
  const lastMonths = (n) => { const out = [K.monthOf(todayStr())]; while (out.length < n) out.push(K.prevMonth(out[out.length - 1])); return out; };
  const daysLeft = () => { const t = todayStr(); const d = new Date(`${t.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return Number(d.toISOString().slice(8, 10)) - Number(t.slice(8, 10)); };

  /* ---------------- Dashboard ---------------- */
  function goalRow(s, name, big) {
    const pct = s.progress == null ? null : Math.min(s.progress, 100);
    const label = s.base === 'utilidad' ? 'utilidad' : 'vendido';
    const head = s.goal ? `<b>${money(s.value)}</b> ${label} de <b>${money(s.goal)}</b> <span class="goal-pct${s.progress >= 100 ? ' ok' : ''}">${s.progress}%</span>` : `<b>${money(s.value)}</b> ${label} · <span class="muted">sin meta definida</span>`;
    const left = s.goal && s.remaining > 0 ? `Faltan ${money(s.remaining)} · ${daysLeft()} días para cerrar el mes` : s.goal ? '🎉 ¡Meta cumplida!' : '';
    const c = s.commission;
    const comm = s.pct == null ? '<span class="muted">Sin % de comisión definido</span>' : `Comisión ${s.pct}%: <b>${money(c.total)}</b>${c.porLiberar ? ` · ${money(c.porLiberar)} por liberar` : ''}${c.porPagar ? ` · <b class="ok">${money(c.porPagar)} por pagar</b>` : ''}${c.pagada ? ` · ${money(c.pagada)} pagada` : ''}${s.missingProfit ? ` <small class="muted">(${s.missingProfit} venta${s.missingProfit > 1 ? 's' : ''} sin utilidad: faltan costos o comisiones en reservas)</small>` : ''}`;
    return `<div class="goal-row${big ? ' big' : ''}" data-goal-seller="${H(s.sellerId)}">
      <div class="goal-top">${name ? `<span class="goal-name">${H(name)}</span>` : ''}<span>${head}</span><small>${s.sales} venta${s.sales === 1 ? '' : 's'}</small></div>
      <div class="pay-bar big goal-bar${s.progress >= 100 ? ' done' : ''}"><i style="width:${pct ?? 0}%"></i></div>
      <div class="goal-foot"><small>${left}</small><small>${comm}</small></div></div>`;
  }
  window.renderGoalPanel = () => {
    const box = $('#goalPanel');
    if (!box || !K) return;
    if (isOps()) { box.classList.add('hidden'); return; }
    const month = K.monthOf(todayStr());
    const goals = db.goals || { base: 'venta', sellers: {} };
    let rows;
    if (isAdmin()) {
      rows = sellerUsers().map((u) => ({ u, s: K.monthSummary(db, goals, month, u.id) })).filter(({ u, s }) => s.sales || goals.sellers[String(u.id)]);
    } else rows = [{ u: null, s: K.monthSummary(db, goals, month, currentUser?.id) }];
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    rows.sort((a, b) => (b.s.progress ?? -1) - (a.s.progress ?? -1) || b.s.value - a.s.value);
    const mine = !isAdmin();
    box.innerHTML = `<div class="panel-head"><div><h3>🎯 ${mine ? 'Mi meta' : 'Metas del equipo'} · ${H(monthName(month))}</h3><p>${goals.base === 'utilidad' ? 'Avance en utilidad' : 'Avance en ventas'} aceptadas este mes. La comisión se libera cuando el cliente liquida su viaje.</p></div><button type="button" class="btn secondary small" data-goal-detail="${mine ? H(currentUser?.id) : ''}">Ver comisiones</button></div>
      <div class="goal-list">${rows.map(({ u, s }) => goalRow(s, u ? u.name : '', mine)).join('')}</div>`;
  };

  // Detalle de ventas y comisiones del mes (vendedor: las suyas; administrador: todas o de un vendedor).
  function detailModal(sellerId, month = K.monthOf(todayStr())) {
    const goals = db.goals || { base: 'venta', sellers: {} };
    const list = K.sales(db, { month, sellerId: sellerId === '' ? null : sellerId, goals });
    const sum = (st) => list.filter((x) => !st || x.status === st).reduce((s, x) => s + (x.commission || 0), 0);
    openModal('COMISIONES', `${sellerId !== '' && sellerId != null ? userName(Number(sellerId)) : 'Todo el equipo'} · ${monthName(month)}`, `<div class="pp">
      <div class="toolbar"><select id="gdMonth">${options(lastMonths(12).map((m) => [m, monthName(m)]), month)}</select></div>
      <div class="mini bk-kpis"><div>Ventas<b>${list.length}</b><small>${money(list.reduce((s, x) => s + x.total, 0))}</small></div><div>Por liberar<b>${money(sum('Por liberar'))}</b><small>cliente con saldo</small></div><div>Por pagar<b>${money(sum('Por pagar'))}</b><small>cliente liquidado</small></div><div>Pagada<b>${money(sum('Pagada'))}</b></div></div>
      ${commissionTable(list, false)}
      <p class="muted-note">Comisión = % del vendedor × utilidad de la venta (reservas de tarifa neta: venta − costo; comisionables: comisión del proveedor). Si falta el costo o la comisión de las reservas, la comisión aparece como “—” hasta completarlas en 🧾 Reservas del viaje.</p>
      <div class="modal-actions"><button type="button" class="btn primary close">Listo</button></div></div>`, { wide: true });
    $('#gdMonth').onchange = (e) => detailModal(sellerId, e.target.value);
  }
  function commissionTable(list, actions) {
    if (!list.length) return '<p class="empty-note">Sin ventas en este periodo.</p>';
    return `<div class="table"><table><thead><tr><th>Venta</th>${isAdmin() ? '<th>Vendedor</th>' : ''}<th>Total</th><th>Utilidad</th><th>Comisión</th><th>Estado</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map((x) => `<tr><td><b>${H(clientName(x.quote.client_id))}</b><br><small>${H(x.quote.folio)} · ${H(x.quote.destination)} · ${H(fmtDate(x.day))}</small></td>${isAdmin() ? `<td>${H(x.seller ? userName(x.seller) : 'Sin asignar')}</td>` : ''}<td>${money(x.total)}${x.balance > 0.5 ? `<br><small>saldo ${money(x.balance)}</small>` : ''}</td><td>${x.profit == null ? '<span class="muted" title="Faltan costos o comisiones en las reservas">—</span>' : money(x.profit)}</td><td>${x.commission == null ? '—' : `${money(x.commission)}<br><small>${x.pct}%</small>`}</td><td><span class="bk-pill ${STATUS_CLASS[x.status]}">${H(x.status)}</span>${x.paid ? `<br><small>${H(fmtDate(String(x.paid.paid_at).slice(0, 10)))}</small>` : ''}</td>${actions ? `<td>${x.status === 'Por pagar' && x.commission != null ? `<button type="button" class="btn primary small" data-sc-pay="${x.quote.id}">Marcar pagada</button>` : ''}${x.status === 'Pagada' ? `<button type="button" class="link" data-sc-undo="${x.quote.id}">Deshacer</button>` : ''}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>`;
  }

  /* ---------------- Reportes › Comisiones de vendedores (administrador) ---------------- */
  const sc = { month: '', seller: '', status: '' };
  window.renderSellerCommissions = () => {
    const box = $('#sellerCommissions');
    if (!box || !K) return;
    if (!isAdmin()) { box.innerHTML = ''; return; }
    sc.month = sc.month || K.monthOf(todayStr());
    const goals = db.goals || { base: 'venta', sellers: {} };
    const all = K.sales(db, { month: sc.month, goals });
    const list = all.filter((x) => (!sc.seller || String(x.seller) === sc.seller) && (!sc.status || x.status === sc.status));
    const sum = (st) => all.filter((x) => x.status === st && (!sc.seller || String(x.seller) === sc.seller)).reduce((s, x) => s + (x.commission || 0), 0);
    const owedAll = K.sales(db, { goals }).filter((x) => x.status === 'Por pagar').reduce((s, x) => s + (x.commission || 0), 0);
    box.innerHTML = `<div class="panel-head"><div><h3>Comisiones de vendedores</h3><p class="panel-sub">Ventas aceptadas en el mes. Se liberan cuando el cliente liquida su viaje; márcalas pagadas al dárselas al vendedor.${owedAll ? ` Total por pagar (todos los meses): <b>${money(owedAll)}</b>.` : ''}</p></div>
      <div class="perf-ctrl"><select id="scMonth">${options(lastMonths(12).map((m) => [m, monthName(m)]), sc.month)}</select><select id="scSeller"><option value="">Todos los vendedores</option>${options(sellerUsers().map((u) => [String(u.id), u.name]), sc.seller)}</select><select id="scStatus"><option value="">Todos los estados</option>${options(K.STATUSES, sc.status)}</select></div></div>
      <div class="mini bk-kpis"><div>Por liberar<b>${money(sum('Por liberar'))}</b></div><div>Por pagar<b>${money(sum('Por pagar'))}</b></div><div>Pagada<b>${money(sum('Pagada'))}</b></div></div>
      ${commissionTable(list, true)}`;
    $('#scMonth').onchange = (e) => { sc.month = e.target.value; renderSellerCommissions(); };
    $('#scSeller').onchange = (e) => { sc.seller = e.target.value; renderSellerCommissions(); };
    $('#scStatus').onchange = (e) => { sc.status = e.target.value; renderSellerCommissions(); };
  };

  document.addEventListener('click', async (e) => {
    const det = e.target.closest('[data-goal-detail]');
    if (det) { detailModal(det.dataset.goalDetail); return; }
    const row = e.target.closest('[data-goal-seller]');
    if (row && isAdmin() && !e.target.closest('button')) { detailModal(row.dataset.goalSeller); return; }
    const pay = e.target.closest('[data-sc-pay]');
    const undo = e.target.closest('[data-sc-undo]');
    if (pay || undo) {
      const id = Number((pay || undo).dataset[pay ? 'scPay' : 'scUndo']);
      const q = quoteById(id);
      if (undo && !confirm(`¿Regresar a pendiente la comisión de ${q?.folio}?`)) return;
      (pay || undo).disabled = true;
      await mutate(() => send('POST', `/api/quotes/${id}/seller-commission`, { action: pay ? 'pay' : 'undo' }), pay ? 'Comisión marcada como pagada' : 'Comisión regresada a pendiente');
    }
  });

  /* ---------------- Configuración › Metas y comisiones ---------------- */
  const gs = { month: '' };
  window.renderGoalsSettings = async (reload = true) => {
    const box = $('#goalsSettingsBody');
    if (!box || !K) return;
    if (reload || !gs.goals) {
      try { gs.goals = await api('/api/goals'); } catch (error) { box.innerHTML = `<p class="muted">${H(error.message)}</p>`; return; }
    }
    const goals = gs.goals;
    gs.month = gs.month || K.monthOf(todayStr());
    const months = [K.monthOf(todayStr())]; for (let i = 0; i < 5; i += 1) { const d = new Date(`${months[months.length - 1]}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); months.push(d.toISOString().slice(0, 7)); }
    const users = sellerUsers();
    const v = (x) => (x === '' || x == null ? '' : x);
    box.innerHTML = `<form class="modal-form" id="gsForm">
      ${field('La meta se mide en', `<select name="base">${options(K.GOAL_BASES.map((b) => [b, b === 'venta' ? 'Ventas (total de cotizaciones aceptadas)' : 'Utilidad (reservas)']), goals.base)}</select>`)}
      ${field('Ajustar la meta de', `<select name="month" id="gsMonth">${options(months.map((m) => [m, monthName(m)]), gs.month)}</select>`)}
      <div class="full table"><table class="gs-table"><thead><tr><th>Vendedor</th><th>Meta mensual (MXN)</th><th>Meta de ${H(monthName(gs.month))}</th><th>% comisión sobre utilidad</th></tr></thead><tbody>
      ${users.map((u) => { const c = goals.sellers[String(u.id)] || { goal: '', pct: '', months: {} }; return `<tr data-gs-user="${u.id}"><td><b>${H(u.name)}</b><br><small>${H(u.role === 'admin' ? 'Administrador' : 'Vendedor')}</small></td><td><input data-gs="goal" inputmode="decimal" maxlength="12" value="${H(v(c.goal))}" placeholder="150000"></td><td><input data-gs="month" inputmode="decimal" maxlength="12" value="${H(v(c.months?.[gs.month]))}" placeholder="${H(v(c.goal) === '' ? 'Igual a la mensual' : `Igual: ${c.goal}`)}"></td><td><input data-gs="pct" inputmode="decimal" maxlength="6" value="${H(v(c.pct))}" placeholder="10"></td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="full muted-note">La meta mensual se repite cada mes; usa “Meta de …” solo para un mes distinto (temporada alta, vacaciones). La comisión es el % sobre la utilidad de cada venta: reservas de tarifa neta (venta − costo) y comisiones de proveedores (TP-205). Queda <b>Por liberar</b> hasta que el cliente liquida su plan de pagos, luego <b>Por pagar</b>; la marcas <b>Pagada</b> en Reportes › Comisiones de vendedores.</p>
      <div class="modal-actions"><button type="submit" class="btn primary">Guardar</button></div></form>`;
    const form = $('#gsForm');
    // Cambiar de mes conserva lo que ya escribiste (se guarda todo junto).
    $('#gsMonth').onchange = (e) => { gs.goals = collect(); gs.month = e.target.value; renderGoalsSettings(false); };
    function collect() {
      const out = { base: form.base.value, sellers: { ...goals.sellers } };
      $$('#gsForm [data-gs-user]').forEach((tr) => {
        const id = tr.dataset.gsUser;
        const prev = goals.sellers[id] || { goal: '', pct: '', months: {} };
        const val = (k) => tr.querySelector(`[data-gs="${k}"]`).value.trim();
        const months = { ...(prev.months || {}) };
        if (val('month') === '') delete months[gs.month]; else months[gs.month] = val('month');
        out.sellers[id] = { goal: val('goal'), pct: val('pct'), months };
      });
      return out;
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { const saved = await send('PUT', '/api/goals', collect()); gs.goals = { base: saved.base, sellers: saved.sellers }; db.goals = gs.goals; toast('Metas y comisiones guardadas'); renderGoalPanel(); } catch (error) { toast(error.message, 6000); }
    };
  };
}());
