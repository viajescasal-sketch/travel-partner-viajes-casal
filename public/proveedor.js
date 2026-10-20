'use strict';

/* =========================================================
   TP-009 · Portal del proveedor de traslados
   Solicitudes de precio, servicios por confirmar / programados y calendario de pagos.
   ========================================================= */
(function () {
  const P = window.TPProv;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const H = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const fmtDate = (d) => { if (!P.isDate(d)) return d || ''; const x = new Date(`${d}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()].slice(0, 3)}`; };
  const fmtLong = (d) => { if (!P.isDate(d)) return d || 'Sin fecha'; const x = new Date(`${d}T12:00:00Z`); return `${['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][x.getUTCDay()]} ${x.getUTCDate()} de ${MONTHS[x.getUTCMonth()]}`; };
  const fmtStamp = (v) => (v ? `${fmtDate(String(v).slice(0, 10))} ${String(v).slice(11, 16)}` : '');
  const waUrl = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length === 10 ? `52${d}` : d}` : ''; };

  const state = { data: null, tab: 'home', svc: 'confirm', month: '', day: '', notices: [], unread: 0 };

  async function api(url, method = 'GET', body) {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace('/'); throw new Error('Inicia sesión'); }
    if (!res.ok || out.ok === false) throw Object.assign(new Error(out.error || 'No se pudo completar'), { status: res.status });
    return out;
  }
  function toast(text, ms = 3500) { const el = document.createElement('div'); el.className = 'pv-toast'; el.textContent = text; $('#pvToasts').appendChild(el); setTimeout(() => el.remove(), ms); }
  function openModal(title, html) { $('#pvModalTitle').textContent = title; $('#pvModalBody').innerHTML = html; $('#pvModalBg').classList.remove('hidden'); $('#pvModalBody input')?.focus(); }
  function closeModal() { $('#pvModalBg').classList.add('hidden'); $('#pvModalBody').innerHTML = ''; }

  /* ---------- tarjeta de un servicio ---------- */
  function facts(s) {
    const d = s.details || {};
    const wa = waUrl(d.phone);
    const f = [
      ['Servicio', d.kind], ['Pasajeros', P.paxText(d) || '—'],
      ['Recoger en', d.pickup_place], ['Llevar a', d.dropoff_place],
      ['Pasajero titular', d.passenger], ['WhatsApp', d.phone ? (wa ? `<a class="pv-wa" href="${H(wa)}" target="_blank" rel="noopener">${H(d.phone)}</a>` : H(d.phone)) : '', true],
      ['Vuelo', d.flight], ['Unidad', d.vehicle],
      ['Regreso', [d.return_date ? fmtDate(d.return_date) : '', d.return_time, d.return_flight].filter(Boolean).join(' · ')]
    ].filter(([, v]) => v);
    return `<div class="pv-facts">${f.map(([k, v, raw]) => `<div><span>${H(k)}</span><b>${raw ? v : H(v)}</b></div>`).join('')}${d.notes ? `<div class="full"><span>Indicaciones</span><b>${H(d.notes)}</b></div>` : ''}</div>`;
  }
  function card(s) {
    const closed = P.CLOSED.includes(s.state);
    let body = '';
    if (s.state === 'Solicitada' || s.state === 'Cotizada') {
      body = `${s.state === 'Cotizada' ? `<div class="pv-note">Enviaste <b>${money(s.quote?.amount)} MXN</b>${s.quote?.notes ? ` · ${H(s.quote.notes)}` : ''}. Viajes Casal lo está revisando; puedes corregirlo mientras tanto.</div>` : ''}
        <form class="pv-form" data-quote="${H(s.key)}">
          <label>Precio total (MXN)*<input name="amount" inputmode="decimal" required maxlength="12" value="${H(s.quote?.amount ?? '')}" placeholder="Ej. 1500"></label>
          <label>Comentarios<input name="notes" maxlength="500" value="${H(s.quote?.notes || '')}" placeholder="Ej. van privada, incluye espera"></label>
          <div class="pv-actions full"><button type="button" class="pv-btn link" data-decline="${H(s.key)}">No tengo disponibilidad</button><button class="pv-btn primary">${s.state === 'Cotizada' ? 'Actualizar precio' : 'Enviar precio'}</button></div>
        </form>`;
    } else if (s.state === 'Aceptada') {
      body = `<div class="pv-note ok">✓ Precio aceptado: <b>${money(s.amount)} MXN</b>${s.decision_note ? ` · ${H(s.decision_note)}` : ''}. Confirma el servicio con tu folio y los datos del chofer.${s.due ? ` Fecha de pago: <b>${H(fmtDate(s.due))}</b>.` : ''}</div>
        <div class="pv-actions"><button type="button" class="pv-btn primary" data-confirm="${H(s.key)}">Confirmar servicio</button></div>`;
    } else if (s.state === 'Confirmada') {
      const dr = s.driver || {};
      body = `<div class="pv-note ok">✓ Confirmado · folio <b>${H(s.confirmation)}</b> · ${money(s.amount)} MXN${dr.name ? ` · chofer ${H(dr.name)}${dr.phone ? ` (${H(dr.phone)})` : ''}` : ''}${dr.unit ? ` · ${H(dr.unit)}` : ''}</div>
        ${s.date >= state.data.today ? `<div class="pv-actions"><button type="button" class="pv-btn secondary" data-confirm="${H(s.key)}">Actualizar chofer o unidad</button></div>` : ''}`;
    } else if (closed) {
      body = `<div class="pv-note bad">${H(P.STATE_LABELS[s.state])}${s.decision_note ? ` · ${H(s.decision_note)}` : ''}</div>`;
    }
    return `<article class="pv-card s-${H(s.state.replace(/\s/g, ''))}${closed ? ' closed' : ''}">
      <div class="pv-card-top"><div><span class="pv-pill p-${H(s.state.replace(/\s/g, ''))}">${H(s.label)}</span> <b>${H(s.folio)}</b><h3>${H(P.route(s.details || {}) || 'Servicio')}</h3></div><div class="pv-when">${H(fmtDate(s.date))}${s.time ? ` · ${H(s.time)}` : ''}</div></div>
      ${facts(s)}
      ${body}
      ${(s.log || []).length ? `<details class="pv-log"><summary>Historial</summary>${s.log.slice().reverse().map((l) => `<div><span class="muted">${H(fmtStamp(l.at))} · ${H(l.who)}</span><br>${H(l.text)}</div>`).join('')}</details>` : ''}
    </article>`;
  }
  const byDay = (list, empty) => {
    if (!list.length) return `<p class="pv-empty">${H(empty)}</p>`;
    let last = null;
    return list.map((s) => { const head = s.date !== last ? `<p class="pv-day">${H(fmtLong(s.date))}</p>` : ''; last = s.date; return head + card(s); }).join('');
  };

  /* ---------- pestañas ---------- */
  function renderHome() {
    const { services, today } = state.data;
    const sec = P.sections(services, today);
    const pay = P.payments(services, today);
    const soon = P.isDate(today) ? new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10) : today;
    const week = sec.upcoming.filter((s) => s.date && s.date <= soon);
    const todayList = sec.upcoming.filter((s) => s.date === today);
    $('#tab-home').innerHTML = `<div class="pv-head"><h2>Hola, ${H(state.data.user.name)} 👋</h2><p>${H(state.data.supplier.name)} · servicios que Viajes Casal tiene contigo.</p></div>
      <div class="pv-kpis">
        <button type="button" data-go="requests" class="${sec.toQuote.length ? 'warn' : ''}"><span>Por cotizar</span><b>${sec.toQuote.length}</b><small>${sec.quoted.length ? `${sec.quoted.length} en revisión` : 'Solicitudes de precio'}</small></button>
        <button type="button" data-go="services" data-svc="confirm" class="${sec.toConfirm.length ? 'warn' : ''}"><span>Por confirmar</span><b>${sec.toConfirm.length}</b><small>Precio aceptado</small></button>
        <button type="button" data-go="services" data-svc="upcoming"><span>Próximos 7 días</span><b>${week.length}</b><small>${todayList.length ? `${todayList.length} hoy` : 'Servicios confirmados'}</small></button>
        <button type="button" data-go="payments" class="${pay.lateCount ? 'danger' : ''}"><span>Por cobrar</span><b>${money(pay.open)}</b><small>${pay.lateCount ? `${money(pay.late)} vencido` : `${pay.openCount} servicio${pay.openCount === 1 ? '' : 's'}`}</small></button>
      </div>
      ${sec.toQuote.length ? `<h3>Te piden precio</h3>${byDay(sec.toQuote.slice(0, 3), '')}${sec.toQuote.length > 3 ? '<button type="button" class="pv-btn secondary" data-go="requests">Ver todas</button>' : ''}` : ''}
      ${sec.toConfirm.length ? `<h3 style="margin-top:14px">Confirma estos servicios</h3>${byDay(sec.toConfirm.slice(0, 3), '')}` : ''}
      <h3 style="margin-top:14px">Próximos servicios</h3>${byDay(week, 'No tienes servicios confirmados en los próximos 7 días.')}`;
  }
  function renderRequests() {
    const sec = P.sections(state.data.services, state.data.today);
    $('#tab-requests').innerHTML = `<div class="pv-head"><h2>Solicitudes de precio</h2><p>Escribe tu precio total por el servicio. Si Viajes Casal lo acepta, te aparecerá en “Servicios › Por confirmar”.</p></div>
      ${byDay(sec.toQuote, 'No tienes solicitudes nuevas. 👌')}
      ${sec.quoted.length ? `<p class="pv-day">Precio enviado · en revisión</p>${sec.quoted.map(card).join('')}` : ''}`;
  }
  function renderServices() {
    const sec = P.sections(state.data.services, state.data.today);
    const views = { confirm: ['Por confirmar', sec.toConfirm, 'No tienes servicios pendientes de confirmar.'], upcoming: ['Próximos', sec.upcoming, 'No tienes servicios programados.'], done: ['Realizados', sec.done, 'Aún no hay servicios realizados.'], closed: ['Cancelados / no aceptados', sec.closed, 'Nada por aquí.'] };
    const [, list, empty] = views[state.svc];
    $('#tab-services').innerHTML = `<div class="pv-head"><h2>Servicios</h2><p>Lo que tenemos pendiente contigo, por fecha.</p></div>
      <div class="pv-sub">${Object.entries(views).map(([k, [label, l]]) => `<button type="button" data-svc="${k}" class="${state.svc === k ? 'active' : ''}">${H(label)} (${l.length})</button>`).join('')}</div>
      ${byDay(list, empty)}`;
  }
  function renderPayments() {
    const { services, today, supplier } = state.data;
    const pay = P.payments(services, today);
    if (!state.month) state.month = today.slice(0, 7);
    const grid = P.monthGrid(state.month);
    const [y, m] = state.month.split('-').map(Number);
    const chip = (s) => `<i class="${s.paid ? 'paid' : s.due < today ? 'late' : 'due'}">${money(s.amount)}</i>`;
    const dayRows = state.day ? pay.byDay[state.day] || [] : null;
    const rows = (dayRows || pay.rows.filter((s) => { const k = s.paid ? s.paid_at || s.due : s.due; return !k || k.slice(0, 7) === state.month; }))
      .sort((a, c) => String(a.due || '9').localeCompare(String(c.due || '9')));
    $('#tab-payments').innerHTML = `<div class="pv-head"><h2>Pagos</h2><p>Lo que Viajes Casal te paga por los servicios aceptados.${supplier.payment_terms ? ` Condiciones: ${H(supplier.payment_terms)}.` : ''}</p></div>
      <div class="pv-kpis">
        <div><span>Por cobrar</span><b>${money(pay.open)}</b><small>${pay.openCount} servicio${pay.openCount === 1 ? '' : 's'}${pay.noDate ? ` · ${pay.noDate} sin fecha` : ''}</small></div>
        <div class="${pay.lateCount ? 'danger' : ''}"><span>Vencido</span><b>${money(pay.late)}</b><small>${pay.lateCount ? `${pay.lateCount} pasado${pay.lateCount === 1 ? '' : 's'} de su fecha` : 'Al día'}</small></div>
        <div><span>Pagado este mes</span><b>${money(pay.paidMonth)}</b><small>${pay.paidMonthCount} pago${pay.paidMonthCount === 1 ? '' : 's'}</small></div>
        <div><span>Servicios con precio aceptado</span><b>${pay.rows.length}</b><small>Total ${money(pay.rows.reduce((x, s) => x + Number(s.amount || 0), 0))}</small></div>
      </div>
      <div class="pv-cal-head"><button type="button" data-month="-1" aria-label="Mes anterior">‹</button><h3>${H(MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1))} ${y}</h3><button type="button" data-month="1" aria-label="Mes siguiente">›</button></div>
      <div class="pv-legend"><span><i style="background:#fff5d9"></i>Por pagar (fecha de pago)</span><span><i style="background:#fdecec"></i>Vencido</span><span><i style="background:#e8f7ef"></i>Pagado</span></div>
      <div class="pv-cal">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span>${d}</span>`).join('')}${grid.map((d) => { const l = pay.byDay[d.date] || []; return `<button type="button" class="d${d.inMonth ? '' : ' out'}${d.date === today ? ' today' : ''}${l.length ? ' has' : ''}${state.day === d.date ? ' sel' : ''}" ${l.length ? `data-day="${d.date}"` : 'disabled'}><b>${Number(d.date.slice(8))}</b>${l.slice(0, 2).map(chip).join('')}${l.length > 2 ? `<small>+${l.length - 2}</small>` : ''}</button>`; }).join('')}</div>
      <h3>${dayRows ? `${H(fmtLong(state.day))} <button type="button" class="pv-btn secondary" data-day="">Ver todo el mes</button>` : 'Detalle del mes'}</h3>
      <div class="pv-table-wrap"><table class="pv-table"><thead><tr><th>Folio</th><th>Servicio</th><th>Fecha servicio</th><th>Monto</th><th>Fecha de pago</th><th>Estado</th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td><b>${H(s.folio)}</b></td><td>${H(P.route(s.details || {}))}<br><small class="muted">${H(s.details?.passenger || '')}</small></td><td>${H(fmtDate(s.date))}</td><td><b>${money(s.amount)}</b></td><td>${s.due ? H(fmtDate(s.due)) : '<span class="muted">Por definir</span>'}</td><td>${s.paid ? `<span class="pv-pill p-Confirmada">Pagado${s.paid_at ? ` ${H(fmtDate(s.paid_at))}` : ''}</span>` : s.due && s.due < today ? '<span class="pv-pill p-Solicitada">Vencido</span>' : '<span class="pv-pill p-Cotizada">Por pagar</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin pagos en este periodo.</td></tr>'}
      </tbody></table></div>`;
  }
  function renderNotices() {
    $('#tab-notices').innerHTML = `<div class="pv-head"><h2>Avisos</h2><p>Nuevas solicitudes, precios aceptados y cancelaciones.</p></div>
      ${state.unread ? '<div class="pv-actions" style="margin-bottom:10px"><button type="button" class="pv-btn secondary" id="pvReadAll">Marcar todo como leído</button></div>' : ''}
      ${state.notices.map((n) => `<div class="pv-notice${n.read ? '' : ' unread'}"><b>${H(n.title)}</b><small>${H(n.body)}${n.body ? ' · ' : ''}${H(fmtStamp(n.createdAt))}</small></div>`).join('') || '<p class="pv-empty">Sin avisos por ahora.</p>'}`;
  }
  function counters() {
    const sec = P.sections(state.data.services, state.data.today);
    $('#cntRequests').textContent = sec.toQuote.length || '';
    $('#cntServices').textContent = sec.toConfirm.length || '';
    $('#cntNotices').textContent = state.unread || '';
  }
  function render() {
    if (!state.data) return;
    counters();
    ({ home: renderHome, requests: renderRequests, services: renderServices, payments: renderPayments, notices: renderNotices })[state.tab]();
  }
  function go(tab, svc) {
    state.tab = tab;
    if (svc) state.svc = svc;
    $$('#pvTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.pv-tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${tab}`));
    render();
    window.scrollTo({ top: 0 });
    if (tab === 'notices' && state.unread) api('/api/notifications/read', 'POST', { all: true }).then(() => { state.unread = 0; counters(); }).catch(() => {});
  }

  async function load() {
    const [portal, notes] = await Promise.all([api('/api/proveedor/portal'), api('/api/notifications?limit=40').catch(() => ({ items: [], unread: 0 }))]);
    state.data = portal;
    state.notices = notes.items || [];
    state.unread = Number(notes.unread ?? state.notices.filter((n) => !n.read).length) || 0;
    $('#pvSupplier').textContent = portal.supplier.name;
    $('#pvUser').textContent = `${portal.user.name} · ${portal.user.email}`;
    $('#pvInitial').textContent = (portal.user.name || '·').charAt(0).toUpperCase();
    $('#pvLoading').classList.add('hidden');
    render();
  }
  const find = (key) => state.data.services.find((s) => s.key === key);
  const pathOf = (s, action) => `/api/proveedor/services/${s.trip_id}/${encodeURIComponent(s.booking_id)}/${action}`;
  async function act(btn, fn, msg) {
    if (btn) btn.disabled = true;
    try { await fn(); toast(msg); await load(); } catch (e) { toast(e.message, 5000); if (btn) btn.disabled = false; }
  }

  function confirmModal(s) {
    const dr = s.driver || {};
    openModal(`Confirmar ${s.folio}`, `<form class="pv-form" id="pvConfirmForm">
      <p class="full muted">${H(fmtLong(s.date))}${s.time ? ` · ${H(s.time)}` : ''} · ${H(P.route(s.details || {}))}</p>
      <label class="full">Tu número de confirmación o folio*<input name="confirmation" required maxlength="60" value="${H(s.confirmation)}"></label>
      <label>Chofer<input name="driver_name" maxlength="80" value="${H(dr.name || '')}"></label>
      <label>Celular del chofer<input name="driver_phone" maxlength="40" inputmode="tel" value="${H(dr.phone || '')}"></label>
      <label class="full">Unidad<input name="unit" maxlength="80" value="${H(dr.unit || '')}" placeholder="Van blanca · placas ABC-123"></label>
      <label class="full">Notas para Viajes Casal<textarea name="notes" rows="2" maxlength="300">${H(dr.notes || '')}</textarea></label>
      <div class="pv-actions full"><button type="button" class="pv-btn secondary" data-close>Cancelar</button><button class="pv-btn primary">${s.state === 'Confirmada' ? 'Guardar cambios' : 'Confirmar servicio'}</button></div></form>`);
    $('#pvConfirmForm').onsubmit = (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.currentTarget));
      act(e.currentTarget.querySelector('.primary'), () => api(pathOf(s, 'confirm'), 'POST', body), s.state === 'Confirmada' ? 'Datos actualizados' : `${s.folio} confirmado ✓`).then(closeModal);
    };
  }
  function passwordModal() {
    openModal('Cambiar mi contraseña', `<form class="pv-form" id="pvPassForm">
      <label class="full">Contraseña actual<input name="currentPassword" type="password" autocomplete="current-password" required></label>
      <label class="full">Nueva contraseña (mínimo 12, con mayúscula, minúscula y número)<input name="newPassword" type="password" autocomplete="new-password" minlength="12" required></label>
      <label class="full">Confirmar<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label>
      <div class="pv-actions full"><button type="button" class="pv-btn secondary" data-close>Cancelar</button><button class="pv-btn primary">Guardar</button></div></form>`);
    $('#pvPassForm').onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.currentTarget));
      if (v.newPassword !== v.confirm) { toast('Las contraseñas no coinciden'); return; }
      try { await api('/api/auth/change-password', 'POST', { currentPassword: v.currentPassword, newPassword: v.newPassword }); closeModal(); toast('Contraseña actualizada'); } catch (err) { toast(err.message, 5000); }
    };
  }

  /* ---------- eventos ---------- */
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-quote]');
    if (!f) return;
    e.preventDefault();
    const s = find(f.dataset.quote);
    const v = Object.fromEntries(new FormData(f));
    act(f.querySelector('.primary'), () => api(pathOf(s, 'quote'), 'POST', v), `Precio enviado para ${s.folio}`);
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    const tab = t.closest('#pvTabs [data-tab]');
    if (tab) { go(tab.dataset.tab); return; }
    const goBtn = t.closest('[data-go]');
    if (goBtn) { go(goBtn.dataset.go, goBtn.dataset.svc); return; }
    const svc = t.closest('.pv-sub [data-svc]');
    if (svc) { state.svc = svc.dataset.svc; render(); return; }
    const dec = t.closest('[data-decline]');
    if (dec) { const s = find(dec.dataset.decline); const note = prompt(`¿No puedes dar el servicio ${s.folio}? Cuéntanos el motivo (opcional):`, ''); if (note !== null) act(dec, () => api(pathOf(s, 'decline'), 'POST', { note }), 'Avisamos a Viajes Casal'); return; }
    const conf = t.closest('[data-confirm]');
    if (conf) { confirmModal(find(conf.dataset.confirm)); return; }
    const mon = t.closest('[data-month]');
    if (mon) { state.month = P.shiftMonth(state.month, Number(mon.dataset.month)); state.day = ''; render(); return; }
    const day = t.closest('[data-day]');
    if (day) { state.day = day.dataset.day === state.day ? '' : day.dataset.day; render(); return; }
    if (t.closest('[data-close]') || t.id === 'pvModalClose' || t.id === 'pvModalBg') { closeModal(); return; }
    if (t.id === 'pvReadAll') { api('/api/notifications/read', 'POST', { all: true }).then(() => { state.unread = 0; state.notices.forEach((n) => { n.read = true; }); render(); }).catch((err) => toast(err.message)); return; }
    if (t.closest('#pvMenuBtn')) { const m = $('#pvMenu'); m.classList.toggle('hidden'); $('#pvMenuBtn').setAttribute('aria-expanded', String(!m.classList.contains('hidden'))); return; }
    if (!t.closest('#pvMenu')) $('#pvMenu').classList.add('hidden');
    if (t.id === 'pvPass') { $('#pvMenu').classList.add('hidden'); passwordModal(); return; }
    if (t.id === 'pvLogout') { api('/api/auth/logout', 'POST').finally(() => location.replace('/')); return; }
    if (t.id === 'pvTheme') { document.body.classList.toggle('dark'); try { localStorage.setItem('tp-dark', document.body.classList.contains('dark') ? '1' : '0'); } catch { /* sin almacenamiento */ } }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  try { if (localStorage.getItem('tp-dark') === '1') document.body.classList.add('dark'); } catch { /* sin almacenamiento */ }

  (async function start() {
    try {
      const me = (await api('/api/auth/me')).user;
      if (me.role !== 'proveedor' || me.mustChangePassword) { location.replace('/'); return; }
      await load();
      // Se actualiza solo cada 2 minutos (si no hay un formulario abierto).
      setInterval(() => { if ($('#pvModalBg').classList.contains('hidden') && !document.activeElement?.closest?.('form')) load().catch(() => {}); }, 2 * 60 * 1000);
    } catch (e) {
      $('#pvLoading').textContent = e.status === 403 ? e.message : 'No se pudo cargar tu portal. Recarga la página.';
    }
  }());
}());
