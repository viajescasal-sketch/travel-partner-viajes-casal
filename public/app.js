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

const db = { clients: [], leads: [], quotes: [], trips: [], followups: [], users: [], agency: {} };
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
    return `<tr class="clickable" data-lead="${l.id}"><td>${clientCell(clientById(l.client_id))}</td><td>${escapeHtml(l.destination)}${badge}</td><td>${escapeHtml(fmtRange(l.start_date, l.end_date))}</td><td><span class="status ${statusClass(l.stage)}">${escapeHtml(l.stage)}</span></td><td>${escapeHtml(l.priority)}</td>${admin ? `<td>${escapeHtml(userName(l.owner_id))}</td>` : ''}<td>${escapeHtml(fmtDue(nextFollowupFor(l.id)?.due_at))}</td></tr>`;
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
    `<article class="card"><div class="card-top"><div>${editable ? `<label class="quote-select"><input type="checkbox" data-select-quote="${x.id}" ${selectedQuoteIds.has(x.id) ? 'checked' : ''}> Seleccionar PDF</label>` : ''}<span class="status ${statusClass(x.status)}">${escapeHtml(x.status)}</span><h3>${escapeHtml(x.folio)}</h3><p>${escapeHtml(clientName(x.client_id))}</p></div>${editable ? `<div class="icon-row"><button class="icon" data-edit-quote="${x.id}" title="Editar cotización" aria-label="Editar cotización">✎</button><button class="icon" data-duplicate="${x.id}" title="Duplicar cotización" aria-label="Duplicar cotización">⧉</button></div>` : ''}</div><div class="price">${money(x.price)}</div><small>${escapeHtml(x.mode)}</small><div class="meta"><div><span>Destino</span><b>${escapeHtml(x.destination)}</b></div><div><span>Vigencia</span><b>${escapeHtml(x.valid_until ? fmtDate(x.valid_until) : 'Por definir')}</b></div></div><p><b>${escapeHtml(x.hotel)}</b></p>${editable ? `<label class="inline-select">Estado<select data-quote-status="${x.id}">${options(QUOTE_STATUSES, x.status)}</select></label>` : ''}<div class="card-actions"><button class="btn secondary small" data-pdf="${x.id}">Vista para PDF</button>${editable ? `<button class="btn primary small" data-whatsapp="${x.id}">WhatsApp</button>` : ''}</div></article>`).join('')
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

function openPrintableQuote(id) {
  const q = quoteById(id);
  if (!q) return;
  const popup = window.open('', '_blank');
  if (!popup) { toast('Permite ventanas emergentes para abrir la vista PDF'); return; }
  popup.opener = null;
  const agency = db.agency || {};
  const lead = q.lead_id ? leadById(q.lead_id) : null;
  const rows = [
    ['Cliente', clientName(q.client_id)], ['Destino', q.destination],
    ...(lead && (lead.start_date || lead.end_date) ? [['Fechas', fmtRange(lead.start_date, lead.end_date)]] : []),
    ...(lead?.travelers ? [['Viajeros', String(lead.travelers)]] : []),
    ['Hotel / paquete', q.hotel], ['Modalidad', q.mode], ['Vigencia', q.valid_until ? fmtDate(q.valid_until) : 'Por definir']
  ];
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(q.folio)}</title><style>body{font:16px Arial;color:#203342;padding:48px;max-width:800px;margin:auto}header{border-bottom:4px solid #00b8c8;padding-bottom:20px}h1{color:#073b66}dl{display:grid;grid-template-columns:180px 1fr;gap:12px}dt{font-weight:bold}.price{font-size:30px;color:#ff7959;font-weight:bold}.services{white-space:pre-line}footer{margin-top:32px;font-size:13px;color:#6c7b87}@media print{.hint{display:none}}</style></head><body><header><p>${escapeHtml((agency.name || 'Viajes Casal').toUpperCase())}</p><h1>Cotización ${escapeHtml(q.folio)}</h1></header><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}<dt>Precio</dt><dd class="price">${money(q.price)}</dd></dl>${q.services ? `<h3>Servicios incluidos</h3><p class="services">${escapeHtml(q.services)}</p>` : ''}<p>Propuesta informativa sujeta a disponibilidad y confirmación.</p><footer>${escapeHtml([agency.whatsapp, agency.email, agency.website].filter(Boolean).join(' · '))}</footer><p class="hint">Para guardar en PDF usa Ctrl+P (Cmd+P en Mac) y elige “Guardar como PDF”.</p></body></html>`);
  popup.document.close();
}

