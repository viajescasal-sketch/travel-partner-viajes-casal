'use strict';

/* Cotizaciones: dos vistas que elige cada asesor (se recuerda en su navegador).
   - Tarjetas compactas: lo esencial a la vista; al tocar una se abre la ficha rápida con todo el detalle y las acciones.
   - Lista: una fila por cotización, ordenable y agrupable por cliente, ideal para encontrar rápido y limpiar duplicadas.
   Filtros por estado (tocando los contadores de arriba), búsqueda, orden y aviso de "posible duplicado". */

const QV_KEY = 'tp.quoteView';
const qv = {
  view: (() => { try { const v = localStorage.getItem(QV_KEY); return v === 'list' || v === 'cards' ? v : 'cards'; } catch { return 'cards'; } })(),
  status: '',
  sort: (() => { try { return localStorage.getItem(`${QV_KEY}.sort`) || 'recent'; } catch { return 'recent'; } })(),
  open: null
};
const QV_SORTS = [['recent', 'Más recientes'], ['client', 'Cliente (agrupado)'], ['valid', 'Vigencia más próxima'], ['price', 'Precio mayor'], ['status', 'Estado']];
const qvSave = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

const qvExternal = (q) => Boolean(q.details?.external);
const qvDates = (q) => { const l = q.lead_id ? leadById(q.lead_id) : null; return fmtRange(l?.start_date || q.details?.startDate || '', l?.end_date || q.details?.endDate || ''); };
const qvKind = (q) => (qvExternal(q) ? '📎 Externa' : q.details?.kind === 'circuito' ? '🗺 Circuito' : '🏝 Paquete');
const qvDupKey = (q) => [q.client_id, String(q.destination || '').trim().toLowerCase(), String(q.hotel || '').trim().toLowerCase(), Math.round(Number(q.price) || 0)].join('|');
function qvDupSet() {
  const seen = new Map();
  db.quotes.forEach((q) => { const k = qvDupKey(q); seen.set(k, (seen.get(k) || 0) + 1); });
  return new Set(db.quotes.filter((q) => seen.get(qvDupKey(q)) > 1).map((q) => q.id));
}
// El admin elimina cualquiera; el asesor, las suyas mientras no estén aceptadas ni tengan pagos.
const canDeleteQuote = (q) => Boolean(q) && (isAdmin() || (canWrite('quotes') && q.owner_id === currentUser?.id && q.status !== 'Aceptada' && !(q.payment_plan?.paid > 0)));

function qvPay(q, { big = false } = {}) {
  const plan = typeof planOf === 'function' ? planOf(q) : null;
  if (!plan) return q.status === 'Aceptada' ? '<span class="qv-pay empty">Sin plan de pagos</span>' : '';
  const pct = plan.total ? Math.min(100, Math.round((plan.paid / plan.total) * 100)) : 0;
  const n = nextInst(plan);
  const late = n && daysTo(n.due) < 0;
  return `<span class="qv-pay${late ? ' late' : ''}${big ? ' big' : ''}" title="${money(plan.paid)} de ${money(plan.total)}"><i style="--p:${pct}%"></i><em>${pct === 100 ? '✅ Liquidado' : `${pct}% · ${money(plan.paid)}`}</em></span>`;
}
function qvChips(q, dups) {
  return [
    dups.has(q.id) ? '<span class="qv-chip dup" title="Mismo cliente, destino, hotel y precio que otra cotización">⚠ Posible duplicado</span>' : '',
    q.viewed_at ? `<span class="qv-chip seen" title="El cliente abrió la liga ${q.view_count || 1} ${Number(q.view_count) === 1 ? 'vez' : 'veces'}">👀 Vista</span>` : '',
    q.status === 'Enviada' && q.reminder_at ? '<span class="qv-chip late">⏰ Sin respuesta</span>' : '',
    q.status === 'Aceptada' && q.acceptance?.by === 'cliente' ? '<span class="qv-chip seen">✅ En línea</span>' : '',
    (q.details?.proposals?.length || 0) > 1 ? `<span class="qv-chip">${q.details.proposals.length} propuestas</span>` : ''
  ].join('');
}

