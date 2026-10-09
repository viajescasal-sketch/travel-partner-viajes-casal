'use strict';

/* =========================================================
   Travel Partner Viajes Casal — cliente del CRM
   Todos los datos vienen de /api/crm (MySQL en producción).
   ========================================================= */

const STAGES = ['Nuevo', 'Calificado', 'Cotizado', 'Negociación', 'Vendido', 'Perdido'];
const CLOSED = ['Vendido', 'Perdido'];
const PRIORITIES = ['Alta', 'Media', 'Baja'];
const SOURCES = ['WhatsApp', 'Instagram', 'Facebook', 'Sitio web', 'Referido', 'Otro'];
const QUOTE_STATUSES = ['Borrador', 'PDF generado', 'Enviada', 'Aceptada', 'Rechazada'];
const QUOTE_MODES = ['Total', 'Por persona', 'Por noche'];
const TRIP_STATUSES = ['Confirmado', 'Documentación pendiente', 'En viaje', 'Solicitar reseña', 'Postventa', 'Cerrado'];
const FOLLOWUP_TYPES = ['Llamada', 'WhatsApp', 'Cotización', 'Pago', 'Otro'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const WEEKDAYS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
const SOURCE_COLORS = ['var(--teal)', '#0b4f7a', 'var(--coral)', 'var(--gold)', '#7a5bd0', '#8a99a6'];

const db = { clients: [], leads: [], quotes: [], trips: [], followups: [], users: [], agency: {}, documents: {}, leadQuestions: [], me: null };
const ui = { leadQuery: '', leadStage: '', leadOwner: '', settingsTab: 'agencyPanel', quoteQuery: '', clientQuery: '', funnelRange: 'month', calYear: 0, calMonth: 0, calDay: '' };
const selectedQuoteIds = new Set();
let currentUser = null;
let passwordChangeRequired = false;
let loaded = false;

/* ---------- utilidades ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const money = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n) || 0);
const initials = (n) => String(n || '?').split(' ').filter(Boolean).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const ROLE_LABELS = { admin: 'Administrador', travel_partner: 'Vendedor', operaciones: 'Operaciones', consulta: 'Consulta' };
const WRITE_RULES = {
  admin: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  travel_partner: ['clients', 'leads', 'quotes', 'trips', 'followups'],
  operaciones: ['trips', 'followups'],
  consulta: []
};
const isAdmin = () => currentUser?.role === 'admin';
const isOps = () => currentUser?.role === 'operaciones';
const canWrite = (entity) => (WRITE_RULES[currentUser?.role] || []).includes(entity);
const userName = (id) => db.users.find((u) => u.id === Number(id))?.name || (Number(id) === currentUser?.id ? currentUser.name : 'Sin asignar');
const sellers = () => db.users.filter((u) => u.active && ['admin', 'travel_partner'].includes(u.role));
// Clientes con leads de más de un vendedor (solo el administrador los ve todos).
const sharedClientIds = () => {
  const owners = new Map();
  db.leads.forEach((l) => { if (!owners.has(l.client_id)) owners.set(l.client_id, new Set()); owners.get(l.client_id).add(l.owner_id); });
  return new Set([...owners].filter(([, set]) => set.size > 1).map(([id]) => id));
};

// Cancún usa UTC-5 todo el año.
function nowLocal() { return new Date(Date.now() - 5 * 3600 * 1000); }
function todayStr() { return nowLocal().toISOString().slice(0, 10); }
function monthKey(dateStr) { return String(dateStr || '').slice(0, 7); }
function addDays(dateStr, days) { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function parts(dateStr) { const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number); return { y, m, d }; }
function fmtDate(dateStr) { if (!dateStr) return ''; const { m, d } = parts(dateStr); return `${d} ${MONTHS[m - 1]}`; }
function fmtRange(start, end) {
  if (!start && !end) return 'Por definir';
  if (!start || !end) return fmtDate(start || end);
  const a = parts(start), b = parts(end);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1]}`;
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}
function fmtDue(dueAt) {
  if (!dueAt) return 'Sin programar';
  const day = dueAt.slice(0, 10), time = dueAt.slice(11, 16), today = todayStr();
  if (day === today) return `Hoy, ${time}`;
  if (day === addDays(today, 1)) return `Mañana, ${time}`;
  if (day < today) return `Vencido · ${fmtDate(day)}`;
  return `${fmtDate(day)}, ${time}`;
}
const toInputDateTime = (v) => (v ? v.slice(0, 16).replace(' ', 'T') : '');
const daysBetween = (a, b) => (new Date(`${b.slice(0, 10)}T00:00:00Z`) - new Date(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000;

const clientById = (id) => db.clients.find((c) => c.id === Number(id));
const leadById = (id) => db.leads.find((l) => l.id === Number(id));
const quoteById = (id) => db.quotes.find((q) => q.id === Number(id));
const tripById = (id) => db.trips.find((t) => t.id === Number(id));
const followupById = (id) => db.followups.find((f) => f.id === Number(id));
const clientName = (id) => clientById(id)?.name || 'Sin cliente';
const pendingFollowups = () => db.followups.filter((f) => !f.done).sort((a, b) => a.due_at.localeCompare(b.due_at));
const nextFollowupFor = (leadId) => pendingFollowups().find((f) => f.lead_id === leadId);
const leadValue = (lead) => {
  const quotes = db.quotes.filter((q) => q.lead_id === lead.id);
  const accepted = quotes.find((q) => q.status === 'Aceptada');
  return accepted ? accepted.price : lead.budget || (quotes[0]?.price ?? 0);
};

const statusClass = (s) => ({
  Nuevo: 'new', Calificado: 'qualified', Cotizado: 'quoted', Negociación: 'negotiation', Vendido: 'accepted', Perdido: 'lost',
  Borrador: 'new', 'PDF generado': 'qualified', Enviada: 'quoted', Aceptada: 'accepted', Rechazada: 'lost'
})[s] || 'new';
const options = (list, selected, { blank } = {}) =>
  (blank !== undefined ? `<option value="">${escapeHtml(blank)}</option>` : '') +
  list.map((v) => { const [value, label] = Array.isArray(v) ? v : [v, v]; return `<option value="${escapeHtml(value)}"${String(value) === String(selected ?? '') ? ' selected' : ''}>${escapeHtml(label)}</option>`; }).join('');

/* ---------- API ---------- */
async function api(url, opts = {}) {
  const response = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const payload = await response.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor' }));
  if (response.status === 401 && currentUser) { showLogin(); throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.'); }
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la solicitud');
  return payload;
}
const send = (method, url, body) => api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

async function loadAll() {
  try {
    const data = await api('/api/crm');
    for (const key of ['clients', 'leads', 'quotes', 'trips', 'followups', 'users']) db[key] = data[key] || [];
    db.agency = data.settings?.agency || {};
    db.documents = data.settings?.documents || {};
    db.leadQuestions = data.settings?.leadQuestions || [];
    db.me = data.me || null;
    loaded = true;
    renderAll();
  } catch (error) {
    toast(error.message);
  }
}

// Ejecuta un cambio, recarga los datos y avisa.
async function mutate(action, message) {
  try {
    const result = await action();
    await loadAll();
    if (message) toast(message);
    return result || true;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

/* ---------- render general ---------- */
function renderAll() {
  if (!loaded) return;
  renderBadges();
  renderDashboard();
  renderLeads();
  renderQuotes();
  renderClients();
  renderTrips();
  renderCalendar();
  renderReports();
  renderSettings();
  if (isAdmin() && ui.settingsTab === 'usersPanel') loadUsers();
}

function renderBadges() {
  const active = db.leads.filter((l) => !CLOSED.includes(l.stage)).length;
  const due = pendingFollowups().filter((f) => f.due_at.slice(0, 10) <= todayStr()).length;
  const lb = $('#leadBadge'), fb = $('#followBadge');
  lb.textContent = active; lb.classList.toggle('hidden', !active);
  fb.textContent = due; fb.classList.toggle('hidden', !due);
}

function clientCell(client, sub) {
  const name = client?.name || 'Sin cliente';
  return `<div class="client"><span class="avatar">${escapeHtml(initials(name))}</span><div><b>${escapeHtml(name)}</b><small>${escapeHtml(sub ?? client?.phone ?? '')}</small></div></div>`;
}
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty-cell">${escapeHtml(text)}</td></tr>`;

/* ---------- dashboard ---------- */
function renderDashboard() {
  const today = todayStr(), month = monthKey(today);
  const d = nowLocal();
  $('#todayLabel').textContent = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} DE ${MONTHS_LONG[d.getUTCMonth()].toUpperCase()}`;

  if (isOps()) { renderOpsDashboard(today); return; }
  setKpiLabels(['Leads activos', 'Cotizaciones enviadas', 'Ventas del mes', 'Conversión']);
  const active = db.leads.filter((l) => !CLOSED.includes(l.stage));
  const newThisMonth = db.leads.filter((l) => monthKey(l.created_at) === month).length;
  $('#kpiLeads').textContent = active.length;
  $('#kpiLeadsNote').textContent = `${newThisMonth} nuevos este mes`;

  const sent = db.quotes.filter((q) => q.status === 'Enviada').length;
  const drafts = db.quotes.filter((q) => ['Borrador', 'PDF generado'].includes(q.status)).length;
  $('#kpiQuotes').textContent = sent;
  $('#kpiQuotesNote').textContent = `${drafts} por enviar`;

  const acceptedMonth = db.quotes.filter((q) => q.accepted_at && monthKey(q.accepted_at) === month);
  $('#kpiSales').textContent = money(acceptedMonth.reduce((s, q) => s + q.price, 0));
  $('#kpiSalesNote').textContent = `${acceptedMonth.length} ${acceptedMonth.length === 1 ? 'venta' : 'ventas'} este mes`;

  const closedMonth = db.leads.filter((l) => l.closed_at && monthKey(l.closed_at) === month);
  const won = closedMonth.filter((l) => l.stage === 'Vendido').length;
  $('#kpiConv').textContent = closedMonth.length ? `${((won / closedMonth.length) * 100).toFixed(1)}%` : '—';
  $('#kpiConvNote').textContent = closedMonth.length ? `${won} de ${closedMonth.length} cerrados · meta 32%` : 'Sin cierres este mes · meta 32%';

  // Embudo: cuántos leads llegaron a cada etapa.
  const pool = (ui.funnelRange === 'month' ? db.leads.filter((l) => monthKey(l.created_at) === month) : db.leads).filter((l) => l.stage !== 'Perdido');
  const steps = [['Leads', 0], ['Calificados', 1], ['Cotizados', 2], ['Negociación', 3], ['Vendidos', 4]];
  const total = pool.length || 1;
  $('#funnel').innerHTML = steps.map(([label, idx]) => {
    const count = pool.filter((l) => STAGES.indexOf(l.stage) >= idx).length;
    return `<div style="--w:${Math.max(0, Math.round((count / total) * 100))}%">${label} <b>${count}</b></div>`;
  }).join('');

  const due = pendingFollowups().filter((f) => f.due_at.slice(0, 10) <= today).slice(0, 6);
  $('#todayTasks').innerHTML = due.length ? due.map((f) => {
    const late = f.due_at.slice(0, 10) < today;
    return `<label><input type="checkbox" data-done="${f.id}"><span><b>${escapeHtml(f.title)}</b><small>${escapeHtml([clientName(f.client_id), f.details].filter(Boolean).join(' · '))}</small></span><em class="${late ? '' : 'soft'}">${late ? 'Vencido' : f.due_at.slice(11, 16)}</em></label>`;
  }).join('') : '<p class="empty-note">Sin pendientes para hoy. Programa seguimientos desde cada lead.</p>';

  const recent = [...active].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  $('#dashboardRows').innerHTML = recent.length ? recent.map((l) =>
    `<tr class="clickable" data-lead="${l.id}"><td>${clientCell(clientById(l.client_id))}</td><td>${escapeHtml(l.destination)}</td><td><span class="status ${statusClass(l.stage)}">${escapeHtml(l.stage)}</span></td><td>${money(leadValue(l))}</td><td>${escapeHtml(fmtDue(nextFollowupFor(l.id)?.due_at))}</td></tr>`).join('')
    : emptyRow(5, 'Aún no hay leads. Registra el primero con “Registrar lead”.');
}

function setKpiLabels(labels) {
  $$('#dashboard .kpis article span').forEach((span, i) => { if (span.firstChild?.nodeType === 3) span.firstChild.textContent = labels[i]; });
}

// Dashboard de Operaciones: enfocado en viajes.
function renderOpsDashboard(today) {
  setKpiLabels(['Salidas próximas (30 días)', 'En viaje hoy', 'Documentación pendiente', 'Postviaje por cerrar']);
  const open = db.trips.filter((t) => t.status !== 'Cerrado');
  const soon = open.filter((t) => t.start_date > today && t.start_date <= addDays(today, 30));
  $('#kpiLeads').textContent = soon.length;
  $('#kpiLeadsNote').textContent = soon[0] ? `Próxima: ${fmtDate(soon.sort((a, b) => a.start_date.localeCompare(b.start_date))[0].start_date)}` : 'Sin salidas próximas';
  $('#kpiQuotes').textContent = open.filter((t) => t.start_date <= today && t.end_date >= today).length;
  $('#kpiQuotesNote').textContent = 'Clientes de viaje';
  const docs = open.filter((t) => t.status === 'Documentación pendiente');
  $('#kpiSales').textContent = docs.length;
  $('#kpiSalesNote').textContent = docs.length ? 'Revisa vouchers y pagos' : 'Todo al día';
  const post = open.filter((t) => t.end_date < today);
  $('#kpiConv').textContent = post.length;
  $('#kpiConvNote').textContent = 'Pedir reseña o cerrar';
  const due = pendingFollowups().filter((f) => f.due_at.slice(0, 10) <= today).slice(0, 6);
  $('#todayTasks').innerHTML = due.length ? due.map((f) => `<label><input type="checkbox" data-done="${f.id}"><span><b>${escapeHtml(f.title)}</b><small>${escapeHtml([clientName(f.client_id), f.details].filter(Boolean).join(' · '))}</small></span><em class="${f.due_at.slice(0, 10) < today ? '' : 'soft'}">${f.due_at.slice(0, 10) < today ? 'Vencido' : f.due_at.slice(11, 16)}</em></label>`).join('')
    : '<p class="empty-note">Sin pendientes para hoy.</p>';
}

/* ---------- leads ---------- */
function filteredLeads() {
  const q = ui.leadQuery.toLowerCase();
  return db.leads.filter((l) => {
    if (ui.leadStage && l.stage !== ui.leadStage) return false;
    if (ui.leadOwner && String(l.owner_id) !== ui.leadOwner) return false;
    if (!q) return true;
    const c = clientById(l.client_id);
    return [c?.name, c?.phone, c?.email, l.destination, l.stage, l.notes, l.source].join(' ').toLowerCase().includes(q);
  });
}
function renderLeads() {
  const admin = isAdmin();
  const filter = $('#ownerFilter');
  filter.classList.toggle('hidden', !admin);
  if (admin) filter.innerHTML = options(sellers().map((u) => [u.id, u.name]), ui.leadOwner, { blank: 'Todos los vendedores' });
  $('#leadHead').innerHTML = ['Lead', 'Destino', 'Fechas', 'Etapa', 'Prioridad', ...(admin ? ['Vendedor'] : []), 'Seguimiento'].map((h) => `<th>${h}</th>`).join('');
  const shared = admin ? sharedClientIds() : new Set();
  const list = filteredLeads();
  const cols = admin ? 7 : 6;
  $('#leadRows').innerHTML = list.length ? list.map((l) => {
    const badge = shared.has(l.client_id) ? '<span class="badge-shared" title="Este cliente tiene leads con más de un vendedor">Cliente compartido</span>' : '';
    return `<tr class="clickable" data-lead="${l.id}"><td>${clientCell(clientById(l.client_id))}</td><td>${escapeHtml(l.destination)}${badge}${qualChip(l)}</td><td>${escapeHtml(fmtRange(l.start_date, l.end_date))}</td><td><span class="status ${statusClass(l.stage)}">${escapeHtml(l.stage)}</span></td><td>${escapeHtml(l.priority)}</td>${admin ? `<td>${escapeHtml(userName(l.owner_id))}</td>` : ''}<td>${escapeHtml(fmtDue(nextFollowupFor(l.id)?.due_at))}</td></tr>`;
  }).join('') : emptyRow(cols, db.leads.length ? 'Ningún lead coincide con la búsqueda.' : 'Aún no hay leads registrados.');
}
function exportLeads() {
  const header = ['Cliente', 'WhatsApp', 'Correo', 'Destino', 'Salida', 'Regreso', 'Viajeros', 'Presupuesto', 'Etapa', 'Prioridad', 'Origen', 'Vendedor', 'Creado', 'Notas'];
  const rows = filteredLeads().map((l) => { const c = clientById(l.client_id) || {}; return [c.name, c.phone, c.email, l.destination, l.start_date, l.end_date, l.travelers, l.budget, l.stage, l.priority, l.source, userName(l.owner_id), l.created_at, l.notes]; });
  const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `leads-${todayStr()}.csv` });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ---------- cotizaciones ---------- */
function renderQuotes() {
  const count = (s) => db.quotes.filter((q) => q.status === s).length;
  $('#qDraft').textContent = count('Borrador');
  $('#qReady').textContent = count('PDF generado');
  $('#qSent').textContent = count('Enviada');
  $('#qAccepted').textContent = count('Aceptada');
  const q = ui.quoteQuery.toLowerCase();
  const list = db.quotes.filter((x) => !q || [x.folio, clientName(x.client_id), x.hotel, x.destination, x.status].join(' ').toLowerCase().includes(q));
  const editable = canWrite('quotes');
  $('#multiSend').classList.toggle('hidden', !editable);
  $('#quoteGrid').innerHTML = list.length ? list.map((x) =>
    `<article class="card"><div class="card-top"><div>${editable ? `<label class="quote-select"><input type="checkbox" data-select-quote="${x.id}" ${selectedQuoteIds.has(x.id) ? 'checked' : ''}> Seleccionar PDF</label>` : ''}<span class="status ${statusClass(x.status)}">${escapeHtml(x.status)}</span><h3>${escapeHtml(x.folio)}${(x.details?.proposals?.length || 0) > 1 ? `<span class="proposals-chip">${x.details.proposals.length} propuestas</span>` : ''}</h3><p>${escapeHtml(clientName(x.client_id))}</p></div>${editable ? `<div class="icon-row"><button class="icon" data-edit-quote="${x.id}" title="Editar cotización" aria-label="Editar cotización">✎</button><button class="icon" data-duplicate="${x.id}" title="Duplicar cotización" aria-label="Duplicar cotización">⧉</button></div>` : ''}</div><div class="price">${money(x.price)}</div><small>${escapeHtml(x.mode)}</small><div class="meta"><div><span>Destino</span><b>${escapeHtml(x.destination)}</b></div><div><span>Vigencia</span><b>${escapeHtml(x.valid_until ? fmtDate(x.valid_until) : 'Por definir')}</b></div></div><p><b>${escapeHtml(x.hotel)}</b></p>${editable ? `<label class="inline-select">Estado<select data-quote-status="${x.id}">${options(QUOTE_STATUSES, x.status)}</select></label>` : ''}<div class="card-actions"><button class="btn secondary small" data-pdf="${x.id}">Ver PDF</button>${editable ? `<button class="btn primary small" data-whatsapp="${x.id}">WhatsApp</button>` : ''}</div></article>`).join('')
    : `<p class="empty-note">${db.quotes.length ? 'Ninguna cotización coincide con la búsqueda.' : 'Aún no hay cotizaciones. Crea la primera con “+ Nueva cotización”.'}</p>`;
}

function toggleQuote(id, checked) {
  const quote = quoteById(id);
  if (!quote) return;
  if (!checked) { selectedQuoteIds.delete(quote.id); return; }
  const selected = [...selectedQuoteIds].map(quoteById).filter(Boolean);
  if (selected.length >= 3) { renderQuotes(); toast('Solo puedes seleccionar hasta 3 PDFs'); return; }
  if (selected.some((item) => item.client_id !== quote.client_id)) { renderQuotes(); toast('Las cotizaciones deben pertenecer al mismo cliente'); return; }
  selectedQuoteIds.add(quote.id);
}

// Abre la cotización o la confirmación con el diseño de Viajes Casal en otra pestaña.
function openDocument(kind, id, win) {
  const url = `/documento.html?tipo=${kind}&id=${Number(id)}`;
  if (win) { win.location.href = url; return; }
  const opened = window.open(url, '_blank');
  if (!opened) location.href = url;
}
const openPrintableQuote = (id) => openDocument('cotizacion', id);

function prepareWhatsapp(ids) {
  const chosen = ids.map(quoteById).filter(Boolean);
  if (!chosen.length) { toast('Selecciona al menos una cotización'); return; }
  if (chosen.length > 3 || new Set(chosen.map((q) => q.client_id)).size !== 1) { toast('Selecciona hasta 3 cotizaciones del mismo cliente'); return; }
  const client = clientById(chosen[0].client_id);
  const single = chosen.length === 1 && chosen[0].details ? chosen[0] : null;
  const lines = single ? [TPDocs.buildQuoteMessage(TPDocs.quoteModel({
    quote: single, client, lead: single.lead_id ? leadById(single.lead_id) : null,
    seller: { name: userName(single.owner_id) }, documents: db.documents, agency: db.agency
  }))] : [
    `Hola ${client?.name || ''}, preparamos estas propuestas para tu viaje:`, '',
    ...chosen.flatMap((q, i) => [`${i + 1}. ${q.destination} — ${q.hotel}`, `${q.folio} · ${money(q.price)} (${q.mode.toLowerCase()})`, '']),
    'Quedo atenta a tus comentarios.'
  ];
  const pending = chosen.filter((q) => ['Borrador', 'PDF generado'].includes(q.status));
  openModal('WHATSAPP', `Mensaje para ${client?.name || 'cliente'}`,
    `<div class="message-preview"><textarea id="whatsappMessage" rows="12" readonly>${escapeHtml(lines.join('\n'))}</textarea>${client?.phone ? `<p>WhatsApp del cliente: <b>${escapeHtml(client.phone)}</b></p>` : ''}<div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button>${pending.length ? '<button type="button" id="markSent" class="btn secondary">Marcar como enviadas</button>' : ''}<button type="button" id="copyWhatsapp" class="btn primary">Copiar mensaje</button></div></div>`);
  $('#copyWhatsapp').onclick = async () => {
    try { await navigator.clipboard.writeText($('#whatsappMessage').value); toast('Mensaje copiado'); }
    catch { $('#whatsappMessage').select(); toast('Selecciona y copia el mensaje con Ctrl+C'); }
  };
  if ($('#markSent')) $('#markSent').onclick = async () => {
    await mutate(async () => { for (const q of pending) await send('PATCH', `/api/quotes/${q.id}`, { status: 'Enviada' }); }, 'Cotizaciones marcadas como enviadas');
    close();
  };
}

/* ---------- clientes ---------- */
function renderClients() {
  const q = ui.clientQuery.toLowerCase();
  const list = db.clients.filter((c) => !q || [c.name, c.phone, c.email, c.tags].join(' ').toLowerCase().includes(q));
  $('#clientGrid').innerHTML = list.length ? list.map((c) => {
    const quotes = db.quotes.filter((x) => x.client_id === c.id);
    const trips = db.trips.filter((t) => t.client_id === c.id).length;
    const value = quotes.filter((x) => x.status === 'Aceptada').reduce((s, x) => s + x.price, 0);
    const destinations = [...new Set(db.leads.filter((l) => l.client_id === c.id).map((l) => l.destination))].slice(0, 2);
    const tags = [...destinations, ...String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean)].slice(0, 5);
    return `<article class="card"><div class="card-top">${clientCell(c, c.phone || c.email || '')}<button class="icon" data-client="${c.id}" title="Ver cliente" aria-label="Ver cliente">⋮</button></div><div class="client-stats"><div><b>${quotes.length}</b><span>Cotizaciones</span></div><div><b>${trips}</b><span>Viajes</span></div><div><b>${money(value)}</b><span>Vendido</span></div></div><p>Preferencias</p><div class="tags">${tags.length ? tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('') : '<small class="muted">Sin preferencias registradas</small>'}</div><div class="card-actions"><button class="btn secondary small" data-client="${c.id}">Historial</button>${canWrite('quotes') ? `<button class="btn primary small" data-quote-for="${c.id}">Cotizar</button>` : `<button class="btn primary small" data-new-trip-client="${c.id}">Nuevo viaje</button>`}</div></article>`;
  }).join('') : `<p class="empty-note">${db.clients.length ? 'Ningún cliente coincide con la búsqueda.' : 'Los clientes se crean al registrar un lead o con “+ Nuevo cliente”.'}</p>`;
}

/* ---------- viajes ---------- */
function renderTrips() {
  const today = todayStr();
  const card = (t, label) => `<article class="trip-card clickable" data-trip="${t.id}"><small>${escapeHtml(label)}</small><h4>${escapeHtml(t.destination)}</h4><p>${escapeHtml(clientName(t.client_id))}</p><p>${escapeHtml(t.status)}${t.confirmation ? ' · ✓ Confirmación' : ''}</p></article>`;
  const open = db.trips.filter((t) => t.status !== 'Cerrado');
  const upcoming = open.filter((t) => t.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const active = open.filter((t) => t.start_date <= today && t.end_date >= today);
  const past = open.filter((t) => t.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const empty = (text) => `<p class="empty-note">${text}</p>`;
  $('#upcoming').innerHTML = upcoming.map((t) => card(t, fmtDate(t.start_date).toUpperCase())).join('') || empty('Sin salidas próximas.');
  $('#activeTrips').innerHTML = active.map((t) => card(t, t.start_date === today ? 'SALE HOY' : `REGRESA ${fmtDate(t.end_date).toUpperCase()}`)).join('') || empty('Nadie está de viaje hoy.');
  $('#pastTrips').innerHTML = past.map((t) => card(t, fmtDate(t.end_date).toUpperCase())).join('') || empty('Sin viajes por cerrar.');
}

/* ---------- seguimientos ---------- */
function renderCalendar() {
  if (!ui.calYear) { const t = parts(todayStr()); ui.calYear = t.y; ui.calMonth = t.m; ui.calDay = todayStr(); }
  const { calYear: y, calMonth: m } = ui;
  $('#calTitle').textContent = `${MONTHS_LONG[m - 1]} ${y}`;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // lunes primero
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const busy = new Set(pendingFollowups().map((f) => f.due_at.slice(0, 10)));
  const cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span class="weekday">${d}</span>`);
  for (let i = 0; i < lead; i++) cells.push('<span class="blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cls = [ds === todayStr() ? 'today' : '', busy.has(ds) ? 'event' : '', ds === ui.calDay ? 'selected' : ''].join(' ');
    cells.push(`<span class="day ${cls}" data-day="${ds}" role="button" tabindex="0" aria-label="${d} de ${MONTHS_LONG[m - 1]}">${d}</span>`);
  }
  $('#calendar').innerHTML = cells.join('');

  const items = db.followups.filter((f) => f.due_at.slice(0, 10) === ui.calDay).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const isToday = ui.calDay === todayStr();
  $('#agendaTitle').textContent = isToday ? 'Agenda de hoy' : `Agenda del ${fmtDate(ui.calDay)}`;
  const pending = items.filter((f) => !f.done).length;
  $('#agendaNote').textContent = items.length ? `${pending} pendientes de ${items.length} actividades` : 'Sin actividades programadas';
  const overdue = isToday ? pendingFollowups().filter((f) => f.due_at.slice(0, 10) < ui.calDay) : [];
  const row = (f, label) => `<div class="item${f.done ? ' done' : ''}"><span class="time">${escapeHtml(label)}</span><i class="dot"></i><div class="event-card"><label class="check"><input type="checkbox" data-done="${f.id}" ${f.done ? 'checked' : ''}><span><b>${escapeHtml(f.type)} · ${escapeHtml(f.title)}</b><small>${escapeHtml([clientName(f.client_id), f.details].filter(Boolean).join(' · '))}</small></span></label><button class="link" data-followup="${f.id}">Editar</button></div></div>`;
  $('#timeline').innerHTML =
    (overdue.length ? `<p class="section-label">Vencidos</p>${overdue.map((f) => row(f, fmtDate(f.due_at))).join('')}<p class="section-label">Hoy</p>` : '') +
    (items.map((f) => row(f, f.due_at.slice(11, 16))).join('') || '<p class="empty-note">Nada programado para este día.</p>');
}

/* ---------- reportes ---------- */
function renderReports() {
  const today = todayStr(), month = monthKey(today);
  const prevMonth = monthKey(addDays(`${month}-01`, -1));
  const accepted = db.quotes.filter((q) => q.accepted_at);
  const thisMonth = accepted.filter((q) => monthKey(q.accepted_at) === month);
  const lastMonth = accepted.filter((q) => monthKey(q.accepted_at) === prevMonth);
  const income = thisMonth.reduce((s, q) => s + q.price, 0);
  const prevIncome = lastMonth.reduce((s, q) => s + q.price, 0);
  $('#repIncome').textContent = money(income);
  $('#repIncomeNote').textContent = prevIncome ? `${income >= prevIncome ? '↑' : '↓'} ${Math.abs(((income - prevIncome) / prevIncome) * 100).toFixed(1)}% vs. mes anterior` : 'Mes en curso';
  $('#repTicket').textContent = thisMonth.length ? money(income / thisMonth.length) : '—';
  $('#repTicketNote').textContent = `${thisMonth.length} ${thisMonth.length === 1 ? 'venta' : 'ventas'}`;
  const won = db.leads.filter((l) => l.stage === 'Vendido' && l.closed_at && daysBetween(l.closed_at, today) <= 90);
  const avg = won.length ? won.reduce((s, l) => s + Math.max(0, daysBetween(l.created_at, l.closed_at)), 0) / won.length : null;
  $('#repClose').textContent = avg === null ? '—' : `${avg.toFixed(1)} días`;
  $('#repCloseNote').textContent = 'Últimos 90 días · meta 4 días';
  $('#repSat').textContent = '—';
  $('#repSatNote').textContent = 'Se activa con la encuesta postviaje';

  // Ventas de las últimas 4 semanas (lunes a domingo).
  const d = parts(today);
  const weekday = (new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() + 6) % 7;
  const monday = addDays(today, -weekday);
  const weeks = [3, 2, 1, 0].map((k) => { const start = addDays(monday, -7 * k); const end = addDays(start, 6); return { start, total: accepted.filter((q) => q.accepted_at.slice(0, 10) >= start && q.accepted_at.slice(0, 10) <= end).reduce((s, q) => s + q.price, 0) }; });
  const max = Math.max(...weeks.map((w) => w.total), 1);
  const short = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : money(n));
  $('#weekBars').innerHTML = weeks.map((w) => `<div style="--h:${Math.max(2, Math.round((w.total / max) * 100))}%" title="Semana del ${fmtDate(w.start)}"><span>${short(w.total)}</span><em>${fmtDate(w.start)}</em></div>`).join('');

  const counts = SOURCES.map((s) => [s, db.leads.filter((l) => l.source === s).length]).filter(([, n]) => n);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  let acc = 0;
  const stops = counts.map(([, n], i) => { const from = acc; acc += (n / total) * 100; return `${SOURCE_COLORS[i % SOURCE_COLORS.length]} ${from}% ${acc}%`; });
  $('#sourceDonut').style.background = total ? `conic-gradient(${stops.join(',')})` : 'var(--border)';
  $('#sourceTotal').textContent = total;
  $('#sourceLegend').innerHTML = counts.length ? counts.map(([s, n], i) => `<p><i class="swatch" style="background:${SOURCE_COLORS[i % SOURCE_COLORS.length]}"></i>${escapeHtml(s)} ${Math.round((n / total) * 100)}%</p>`).join('') : '<p>Sin leads todavía</p>';
}

/* ---------- configuración ---------- */
function renderSettings() {
  const a = db.agency || {};
  $('#setName').value = a.name || '';
  $('#setWhatsapp').value = a.whatsapp || '';
  $('#setEmail').value = a.email || '';
  $('#setWebsite').value = a.website || '';
}

/* ---------- modales y formularios ---------- */
function openModal(eyebrow, title, html, opts = {}) {
  const body = $('#modalBody');
  body.oninput = null; body.onchange = null; body.onclick = null;
  $('#modalBg .modal').classList.toggle('wide', Boolean(opts.wide));
  $('#modalEyebrow').textContent = eyebrow;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalBg').classList.remove('hidden');
}
function close() {
  if (passwordChangeRequired) return;
  $('#modalBg').classList.add('hidden');
}
const formValues = (form) => Object.fromEntries(new FormData(form));
const field = (label, input, full) => `<label${full ? ' class="full"' : ''}>${label}${input}</label>`;
const deleteBlock = (kind, id) => (isAdmin() && id ? `<div class="danger-zone full"><button type="button" class="btn ghost-danger small" data-ask-delete>Eliminar ${kind}</button><span class="confirm hidden">¿Seguro? No se puede deshacer. <button type="button" class="btn danger small" data-confirm-delete>Sí, eliminar</button></span></div>` : '');

// Conecta el envío del formulario con bloqueo del botón y manejo de errores.
function bindForm(onSubmit) {
  const form = $('#modalBody form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('button.primary[type="submit"], button.primary:not([type])');
    if (button) button.disabled = true;
    const ok = await onSubmit(formValues(form), form);
    if (button) button.disabled = false;
    if (ok) close();
  };
  return form;
}
function bindDelete(url, message) {
  const ask = $('#modalBody [data-ask-delete]');
  if (!ask) return;
  ask.onclick = () => { ask.classList.add('hidden'); $('#modalBody .confirm').classList.remove('hidden'); };
  $('#modalBody [data-confirm-delete]').onclick = async () => { if (await mutate(() => send('DELETE', url), message)) close(); };
}
const clean = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

function leadModal(id, presetClientId) {
  if (!canWrite('leads')) return;
  const lead = id ? leadById(id) : null;
  const client = lead ? clientById(lead.client_id) : presetClientId ? clientById(presetClientId) : null;
  const clientFields = client
    ? `<div class="full fixed-client">${clientCell(client)}<button type="button" class="link" data-client="${client.id}">Ver cliente</button></div>`
    : field('Nombre*', '<input name="name" required maxlength="120">') + field('WhatsApp*', '<input name="phone" required maxlength="40" placeholder="998 123 4567">') + field('Correo', '<input name="email" type="email" maxlength="254">');
  const html = `<form class="modal-form">${clientFields}
    ${field('Destino*', `<input name="destination" required maxlength="120" value="${escapeHtml(lead?.destination)}">`)}
    ${field('Origen', `<select name="source">${options(SOURCES, lead?.source || 'WhatsApp')}</select>`)}
    ${field('Salida', `<input name="start_date" type="date" value="${escapeHtml(lead?.start_date)}">`)}
    ${field('Regreso', `<input name="end_date" type="date" value="${escapeHtml(lead?.end_date)}">`)}
    ${field('Viajeros', `<input name="travelers" type="number" min="1" max="500" value="${escapeHtml(lead?.travelers)}">`)}
    ${field('Presupuesto (MXN)', `<input name="budget" type="number" min="0" step="1" value="${escapeHtml(lead?.budget)}">`)}
    ${lead ? field('Etapa', `<select name="stage">${options(STAGES, lead.stage)}</select>`) : field('Primer seguimiento', '<input name="first_followup_at" type="datetime-local">')}
    ${field('Prioridad', `<select name="priority">${options(PRIORITIES, lead?.priority || 'Media')}</select>`)}
    ${isAdmin() ? field('Vendedor asignado', `<select name="owner_id">${options(sellers().map((u) => [u.id, `${u.name} · ${ROLE_LABELS[u.role]}`]), lead?.owner_id ?? currentUser.id)}</select>`) : ''}
    ${field('Notas', `<textarea name="notes" rows="3" maxlength="4000">${escapeHtml(lead?.notes)}</textarea>`, true)}
    ${qualHtml(lead)}
    ${lead ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}">Nueva cotización</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}">Programar seguimiento</button><small>Creado ${escapeHtml(fmtDate(lead.created_at))}</small></div>` : ''}
    ${lead ? historyButton('leads', lead.id) : ''}
    ${deleteBlock('lead', lead?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${lead ? 'Guardar cambios' : 'Guardar lead'}</button></div></form>`;
  openModal('REGISTRO COMERCIAL', lead ? `Lead de ${client?.name || ''}` : 'Nuevo lead', html);
  bindQualification();
  bindForm(async (v, form) => {
    const body = clean({
      destination: v.destination, source: v.source, start_date: v.start_date || null, end_date: v.end_date || null,
      travelers: v.travelers || null, budget: v.budget || null, priority: v.priority, notes: v.notes || null
    });
    if (db.leadQuestions.length) body.qualification = readQualification();
    if (v.owner_id) body.owner_id = Number(v.owner_id);
    if (lead) {
      const reassigned = body.owner_id && body.owner_id !== lead.owner_id;
      return mutate(() => send('PATCH', `/api/leads/${lead.id}`, { ...body, stage: v.stage }), reassigned ? `Lead reasignado a ${userName(body.owner_id)}` : 'Lead actualizado');
    }
    if (client) body.client_id = client.id;
    else body.client = clean({ name: v.name, phone: v.phone, email: v.email || null });
    if (v.first_followup_at) body.first_followup_at = v.first_followup_at;
    const result = await mutate(() => send('POST', '/api/leads', body), 'Lead registrado');
    if (result?.warning) toast(result.warning, 7000);
    return result;
  });
  if (lead) bindDelete(`/api/leads/${lead.id}`, 'Lead eliminado');
}

/* ---------- utilidades de los editores (cotizador, confirmación, perfil) ---------- */
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}
// Reduce la foto (máximo 1600 px) y la sube; devuelve el id de la imagen guardada.
async function uploadImage(file, maxSide = 1600) {
  if (!file) throw new Error('Elige una imagen');
  let blob = file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
  } else if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error('Formato no compatible. Usa una foto JPG, PNG o WebP');
  }
  const response = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'No se pudo subir la imagen');
  return payload.id;
}
const mediaUrl = (id) => (Number(id) > 0 ? `/api/media/${Number(id)}` : '');
const imgField = (key, id, label, opts = {}) => `<div class="lbl ${opts.cls || ''}">${label}<div class="img-up" data-img="${key}"><span class="thumb${opts.round ? ' round' : ''}"${id ? ` style="background-image:url('${mediaUrl(id)}')"` : ''}></span><span class="img-actions"><input type="file" accept="image/*"><button type="button" class="link" data-img-clear${id ? '' : ' hidden'}>Quitar</button><span class="busy hidden">Subiendo…</span></span></div></div>`;
// Conecta los campos de imagen: sube al elegir y avisa el id (o null al quitar).
function bindImages(root, onChange) {
  root.querySelectorAll('.img-up').forEach((box) => {
    const thumb = box.querySelector('.thumb'), clear = box.querySelector('[data-img-clear]'), busy = box.querySelector('.busy');
    const input = box.querySelector('input[type=file]');
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      busy.classList.remove('hidden');
      try {
        const id = await uploadImage(file);
        thumb.style.backgroundImage = `url('${mediaUrl(id)}')`;
        clear.hidden = false;
        onChange(box.dataset.img, id);
      } catch (error) { toast(error.message, 6000); }
      finally { busy.classList.add('hidden'); input.value = ''; }
    };
    clear.onclick = () => { thumb.style.backgroundImage = ''; clear.hidden = true; onChange(box.dataset.img, null); };
  });
}
// Campos enlazados a una ruta del estado (data-k).
const czInput = (state, k, label, attrs = '', cls = '') => `<label class="${cls}">${label}<input data-k="${k}" value="${escapeHtml(getPath(state, k) ?? '')}" ${attrs}></label>`;
const czArea = (state, k, label, attrs = '', cls = '') => `<label class="${cls}">${label}<textarea data-k="${k}" ${attrs}>${escapeHtml(getPath(state, k) ?? '')}</textarea></label>`;
const czSelect = (state, k, label, list, opts = {}) => `<label class="${opts.cls || ''}">${label}<select data-k="${k}"${opts.struct ? ' data-struct' : ''}>${options(list, getPath(state, k) ?? opts.fallback ?? '')}</select></label>`;
function bindState(state, root, { onStruct, onCore } = {}) {
  const handler = (e) => {
    const el = e.target;
    if (el.dataset.k) {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      setPath(state, el.dataset.k, value);
      if (el.hasAttribute('data-struct') && e.type === 'change' && onStruct) onStruct(el);
    } else if (el.dataset.core && onCore) onCore(el, e.type);
  };
  root.oninput = handler;
  root.onchange = handler;
}

/* ---------- Cotizador (diseño de Viajes Casal dentro del CRM) ---------- */
const CZ_SERVICES = [['vuelo', 'Vuelo'], ['hotel', 'Hotel'], ['traslados', 'Traslados'], ['tours', 'Tours'], ['seguro', 'Seguro']];
const czLabel = (key) => CZ_SERVICES.find(([k]) => k === key)?.[1] || key;

function serviceFields(det, svc, prefix) {
  const i = (k, label, attrs, cls) => czInput(det, `${prefix}.${k}`, label, attrs, cls);
  switch (svc) {
    case 'vuelo': return `<div class="cz-grid">
      ${i('aerolinea', 'Aerolínea', 'placeholder="Volaris" maxlength="80"')}${i('origen', 'Origen', 'placeholder="CDMX" maxlength="80"')}
      ${i('equipaje', 'Equipaje', 'placeholder="artículo personal + equipaje de mano" maxlength="160"', 'span2')}
      ${i('hsIda', 'Hora salida ida', 'placeholder="08:35" maxlength="20"')}${i('hlIda', 'Hora llegada ida', 'placeholder="11:02" maxlength="20"')}
      ${i('hsReg', 'Hora salida regreso', 'placeholder="17:45" maxlength="20"')}${i('hlReg', 'Hora llegada regreso', 'placeholder="19:55" maxlength="20"')}</div>`;
    case 'traslados': return `<div class="cz-grid g2">
      ${czSelect(det, `${prefix}.tipo`, 'Tipo', ['Redondo', 'Solo llegada', 'Solo regreso'], { fallback: 'Redondo' })}
      ${i('desc', 'Descripción', 'placeholder="Aeropuerto ↔ Hotel" maxlength="200"')}</div>`;
    case 'seguro': return `<div class="cz-grid g2">${czArea(det, `${prefix}.cobertura`, 'Cobertura', 'placeholder="Seguro de viaje con cobertura médica y cancelación" maxlength="600"', 'full')}</div>`;
    case 'tours': return `<div class="cz-grid g2">${i('promo', 'Mensaje promocional (opcional)', 'placeholder="Ej. Tours gratis: elige 1 de las siguientes 3 opciones" maxlength="160"', 'full')}</div>
      ${[0, 1, 2].map((n) => `<div class="cz-block"><b>Tour ${n + 1}${n ? ' (opcional)' : ''}</b><div class="cz-grid">
        ${i(`items.${n}.nombre`, 'Nombre del tour', 'placeholder="Xcaret México — día completo" maxlength="120"', 'span2')}
        ${i(`items.${n}.precio`, 'Precio adicional', 'placeholder="$450 MXN por persona" maxlength="80"')}
        ${imgField(`${prefix}.items.${n}.mediaId`, getPath(det, `${prefix}.items.${n}.mediaId`), 'Foto (opcional)')}
        ${i(`items.${n}.desc`, 'Descripción breve', 'placeholder="Snorkel, tirolesas y río subterráneo" maxlength="200"', 'full')}</div></div>`).join('')}`;
    default: return `<div class="cz-grid">
      ${i('hotel', 'Hotel', 'placeholder="Hyatt Ziva Cancún" maxlength="120"', 'span2')}
      ${imgField(`${prefix}.mediaId`, getPath(det, `${prefix}.mediaId`), 'Foto del hotel', { cls: 'span2' })}
      ${czSelect(det, `${prefix}.stars`, 'Estrellas', ['5', '4', '3'], { fallback: '5' })}
      ${i('room', 'Habitación', 'placeholder="Junior Suite Ocean View" maxlength="120"')}${i('plan', 'Plan', 'placeholder="Todo Incluido" maxlength="80"', 'span2')}
      ${czArea(det, `${prefix}.desc`, 'Descripción breve', 'placeholder="Un resort frente al Caribe, ideal para…" maxlength="600"', 'full')}</div>`;
  }
}

function proposalHtml(det, p, i) {
  const pre = `proposals.${i}`;
  const plan = p.pay?.esquema === 'plan';
  return `<div class="cz-prop">
    <div class="cz-prop-head"><b>Propuesta ${i + 1} · ${escapeHtml(czLabel(det.varying))} que varía</b>
      <span class="cz-top">${det.proposals.length > 1 ? `<label class="principal"><input type="radio" name="czPrincipal" data-core="principal" value="${i}" ${det.principal === i ? 'checked' : ''}> Principal (se usa en el CRM)</label><button type="button" class="link" data-remove-prop="${i}">Eliminar propuesta</button>` : ''}</span></div>
    ${serviceFields(det, det.varying, `${pre}.${det.varying}`)}
    <div class="cz-grid" style="margin-top:10px">
      ${czInput(det, `${pre}.price.total`, 'Precio total (MXN)*', 'inputmode="decimal" placeholder="32850" maxlength="20"')}
      ${czInput(det, `${pre}.price.pp`, 'Precio por persona (MXN)', 'inputmode="decimal" placeholder="10950" maxlength="20"')}
      ${czInput(det, `${pre}.price.base`, 'Base pasajeros', 'placeholder="3 pasajeros" maxlength="40"')}
      ${czSelect(det, `${pre}.pay.esquema`, 'Esquema de pago', [['anticipo', 'Anticipo + saldo'], ['plan', 'Plan de pagos (varias fechas)']], { struct: true, fallback: 'anticipo' })}
    </div>
    <div class="cz-block">${plan
      ? `<b>Plan de pagos</b><div class="cz-grid g3">${[0, 1, 2].map((n) => `<div>${czInput(det, `${pre}.pay.pagos.${n}.fecha`, n === 2 ? 'Pago 3 (liquidación)' : `Pago ${n + 1}`, 'type="date"')}${czInput(det, `${pre}.pay.pagos.${n}.monto`, 'Monto', 'inputmode="decimal" placeholder="$ monto" maxlength="20"')}</div>`).join('')}</div>`
      : `<b>Anticipo</b><div class="cz-grid g2">${czInput(det, `${pre}.pay.anticipo`, 'Anticipo (MXN)', 'inputmode="decimal" placeholder="8213" maxlength="20"')}${czInput(det, `${pre}.pay.anticipoFecha`, 'Fecha límite de anticipo', 'type="date"')}</div>`}
    </div></div>`;
}

function quoteModal(id, preset = {}) {
  if (!canWrite('quotes')) { if (id) openDocument('cotizacion', id); return; }
  const quote = id ? quoteById(id) : null;
  if (!quote && !db.clients.length) { toast('Primero registra un lead o un cliente'); return; }
  const presetLead = preset.leadId ? leadById(preset.leadId) : null;
  const core = {
    client_id: quote?.client_id ?? preset.clientId ?? presetLead?.client_id ?? db.clients[0]?.id,
    lead_id: quote?.lead_id ?? preset.leadId ?? '',
    destination: quote?.destination ?? presetLead?.destination ?? '',
    valid_until: quote?.valid_until ?? '',
    status: quote?.status ?? 'Borrador'
  };
  let det = TPDocs.normalizeDetails(quote, leadById(core.lead_id));
  if (!quote) {
    det.services = { vuelo: true, hotel: true, traslados: true, tours: false, seguro: false };
    det.proposals = [{ hotel: { stars: '5' }, price: {}, pay: { esquema: 'anticipo' } }];
    if (preset.kind === 'circuito') det = TPDocs.newCircuitDetails(presetLead);
  }
  // Se conservan ambos formatos mientras se edita, por si el vendedor cambia de tipo.
  const drafts = { [det.kind === 'circuito' ? 'circuito' : 'paquete']: det };
  const leadChoices = () => db.leads.filter((l) => l.client_id === Number(core.client_id)).map((l) => [l.id, `${l.destination} · ${fmtRange(l.start_date, l.end_date)} · ${l.stage}`]);

  function render() {
    const scroller = $('#modalBg .modal');
    const top = scroller.scrollTop;
    const svc = det.services || {};
    const fixed = CZ_SERVICES.filter(([k]) => svc[k] && k !== det.varying);
    const checked = CZ_SERVICES.filter(([k]) => svc[k]);
    const isCircuit = det.kind === 'circuito';
    const range = isCircuit ? (det.startDate ? `${circuitDays(det)} · sale ${TPDocs.formatSingleDate(det.startDate)}` : circuitDays(det)) : TPDocs.formatDateRange(det.startDate, det.endDate);
    const html = `<form class="cz" novalidate>
      <div class="cz-kind"><span>Tipo de cotización</span><button type="button" data-kind="paquete" class="${isCircuit ? '' : 'on'}">Paquete (hotel, vuelo y traslados)</button><button type="button" data-kind="circuito" class="${isCircuit ? 'on' : ''}">Circuito (varias ciudades)</button></div>
      <section class="cz-card"><h4>Datos generales</h4><p class="cz-hint">${isCircuit ? 'Datos del circuito y del cliente.' : 'Aplican a toda la cotización, aunque incluyas varias propuestas.'}</p>
        <div class="cz-grid">
          <label>Cliente*<select data-core="client_id">${options(db.clients.map((c) => [c.id, c.name]), core.client_id)}</select></label>
          <label>Lead<select data-core="lead_id">${options(leadChoices(), core.lead_id, { blank: 'Sin lead' })}</select></label>
          <label>${isCircuit ? 'Destino o región*' : 'Destino principal*'}<input data-core="destination" maxlength="120" placeholder="${isCircuit ? 'Península de Yucatán' : 'Cancún, Quintana Roo'}" value="${escapeHtml(core.destination)}"></label>
          <label>Vigencia de la cotización<input data-core="valid_until" type="date" value="${escapeHtml(core.valid_until)}"></label>
          ${czInput(det, 'pax', 'Pasajeros', 'placeholder="2 adultos + 1 menor" maxlength="80"')}
          ${isCircuit ? czInput(det, 'circuit.nombre', 'Nombre del circuito*', 'placeholder="Ruta Maya Clásica" maxlength="120"') : ''}
          ${czInput(det, 'startDate', 'Fecha de salida', 'type="date" data-struct')}
          ${isCircuit ? '' : czInput(det, 'endDate', 'Fecha de regreso', 'type="date" data-struct')}
          ${quote ? `<label>Estado<select data-core="status">${options(QUOTE_STATUSES, core.status)}</select></label>` : '<span></span>'}
          <span class="cz-duration full">${range ? `📅 ${escapeHtml(range)}` : ''}</span>
          ${czInput(det, 'linkOnline', 'Link para ver la cotización en línea (opcional)', 'placeholder="https://…" maxlength="300"', 'span2')}
          ${isCircuit ? czInput(det, 'circuit.tipoTraslado', 'Tipo de traslado', 'placeholder="Terrestre en van" maxlength="80"') + czInput(det, 'circuit.idiomaGuia', 'Idioma del guía', 'placeholder="Español" maxlength="40"') : ''}
          ${imgField('heroMediaId', det.heroMediaId, 'Imagen de portada (foto del destino)', { cls: 'span2' })}
        </div>
      </section>
      ${isCircuit ? circuitSections(det) : `<section class="cz-card"><h4>Servicios incluidos</h4><p class="cz-hint">Marca lo que incluye. El servicio que varía se captura en cada propuesta (hasta 4); los demás, una sola vez.</p>
        <div class="cz-svc">${CZ_SERVICES.map(([k, label]) => `<label><input type="checkbox" data-k="services.${k}" data-struct ${det.services[k] ? 'checked' : ''}> ${label}</label>`).join('')}</div>
        <div class="cz-grid g2">${checked.length ? czSelect(det, 'varying', '¿Qué servicio varía entre las propuestas?', checked, { struct: true }) : '<p class="note-warn full">Marca al menos un servicio.</p>'}</div>
      </section>
      <section class="cz-card"><h4>Servicios fijos</h4><p class="cz-hint">Iguales en todas las propuestas.</p>
        ${fixed.length ? fixed.map(([k, label]) => `<div class="cz-block"><b>${label} (fijo)${k === 'tours' ? ' · complemento con costo adicional' : ''}</b>${serviceFields(det, k, `fixed.${k}`)}</div>`).join('') : '<p class="cz-hint">No hay servicios fijos: solo capturas el servicio que varía en cada propuesta.</p>'}
      </section>
      <section class="cz-card"><h4>Propuestas</h4><p class="cz-hint">La propuesta principal define el precio y el hotel que ves en el CRM y en los reportes.</p>
        ${det.proposals.map((p, i) => proposalHtml(det, p, i)).join('')}
        ${det.proposals.length < 4 ? '<div class="cz-add"><button type="button" class="btn secondary small" data-add-prop>+ Agregar otra propuesta (hasta 4)</button></div>' : ''}
      </section>`}
      ${quote?.status === 'Aceptada' ? `<div class="quick-actions"><button type="button" class="btn secondary small" data-trip-from-quote="${quote.id}">Crear viaje con esta cotización</button></div>` : ''}
      ${quote ? historyButton('quotes', quote.id) : ''}
      ${deleteBlock('cotización', quote?.id)}
      <div class="cz-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="button" class="btn secondary" data-save="0">${quote ? 'Guardar cambios' : 'Guardar cotización'}</button><button type="button" class="btn coral-btn" data-save="1">Guardar y ver PDF</button></div>
    </form>`;
    openModal('COTIZADOR', quote ? `Cotización ${quote.folio}` : 'Nueva cotización', html, { wide: true });
    scroller.scrollTop = top;
    const body = $('#modalBody');
    body.querySelector('form').onsubmit = (e) => e.preventDefault();
    bindImages(body, (key, mediaId) => setPath(det, key, mediaId));
    bindState(det, body, {
      onStruct: (el) => {
        if (el.dataset.k?.startsWith('services.')) {
          const on = CZ_SERVICES.filter(([k]) => det.services[k]).map(([k]) => k);
          if (!on.includes(det.varying)) det.varying = on.includes('hotel') ? 'hotel' : on[0] || 'hotel';
        }
        render();
      },
      onCore: (el, type) => {
        if (el.dataset.core === 'principal') { det.principal = Number(el.value); return; }
        core[el.dataset.core] = el.value;
        if (type !== 'change') return;
        if (el.dataset.core === 'client_id') { core.lead_id = ''; render(); }
        if (el.dataset.core === 'lead_id') {
          const l = leadById(core.lead_id);
          if (l) {
            if (!core.destination) core.destination = l.destination;
            if (!det.startDate && l.start_date) det.startDate = l.start_date;
            if (!det.endDate && l.end_date) det.endDate = l.end_date;
            if (!det.pax && l.travelers) det.pax = `${l.travelers} ${l.travelers === 1 ? 'pasajero' : 'pasajeros'}`;
            render();
          }
        }
      }
    });
    body.onclick = (e) => {
      const add = e.target.closest('[data-add-prop]');
      const remove = e.target.closest('[data-remove-prop]');
      const saveBtn = e.target.closest('[data-save]');
      const kindBtn = e.target.closest('[data-kind]');
      const cAdd = e.target.closest('[data-cadd]');
      const cDel = e.target.closest('[data-cdel]');
      if (kindBtn) {
        const kind = kindBtn.dataset.kind;
        if ((det.kind === 'circuito') === (kind === 'circuito')) return;
        drafts[det.kind === 'circuito' ? 'circuito' : 'paquete'] = det;
        const next = drafts[kind] || (kind === 'circuito' ? TPDocs.newCircuitDetails(leadById(core.lead_id)) : TPDocs.normalizeDetails(null, leadById(core.lead_id)));
        if (kind !== 'circuito' && !drafts[kind]) { next.services = { vuelo: true, hotel: true, traslados: true, tours: false, seguro: false }; next.proposals = [{ hotel: { stars: '5' }, price: {}, pay: { esquema: 'anticipo' } }]; }
        next.pax = next.pax || det.pax; next.startDate = next.startDate || det.startDate; next.heroMediaId = next.heroMediaId || det.heroMediaId;
        det = next;
        render();
        return;
      }
      if (cAdd) { circuitAdd(det.circuit, cAdd.dataset.cadd); render(); return; }
      if (cDel) { circuitDel(det.circuit, cDel.dataset.cdel); render(); return; }
      if (add) { det.proposals.push({ [det.varying]: det.varying === 'hotel' ? { stars: '5' } : {}, price: {}, pay: { esquema: 'anticipo' } }); render(); }
      else if (remove) {
        const idx = Number(remove.dataset.removeProp);
        det.proposals.splice(idx, 1);
        det.principal = det.principal === idx ? 0 : det.principal > idx ? det.principal - 1 : det.principal;
        render();
      } else if (saveBtn) save(saveBtn.dataset.save === '1', saveBtn);
    };
    if (quote) bindDelete(`/api/quotes/${quote.id}`, 'Cotización eliminada');
  }

  // Deja solo lo que corresponde a los servicios marcados.
  function cleanDetails() {
    const out = { version: 1, pax: str(det.pax), startDate: det.startDate || '', endDate: det.endDate || '', linkOnline: str(det.linkOnline), heroMediaId: det.heroMediaId || null, services: { ...det.services }, varying: det.varying, principal: det.principal || 0, fixed: {}, proposals: [] };
    CZ_SERVICES.forEach(([k]) => { if (det.services[k] && k !== det.varying && det.fixed?.[k]) out.fixed[k] = det.fixed[k]; });
    out.proposals = det.proposals.map((p) => ({ [det.varying]: p[det.varying] || {}, price: p.price || {}, pay: p.pay || { esquema: 'anticipo' } }));
    if (out.fixed.tours?.items) out.fixed.tours.items = out.fixed.tours.items.filter(Boolean);
    out.proposals.forEach((p) => { if (p.tours?.items) p.tours.items = p.tours.items.filter(Boolean); if (p.pay.pagos) p.pay.pagos = p.pay.pagos.map((x) => x || {}); });
    return out;
  }

  async function save(openPdf, button) {
    if (!core.client_id) { toast('Elige el cliente'); return; }
    if (!str(core.destination)) { toast('Escribe el destino principal'); return; }
    if (det.kind === 'circuito') { saveCircuit(openPdf, button); return; }
    if (!CZ_SERVICES.some(([k]) => det.services[k])) { toast('Marca al menos un servicio'); return; }
    if (det.startDate && det.endDate && det.endDate < det.startDate) { toast('La fecha de regreso no puede ser anterior a la de salida'); return; }
    const details = cleanDetails();
    const principal = details.proposals[details.principal] || details.proposals[0];
    const total = TPDocs.num(principal.price.total);
    if (!total) { toast(`Escribe el precio total de la propuesta ${details.principal + 1}`); return; }
    const merged = { ...details.fixed, [details.varying]: principal[details.varying] };
    const hotel = (merged.hotel?.hotel ? `${merged.hotel.hotel}${merged.hotel.plan ? ` — ${merged.hotel.plan}` : ''}` : TPDocs.optionLabel(details.varying, merged)) || `Paquete a ${core.destination}`;
    const body = {
      client_id: Number(core.client_id), lead_id: core.lead_id ? Number(core.lead_id) : null,
      destination: str(core.destination), valid_until: core.valid_until || null,
      hotel: hotel.slice(0, 200), price: total, mode: 'Total',
      services: CZ_SERVICES.filter(([k]) => details.services[k]).map(([, l]) => l).join(', '),
      details
    };
    const win = openPdf ? window.open('', '_blank') : null;
    button.disabled = true;
    const result = await mutate(() => (quote ? send('PATCH', `/api/quotes/${quote.id}`, { ...body, status: core.status }) : send('POST', '/api/quotes', body)), quote ? 'Cotización actualizada' : 'Cotización creada');
    button.disabled = false;
    if (!result) { win?.close(); return; }
    close();
    if (openPdf) openDocument('cotizacion', result.record.id, win);
  }
  async function saveCircuit(openPdf, button) {
    const c = det.circuit;
    if (!str(c.nombre)) { toast('Escribe el nombre del circuito'); return; }
    const desde = TPDocs.circuitDesde(c);
    if (!desde) { toast('Captura al menos una tarifa por persona'); return; }
    const details = {
      version: 1, kind: 'circuito', pax: str(det.pax), startDate: det.startDate || '', linkOnline: str(det.linkOnline), heroMediaId: det.heroMediaId || null,
      circuit: { ...c, ruta: c.ruta.map(str).filter(Boolean), incluye: c.incluye.map(str).filter(Boolean), excluye: c.excluye.map(str).filter(Boolean),
        categories: c.categories.map((cat) => ({ ...cat, hoteles: cat.hoteles.filter((h) => h && (h.ciudad || h.hotel)), precios: c.occupancies.map((_, i) => str(cat.precios[i])) })) }
    };
    const body = {
      client_id: Number(core.client_id), lead_id: core.lead_id ? Number(core.lead_id) : null,
      destination: str(core.destination), valid_until: core.valid_until || null,
      hotel: `Circuito ${str(c.nombre)}`.slice(0, 200), price: desde.min, mode: 'Por persona',
      services: TPDocs.CIRCUIT_SERVICES.filter((s) => c.services[s.key]).map((s) => s.label).join(', '),
      details
    };
    const win = openPdf ? window.open('', '_blank') : null;
    button.disabled = true;
    const result = await mutate(() => (quote ? send('PATCH', `/api/quotes/${quote.id}`, { ...body, status: core.status }) : send('POST', '/api/quotes', body)), quote ? 'Cotización actualizada' : 'Cotización de circuito creada');
    button.disabled = false;
    if (!result) { win?.close(); return; }
    close();
    if (openPdf) openDocument('cotizacion', result.record.id, win);
  }
  render();
}
const str = (v) => String(v ?? '').trim();

/* ---------- Circuito: secciones del cotizador ---------- */
const CIRCUIT_LIMITS = { ruta: 8, days: 12, categories: 5, occupancies: 6, incluye: 8, excluye: 8, hoteles: 8 };
const circuitDays = (d) => { const dias = d.circuit.days.length || 1, n = Math.max(dias - 1, 0); return `${dias} día${dias > 1 ? 's' : ''} / ${n} noche${n !== 1 ? 's' : ''}`; };
function circuitAdd(c, what) {
  if (what.startsWith('categories.')) {
    const cat = c.categories[Number(what.split('.')[1])];
    if (cat && cat.hoteles.length < CIRCUIT_LIMITS.hoteles) cat.hoteles.push({ ciudad: '', hotel: '' });
    return;
  }
  const list = c[what];
  if (!list || list.length >= CIRCUIT_LIMITS[what]) return;
  if (what === 'days') list.push({ titulo: '', descripcion: '', desayuno: true, comida: false, cena: false });
  else if (what === 'categories') list.push({ nombre: '', estrellas: '4', hoteles: [{ ciudad: '', hotel: '' }], precios: [] });
  else list.push('');
}
function circuitDel(c, path) {
  const parts = path.split('.');
  const index = Number(parts.pop());
  const list = getPath(c, parts.join('.'));
  if (!Array.isArray(list)) return;
  list.splice(index, 1);
  if (parts.join('.') === 'occupancies') c.categories.forEach((cat) => cat.precios.splice(index, 1));
}
function circuitSections(det) {
  const c = det.circuit;
  const del = (path, show = true) => (show ? `<button type="button" class="cz-x" data-cdel="${path}" title="Quitar">✕</button>` : '');
  const addBtn = (what, label, list) => (list.length < CIRCUIT_LIMITS[what] ? `<div class="cz-add"><button type="button" class="btn secondary small" data-cadd="${what}">${label}</button></div>` : '');
  const listRows = (what, ph) => c[what].map((v, i) => `<div class="cz-row"><input data-k="circuit.${what}.${i}" value="${escapeHtml(v)}" maxlength="160" placeholder="${ph}">${del(`${what}.${i}`)}</div>`).join('');
  const stars = (n) => '★'.repeat(Number(n) || 3);
  return `
    <section class="cz-card"><h4>Ruta / ciudades</h4><p class="cz-hint">El orden en que las agregues es el orden en que aparecen en la portada (hasta 8).</p>
      ${listRows('ruta', 'Ej. Cancún')}${addBtn('ruta', '+ Agregar ciudad', c.ruta)}</section>
    <section class="cz-card"><h4>Servicios incluidos en el circuito</h4>
      <div class="cz-svc">${TPDocs.CIRCUIT_SERVICES.map((s) => `<label><input type="checkbox" data-k="circuit.services.${s.key}" ${c.services[s.key] ? 'checked' : ''}> ${s.label}</label>`).join('')}</div></section>
    <section class="cz-card"><h4>Itinerario día por día</h4><p class="cz-hint">${escapeHtml(circuitDays(det))}. Hasta 12 días.</p>
      ${c.days.map((d, i) => `<div class="cz-block"><div class="cz-prop-head"><b>Día ${i + 1}</b>${del(`days.${i}`, c.days.length > 1)}</div>
        <div class="cz-grid g2">${czInput(det, `circuit.days.${i}.titulo`, 'Título / ruta del día', 'placeholder="Cancún — Llegada" maxlength="120"', 'full')}
        ${czArea(det, `circuit.days.${i}.descripcion`, 'Descripción', 'placeholder="Recepción en el aeropuerto y traslado al hotel…" maxlength="1200"', 'full')}</div>
        <div class="cz-meals">${[['desayuno', 'Desayuno'], ['comida', 'Comida'], ['cena', 'Cena']].map(([k, l]) => `<label><input type="checkbox" data-k="circuit.days.${i}.${k}" ${d[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>`).join('')}
      ${addBtn('days', '+ Agregar día', c.days)}</section>
    <section class="cz-card"><h4>Hospedaje por categoría</h4><p class="cz-hint">Cada categoría es una fila en la tabla de tarifas (hasta 5).</p>
      ${c.categories.map((cat, ci) => `<div class="cz-block"><div class="cz-prop-head"><b>Categoría ${ci + 1}</b>${del(`categories.${ci}`, c.categories.length > 1)}</div>
        <div class="cz-grid g2">${czInput(det, `circuit.categories.${ci}.nombre`, 'Nombre de categoría', 'placeholder="Estándar" maxlength="60" data-struct')}${czSelect(det, `circuit.categories.${ci}.estrellas`, 'Estrellas', ['5', '4', '3', '2'], { struct: true })}</div>
        <p class="cz-hint" style="margin:8px 0 4px">Hoteles por ciudad:</p>
        ${cat.hoteles.map((h, hi) => `<div class="cz-row"><input data-k="circuit.categories.${ci}.hoteles.${hi}.ciudad" value="${escapeHtml(h.ciudad)}" maxlength="80" placeholder="Ciudad (ej. Mérida)" class="cz-city"><input data-k="circuit.categories.${ci}.hoteles.${hi}.hotel" value="${escapeHtml(h.hotel)}" maxlength="120" placeholder="Nombre del hotel">${del(`categories.${ci}.hoteles.${hi}`, cat.hoteles.length > 1)}</div>`).join('')}
        ${cat.hoteles.length < CIRCUIT_LIMITS.hoteles ? `<button type="button" class="link" data-cadd="categories.${ci}">+ Agregar ciudad/hotel</button>` : ''}</div>`).join('')}
      ${addBtn('categories', '+ Agregar categoría de hotel', c.categories)}</section>
    <section class="cz-card"><h4>Ocupaciones y tarifas por persona (MXN)</h4><p class="cz-hint">La tarifa más baja se muestra como “Desde” y es el precio que ves en el CRM.</p>
      <div class="cz-occ">${c.occupancies.map((o, i) => `<span class="cz-row"><input data-k="circuit.occupancies.${i}" value="${escapeHtml(o)}" maxlength="30" placeholder="Doble" data-struct>${del(`occupancies.${i}`, c.occupancies.length > 1)}</span>`).join('')}
        ${c.occupancies.length < CIRCUIT_LIMITS.occupancies ? '<button type="button" class="link" data-cadd="occupancies">+ Ocupación</button>' : ''}</div>
      <div class="table"><table class="cz-prices"><thead><tr><th>Categoría</th>${c.occupancies.map((o) => `<th>${escapeHtml(o || 'Ocupación')}</th>`).join('')}</tr></thead>
        <tbody>${c.categories.map((cat, ci) => `<tr><td>${escapeHtml(cat.nombre || `Categoría ${ci + 1}`)} ${stars(cat.estrellas)}</td>${c.occupancies.map((_, oi) => `<td><input data-k="circuit.categories.${ci}.precios.${oi}" value="${escapeHtml(cat.precios[oi] ?? '')}" inputmode="decimal" maxlength="20" placeholder="$0"></td>`).join('')}</tr>`).join('')}</tbody></table></div></section>
    <section class="cz-card"><h4>¿Qué incluye y qué no?</h4><div class="cz-grid g2">
      <div><span class="lbl">Incluye</span>${listRows('incluye', 'Ej. Vuelo redondo México–Cancún')}${addBtn('incluye', '+ Agregar línea', c.incluye)}</div>
      <div><span class="lbl">No incluye</span>${listRows('excluye', 'Ej. Propinas y gastos personales')}${addBtn('excluye', '+ Agregar línea', c.excluye)}</div></div></section>`;
}

function clientModal(id) {
  const c = id ? clientById(id) : null;
  const history = c ? (() => {
    const leads = db.leads.filter((l) => l.client_id === c.id);
    const quotes = db.quotes.filter((q) => q.client_id === c.id);
    const trips = db.trips.filter((t) => t.client_id === c.id);
    const fups = db.followups.filter((f) => f.client_id === c.id);
    const list = (title, items) => `<div class="history-block"><b>${title}</b>${items.length ? `<ul>${items.join('')}</ul>` : '<small class="muted">Sin registros</small>'}</div>`;
    return `<div class="full history">
      ${list(`Leads (${leads.length})`, leads.map((l) => `<li><button type="button" class="link" data-lead="${l.id}">${escapeHtml(l.destination)}</button> · ${escapeHtml(fmtRange(l.start_date, l.end_date))} · <span class="status ${statusClass(l.stage)}">${escapeHtml(l.stage)}</span></li>`))}
      ${list(`Cotizaciones (${quotes.length})`, quotes.map((q) => `<li><button type="button" class="link" data-edit-quote="${q.id}">${escapeHtml(q.folio)}</button> · ${escapeHtml(q.hotel)} · ${money(q.price)} · ${escapeHtml(q.status)}</li>`))}
      ${list(`Viajes (${trips.length})`, trips.map((t) => `<li><button type="button" class="link" data-trip="${t.id}">${escapeHtml(t.destination)}</button> · ${escapeHtml(fmtRange(t.start_date, t.end_date))} · ${escapeHtml(t.status)}</li>`))}
      ${list(`Seguimientos (${fups.length})`, fups.slice(0, 8).map((f) => `<li>${f.done ? '✓ ' : ''}${escapeHtml(f.title)} · ${escapeHtml(fmtDue(f.due_at))}</li>`))}
    </div>`;
  })() : '';
  const readonly = !canWrite('clients');
  const html = `<form class="modal-form"><fieldset class="readonly"${readonly ? ' disabled' : ''}>
    ${field('Nombre*', `<input name="name" required maxlength="120" value="${escapeHtml(c?.name)}">`)}
    ${field('WhatsApp', `<input name="phone" maxlength="40" value="${escapeHtml(c?.phone)}">`)}
    ${field('Correo', `<input name="email" type="email" maxlength="254" value="${escapeHtml(c?.email)}">`)}
    ${field('Preferencias (separadas por coma)', `<input name="tags" maxlength="255" placeholder="Pareja, Todo incluido" value="${escapeHtml(c?.tags)}">`)}
    ${field('Notas', `<textarea name="notes" rows="2" maxlength="4000">${escapeHtml(c?.notes)}</textarea>`, true)}
    </fieldset>
    ${c ? `<div class="full quick-actions">${canWrite('leads') ? `<button type="button" class="btn secondary small" data-new-lead-client="${c.id}">Nuevo lead</button>` : ''}${canWrite('quotes') ? `<button type="button" class="btn secondary small" data-quote-for="${c.id}">Nueva cotización</button>` : ''}${canWrite('trips') ? `<button type="button" class="btn secondary small" data-new-trip-client="${c.id}">Nuevo viaje</button>` : ''}</div>` : ''}
    ${history}
    ${c ? historyButton('clients', c.id) : ''}
    ${deleteBlock('cliente y todo su historial', c?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">${readonly ? 'Cerrar' : 'Cancelar'}</button>${readonly ? '' : `<button type="submit" class="btn primary">${c ? 'Guardar cambios' : 'Guardar cliente'}</button>`}</div></form>`;
  openModal('CLIENTE', c ? c.name : 'Nuevo cliente', html);
  bindForm((v) => {
    const body = clean({ name: v.name, phone: v.phone || null, email: v.email || null, tags: v.tags || null, notes: v.notes || null });
    return c ? mutate(() => send('PATCH', `/api/clients/${c.id}`, body), 'Cliente actualizado') : mutate(() => send('POST', '/api/clients', body), 'Cliente creado');
  });
  if (c) bindDelete(`/api/clients/${c.id}`, 'Cliente eliminado');
}

function tripModal(id, preset = {}) {
  const t = id ? tripById(id) : null;
  if (!t && !db.clients.length) { toast('Primero registra un cliente'); return; }
  const fromQuote = preset.quoteId ? quoteById(preset.quoteId) : null;
  const fromLead = fromQuote?.lead_id ? leadById(fromQuote.lead_id) : null;
  const clientId = t?.client_id ?? fromQuote?.client_id ?? preset.clientId ?? db.clients[0]?.id;
  const quoteOptions = (cid) => options(db.quotes.filter((q) => q.client_id === Number(cid)).map((q) => [q.id, `${q.folio} · ${q.hotel}`]), t?.quote_id ?? fromQuote?.id, { blank: 'Sin cotización' });
  const html = `<form class="modal-form">
    ${field('Cliente*', `<select name="client_id" required>${options(db.clients.map((c) => [c.id, c.name]), clientId)}</select>`)}
    ${field('Cotización', `<select name="quote_id">${quoteOptions(clientId)}</select>`)}
    ${field('Destino*', `<input name="destination" required maxlength="120" value="${escapeHtml(t?.destination ?? fromQuote?.destination)}">`, true)}
    ${field('Salida*', `<input name="start_date" type="date" required value="${escapeHtml(t?.start_date ?? fromLead?.start_date)}">`)}
    ${field('Regreso*', `<input name="end_date" type="date" required value="${escapeHtml(t?.end_date ?? fromLead?.end_date)}">`)}
    ${field('Estado', `<select name="status">${options(TRIP_STATUSES, t?.status || 'Confirmado')}</select>`, true)}
    ${field('Notas', `<textarea name="notes" rows="3" maxlength="4000">${escapeHtml(t?.notes)}</textarea>`, true)}
    ${t ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-confirmation="${t.id}">${t.confirmation ? 'Editar confirmación de servicios' : 'Preparar confirmación de servicios'}</button><button type="button" class="btn secondary small" data-res-pdf="${t.id}">Ver PDF de confirmación</button>${t.confirmation ? '<small>✓ Confirmación lista</small>' : ''}</div>` : ''}
    ${t ? historyButton('trips', t.id) : ''}
    ${deleteBlock('viaje', t?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${t ? 'Guardar cambios' : 'Guardar viaje'}</button></div></form>`;
  openModal('OPERACIÓN', t ? `Viaje a ${t.destination}` : 'Nuevo viaje', html);
  const form = bindForm((v) => {
    const body = clean({ client_id: Number(v.client_id), quote_id: v.quote_id ? Number(v.quote_id) : null, destination: v.destination, start_date: v.start_date, end_date: v.end_date, status: v.status, notes: v.notes || null });
    return t ? mutate(() => send('PATCH', `/api/trips/${t.id}`, body), 'Viaje actualizado') : mutate(() => send('POST', '/api/trips', body), 'Viaje registrado');
  });
  form.client_id.onchange = () => { form.quote_id.innerHTML = quoteOptions(form.client_id.value); };
  if (t) bindDelete(`/api/trips/${t.id}`, 'Viaje eliminado');
}

function followupModal(id, preset = {}) {
  const f = id ? followupById(id) : null;
  const lead = preset.leadId ? leadById(preset.leadId) : null;
  const clientId = f?.client_id ?? lead?.client_id ?? '';
  const leadOptions = (cid) => options(db.leads.filter((l) => l.client_id === Number(cid)).map((l) => [l.id, `${l.destination} · ${l.stage}`]), f?.lead_id ?? lead?.id, { blank: 'Sin lead' });
  const due = f ? toInputDateTime(f.due_at) : `${ui.calDay && ui.calDay >= todayStr() ? ui.calDay : todayStr()}T10:00`;
  const html = `<form class="modal-form">
    ${field('Tipo', `<select name="type">${options(FOLLOWUP_TYPES, f?.type || 'Llamada')}</select>`)}
    ${field('Fecha y hora*', `<input name="due_at" type="datetime-local" required value="${escapeHtml(due)}">`)}
    ${field('Actividad*', `<input name="title" required maxlength="160" value="${escapeHtml(f?.title ?? (lead ? `Seguimiento a ${clientName(lead.client_id)}` : ''))}">`, true)}
    ${field('Cliente', `<select name="client_id">${options(db.clients.map((c) => [c.id, c.name]), clientId, { blank: 'Sin cliente' })}</select>`)}
    ${field('Lead', `<select name="lead_id">${leadOptions(clientId)}</select>`)}
    ${field('Detalles', `<textarea name="details" rows="2" maxlength="2000">${escapeHtml(f?.details)}</textarea>`, true)}
    ${f ? `<label class="full check"><input type="checkbox" name="done" ${f.done ? 'checked' : ''}> Marcar como hecho</label>` : ''}
    ${deleteBlock('seguimiento', f?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${f ? 'Guardar cambios' : 'Programar'}</button></div></form>`;
  openModal('PRODUCTIVIDAD', f ? 'Editar seguimiento' : 'Nuevo seguimiento', html);
  const form = bindForm((v) => {
    const body = clean({ type: v.type, due_at: v.due_at, title: v.title, client_id: v.client_id ? Number(v.client_id) : null, lead_id: v.lead_id ? Number(v.lead_id) : null, details: v.details || null });
    if (f) return mutate(() => send('PATCH', `/api/followups/${f.id}`, { ...body, done: v.done === 'on' }), 'Seguimiento actualizado');
    ui.calDay = v.due_at.slice(0, 10); const p = parts(ui.calDay); ui.calYear = p.y; ui.calMonth = p.m;
    return mutate(() => send('POST', '/api/followups', body), 'Seguimiento programado');
  });
  form.client_id.onchange = () => { form.lead_id.innerHTML = leadOptions(form.client_id.value); };
  if (f) bindDelete(`/api/followups/${f.id}`, 'Seguimiento eliminado');
}

/* ---------- Confirmación de servicios (diseño V8 de Viajes Casal) ---------- */
const PAY_STATUSES = ['Pendiente de pago', 'Pago parcial', 'Pagado por completo'];
async function confirmationModal(tripId) {
  let payload;
  try { payload = await api(`/api/documents/trip/${tripId}`); } catch (error) { toast(error.message); return; }
  const defaults = TPDocs.confirmationDefaults(payload);
  let c = TPDocs.mergeConfirmation(payload.trip.confirmation, defaults);
  const editable = payload.canEdit;
  const S = [['flight', 'Vuelo'], ['hotel', 'Hotel'], ['transfer', 'Traslados'], ['activities', 'Actividades'], ['insurance', 'Seguro'], ['partner', 'Travel Partner']];
  function render() {
    const i = (k, label, attrs = '', cls = '') => czInput(c, k, label, `maxlength="300" ${attrs}`, cls);
    const a = (k, label, attrs = '', cls = 'full') => czArea(c, k, label, `maxlength="1500" ${attrs}`, cls);
    const html = `<form class="cz" novalidate><fieldset class="readonly"${editable ? '' : ' disabled'}>
      <section class="cz-card"><h4>Portada y reserva</h4><p class="cz-hint">Se llenó con el viaje${payload.quote ? ` y la cotización ${escapeHtml(payload.quote.folio)}` : ''}. Revisa y completa lo que falte.</p>
        <div class="cz-grid">
          ${i('reservation', 'Número de reserva')}${i('holder', 'Titular')}${i('destination', 'Destino')}${i('travelers', 'Número de pasajeros', 'type="number" min="1" max="500"')}
          ${a('passengers', 'Pasajeros (uno por línea)', 'rows="3"', 'span2')}
          ${imgField('coverMediaId', c.coverMediaId, 'Imagen de portada', { cls: 'span2' })}
          <label class="cz-check full"><input type="checkbox" data-k="showSanitation" ${c.showSanitation ? 'checked' : ''}> Mostrar la cuota de saneamiento ambiental de Quintana Roo</label>
        </div></section>
      <section class="cz-card"><h4>Servicios incluidos</h4>
        <div class="cz-svc">${S.map(([k, label]) => `<label><input type="checkbox" data-k="services.${k}" ${c.services[k] ? 'checked' : ''}> ${label}</label>`).join('')}</div></section>
      <section class="cz-card"><h4>Vuelo</h4><div class="cz-grid">
        ${i('airline', 'Aerolínea')}${i('flightBooking', 'Reserva de vuelo')}${i('outboundFlight', 'Vuelo de ida', 'placeholder="Y4 123 CDMX → CUN"')}${i('returnFlight', 'Vuelo de regreso', 'placeholder="Y4 124 CUN → CDMX"')}
        ${i('outboundDeparture', 'Salida ida', 'placeholder="15 Ago 2026 | 08:35"')}${i('outboundArrival', 'Llegada ida')}${i('returnDeparture', 'Salida regreso')}${i('returnArrival', 'Llegada regreso')}
        ${a('baggage', 'Equipaje permitido', 'rows="2"', 'span2')}${a('flightTips', 'Tips de vuelo (uno por línea)', 'rows="2"', 'span2')}
        ${i('airlinePhone', 'Teléfono de la aerolínea')}</div></section>
      <section class="cz-card"><h4>Hotel</h4><div class="cz-grid">
        ${i('hotelName', 'Nombre del hotel', '', 'span2')}${imgField('hotelMediaId', c.hotelMediaId, 'Imagen del hotel', { cls: 'span2' })}
        ${czSelect(c, 'hotelStars', 'Estrellas', ['5', '4', '3'])}${i('room', 'Habitación')}${i('mealPlan', 'Plan alimenticio')}${i('hotelPhone', 'Teléfono del hotel')}
        ${i('checkin', 'Check-in', 'placeholder="15 Ago 2026 | 15:00 hrs"')}${i('checkout', 'Check-out')}
        ${a('hotelHighlights', 'Datos destacables (uno por línea)', 'rows="3"', 'span2')}</div></section>
      <section class="cz-card"><h4>Traslados</h4><div class="cz-grid">
        ${i('operator', 'Operador')}${i('transferContact', 'Contacto')}<span></span><span></span>
        ${i('transferOutOrigin', 'Ida: origen')}${i('transferOutDestination', 'Ida: destino')}${i('transferOutDate', 'Fecha ida')}${i('transferOutTime', 'Horario ida')}
        ${i('transferBackOrigin', 'Regreso: origen')}${i('transferBackDestination', 'Regreso: destino')}${i('transferBackDate', 'Fecha regreso')}${i('transferBackTime', 'Horario regreso')}</div></section>
      <section class="cz-card"><h4>Actividades y seguro</h4><div class="cz-grid">
        ${a('activitiesDetail', 'Actividades y tours (fecha, horario, punto de encuentro)', 'rows="3"', 'span2')}
        <div class="span2 cz-grid g2">${i('insuranceProvider', 'Aseguradora')}${i('insurancePolicy', 'Número de póliza')}${a('insuranceDetail', 'Cobertura y contacto', 'rows="2"')}</div></div></section>
      <section class="cz-card"><h4>Travel Partner y contactos</h4><div class="cz-grid">
        ${i('partnerName', 'Travel Partner')}${i('partnerPhone', 'WhatsApp del Travel Partner')}${i('emergencyPhone', 'Teléfono de emergencias')}<span></span>
        ${a('partnerDetail', 'Información de atención', 'rows="3"')}</div></section>
      <section class="cz-card"><h4>Información de pagos</h4><div class="cz-grid">
        ${czSelect(c, 'paymentStatus', 'Estado del pago', PAY_STATUSES)}${i('paymentTotal', 'Total de la reserva', 'placeholder="$0.00 MXN"')}${i('paymentPaid', 'Monto pagado', 'placeholder="$0.00 MXN"')}<span></span>
        ${a('paymentSchedule', 'Pagos programados (fecha — monto — concepto, uno por línea)', 'rows="2"')}</div></section>
      </fieldset>
      <div class="cz-actions">${editable ? '<button type="button" class="btn secondary" data-reset-conf>Volver a llenar con la cotización</button>' : ''}<button type="button" class="btn secondary close">${editable ? 'Cancelar' : 'Cerrar'}</button>${editable ? '<button type="button" class="btn secondary" data-save="0">Guardar</button>' : ''}<button type="button" class="btn coral-btn" data-save="1">${editable ? 'Guardar y ver PDF' : 'Ver PDF'}</button></div>
    </form>`;
    openModal('CONFIRMACIÓN DE SERVICIOS', `${payload.client?.name || 'Viaje'} · ${payload.trip.destination}`, html, { wide: true });
    const body = $('#modalBody');
    body.querySelector('form').onsubmit = (e) => e.preventDefault();
    bindImages(body, (key, id) => setPath(c, key, id));
    bindState(c, body);
    body.onclick = async (e) => {
      if (e.target.closest('[data-reset-conf]')) { c = { ...defaults, services: { ...defaults.services } }; render(); toast('Datos tomados del viaje y la cotización. Guarda para conservarlos.'); return; }
      const btn = e.target.closest('[data-save]');
      if (!btn) return;
      const pdf = btn.dataset.save === '1';
      if (!editable) { openDocument('reserva', tripId); return; }
      const win = pdf ? window.open('', '_blank') : null;
      btn.disabled = true;
      const ok = await mutate(() => send('PATCH', `/api/trips/${tripId}`, { confirmation: c }), 'Confirmación guardada');
      btn.disabled = false;
      if (!ok) { win?.close(); return; }
      close();
      if (pdf) openDocument('reserva', tripId, win);
    };
  }
  render();
}

/* ---------- Calificación del lead (respuestas con botones y ponderación) ---------- */
const LEVEL_CLASS = { Caliente: 'hot', Tibio: 'warm', 'Frío': 'cold' };
const maxPoints = (q) => Math.max(0, ...q.options.map((o) => Number(o.points) || 0));
function scoreAnswers(answers) {
  const qs = db.leadQuestions;
  let points = 0, max = 0, answeredCount = 0;
  qs.forEach((q) => {
    max += maxPoints(q);
    const o = q.options.find((x) => x.label === answers[q.id]);
    if (o) { points += Number(o.points) || 0; answeredCount += 1; }
  });
  const score = answeredCount && max ? Math.round((points / max) * 100) : null;
  return { score, answered: answeredCount, total: qs.length, level: score == null ? null : score >= 70 ? 'Caliente' : score >= 40 ? 'Tibio' : 'Frío' };
}
function qualChip(lead) {
  if (!db.leadQuestions.length) return '';
  const q = lead?.qualification;
  if (!q || q.score == null) return '<span class="qual-chip none" title="Responde las preguntas de calificación">Sin calificar</span>';
  return `<span class="qual-chip ${LEVEL_CLASS[q.level] || 'none'}" title="${q.answered} de ${q.total} preguntas respondidas">${q.level === 'Caliente' ? '🔥 ' : ''}${q.score}% ${escapeHtml(q.level)}</span>`;
}
let qualDraft = {};
function qualSummary() {
  const r = scoreAnswers(qualDraft);
  const cls = LEVEL_CLASS[r.level] || '';
  return { r, html: r.score == null ? '<span class="muted">Sin calificar · toca una respuesta</span>' : `<span class="lvl-${cls}">${r.score}% · ${r.level}</span> <small class="muted">(${r.answered}/${r.total})</small>`, cls };
}
function qualHtml(lead) {
  const qs = db.leadQuestions;
  if (!qs.length) return '';
  qualDraft = { ...(lead?.qualification?.answers || {}) };
  const totalMax = qs.reduce((sum, q) => sum + maxPoints(q), 0) || 1;
  const { r, html, cls } = qualSummary();
  return `<div class="qual full" id="qualBox"><div class="qual-head"><b>Calificación del lead</b><span class="qual-score" id="qualScore">${html}</span></div>
    <div class="qual-bar"><i id="qualBar" class="bar-${cls}" style="width:${r.score || 0}%"></i></div>
    ${qs.map((q) => `<div class="qual-q"><span class="qual-label">${escapeHtml(q.label)}<small>peso ${Math.round((maxPoints(q) / totalMax) * 100)}%</small></span>
      <div class="qual-btns">${q.options.map((o) => `<button type="button" data-qa="${escapeHtml(q.id)}" data-val="${escapeHtml(o.label)}" class="${qualDraft[q.id] === o.label ? 'on' : ''}">${escapeHtml(o.label)}</button>`).join('')}</div></div>`).join('')}
  </div>`;
}
// Tocar una respuesta la marca (o la quita si ya estaba) y recalcula al instante.
function bindQualification() {
  const box = $('#qualBox');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-qa]');
    if (!btn) return;
    const id = btn.dataset.qa;
    qualDraft[id] = qualDraft[id] === btn.dataset.val ? undefined : btn.dataset.val;
    if (!qualDraft[id]) delete qualDraft[id];
    box.querySelectorAll(`[data-qa="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle('on', b.dataset.val === qualDraft[id]));
    const { r, html, cls } = qualSummary();
    $('#qualScore').innerHTML = html;
    $('#qualBar').style.width = `${r.score || 0}%`;
    $('#qualBar').className = `bar-${cls}`;
  });
}
function readQualification() { return { answers: { ...qualDraft } }; }

/* ---------- Perfil para documentos (foto, WhatsApp y presentación del vendedor) ---------- */
async function profileModal(userId) {
  const self = !userId || userId === currentUser.id;
  let profile;
  try { profile = (await api(self ? '/api/profile' : `/api/profile/${userId}`)).profile; } catch (error) { toast(error.message); return; }
  const state = { photoMediaId: profile.photoMediaId ?? (profile.photoUrl ? Number(profile.photoUrl.split('/').pop()) : null) };
  const defaultBio = `Soy ${profile.name.split(' ')[0]}, tu Travel Partner en Viajes Casal. Te acompaño desde el primer mensaje hasta que regresas a casa, cuidando cada detalle de tu viaje para que tú solo pienses en disfrutarlo.`;
  openModal('PERFIL PARA DOCUMENTOS', self ? 'Mi perfil' : `Perfil de ${profile.name}`, `<form class="modal-form">
    <p class="full muted">Así apareces en la sección “Conoce a tu Travel Partner” de la cotización y en la confirmación de servicios. Tu nombre se cambia en Configuración → Usuarios.</p>
    <div class="full cz">${imgField('photoMediaId', state.photoMediaId, 'Foto (cuadrada, de frente)', { round: true })}</div>
    ${field('WhatsApp', `<input name="phone" maxlength="40" placeholder="+52 998 123 4567" value="${escapeHtml(profile.phone)}">`)}
    ${field('Página personal (opcional)', `<input name="website" maxlength="200" placeholder="https://paulina.viajescasal.com" value="${escapeHtml(profile.website)}">`)}
    ${field('Presentación', `<textarea name="bio" rows="4" maxlength="1500" placeholder="${escapeHtml(defaultBio)}">${escapeHtml(profile.bio)}</textarea>`, true)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Guardar perfil</button></div></form>`);
  bindImages($('#modalBody'), (_key, id) => { state.photoMediaId = id; });
  bindForm(async (v) => {
    try {
      await send('PUT', self ? '/api/profile' : `/api/profile/${userId}`, { phone: v.phone, website: v.website, bio: v.bio, photoMediaId: state.photoMediaId });
      toast('Perfil guardado');
      if (self) loadAll();
      return true;
    } catch (error) { toast(error.message, 6000); return false; }
  });
}

/* ---------- Configuración: Plantilla PDF ---------- */
const DOC_SETTINGS = [
  ['Marca y contacto', [
    ['brandName', 'Nombre en los documentos', 'input', 'Aparece junto al logo'], ['tagline', 'Frase de cierre', 'input'],
    ['supportWhatsapp', 'WhatsApp de soporte 24/7', 'input', 'Se usa si el vendedor no tiene WhatsApp en su perfil'], ['emergencyPhone', 'Teléfono de emergencias', 'input']
  ]],
  ['Sitio, redes y reseñas', [
    ['website', 'Sitio web', 'url'], ['reviewsUrl', 'Reseñas de Google', 'url'], ['facebook', 'Facebook', 'url'], ['instagram', 'Instagram', 'url'],
    ['tiktok', 'TikTok', 'url'], ['youtube', 'YouTube', 'url'], ['blogUrl', 'Blog / guías de viaje', 'url']
  ]],
  ['Cotización', [
    ['quoteImportant', 'Información importante', 'area'], ['quotePolicies', 'Políticas', 'area'], ['quoteNote', 'Esta cotización', 'area', 'También aparece en los circuitos'],
    ['circImportant', 'Información importante (circuitos)', 'area'], ['circPolicies', 'Políticas (circuitos)', 'area'],
    ['partnerBenefits', 'Beneficios del Travel Partner', 'area', 'Uno por línea'], ['paymentInstructions', 'Datos para pago (opcional)', 'area', 'Banco, beneficiario, CLABE o liga de pago. Aparece en “Formas de pago”.']
  ]],
  ['Confirmación de servicios', [
    ['resSanitation', 'Cuota de saneamiento (Quintana Roo)', 'area'], ['resConsiderations', 'Consideraciones (otros destinos)', 'area'],
    ['resPolicies', 'Políticas principales', 'area', 'Una por línea'], ['resTerms', 'Términos y condiciones', 'area'],
    ['resTermsUrl', 'Enlace a términos completos', 'url'], ['resDocuments', 'Documentos recomendados', 'area', 'Uno por línea'],
    ['resFlightTips', 'Tips de vuelo', 'area', 'Uno por línea'], ['resPartnerDetail', 'Atención del Travel Partner', 'area']
  ]]
];
function renderDocSettings() {
  const d = db.documents || {};
  $('#docSettingsForm').innerHTML = DOC_SETTINGS.map(([legend, fields]) => `<fieldset><legend>${legend}</legend>${fields.map(([k, label, type, hint]) => {
    const help = hint ? `<small>${escapeHtml(hint)}</small>` : '';
    if (type === 'area') return `<label class="full">${escapeHtml(label)}${help}<textarea data-doc="${k}" rows="3">${escapeHtml(d[k])}</textarea></label>`;
    return `<label>${escapeHtml(label)}${help}<input data-doc="${k}" ${type === 'url' ? 'type="url" placeholder="https://…"' : ''} value="${escapeHtml(d[k])}"></label>`;
  }).join('')}</fieldset>`).join('');
}
async function saveDocSettings() {
  const body = Object.fromEntries($$('#docSettingsForm [data-doc]').map((el) => [el.dataset.doc, el.value]));
  const ok = await mutate(() => send('PUT', '/api/settings/documents', body), 'Plantilla guardada');
  if (ok) renderDocSettings();
}

/* ---------- Configuración: preguntas de calificación (máximo 5, respuestas con puntos) ---------- */
let questionDraft = [];
const MAX_QUESTIONS = 5, MAX_OPTIONS = 6;
function renderQuestionsEditor(fromDb = false) {
  if (fromDb) questionDraft = JSON.parse(JSON.stringify(db.leadQuestions || []));
  const totalMax = questionDraft.reduce((sum, q) => sum + maxPoints(q), 0) || 1;
  $('#questionRows').innerHTML = (questionDraft.length ? questionDraft.map((q, i) => `<div class="q-card" data-q="${i}">
    <div class="q-card-head"><input data-qf="label" maxlength="120" placeholder="Pregunta" value="${escapeHtml(q.label)}"><span class="q-weight" title="Peso de la pregunta en la calificación">peso ${Math.round((maxPoints(q) / totalMax) * 100)}%</span>
      <span class="q-btns"><button type="button" data-qmove="-1" title="Subir">↑</button><button type="button" data-qmove="1" title="Bajar">↓</button><button type="button" data-qdel title="Eliminar pregunta">✕</button></span></div>
    <div class="q-opts">${q.options.map((o, j) => `<div class="q-opt" data-o="${j}"><input data-of="label" maxlength="60" placeholder="Respuesta (botón)" value="${escapeHtml(o.label)}"><span class="pts"><input data-of="points" type="number" min="0" max="100" value="${escapeHtml(o.points)}"> pts</span><button type="button" class="cz-x" data-odel title="Quitar respuesta">✕</button></div>`).join('')}
      ${q.options.length < MAX_OPTIONS ? '<button type="button" class="link" data-oadd>+ Agregar respuesta</button>' : ''}</div>
  </div>`).join('') : '<p class="empty-note">Sin preguntas. Agrega la primera.</p>')
  + `<div class="q-legend"><b>¿Cómo se califica?</b> Cada respuesta suma sus puntos. La calificación es el % de puntos obtenidos sobre el máximo posible, así que el peso de cada pregunta es su respuesta con más puntos. <b>Caliente</b> 70% o más · <b>Tibio</b> 40 a 69% · <b>Frío</b> menos de 40%. Máximo ${MAX_QUESTIONS} preguntas para que el cuestionario tome menos de un minuto.</div>`;
  $('#addQuestion').disabled = questionDraft.length >= MAX_QUESTIONS;
}
$('#questionRows').addEventListener('input', (e) => {
  const card = e.target.closest('[data-q]'); if (!card) return;
  const q = questionDraft[Number(card.dataset.q)];
  if (e.target.dataset.qf === 'label') q.label = e.target.value;
  const row = e.target.closest('[data-o]');
  if (row && e.target.dataset.of) {
    const o = q.options[Number(row.dataset.o)];
    if (e.target.dataset.of === 'points') o.points = Number(e.target.value);
    else o.label = e.target.value;
  }
});
$('#questionRows').addEventListener('change', (e) => { if (e.target.dataset.of === 'points') renderQuestionsEditor(); });
$('#questionRows').addEventListener('click', (e) => {
  const card = e.target.closest('[data-q]'); if (!card) return;
  const i = Number(card.dataset.q);
  const q = questionDraft[i];
  if (e.target.closest('[data-qdel]')) questionDraft.splice(i, 1);
  else if (e.target.closest('[data-qmove]')) {
    const j = i + Number(e.target.closest('[data-qmove]').dataset.qmove);
    if (j < 0 || j >= questionDraft.length) return;
    [questionDraft[i], questionDraft[j]] = [questionDraft[j], questionDraft[i]];
  } else if (e.target.closest('[data-oadd]')) q.options.push({ label: '', points: 0 });
  else if (e.target.closest('[data-odel]')) q.options.splice(Number(e.target.closest('[data-o]').dataset.o), 1);
  else return;
  renderQuestionsEditor();
});
$('#addQuestion').onclick = () => {
  if (questionDraft.length >= MAX_QUESTIONS) return;
  questionDraft.push({ label: '', options: [{ label: '', points: 10 }, { label: '', points: 0 }] });
  renderQuestionsEditor();
  $('#questionRows .q-card:last-of-type input')?.focus();
};
$('#cancelQuestions').onclick = () => renderQuestionsEditor(true);
$('#saveQuestions').onclick = async () => {
  const ok = await mutate(() => send('PUT', '/api/settings/lead-questions', { questions: questionDraft }), 'Preguntas guardadas');
  if (ok) renderQuestionsEditor(true);
};
$('#saveDocSettings').onclick = saveDocSettings;
$('#cancelDocSettings').onclick = renderDocSettings;

/* ---------- Configuración: integraciones ---------- */
function renderIntegrations() {
  const d = db.documents || {};
  const waNumber = d.supportWhatsapp || db.agency.whatsapp;
  const wa = TPDocs.waLink(waNumber);
  const reviews = TPDocs.safeUrl(d.reviewsUrl);
  const card = (title, text, link, qr, extra = '') => `<div class="integration"><div class="int-main"><b>${title}</b><small>${text}</small>${link ? `<p><a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a></p>` : ''}${extra}</div>
    <div class="int-side">${qr ? `<img class="qr-mini" src="/api/qr?data=${encodeURIComponent(qr)}" alt="Código QR">` : ''}${link ? `<button class="btn secondary small" data-copy="${escapeHtml(link)}">Copiar enlace</button>` : ''}</div></div>`;
  $('#integrationCards').innerHTML =
    card('Documentos para clientes <span class="tag-ok">Activo</span>', 'Cotización (hasta 4 propuestas) y Confirmación de servicios con el diseño de Viajes Casal, listas para guardar en PDF y enviar por WhatsApp.', '', '', '<p><button class="link" data-settings-tab="pdfPanel">Editar textos y redes de la plantilla</button></p>')
    + card(`WhatsApp de la agencia ${wa ? '<span class="tag-ok">Listo</span>' : '<span class="tag-soon">Sin número</span>'}`, wa ? `Enlace directo y código QR para ${escapeHtml(waNumber)}. Úsalo en tu sitio, redes o material impreso.` : 'Agrega el WhatsApp en Perfil de agencia o en Plantilla PDF.', wa, wa)
    + card(`Reseñas de Google ${reviews ? '<span class="tag-ok">Listo</span>' : '<span class="tag-soon">Sin enlace</span>'}`, reviews ? 'Aparece al pie de la cotización y la confirmación. Comparte el QR al terminar cada viaje.' : 'Agrega el enlace en Plantilla PDF.', reviews, reviews)
    + `<div class="int-soon"><div><b>Bot de WhatsApp → CRM</b>Que el bot cree el lead con sus respuestas. Próximamente (TP-101).</div><div><b>Formulario web</b>Solicitudes de tu sitio directo a Leads. Próximamente (TP-102).</div><div><b>Respaldos y exportación</b>Copia diaria y descarga a Excel. Próximamente (TP-007).</div></div>`;
}
$('#integrationCards').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try { await navigator.clipboard.writeText(btn.dataset.copy); toast('Enlace copiado'); } catch { toast(btn.dataset.copy, 6000); }
});

/* ---------- bitácora ---------- */
const ENTITY_LABELS = { clients: 'Cliente', leads: 'Lead', quotes: 'Cotización', trips: 'Viaje', followups: 'Seguimiento' };
const SECURITY_LABELS = {
  login_success: 'Inició sesión', login_failed: 'Intento de acceso fallido', logout: 'Cerró sesión',
  password_changed: 'Cambió su contraseña', password_reset_requested: 'Pidió recuperar su contraseña',
  password_reset_completed: 'Recuperó su contraseña', password_reset_mail_failed: 'Falló el correo de recuperación',
  password_reset_sent_by_admin: 'Envió enlace de recuperación', user_create: 'Creó un usuario', user_update: 'Editó un usuario',
  user_reset_password: 'Generó contraseña temporal', mail_test_sent: 'Envió correo de prueba',
  twofa_enabled: 'Activó la verificación en dos pasos', twofa_disabled: 'Desactivó la verificación en dos pasos',
  totp_enabled: 'Configuró app de autenticación', totp_disabled: 'Quitó su app de autenticación',
  backup_codes_regenerated: 'Generó códigos de respaldo', twofa_backup_code_used: 'Entró con código de respaldo',
  twofa_failed: 'Bloqueado por códigos incorrectos', twofa_reset_by_admin: 'Quitó la app de un usuario',
  trusted_devices_cleared: 'Olvidó sus equipos recordados', twofa_skipped_no_mail: 'Entró sin segundo paso (correo no configurado)',
  crm_settings_update: 'Cambió la configuración', profile_update: 'Actualizó el perfil para documentos', crm_shared_client: 'Registró un cliente que ya atiende otro vendedor'
};
const VERB = { create: 'Creó', update: 'Editó', delete: 'Eliminó', duplicate: 'Duplicó', reassign: 'Reasignó' };
function describeAction(item) {
  const match = /^crm_(clients|leads|quotes|trips|followups)_(\w+)$/.exec(item.action);
  if (match && VERB[match[2]]) {
    const kind = match[2] === 'create' || match[2] === 'duplicate' ? 'create' : match[2] === 'delete' ? 'delete' : 'update';
    return { text: `${VERB[match[2]]} ${ENTITY_LABELS[match[1]].toLowerCase()}`, kind };
  }
  const alert = ['login_failed', 'twofa_failed', 'password_reset_mail_failed', 'crm_shared_client', 'twofa_skipped_no_mail'].includes(item.action);
  return { text: SECURITY_LABELS[item.action] || item.action, kind: alert ? 'alert' : 'security' };
}
function fmtMs(ms) {
  const d = new Date(ms - 5 * 3600 * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function changesHtml(item) {
  const parts = item.changes.map((c) => `<span class="act-change"><b>${escapeHtml(c.label)}:</b> ${c.from == null ? '<i>vacío</i>' : `<del>${escapeHtml(c.from)}</del>`} → ${c.to == null ? '<i>vacío</i>' : `<ins>${escapeHtml(c.to)}</ins>`}</span>`);
  if (item.note) parts.push(`<span class="act-note">${escapeHtml(item.note)}</span>`);
  if (item.method) parts.push(`<span class="act-note">Verificación: ${escapeHtml(item.method)}</span>`);
  if (item.action === 'login_failed' && item.userEmail) parts.push(`<span class="act-note">Correo usado: ${escapeHtml(item.userEmail)}</span>`);
  return parts.join('') || '<span class="muted">—</span>';
}
const activityState = { items: [], seq: 0, done: false };
function activityFilters() {
  const params = new URLSearchParams();
  for (const [key, id] of [['user', 'actUser'], ['type', 'actType'], ['entity', 'actEntity'], ['from', 'actFrom'], ['to', 'actTo']]) {
    const value = $(`#${id}`).value;
    if (value) params.set(key, value);
  }
  return params;
}
// Cada consulta lleva un número; si llega una respuesta vieja (filtros cambiados), se descarta.
async function loadActivity(more = false) {
  const seq = ++activityState.seq;
  const params = activityFilters();
  params.set('limit', '100');
  if (more && activityState.items.length) params.set('before', activityState.items.at(-1).id);
  try {
    const { items } = await api(`/api/activity?${params}`);
    if (seq !== activityState.seq) return;
    activityState.items = more ? activityState.items.concat(items) : items;
    activityState.done = items.length < 100;
    renderActivity();
  } catch (error) { if (seq === activityState.seq) toast(error.message); }
}
function renderActivity() {
  const rows = activityState.items;
  $('#actRows').innerHTML = rows.length ? rows.map((item) => {
    const action = describeAction(item);
    const record = item.entity ? `${ENTITY_LABELS[item.entity] || ''}${item.summary ? ` · ${escapeHtml(item.summary)}` : item.entityId ? ` #${item.entityId}` : ''}` : (item.summary ? escapeHtml(item.summary) : '—');
    return `<tr><td>${escapeHtml(fmtMs(item.createdMs))}</td><td>${escapeHtml(item.userName || item.userEmail || 'Sistema')}</td><td><span class="act-pill ${action.kind}">${escapeHtml(action.text)}</span></td><td>${record}</td><td>${changesHtml(item)}</td></tr>`;
  }).join('') : emptyRow(5, 'No hay actividad con estos filtros.');
  $('#actMore').classList.toggle('hidden', activityState.done || !rows.length);
}
function fillActivityUsers() {
  const select = $('#actUser');
  const current = select.value;
  select.innerHTML = options(db.users.map((u) => [u.id, u.name]), current, { blank: 'Todos los usuarios' });
}
function exportActivity() {
  const header = ['Fecha y hora', 'Usuario', 'Acción', 'Sección', 'Registro', 'Cambios', 'Nota', 'IP'];
  const rows = activityState.items.map((i) => [fmtMs(i.createdMs), i.userName || i.userEmail || 'Sistema', describeAction(i).text, ENTITY_LABELS[i.entity] || '', i.summary || '',
    i.changes.map((c) => `${c.label}: ${c.from ?? 'vacío'} -> ${c.to ?? 'vacío'}`).join(' | '), i.note || '', i.ip || '']);
  const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `bitacora-${todayStr()}.csv` });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// Historial de un registro dentro de su ventana.
const historyButton = (entity, id) => `<div class="full"><button type="button" class="link" data-history="${entity}:${id}">Ver historial de cambios</button></div>`;
async function historyModal(entity, id) {
  try {
    const { items } = await api(`/api/history/${entity}/${id}`);
    const title = items.find((i) => i.summary)?.summary || `${ENTITY_LABELS[entity]} #${id}`;
    openModal('HISTORIAL', title, `<div class="timeline-hist">${items.length ? items.map((item) => `<div class="entry"><b>${escapeHtml(describeAction(item).text)}</b> · ${escapeHtml(item.userName || 'Sistema')}<small>${escapeHtml(fmtMs(item.createdMs))}</small>${changesHtml(item)}</div>`).join('') : '<p class="empty-note">Sin movimientos registrados.</p>'}</div><div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div>`);
  } catch (error) { toast(error.message); }
}

/* ---------- usuarios (administrador) ---------- */
let usersCache = [];
async function loadUsers() {
  try {
    usersCache = (await api('/api/users')).users;
    renderUsers();
  } catch (error) { toast(error.message); }
}
function fmtStamp(value) {
  if (!value) return 'Nunca';
  const v = String(value).replace('T', ' ');
  return `${fmtDate(v.slice(0, 10))}, ${v.slice(11, 16)}`;
}
function renderUsers() {
  $('#userRows').innerHTML = usersCache.length ? usersCache.map((u) => `<tr>
    <td>${clientCell({ name: u.name }, u.email)}</td>
    <td>${escapeHtml(u.roleLabel)}</td>
    <td><span class="status ${u.active ? (u.mustChangePassword ? 'quoted' : 'accepted') : 'pill-off'}">${u.active ? (u.mustChangePassword ? 'Pendiente de primer acceso' : 'Activo') : 'Desactivado'}</span></td>
    <td>${u.twofa ? (u.twofaApp ? 'App' : 'Correo') : '—'}</td>
    <td>${escapeHtml(fmtStamp(u.lastLoginAt))}</td>
    <td><div class="user-actions"><button class="link" data-edit-user="${u.id}">Editar</button>${u.id !== currentUser.id ? `<button class="link" data-reset-user="${u.id}">Nueva contraseña</button>` : ''}${u.twofaApp && u.id !== currentUser.id ? `<button class="link" data-reset-2fa="${u.id}">Quitar app</button>` : ''}</div></td></tr>`).join('')
    : emptyRow(6, 'Sin usuarios');
}
function showTemporaryPassword(user, password, intro) {
  const url = location.origin;
  const message = `Hola ${user.name}, este es tu acceso a la plataforma de Viajes Casal:\n${url}\nCorreo: ${user.email}\nContraseña temporal: ${password}\nAl entrar te pedirá crear tu propia contraseña.`;
  openModal('ACCESO', `Acceso de ${user.name}`, `<div class="modal-form">
    <p class="full">${escapeHtml(intro)}</p>
    <div class="full temp-pass" id="tempPass">${escapeHtml(password)}</div>
    <p class="full note-warn">Esta contraseña solo se muestra ahora. Cópiala y compártela por WhatsApp; al entrar, ${escapeHtml(user.name)} deberá crear la suya.</p>
    <label class="full">Mensaje listo para enviar<textarea id="accessMessage" rows="6" readonly>${escapeHtml(message)}</textarea></label>
    <div class="modal-actions"><button type="button" class="btn secondary close">Listo</button><button type="button" class="btn primary" id="copyAccess">Copiar mensaje</button></div></div>`);
  $('#copyAccess').onclick = async () => {
    try { await navigator.clipboard.writeText($('#accessMessage').value); toast('Mensaje copiado'); }
    catch { $('#accessMessage').select(); toast('Selecciona y copia el mensaje con Ctrl+C'); }
  };
}
function userModal(id) {
  const u = id ? usersCache.find((x) => x.id === Number(id)) : null;
  const self = u && u.id === currentUser.id;
  const roleOptions = options(Object.entries(ROLE_LABELS).filter(([k]) => k !== 'consulta' || u?.role === 'consulta'), u?.role || 'travel_partner');
  const html = `<form class="modal-form">
    ${field('Nombre*', `<input name="name" required maxlength="120" value="${escapeHtml(u?.name)}">`)}
    ${field('Correo*', `<input name="email" type="email" required maxlength="254" value="${escapeHtml(u?.email)}" ${u ? 'disabled' : ''}>`)}
    ${field('Rol', `<select name="role" ${self ? 'disabled' : ''}>${roleOptions}</select>`)}
    ${u ? field('Estado', `<select name="active" ${self ? 'disabled' : ''}>${options([['1', 'Activo'], ['0', 'Desactivado']], u.active ? '1' : '0')}</select>`) : ''}
    ${self ? '<p class="full note-warn">No puedes cambiar tu propio rol ni desactivar tu cuenta.</p>' : ''}
    ${u ? '' : '<p class="full muted">Al guardar se genera una contraseña temporal para compartir con el usuario.</p>'}
    ${u && u.role !== 'consulta' ? `<div class="full"><button type="button" class="link" data-user-profile="${u.id}">Foto, WhatsApp y presentación para documentos</button></div>` : ''}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${u ? 'Guardar cambios' : 'Crear usuario'}</button></div></form>`;
  openModal('USUARIOS', u ? `Editar a ${u.name}` : 'Nuevo usuario', html);
  bindForm(async (v) => {
    try {
      if (u) {
        const body = { name: v.name };
        if (!self) { body.role = v.role; body.active = v.active === '1'; }
        await send('PATCH', `/api/users/${u.id}`, body);
        toast(body.active === false ? `${v.name} ya no puede entrar` : 'Usuario actualizado');
        await loadAll();
        await loadUsers();
        return true;
      }
      const result = await send('POST', '/api/users', { name: v.name, email: v.email, role: v.role });
      await loadAll();
      await loadUsers();
      showTemporaryPassword(result.user, result.temporaryPassword, `Usuario creado con el rol ${result.user.roleLabel}.`);
      return false;
    } catch (error) {
      toast(error.message);
      return false;
    }
  });
}
function resetUserModal(id) {
  const u = usersCache.find((x) => x.id === Number(id));
  if (!u) return;
  openModal('USUARIOS', `Nueva contraseña para ${u.name}`, `<div class="modal-form">
    <p class="full"><b>Opción 1 · Enlace por correo:</b> ${escapeHtml(u.name)} recibe en ${escapeHtml(u.email)} un enlace para crear su contraseña (vence en 30 minutos). Su contraseña actual sigue funcionando hasta que la cambie.</p>
    <p class="full"><b>Opción 2 · Contraseña temporal:</b> se genera una para compartir por WhatsApp y se cierran sus sesiones abiertas. Su contraseña actual deja de funcionar.</p>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="button" class="btn secondary" id="sendResetLink">Enviar enlace por correo</button><button type="button" class="btn primary" id="confirmReset">Generar contraseña temporal</button></div></div>`);
  $('#sendResetLink').onclick = async () => {
    const button = $('#sendResetLink');
    button.disabled = true;
    try { toast((await send('POST', `/api/users/${u.id}/send-reset`)).message, 6000); close(); }
    catch (error) { toast(error.message, 7000); button.disabled = false; }
  };
  $('#confirmReset').onclick = async () => {
    try {
      const result = await send('POST', `/api/users/${u.id}/reset-password`);
      await loadUsers();
      showTemporaryPassword(u, result.temporaryPassword, 'Contraseña temporal generada.');
    } catch (error) { toast(error.message); }
  };
}
function showSettingsTab(tab) {
  ui.settingsTab = tab;
  $$('#settingsNav [data-settings-tab]').forEach((b) => b.classList.toggle('active', b.dataset.settingsTab === tab));
  $$('.settings-panel').forEach((p) => { p.hidden = p.id !== tab; });
  if (tab === 'usersPanel') loadUsers();
  if (tab === 'integrationsPanel') { loadMailStatus(); renderIntegrations(); }
  if (tab === 'pdfPanel') renderDocSettings();
  if (tab === 'questionsPanel') renderQuestionsEditor(true);
}
async function loadMailStatus() {
  const el = $('#mailStatus'), button = $('#testMail');
  try {
    const status = await api('/api/settings/mail-status');
    el.innerHTML = status.configured
      ? `<span class="mail-ok">Configurado</span> · envía desde ${escapeHtml(status.from)} · enlaces a ${escapeHtml(status.appUrl)}`
      : '<span class="mail-off">Sin configurar</span> · faltan las variables SMTP en Hostinger';
    button.disabled = !status.configured;
  } catch (error) { el.textContent = error.message; }
}

/* ---------- recuperación de contraseña ---------- */
let resetToken = null;
function showAuthView(view) {
  ['loginForm', 'twofaForm', 'forgotForm', 'resetForm'].forEach((id) => $(`#${id}`).classList.toggle('hidden', id !== view));
  ['loginError', 'loginNotice', 'twofaError', 'twofaNotice', 'forgotError', 'forgotDone', 'resetError'].forEach((id) => $(`#${id}`).classList.add('hidden'));
  const focus = { loginForm: '#loginEmail', twofaForm: '#twofaCode', forgotForm: '#forgotEmail', resetForm: '#resetPassword' }[view];
  setTimeout(() => $(focus)?.focus(), 0);
}
const showMessage = (id, text) => { const el = $(`#${id}`); el.textContent = text; el.classList.remove('hidden'); };

// Si la página se abre desde el enlace del correo (#reset=...), muestra el formulario.
async function handleResetLink() {
  const match = /^#reset=([\w-]{20,200})$/.exec(location.hash);
  if (!match) return false;
  resetToken = match[1];
  history.replaceState(null, '', location.pathname);
  $('#platform').classList.add('hidden');
  $('#login').classList.remove('hidden');
  try {
    const result = await send('POST', '/api/auth/reset-password/verify', { token: resetToken });
    if (!result.valid) {
      resetToken = null;
      showAuthView('forgotForm');
      showMessage('forgotError', 'El enlace ya venció o ya se usó. Escribe tu correo y te enviamos uno nuevo.');
      return true;
    }
    showAuthView('resetForm');
    $('#resetIntro').textContent = `Hola ${result.name}, usa al menos 12 caracteres con mayúscula, minúscula y número.`;
  } catch (error) {
    showAuthView('forgotForm');
    showMessage('forgotError', error.message);
  }
  return true;
}

/* ---------- sesión ---------- */
function showLogin() {
  currentUser = null; loaded = false;
  showAuthView('loginForm');
  $('#platform').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginPassword').value = '';
}
function applyUser(user) {
  currentUser = user;
  $('#profileName').textContent = user.name;
  $('#profileInitial').textContent = user.name.charAt(0).toUpperCase();
  $('#profileRole').textContent = user.roleLabel || ROLE_LABELS[user.role] || user.role;
  document.body.classList.remove(...Object.keys(ROLE_LABELS).map((r) => `role-${r}`));
  document.body.classList.add(`role-${user.role}`);
  $('#dashboard .heading h2').textContent = `Hola, ${user.name} 👋`;
  $$('[data-admin-only]').forEach((el) => el.classList.toggle('hidden', user.role !== 'admin'));
  $('#login').classList.add('hidden');
  $('#platform').classList.remove('hidden');
  if (user.mustChangePassword) showPasswordChange();
  else loadAll();
}
async function restoreSession() {
  if (await handleResetLink()) return;
  try { applyUser((await api('/api/auth/me')).user); }
  catch { $('#login').classList.remove('hidden'); $('#platform').classList.add('hidden'); }
}
function showPasswordChange() {
  passwordChangeRequired = true;
  $('#closeModal').classList.add('hidden');
  openModal('SEGURIDAD', 'Crea una nueva contraseña', `<form id="passwordChangeForm" class="modal-form"><p class="full">Por seguridad debes cambiar la contraseña temporal antes de continuar.</p><label class="full">Contraseña temporal<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>Nueva contraseña<input name="newPassword" type="password" autocomplete="new-password" minlength="12" required></label><label>Confirmar contraseña<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label><p id="passwordError" class="form-error full hidden" role="alert"></p><div class="modal-actions"><button class="btn primary">Guardar contraseña</button></div></form>`);
  $('#passwordChangeForm').onsubmit = async (event) => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    const error = $('#passwordError');
    error.classList.add('hidden');
    if (values.newPassword !== values.confirmPassword) { error.textContent = 'Las contraseñas no coinciden'; error.classList.remove('hidden'); return; }
    try {
      await send('POST', '/api/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      passwordChangeRequired = false;
      currentUser.mustChangePassword = false;
      $('#closeModal').classList.remove('hidden');
      close();
      toast('Contraseña actualizada correctamente');
      loadAll();
    } catch (requestError) {
      error.textContent = requestError.message;
      error.classList.remove('hidden');
    }
  };
}

/* ---------- navegación y eventos ---------- */
function navigate(page) {
  if (page === 'activity') { fillActivityUsers(); loadActivity(); }
  $$('aside nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === page));
  $('#sidebar').classList.remove('open');
  scrollTo({ top: 0, behavior: 'smooth' });
}
function toast(text, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

$('#nav').onclick = (e) => { const b = e.target.closest('[data-page]'); if (b) navigate(b.dataset.page); };
$('#menu').onclick = () => $('#sidebar').classList.toggle('open');
$('#theme').onclick = () => {
  document.body.classList.toggle('dark');
  try { localStorage.setItem('tp-dark', document.body.classList.contains('dark') ? '1' : '0'); } catch { /* sin almacenamiento */ }
};
try { if (localStorage.getItem('tp-dark') === '1') document.body.classList.add('dark'); } catch { /* sin almacenamiento */ }

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const error = $('#loginError'), button = $('#loginButton');
  error.classList.add('hidden');
  button.disabled = true;
  try {
    const payload = await send('POST', '/api/auth/login', { email: $('#loginEmail').value, password: $('#loginPassword').value });
    $('#loginPassword').value = '';
    if (payload.twofa) { showTwofa(payload.twofa); return; }
    applyUser(payload.user);
    toast('Sesión iniciada correctamente');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
};
// ---- Segundo paso del inicio de sesión ----
function showTwofa(info) {
  showAuthView('twofaForm');
  $('#twofaCode').value = '';
  $('#twofaCode').setAttribute('inputmode', 'numeric');
  $('#twofaIntro').textContent = info.method === 'app'
    ? 'Escribe el código de 6 dígitos que muestra tu app de autenticación.'
    : `Enviamos un código de 6 dígitos a ${info.email}. Vence en 10 minutos; si no lo ves, revisa spam.`;
  const emailLink = $('#twofaEmail');
  emailLink.classList.toggle('hidden', !info.canUseEmail);
  emailLink.textContent = info.method === 'app' ? 'No tengo mi celular: enviarme un código por correo' : 'Reenviar código por correo';
  $('#twofaBackup').classList.toggle('hidden', info.method !== 'app');
}
$('#twofaForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#twofaError').classList.add('hidden');
  const button = $('#twofaButton');
  button.disabled = true;
  try {
    const result = await send('POST', '/api/auth/2fa/verify', { code: $('#twofaCode').value, remember: $('#twofaRemember').checked });
    showAuthView('loginForm');
    applyUser(result.user);
    toast('Sesión iniciada correctamente');
  } catch (error) {
    if (/vuelve a iniciar sesión/i.test(error.message)) { showAuthView('loginForm'); showMessage('loginError', error.message); }
    else { showMessage('twofaError', error.message); $('#twofaCode').select(); }
  } finally {
    button.disabled = false;
  }
};
$('#twofaEmail').onclick = async () => {
  $('#twofaError').classList.add('hidden');
  try {
    const result = await send('POST', '/api/auth/2fa/send-email');
    showMessage('twofaNotice', `Enviamos un código nuevo a ${result.email}.`);
    $('#twofaIntro').textContent = 'Escribe el código de 6 dígitos que llegó a tu correo.';
    $('#twofaCode').focus();
  } catch (error) {
    if (/vuelve a iniciar sesión/i.test(error.message)) { showAuthView('loginForm'); showMessage('loginError', error.message); }
    else showMessage('twofaError', error.message);
  }
};
$('#twofaBackup').onclick = () => {
  $('#twofaCode').setAttribute('inputmode', 'text');
  $('#twofaIntro').textContent = 'Escribe uno de tus códigos de respaldo (formato XXXX-XXXX). Cada código sirve una sola vez.';
  $('#twofaCode').value = '';
  $('#twofaCode').focus();
};

// ---- Mi cuenta ----
async function accountModal(view = {}) {
  let data;
  try { data = await api('/api/account'); } catch (error) { toast(error.message); return; }
  const t = data.twofa;
  const pill = (on, yes, no) => `<span class="pill ${on ? 'on' : 'off'}">${on ? yes : no}</span>`;
  const twofaSection = t.required
    ? `<p>Como administrador, la verificación es obligatoria. Al entrar en un equipo nuevo te pedimos un código ${t.app ? 'de tu app (o por correo como respaldo)' : `enviado a ${escapeHtml(t.email_masked)}`}.</p>`
    : t.active
      ? `<p>Al entrar en un equipo nuevo te pedimos un código ${t.app ? 'de tu app' : `enviado a ${escapeHtml(t.email_masked)}`}.</p><div class="row"><input type="password" id="acctPassOff" placeholder="Tu contraseña" autocomplete="current-password"><button class="btn secondary small" id="twofaOff">Desactivar</button></div>`
      : `<p>Actívala para pedir un código por correo al entrar desde un equipo nuevo.</p><div class="row"><button class="btn primary small" id="twofaOn" ${t.mailConfigured ? '' : 'disabled title="El correo de la plataforma no está configurado"'}>Activar código por correo</button></div>`;
  const appSection = view.setup
    ? `<div class="qr-box"><img src="${view.setup.qr}" alt="Código QR para la app de autenticación"><div><p>1. Abre Google Authenticator o Microsoft Authenticator y escanea el código.</p><p>2. Si no puedes escanear, escribe esta clave:</p><p class="secret">${escapeHtml(view.setup.secret.replace(/(.{4})/g, '$1 ').trim())}</p></div></div>
       <div class="row"><input id="totpCode" inputmode="numeric" maxlength="6" placeholder="Código de 6 dígitos" autocomplete="one-time-code"><button class="btn primary small" id="totpEnable">Confirmar</button><button class="btn secondary small" id="totpCancel">Cancelar</button></div>`
    : view.backupCodes
      ? `<p class="note-warn">Guarda estos códigos en un lugar seguro. Cada uno sirve una vez si pierdes tu celular y solo se muestran ahora.</p><div class="backup-grid" id="backupCodes">${view.backupCodes.map((c) => `<span>${c}</span>`).join('')}</div><div class="row"><button class="btn secondary small" id="copyBackup">Copiar códigos</button></div>`
      : t.app
        ? `<p>${pill(true, 'Activa', '')} Te quedan ${t.backupCodesLeft} códigos de respaldo.</p><div class="row"><input type="password" id="acctPassApp" placeholder="Tu contraseña" autocomplete="current-password"><button class="btn secondary small" id="newBackup">Nuevos códigos de respaldo</button><button class="btn secondary small" id="totpOff">Quitar app</button></div>`
        : '<p>Más seguro que el correo: el código lo genera tu celular, sin internet.</p><div class="row"><button class="btn secondary small" id="totpSetup">Configurar app de autenticación</button></div>';
  openModal('MI CUENTA', data.user.name, `<div class="acct">
    <section><h4>Mis datos</h4><p>${escapeHtml(data.user.email)} · ${escapeHtml(data.user.roleLabel)}</p><div class="row"><button class="btn secondary small" id="acctChangePass">Cambiar mi contraseña</button></div></section>
    <section><h4>Mi perfil para documentos</h4><p>${db.me?.phone ? `WhatsApp ${escapeHtml(db.me.phone)}` : 'Sin WhatsApp'} · ${db.me?.photoUrl ? 'con foto' : 'sin foto'}. Aparece en tus cotizaciones y confirmaciones.</p><div class="row"><button class="btn secondary small" id="acctProfile">Editar mi foto, WhatsApp y presentación</button></div></section>
    <section><h4>Verificación en dos pasos ${pill(t.active, 'Activa', 'Desactivada')}</h4>${twofaSection}</section>
    <section><h4>App de autenticación</h4>${appSection}</section>
    <section><h4>Equipos recordados</h4><p>${t.trustedDevices ? `${t.trustedDevices} equipo(s) no piden código durante 30 días.` : 'Ningún equipo recordado.'}</p>${t.trustedDevices ? '<div class="row"><button class="btn secondary small" id="forgetDevices">Olvidar todos los equipos</button></div>' : ''}</section>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div></div>`);
  const on = (id, fn) => { const el = $(`#${id}`); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (error) { toast(error.message, 6000); el.disabled = false; } }; };
  on('acctChangePass', async () => voluntaryPasswordChange());
  on('acctProfile', async () => profileModal());
  on('twofaOn', async () => { await send('POST', '/api/account/twofa', { enabled: true }); toast('Verificación activada'); accountModal(); });
  on('twofaOff', async () => { await send('POST', '/api/account/twofa', { enabled: false, password: $('#acctPassOff').value }); toast('Verificación desactivada'); accountModal(); });
  on('totpSetup', async () => accountModal({ setup: await send('POST', '/api/account/totp/setup') }));
  on('totpCancel', async () => accountModal());
  on('totpEnable', async () => { const r = await send('POST', '/api/account/totp/enable', { code: $('#totpCode').value }); toast('App de autenticación activada'); accountModal({ backupCodes: r.backupCodes }); });
  on('newBackup', async () => { const r = await send('POST', '/api/account/backup-codes', { password: $('#acctPassApp').value }); accountModal({ backupCodes: r.backupCodes }); });
  on('totpOff', async () => { await send('POST', '/api/account/totp/disable', { password: $('#acctPassApp').value }); toast('App quitada; recibirás el código por correo'); accountModal(); });
  on('forgetDevices', async () => { await send('POST', '/api/account/forget-devices'); toast('Equipos olvidados'); accountModal(); });
  on('copyBackup', async () => {
    const text = view.backupCodes.join('\n');
    try { await navigator.clipboard.writeText(text); toast('Códigos copiados'); } catch { toast('Selecciona los códigos y cópialos con Ctrl+C'); }
    $('#copyBackup').disabled = false;
  });
}
function voluntaryPasswordChange() {
  openModal('MI CUENTA', 'Cambiar mi contraseña', `<form class="modal-form">
    ${field('Contraseña actual', '<input name="currentPassword" type="password" autocomplete="current-password" required>', true)}
    ${field('Nueva contraseña', '<input name="newPassword" type="password" autocomplete="new-password" minlength="12" required>')}
    ${field('Confirmar contraseña', '<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required>')}
    <p class="full muted">Al menos 12 caracteres con mayúscula, minúscula y número.</p>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Guardar contraseña</button></div></form>`);
  bindForm(async (v) => {
    if (v.newPassword !== v.confirmPassword) { toast('Las contraseñas no coinciden'); return false; }
    try { await send('POST', '/api/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }); toast('Contraseña actualizada'); return true; }
    catch (error) { toast(error.message); return false; }
  });
}
$('#myAccount').onclick = () => accountModal();

$('#forgotLink').onclick = () => {
  showAuthView('forgotForm');
  $('#forgotEmail').value = $('#loginEmail').value;
};
$$('.back-login').forEach((b) => { b.onclick = () => showAuthView('loginForm'); });
$('#forgotForm').onsubmit = async (e) => {
  e.preventDefault();
  const button = $('#forgotButton');
  $('#forgotError').classList.add('hidden');
  $('#forgotDone').classList.add('hidden');
  const email = $('#forgotEmail').value.trim();
  if (!email) { showMessage('forgotError', 'Escribe tu correo'); return; }
  button.disabled = true;
  try {
    const result = await send('POST', '/api/auth/forgot-password', { email });
    showMessage('forgotDone', result.message);
  } catch (error) {
    showMessage('forgotError', error.message);
  } finally {
    button.disabled = false;
  }
};
$('#resetForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#resetError').classList.add('hidden');
  const password = $('#resetPassword').value;
  if (password !== $('#resetConfirm').value) { showMessage('resetError', 'Las contraseñas no coinciden'); return; }
  const button = $('#resetButton');
  button.disabled = true;
  try {
    const result = await send('POST', '/api/auth/reset-password', { token: resetToken, newPassword: password });
    resetToken = null;
    $('#resetPassword').value = '';
    $('#resetConfirm').value = '';
    showAuthView('loginForm');
    showMessage('loginNotice', result.message);
  } catch (error) {
    showMessage('resetError', error.message);
  } finally {
    button.disabled = false;
  }
};

$('#logout').onclick = async () => {
  try { await send('POST', '/api/auth/logout'); } catch { /* sesión ya cerrada */ }
  showLogin();
  navigate('dashboard');
};

$('#closeModal').onclick = close;
$('#modalBg').onclick = (e) => { if (e.target.id === 'modalBg') close(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-day]')) { e.preventDefault(); e.target.click(); }
});

// Delegación de clics para todos los botones dinámicos.
document.addEventListener('click', (e) => {
  const t = e.target;
  const hit = (sel) => t.closest(sel);
  let el;
  if ((el = hit('[data-action]'))) {
    const action = el.dataset.action;
    if (action === 'lead') leadModal();
    else if (action === 'quote') quoteModal();
    else if (action === 'circuit') quoteModal(null, { kind: 'circuito' });
    else if (action === 'client') clientModal();
    else if (action === 'trip') tripModal();
    else if (action === 'followup') followupModal();
    return;
  }
  if (t.classList.contains('close')) { close(); return; }
  if ((el = hit('[data-demo]'))) { toast(el.dataset.demo); return; }
  if ((el = hit('[data-quote-for]'))) { quoteModal(null, { clientId: Number(el.dataset.quoteFor), leadId: el.dataset.quoteLead ? Number(el.dataset.quoteLead) : undefined }); return; }
  if ((el = hit('[data-new-followup-lead]'))) { followupModal(null, { leadId: Number(el.dataset.newFollowupLead) }); return; }
  if ((el = hit('[data-new-lead-client]'))) { leadModal(null, Number(el.dataset.newLeadClient)); return; }
  if ((el = hit('[data-new-trip-client]'))) { tripModal(null, { clientId: Number(el.dataset.newTripClient) }); return; }
  if ((el = hit('[data-trip-from-quote]'))) { tripModal(null, { quoteId: Number(el.dataset.tripFromQuote) }); return; }
  if ((el = hit('[data-history]'))) { const [entity, id] = el.dataset.history.split(':'); historyModal(entity, Number(id)); return; }
  if ((el = hit('[data-settings-tab]'))) { showSettingsTab(el.dataset.settingsTab); return; }
  if ((el = hit('[data-edit-user]'))) { userModal(Number(el.dataset.editUser)); return; }
  if ((el = hit('[data-reset-user]'))) { resetUserModal(Number(el.dataset.resetUser)); return; }
  if ((el = hit('[data-reset-2fa]'))) {
    const id = Number(el.dataset.reset2fa);
    send('POST', `/api/users/${id}/reset-2fa`).then((r) => { toast(r.message, 6000); loadUsers(); }).catch((error) => toast(error.message));
    return;
  }
  if ((el = hit('[data-confirmation]'))) { confirmationModal(Number(el.dataset.confirmation)); return; }
  if ((el = hit('[data-res-pdf]'))) { openDocument('reserva', el.dataset.resPdf); return; }
  if ((el = hit('[data-user-profile]'))) { profileModal(Number(el.dataset.userProfile)); return; }
  if ((el = hit('[data-edit-quote]'))) { quoteModal(Number(el.dataset.editQuote)); return; }
  if ((el = hit('[data-lead]'))) { leadModal(Number(el.dataset.lead)); return; }
  if ((el = hit('[data-client]'))) { clientModal(Number(el.dataset.client)); return; }
  if ((el = hit('[data-trip]'))) { tripModal(Number(el.dataset.trip)); return; }
  if ((el = hit('[data-followup]'))) { followupModal(Number(el.dataset.followup)); return; }
  if ((el = hit('[data-day]'))) { ui.calDay = el.dataset.day; renderCalendar(); return; }
  if ((el = hit('[data-duplicate]'))) { const q = quoteById(el.dataset.duplicate); mutate(() => send('POST', `/api/quotes/${el.dataset.duplicate}/duplicate`), `Cotización ${q?.folio || ''} duplicada`); return; }
  if ((el = hit('[data-pdf]'))) { openPrintableQuote(el.dataset.pdf); return; }
  if ((el = hit('[data-whatsapp]'))) { prepareWhatsapp([el.dataset.whatsapp]); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-done]')) {
    const id = Number(t.dataset.done);
    mutate(() => send('PATCH', `/api/followups/${id}`, { done: t.checked }), t.checked ? 'Seguimiento completado' : 'Seguimiento reabierto');
  } else if (t.matches('[data-select-quote]')) {
    toggleQuote(t.dataset.selectQuote, t.checked);
  } else if (t.matches('[data-quote-status]')) {
    mutate(() => send('PATCH', `/api/quotes/${t.dataset.quoteStatus}`, { status: t.value }), `Estado actualizado a ${t.value}`);
  }
});

$('#leadSearch').oninput = (e) => { ui.leadQuery = e.target.value; renderLeads(); };
$('#stageFilter').onchange = (e) => { ui.leadStage = e.target.value; renderLeads(); };
$('#ownerFilter').onchange = (e) => { ui.leadOwner = e.target.value; renderLeads(); };
$('#newUser').onclick = () => userModal();
['actUser', 'actType', 'actEntity', 'actFrom', 'actTo'].forEach((id) => { $(`#${id}`).onchange = () => loadActivity(); });
$('#actMore').onclick = () => loadActivity(true);
$('#actExport').onclick = exportActivity;
$('#testMail').onclick = async () => {
  const button = $('#testMail');
  button.disabled = true;
  try { toast((await send('POST', '/api/settings/test-email')).message, 6000); }
  catch (error) { toast(error.message, 7000); }
  finally { button.disabled = false; }
};
$('#exportLeads').onclick = exportLeads;
$('#quoteSearch').oninput = (e) => { ui.quoteQuery = e.target.value; renderQuotes(); };
$('#clientSearch').oninput = (e) => { ui.clientQuery = e.target.value; renderClients(); };
$('#funnelRange').onchange = (e) => { ui.funnelRange = e.target.value; renderDashboard(); };
$('#globalSearch').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  navigate('leads');
  ui.leadQuery = e.target.value;
  $('#leadSearch').value = ui.leadQuery;
  renderLeads();
};
$('#multiSend').onclick = () => prepareWhatsapp([...selectedQuoteIds]);
$('#calPrev').onclick = () => { ui.calMonth -= 1; if (ui.calMonth < 1) { ui.calMonth = 12; ui.calYear -= 1; } renderCalendar(); };
$('#calNext').onclick = () => { ui.calMonth += 1; if (ui.calMonth > 12) { ui.calMonth = 1; ui.calYear += 1; } renderCalendar(); };
$('#calToday').onclick = () => { ui.calYear = 0; renderCalendar(); };
$('#saveSettings').onclick = () => mutate(() => send('PUT', '/api/settings/agency', {
  name: $('#setName').value, whatsapp: $('#setWhatsapp').value, email: $('#setEmail').value, website: $('#setWebsite').value
}), 'Configuración guardada');
$('#cancelSettings').onclick = renderSettings;

// Refresca la fecha y los datos cada 5 minutos para que el dashboard no se quede en el día anterior.
setInterval(() => { if (currentUser && !currentUser.mustChangePassword && $('#modalBg').classList.contains('hidden')) loadAll(); }, 5 * 60 * 1000);

// El enlace del correo también funciona si se pega en una pestaña donde la plataforma ya está abierta.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#reset=')) handleResetLink(); });

restoreSession();