function prepareWhatsapp(ids) {
  const chosen = ids.map(quoteById).filter(Boolean);
  if (!chosen.length) { toast('Selecciona al menos una cotización'); return; }
  if (chosen.length > 3 || new Set(chosen.map((q) => q.client_id)).size !== 1) { toast('Selecciona hasta 3 cotizaciones del mismo cliente'); return; }
  const client = clientById(chosen[0].client_id);
  const lines = [
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
  const card = (t, label) => `<article class="trip-card clickable" data-trip="${t.id}"><small>${escapeHtml(label)}</small><h4>${escapeHtml(t.destination)}</h4><p>${escapeHtml(clientName(t.client_id))}</p><p>${escapeHtml(t.status)}</p></article>`;
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
function openModal(eyebrow, title, html) {
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
    ${lead ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}">Nueva cotización</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}">Programar seguimiento</button><small>Creado ${escapeHtml(fmtDate(lead.created_at))}</small></div>` : ''}
    ${deleteBlock('lead', lead?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${lead ? 'Guardar cambios' : 'Guardar lead'}</button></div></form>`;
  openModal('REGISTRO COMERCIAL', lead ? `Lead de ${client?.name || ''}` : 'Nuevo lead', html);
  bindForm(async (v) => {
    const body = clean({
      destination: v.destination, source: v.source, start_date: v.start_date || null, end_date: v.end_date || null,
      travelers: v.travelers || null, budget: v.budget || null, priority: v.priority, notes: v.notes || null
    });
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

function quoteModal(id, preset = {}) {
  if (!canWrite('quotes')) { if (id) openPrintableQuote(id); return; }
  const quote = id ? quoteById(id) : null;
  if (!quote && !db.clients.length) { toast('Primero registra un lead o un cliente'); return; }
  const clientId = quote?.client_id ?? preset.clientId ?? db.clients[0]?.id;
  const leadOptions = (cid) => options(db.leads.filter((l) => l.client_id === Number(cid)).map((l) => [l.id, `${l.destination} · ${fmtRange(l.start_date, l.end_date)} · ${l.stage}`]), quote?.lead_id ?? preset.leadId, { blank: 'Sin lead' });
  const presetLead = preset.leadId ? leadById(preset.leadId) : null;
  const html = `<form class="modal-form">
    ${field('Cliente*', `<select name="client_id" required>${options(db.clients.map((c) => [c.id, c.name]), clientId)}</select>`)}
    ${field('Lead', `<select name="lead_id">${leadOptions(clientId)}</select>`)}
    ${field('Destino*', `<input name="destination" required maxlength="120" value="${escapeHtml(quote?.destination ?? presetLead?.destination)}">`)}
    ${field('Vigencia', `<input name="valid_until" type="date" value="${escapeHtml(quote?.valid_until)}">`)}
    ${field('Hotel / paquete*', `<input name="hotel" required maxlength="200" value="${escapeHtml(quote?.hotel)}">`, true)}
    ${field('Precio final*', `<input name="price" type="number" min="0" step="1" required value="${escapeHtml(quote?.price)}">`)}
    ${field('Modalidad', `<select name="mode">${options(QUOTE_MODES, quote?.mode || 'Total')}</select>`)}
    ${quote ? field('Estado', `<select name="status">${options(QUOTE_STATUSES, quote.status)}</select>`) : ''}
    ${field('Servicios incluidos', `<textarea name="services" rows="3" maxlength="4000">${escapeHtml(quote?.services)}</textarea>`, true)}
    ${quote?.status === 'Aceptada' ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-trip-from-quote="${quote.id}">Crear viaje con esta cotización</button></div>` : ''}
    ${deleteBlock('cotización', quote?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${quote ? 'Guardar cambios' : 'Guardar cotización'}</button></div></form>`;
  openModal('PROPUESTA', quote ? `Cotización ${quote.folio}` : 'Nueva cotización', html);
  const form = bindForm(async (v) => {
    const body = clean({ client_id: Number(v.client_id), lead_id: v.lead_id ? Number(v.lead_id) : null, destination: v.destination, hotel: v.hotel, price: v.price, mode: v.mode, valid_until: v.valid_until || null, services: v.services || null });
    if (quote) return mutate(() => send('PATCH', `/api/quotes/${quote.id}`, { ...body, status: v.status }), 'Cotización actualizada');
    return mutate(() => send('POST', '/api/quotes', body), 'Cotización creada');
  });
  form.client_id.onchange = () => { form.lead_id.innerHTML = leadOptions(form.client_id.value); };
  form.lead_id.onchange = () => { const l = leadById(form.lead_id.value); if (l && !form.destination.value) form.destination.value = l.destination; };
  if (quote) bindDelete(`/api/quotes/${quote.id}`, 'Cotización eliminada');
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
  if (tab === 'integrationsPanel') loadMailStatus();
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
    <section><h4>Verificación en dos pasos ${pill(t.active, 'Activa', 'Desactivada')}</h4>${twofaSection}</section>
    <section><h4>App de autenticación</h4>${appSection}</section>
    <section><h4>Equipos recordados</h4><p>${t.trustedDevices ? `${t.trustedDevices} equipo(s) no piden código durante 30 días.` : 'Ningún equipo recordado.'}</p>${t.trustedDevices ? '<div class="row"><button class="btn secondary small" id="forgetDevices">Olvidar todos los equipos</button></div>' : ''}</section>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div></div>`);
  const on = (id, fn) => { const el = $(`#${id}`); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (error) { toast(error.message, 6000); el.disabled = false; } }; };
  on('acctChangePass', async () => voluntaryPasswordChange());
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
  if ((el = hit('[data-settings-tab]'))) { showSettingsTab(el.dataset.settingsTab); return; }
  if ((el = hit('[data-edit-user]'))) { userModal(Number(el.dataset.editUser)); return; }
  if ((el = hit('[data-reset-user]'))) { resetUserModal(Number(el.dataset.resetUser)); return; }
  if ((el = hit('[data-reset-2fa]'))) {
    const id = Number(el.dataset.reset2fa);
    send('POST', `/api/users/${id}/reset-2fa`).then((r) => { toast(r.message, 6000); loadUsers(); }).catch((error) => toast(error.message));
    return;
  }
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