function qvFiltered() {
  const text = String(ui.quoteQuery || '').toLowerCase().trim();
  let list = db.quotes.filter((x) => (!qv.status || x.status === qv.status) && (!text || [x.folio, clientName(x.client_id), x.hotel, x.destination, x.status, clientById(x.client_id)?.phone].join(' ').toLowerCase().includes(text)));
  const by = {
    recent: (a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)) || b.id - a.id,
    client: (a, b) => clientName(a.client_id).localeCompare(clientName(b.client_id), 'es') || b.id - a.id,
    valid: (a, b) => String(a.valid_until || '9999').localeCompare(String(b.valid_until || '9999')),
    price: (a, b) => Number(b.price) - Number(a.price),
    status: (a, b) => QUOTE_STATUSES.indexOf(a.status) - QUOTE_STATUSES.indexOf(b.status) || b.id - a.id
  };
  list = list.slice().sort(by[qv.sort] || by.recent);
  return list;
}

function qvToolbar() {
  if ($('#qvBar')) return;
  const toolbar = $('#quotes .toolbar');
  toolbar.insertAdjacentHTML('beforeend', `<div id="qvBar" class="qv-bar">
    <label class="qv-sort">Ordenar<select id="qvSort">${QV_SORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    <div class="qv-seg" role="group" aria-label="Vista"><button type="button" data-qv-view="cards" title="Tarjetas">▦ <span>Tarjetas</span></button><button type="button" data-qv-view="list" title="Lista">☰ <span>Lista</span></button></div>
  </div>`);
  $('#quotes .heading').insertAdjacentHTML('afterend', '<div id="payChanges" class="pc-banner hidden"></div>');
  $('#qvSort').onchange = (e) => { qv.sort = e.target.value; qvSave(`${QV_KEY}.sort`, qv.sort); renderQuoteCollection(); };
  // Los contadores de arriba filtran por estado.
  const map = { qDraft: 'Borrador', qReady: 'PDF generado', qSent: 'Enviada', qAccepted: 'Aceptada' };
  Object.entries(map).forEach(([id, st]) => {
    const box = $(`#${id}`)?.parentElement;
    if (!box) return;
    box.classList.add('qv-filter');
    box.dataset.qvStatus = st;
    box.setAttribute('role', 'button');
    box.tabIndex = 0;
    box.title = `Ver solo: ${st}`;
  });
}

function renderQuoteCollection() {
  qvToolbar();
  if (typeof renderPayChangesBanner === 'function') renderPayChangesBanner();
  $('#qvSort').value = qv.sort;
  $$('[data-qv-view]').forEach((b) => b.classList.toggle('on', b.dataset.qvView === qv.view));
  $$('.qv-filter').forEach((b) => b.classList.toggle('on', b.dataset.qvStatus === qv.status));
  const list = qvFiltered();
  const dups = qvDupSet();
  const grid = $('#quoteGrid');
  grid.className = qv.view === 'list' ? 'qv-list' : 'qv-cards';
  const filterNote = qv.status ? `<div class="qv-active">Mostrando: <b>${escapeHtml(qv.status)}</b> (${list.length}) <button type="button" class="link" data-qv-status="">Ver todas</button></div>` : '';
  if (!list.length) {
    grid.innerHTML = `${filterNote}<p class="empty-note">${db.quotes.length ? 'Ninguna cotización coincide con la búsqueda o el filtro.' : 'Aún no hay cotizaciones. Crea la primera con “+ Nueva cotización”.'}</p>`;
    return;
  }
  grid.innerHTML = filterNote + (qv.view === 'list' ? qvListHtml(list, dups) : list.map((q) => qvCardHtml(q, dups)).join(''));
}

