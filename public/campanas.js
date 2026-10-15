'use strict';

/* =========================================================
   TP-310 Campañas de recompra · TP-311 Reportes por vendedor y por origen
   ========================================================= */
(function () {
  const H = escapeHtml;
  const KIND = { aniversario: ['🌴', 'Aniversario del viaje'], cumpleanos: ['🎂', 'Cumpleaños'], temporada: ['📅', 'Temporada'] };
  const TEMPLATE = { aniversario: 'rc1', cumpleanos: 'rc2', temporada: 'rc3' };
  const cv = { status: 'Pendiente', kind: '', data: null, loading: false };

  /* ---------------- TP-310 · Bandeja de campañas ---------------- */
  async function loadCampaigns() {
    if (cv.loading) return;
    cv.loading = true;
    try { cv.data = await api('/api/campaigns'); } catch { cv.data = cv.data || { touches: [], settings: null }; }
    cv.loading = false;
  }
  window.renderCampaigns = async (reload = true) => {
    const box = $('#campaignsBody');
    if (!box) return;
    if (reload || !cv.data) await loadCampaigns();
    const all = cv.data?.touches || [];
    const today = todayStr();
    const count = (st) => all.filter((t) => t.status === st).length;
    const badge = $('#campaignBadge');
    if (badge) { const n = count('Pendiente'); badge.textContent = n; badge.classList.toggle('hidden', !n); }
    const list = all.filter((t) => (!cv.status || t.status === cv.status) && (!cv.kind || t.kind === cv.kind));
    const s = cv.data?.settings;
    const sentMonth = all.filter((t) => t.status === 'Enviado' && String(t.done_at || '').slice(0, 7) === today.slice(0, 7)).length;
    const reopened = (t) => db.leads.some((l) => l.client_id === t.client_id && String(l.created_at || '').slice(0, 10) >= t.due);
    const won = all.filter((t) => t.status === 'Enviado' && reopened(t)).length;
    box.innerHTML = `<div class="mini bk-kpis"><div>Por contactar<b>${count('Pendiente')}</b></div><div>Enviados este mes<b>${sentMonth}</b></div><div>Volvieron a cotizar<b>${won}</b><small>tras un mensaje de campaña</small></div><div>Omitidos<b>${count('Omitido')}</b></div></div>
      ${s && !s.enabled ? '<p class="note-warn">Las campañas están pausadas (Configuración › Campañas de recompra).</p>' : ''}
      <div class="toolbar"><select id="cvStatus">${options([['Pendiente', 'Por contactar'], ['Enviado', 'Enviados'], ['Omitido', 'Omitidos'], ['', 'Todos']], cv.status)}</select><select id="cvKind"><option value="">Todas las campañas</option>${options(Object.entries(KIND).map(([k, v]) => [k, `${v[0]} ${v[1]}`]), cv.kind)}</select>${isAdmin() ? '<button type="button" class="btn secondary small" id="cvRun">Revisar ahora</button>' : ''}</div>
      <div class="cv-list">${list.length ? list.map((t) => `<article class="cv-touch ${t.status === 'Pendiente' ? '' : 'done'}" data-cv-client="${t.client_id}" data-cv-touch="${H(t.id)}">
          <span class="cv-ico">${KIND[t.kind]?.[0] || '📣'}</span>
          <div><b>${H(t.client_name)}</b><small>${H(t.name)} · ${t.due > today ? `para el ${H(fmtDate(t.due))}` : t.due === today ? 'hoy' : `desde el ${H(fmtDate(t.due))}`}${t.email_sent_at ? ' · ✉️ correo enviado' : ''}${t.status !== 'Pendiente' ? ` · ${H(t.status)} ${H(fmtDate(String(t.done_at || '').slice(0, 10)))}` : ''}</small></div>
          <div class="cv-acts">${t.status === 'Pendiente' ? `${t.phone ? '<button type="button" class="btn primary small" data-cv-wa>💬 WhatsApp</button>' : '<small class="muted">Sin WhatsApp</small>'}<button type="button" class="btn secondary small" data-cv-set="Enviado">✓ Enviado</button><button type="button" class="btn secondary small" data-cv-set="Omitido">Omitir</button>` : '<button type="button" class="link" data-cv-set="Pendiente">Regresar a pendientes</button>'}<button type="button" class="link" data-client="${t.client_id}">Ficha</button></div></article>`).join('') : `<p class="empty-note">${all.length ? 'Nada con estos filtros.' : 'Aún no hay contactos. Cada día se agregan los clientes con aniversario de viaje, cumpleaños o temporada.'}</p>`}</div>`;
    $('#cvStatus').onchange = (e) => { cv.status = e.target.value; renderCampaigns(false); };
    $('#cvKind').onchange = (e) => { cv.kind = e.target.value; renderCampaigns(false); };
    const run = $('#cvRun');
    if (run) run.onclick = async () => { run.disabled = true; try { const r = await send('POST', '/api/campaigns/run'); toast(r.result.created ? `${r.result.created} contactos nuevos` : 'Sin contactos nuevos por hoy'); await loadAll(); } catch (error) { toast(error.message); } run.disabled = false; };
  };
  async function setTouch(clientId, touchId, status) {
    try { await send('PATCH', `/api/clients/${clientId}/campaigns/${touchId}`, { status }); await renderCampaigns(); } catch (error) { toast(error.message); }
  }
  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-cv-touch]');
    if (!card) return;
    const clientId = Number(card.dataset.cvClient), touchId = card.dataset.cvTouch;
    const t = (cv.data?.touches || []).find((x) => x.id === touchId && x.client_id === clientId);
    if (!t) return;
    if (e.target.closest('[data-cv-set]')) { setTouch(clientId, touchId, e.target.closest('[data-cv-set]').dataset.cvSet); return; }
    if (e.target.closest('[data-cv-wa]')) {
      const years = t.years ? `${t.years} ${t.years === 1 ? 'año' : 'años'}` : '';
      waModal({ clientId, tripId: t.trip_id || undefined, stage: 'recompra', templateId: TEMPLATE[t.kind], vars: { campana: t.campaign || '', anos_viaje: years, destino_anterior: t.destination || '' }, onSent: (channel) => send('PATCH', `/api/clients/${clientId}/campaigns/${touchId}`, { status: 'Enviado', note: channel }).catch(() => {}) });
    }
  });

  /* ---------------- Configuración ---------------- */
  window.renderCampaignSettings = async () => {
    const box = $('#campaignSettingsBody');
    if (!box) return;
    let s;
    try { s = await api('/api/campaigns/settings'); } catch (error) { box.innerHTML = `<p class="muted">${H(error.message)}</p>`; return; }
    let seasons = s.seasons.map((x) => ({ ...x }));
    const seasonRow = (x, i) => `<div class="cs-row" data-si="${i}"><input data-sf="name" maxlength="60" value="${H(x.name)}" placeholder="el verano"><input data-sf="date" maxlength="5" value="${H(x.date)}" placeholder="MM-DD"><label class="kb-check"><input type="checkbox" data-sf="enabled" ${x.enabled ? 'checked' : ''}> Activa</label><label class="kb-check"><input type="checkbox" data-sf="email" ${x.email ? 'checked' : ''}> Correo</label><button type="button" class="link danger-link" data-s-del="${i}">Quitar</button></div>`;
    const paint = () => { $('#csSeasons').innerHTML = seasons.map(seasonRow).join('') || '<p class="muted-note">Sin temporadas.</p>'; };
    box.innerHTML = `<form class="modal-form" id="csForm">
      <label class="full kb-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Campañas de recompra activas (se revisan una vez al día)</label>
      <p class="full section-label">🌴 Aniversario del viaje</p>
      <label class="kb-check"><input type="checkbox" name="anEnabled" ${s.anniversary.enabled ? 'checked' : ''}> Activa</label>
      ${field('Días antes del aniversario', `<input name="anDays" type="number" min="0" max="90" value="${s.anniversary.daysBefore}">`)}
      <label class="full kb-check"><input type="checkbox" name="anEmail" ${s.anniversary.email ? 'checked' : ''}> Enviar también correo al cliente</label>
      <p class="full section-label">🎂 Cumpleaños</p>
      <label class="kb-check"><input type="checkbox" name="bdEnabled" ${s.birthday.enabled ? 'checked' : ''}> Activa</label>
      ${field('Días antes del cumpleaños', `<input name="bdDays" type="number" min="0" max="90" value="${s.birthday.daysBefore}">`)}
      <label class="full kb-check"><input type="checkbox" name="bdEmail" ${s.birthday.email ? 'checked' : ''}> Enviar también correo de felicitación</label>
      <p class="full muted-note">La fecha de nacimiento se captura en Ficha 360 › Datos del cliente, o se toma sola de su registro como pasajero.</p>
      <p class="full section-label">📅 Temporadas (a clientes anteriores sin viaje próximo ni lead abierto)</p>
      <div class="full" id="csSeasons"></div>
      <div class="full"><button type="button" class="btn secondary small" id="csAdd">+ Agregar temporada</button></div>
      <p class="full muted-note">Fecha en formato MM-DD (por ejemplo 04-15 = 15 de abril). El nombre completa la frase “Ya se acerca …”. Los clientes marcados “No contactar en campañas” nunca se incluyen.</p>
      <div class="modal-actions"><button type="submit" class="btn primary">Guardar</button></div></form>`;
    paint();
    const form = $('#csForm');
    form.oninput = (e) => { const row = e.target.closest('[data-si]'); if (!row || !e.target.dataset.sf) return; const x = seasons[Number(row.dataset.si)]; x[e.target.dataset.sf] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim(); };
    form.onchange = form.oninput;
    form.onclick = (e) => {
      if (e.target.id === 'csAdd') { seasons.push({ name: '', date: '', enabled: true, email: false }); paint(); return; }
      const del = e.target.closest('[data-s-del]');
      if (del) { seasons.splice(Number(del.dataset.sDel), 1); paint(); }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try {
        await send('PUT', '/api/campaigns/settings', { enabled: Boolean(v.enabled), anniversary: { enabled: Boolean(v.anEnabled), daysBefore: Number(v.anDays), email: Boolean(v.anEmail) }, birthday: { enabled: Boolean(v.bdEnabled), daysBefore: Number(v.bdDays), email: Boolean(v.bdEmail) }, seasons: seasons.filter((x) => x.name || x.date) });
        toast('Campañas de recompra guardadas');
      } catch (error) { toast(error.message, 6000); }
    };
  };

  /* ---------------- TP-311 · Desempeño por vendedor y por origen ---------------- */
  const pf = { period: 'month', by: 'seller' };
  const PERIODS = [['month', 'Este mes'], ['prev', 'Mes anterior'], ['90', 'Últimos 90 días'], ['year', 'Este año'], ['all', 'Todo']];
  const COLS = [
    ['label', 'Vendedor'], ['leads', 'Leads'], ['contactRate', 'Contactados', (v) => (v == null ? '—' : `${v}%`)], ['responseHours', '1ª respuesta', (v) => (v == null ? '—' : v < 1 ? `${Math.round(v * 60)} min` : `${v} h`)],
    ['quotesSent', 'Cotizaciones enviadas'], ['sales', 'Ventas'], ['revenue', 'Ingresos', (v) => money(v)], ['ticket', 'Ticket', (v) => (v == null ? '—' : money(v))],
    ['conversion', 'Conversión', (v) => (v == null ? '—' : `${v}%`)], ['lost', 'Perdidos'], ['winRate', 'Ganadas / cerradas', (v) => (v == null ? '—' : `${v}%`)],
    ['closeDays', 'Días al cierre', (v) => (v == null ? '—' : v)], ['profit', 'Utilidad (reservas)', (v, r) => (v == null ? '—' : `${money(v)}${r.profitSales < r.sales ? ` <small>(${r.profitSales}/${r.sales})</small>` : ''}`)]
  ];
  function compute() {
    const { from, to } = TPReports.period(pf.period, todayStr());
    return TPReports.performance(db, { from, to, by: pf.by, label: (k) => (pf.by === 'origin' ? k : k === 'none' ? 'Sin asignar' : userName(k)) });
  }
  window.renderPerformance = () => {
    const box = $('#performanceReport');
    if (!box || !window.TPReports) return;
    const r = compute();
    const cols = COLS.map((c, i) => (i === 0 ? [c[0], pf.by === 'origin' ? 'Origen' : 'Vendedor', c[2]] : c));
    const maxRev = Math.max(1, ...r.rows.map((x) => x.revenue));
    const cell = (c, row) => (c[2] ? c[2](row[c[0]], row) : H(row[c[0]] ?? '—'));
    box.innerHTML = `<div class="panel-head"><div><h3>Desempeño por ${pf.by === 'origin' ? 'origen' : 'vendedor'}</h3><p class="panel-sub">Leads, contacto y conversión: leads creados en el periodo. Ventas, ingresos, perdidos y utilidad: leads cerrados en el periodo.</p></div>
        <div class="perf-ctrl"><div class="seg">${[['seller', 'Por vendedor'], ['origin', 'Por origen']].map(([k, l]) => `<button type="button" data-pf-by="${k}" class="${pf.by === k ? 'on' : ''}">${l}</button>`).join('')}</div><select id="pfPeriod">${options(PERIODS, pf.period)}</select><button type="button" class="btn secondary small" id="pfCsv">⬇ CSV</button></div></div>
      ${r.rows.length ? `<div class="table"><table class="perf-table"><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>
        ${r.rows.map((row) => `<tr>${cols.map((c, i) => `<td>${i === 0 ? `<b>${H(row.label)}</b><i class="perf-bar" style="width:${Math.round((row.revenue / maxRev) * 100)}%"></i>` : cell(c, row)}</td>`).join('')}</tr>`).join('')}
        <tr class="perf-total">${cols.map((c, i) => `<td>${i === 0 ? '<b>Total</b>' : cell(c, r.total)}</td>`).join('')}</tr></tbody></table></div>
        <p class="muted-note">1ª respuesta: mediana entre la asignación del lead y el primer contacto. Utilidad: venta menos costo de las reservas registradas (entre paréntesis, cuántas ventas ya tienen costos). Comisiones por vendedor: se agregan con TP-206.</p>` : '<p class="empty-note">Sin datos en este periodo.</p>'}`;
    box.querySelectorAll('[data-pf-by]').forEach((b) => { b.onclick = () => { pf.by = b.dataset.pfBy; renderPerformance(); }; });
    $('#pfPeriod').onchange = (e) => { pf.period = e.target.value; renderPerformance(); };
    $('#pfCsv').onclick = () => {
      const plainCell = (c, row) => { const v = row[c[0]]; return v == null ? '' : String(v); };
      const lines = [cols.map((c) => c[1]), ...r.rows.map((row) => cols.map((c) => plainCell(c, row))), cols.map((c, i) => (i === 0 ? 'Total' : plainCell(c, r.total)))];
      const csv = '﻿' + lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `desempeno-${pf.by === 'origin' ? 'origen' : 'vendedor'}-${pf.period}-${todayStr()}.csv` });
      document.body.appendChild(a); a.click(); a.remove();
    };
  };
}());