function qvCardHtml(q, dups) {
  const editable = canWrite('quotes');
  const sel = editable && !qvExternal(q) ? `<label class="qv-check" title="Seleccionar para enviar varias propuestas"><input type="checkbox" data-select-quote="${q.id}" ${selectedQuoteIds.has(q.id) ? 'checked' : ''}></label>` : '';
  return `<article class="qv-card s-${statusClass(q.status)}${dups.has(q.id) ? ' is-dup' : ''}" data-qv-open="${q.id}" tabindex="0">
    <div class="qv-top">${sel}<span class="status ${statusClass(q.status)}">${escapeHtml(q.status)}</span><span class="qv-folio">${escapeHtml(q.folio)}</span></div>
    <h3>${escapeHtml(clientName(q.client_id))}</h3>
    <p class="qv-dest">${qvKind(q)} · ${escapeHtml(q.destination)}</p>
    <p class="qv-hotel">${escapeHtml(q.hotel || '')}</p>
    <div class="qv-mid"><b class="qv-price">${money(q.price)}</b><small>${escapeHtml(q.mode || '')}</small></div>
    <div class="qv-meta"><span>📅 ${escapeHtml(qvDates(q))}</span>${q.valid_until ? `<span class="${q.valid_until < todayStr() && !['Aceptada', 'Rechazada'].includes(q.status) ? 'late' : ''}">⏳ Vigente al ${escapeHtml(fmtDate(q.valid_until))}</span>` : ''}</div>
    ${qvPay(q)}
    <div class="qv-chips">${qvChips(q, dups)}</div>
    <div class="qv-foot">
      <button type="button" class="qv-ic" data-pdf="${q.id}" title="${qvExternal(q) ? 'Abrir' : 'Ver PDF'}">📄</button>
      ${editable ? `<button type="button" class="qv-ic" data-whatsapp="${q.id}" title="Enviar por WhatsApp">💬</button><button type="button" class="qv-ic" data-edit-quote="${q.id}" title="Editar">✎</button>${qvExternal(q) ? '' : `<button type="button" class="qv-ic" data-duplicate="${q.id}" title="Duplicar">⧉</button>`}` : ''}
      ${canDeleteQuote(q) ? `<button type="button" class="qv-ic del" data-qv-del="${q.id}" title="Eliminar">🗑</button>` : ''}
      <button type="button" class="qv-more" data-qv-open="${q.id}">Detalle →</button>
    </div>
  </article>`;
}

function qvListHtml(list, dups) {
  const editable = canWrite('quotes');
  const admin = isAdmin();
  const row = (q) => `<tr class="qv-row${dups.has(q.id) ? ' is-dup' : ''}" data-qv-open="${q.id}" tabindex="0">
    <td class="c-sel">${editable && !qvExternal(q) ? `<input type="checkbox" data-select-quote="${q.id}" ${selectedQuoteIds.has(q.id) ? 'checked' : ''} aria-label="Seleccionar ${escapeHtml(q.folio)}">` : ''}</td>
    <td class="c-client"><b>${escapeHtml(clientName(q.client_id))}</b><small>${escapeHtml(q.folio)}${admin ? ` · ${escapeHtml(userName(q.owner_id))}` : ''}</small></td>
    <td class="c-dest"><span>${escapeHtml(q.destination)}</span><small>${qvKind(q)} · ${escapeHtml(q.hotel || '')}</small></td>
    <td class="c-dates">${escapeHtml(qvDates(q))}</td>
    <td class="c-price"><b>${money(q.price)}</b><small>${escapeHtml(q.mode || '')}</small></td>
    <td class="c-status"><span class="status ${statusClass(q.status)}">${escapeHtml(q.status)}</span>${dups.has(q.id) ? '<span class="qv-chip dup" title="Posible duplicado">⚠</span>' : ''}${q.viewed_at ? '<span class="qv-chip seen" title="El cliente la vio">👀</span>' : ''}</td>
    <td class="c-pay">${qvPay(q)}</td>
    <td class="c-acts"><button type="button" class="qv-ic" data-pdf="${q.id}" title="Ver PDF">📄</button>${editable ? `<button type="button" class="qv-ic" data-whatsapp="${q.id}" title="WhatsApp">💬</button><button type="button" class="qv-ic" data-edit-quote="${q.id}" title="Editar">✎</button>` : ''}${canDeleteQuote(q) ? `<button type="button" class="qv-ic del" data-qv-del="${q.id}" title="Eliminar">🗑</button>` : ''}</td>
  </tr>`;
  let body = '';
  if (qv.sort === 'client') {
    const groups = new Map();
    list.forEach((q) => { if (!groups.has(q.client_id)) groups.set(q.client_id, []); groups.get(q.client_id).push(q); });
    groups.forEach((qs, cid) => { body += `<tr class="qv-group"><td colspan="8"><button type="button" class="link" data-client="${cid}">👤 ${escapeHtml(clientName(cid))}</button> <small>${qs.length} ${qs.length === 1 ? 'cotización' : 'cotizaciones'}</small></td></tr>${qs.map(row).join('')}`; });
  } else body = list.map(row).join('');
  return `<div class="qv-table"><table><thead><tr><th></th><th>Cliente</th><th>Destino</th><th>Fechas</th><th>Precio</th><th>Estado</th><th>Cobro</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Ficha rápida (panel lateral) ---------- */
function qvDrawer(id) {
  const q = quoteById(id);
  if (!q) return;
  qv.open = q.id;
  const editable = canWrite('quotes');
  const client = clientById(q.client_id);
  const lead = q.lead_id ? leadById(q.lead_id) : null;
  const plan = typeof planOf === 'function' ? planOf(q) : null;
  const dups = qvDupSet();
  const row = (k, v) => (v ? `<div><span>${k}</span><b>${v}</b></div>` : '');
  const services = String(q.services || '').split(',').map((s) => s.trim()).filter(Boolean);
  let el = $('#qvDrawer');
  if (!el) {
    document.body.insertAdjacentHTML('beforeend', '<div id="qvDrawerBg" class="qv-drawer-bg hidden"></div><div id="qvDrawer" class="qv-drawer" aria-hidden="true" role="dialog" aria-label="Detalle de la cotización"></div>');
    el = $('#qvDrawer');
    $('#qvDrawerBg').onclick = qvClose;
  }
  el.innerHTML = `<header class="qv-dh s-${statusClass(q.status)}">
      <div><p class="eyebrow">${qvKind(q).toUpperCase()} · ${escapeHtml(q.folio)}</p><h3>${escapeHtml(client?.name || 'Sin cliente')}</h3><p>${escapeHtml(q.destination)}${q.hotel ? ` · ${escapeHtml(q.hotel)}` : ''}</p></div>
      <button type="button" class="qv-x" data-qv-close aria-label="Cerrar">✕</button>
    </header>
    <div class="qv-db">
      <div class="qv-big"><b>${money(q.price)}</b><small>${escapeHtml(q.mode || '')}</small>${editable ? `<label class="qv-st">Estado<select data-quote-status="${q.id}">${options(QUOTE_STATUSES, q.status)}</select></label>` : `<span class="status ${statusClass(q.status)}">${escapeHtml(q.status)}</span>`}</div>
      <div class="qv-chips">${qvChips(q, dups)}</div>
      ${plan ? `<button type="button" class="qv-plan" data-pay-plan="${q.id}"><span>💳 Plan de pagos</span>${qvPay(q, { big: true })}<small>${money(plan.paid)} de ${money(plan.total)} · saldo ${money(plan.balance)}</small></button>` : (q.status === 'Aceptada' && editable ? `<button type="button" class="qv-plan empty" data-pay-plan="${q.id}">💳 Armar plan de pagos y liga</button>` : '')}
      <div class="qv-grid">
        ${row('Fechas', escapeHtml(qvDates(q)))}
        ${row('Pasajeros', escapeHtml(q.details?.pax || (lead?.travelers ? `${lead.travelers}` : '')))}
        ${row('Vigencia', q.valid_until ? escapeHtml(fmtDate(q.valid_until)) : 'Por definir')}
        ${row('Asesor', escapeHtml(userName(q.owner_id)))}
        ${row('Creada', escapeHtml(fmtDue(q.created_at)))}
        ${row('Vista por el cliente', q.viewed_at ? `${escapeHtml(fmtDue(q.viewed_at))} (${q.view_count || 1})` : '')}
      </div>
      ${services.length ? `<div class="qv-svc">${services.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      ${q.details?.notas ? `<div class="qv-notes"><b>Notas</b><p>${escapeHtml(q.details.notas)}</p></div>` : ''}
      ${client ? `<button type="button" class="link" data-client="${client.id}">👤 Abrir ficha 360 de ${escapeHtml(client.name)}</button>` : ''}
    </div>
    <footer class="qv-df">
      <div class="qv-acts">
        <button type="button" class="btn secondary" data-pdf="${q.id}">${qvExternal(q) ? '📄 Abrir' : '📄 Ver PDF'}</button>
        ${editable ? `<button type="button" class="btn primary" data-whatsapp="${q.id}">💬 WhatsApp</button>${qvExternal(q) ? '' : `<button type="button" class="btn secondary" data-share-quote="${q.id}">🔗 Liga</button>`}<button type="button" class="btn secondary" data-edit-quote="${q.id}">✎ Editar</button>${qvExternal(q) ? '' : `<button type="button" class="btn secondary" data-duplicate="${q.id}">⧉ Duplicar</button>`}` : ''}
      </div>
      ${canDeleteQuote(q) ? `<button type="button" class="btn ghost-danger small" data-qv-del="${q.id}">🗑 Eliminar cotización</button>` : (editable && q.status === 'Aceptada' && !isAdmin() ? '<small class="muted">Las cotizaciones aceptadas solo las elimina el administrador.</small>' : '')}
    </footer>`;
  $('#qvDrawerBg').classList.remove('hidden');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  el.querySelector('.qv-x').focus();
}
function qvClose() {
  qv.open = null;
  $('#qvDrawer')?.classList.remove('open');
  $('#qvDrawer')?.setAttribute('aria-hidden', 'true');
  $('#qvDrawerBg')?.classList.add('hidden');
}

async function qvDelete(id) {
  const q = quoteById(id);
  if (!q) return;
  const warn = q.status === 'Aceptada' || q.payment_plan?.paid > 0 ? '\n\n⚠ Está aceptada o tiene pagos: también se pierde su plan de pagos.' : '';
  if (!confirm(`¿Eliminar la cotización ${q.folio} de ${clientName(q.client_id)}? No se puede deshacer.${warn}`)) return;
  selectedQuoteIds.delete(q.id);
  const ok = await mutate(() => send('DELETE', `/api/quotes/${q.id}`), `Cotización ${q.folio} eliminada`);
  if (ok && qv.open === q.id) qvClose();
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const view = t.closest('[data-qv-view]');
  if (view) { qv.view = view.dataset.qvView; qvSave(QV_KEY, qv.view); renderQuoteCollection(); return; }
  const st = t.closest('[data-qv-status]');
  if (st) { qv.status = qv.status === st.dataset.qvStatus ? '' : st.dataset.qvStatus; renderQuoteCollection(); return; }
  const del = t.closest('[data-qv-del]');
  if (del) { e.stopPropagation(); qvDelete(Number(del.dataset.qvDel)); return; }
  if (t.closest('[data-qv-close]')) { qvClose(); return; }
  // Al usar una acción del panel, se cierra para dejar ver lo que abre (editor, PDF, plan…).
  if (t.closest('#qvDrawer') && t.closest('[data-edit-quote],[data-pay-plan],[data-share-quote],[data-client],[data-duplicate]')) { qvClose(); return; }
  const open = t.closest('[data-qv-open]');
  if (!open) return;
  // Los botones y casillas dentro de la tarjeta/fila hacen lo suyo; el resto abre la ficha rápida.
  if (t.closest('button:not([data-qv-open]),input,select,label,a')) return;
  qvDrawer(Number(open.dataset.qvOpen));
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qv.open) { e.stopPropagation(); qvClose(); return; }
  if (e.key === 'Enter' && e.target.matches?.('[data-qv-open]')) qvDrawer(Number(e.target.dataset.qvOpen));
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.qv-filter')) { e.preventDefault(); e.target.click(); }
}, true);
// Si cambian los datos con el panel abierto (estado, plan…), se repinta con lo nuevo.
const qvAfterRender = () => { if (qv.open && $('#qvDrawer')?.classList.contains('open')) { if (quoteById(qv.open)) qvDrawer(qv.open); else qvClose(); } };
const qvRenderOrig = renderQuoteCollection;
renderQuoteCollection = function renderQuoteCollectionWrapped() { qvRenderOrig(); qvAfterRender(); }; // eslint-disable-line no-func-assign
