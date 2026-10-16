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
const ui = { leadQuery: '', leadStage: '', leadOwner: '', settingsTab: 'agencyPanel', quoteQuery: '', clientQuery: '', funnelRange: 'month', calDay: '', calView: (() => { const fallback = window.innerWidth < 800 ? 'day' : 'week'; try { const v = localStorage.getItem('tp.calView'); return ['day', 'week', 'month'].includes(v) ? v : fallback; } catch { return fallback; } })(), calOwner: '' };
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
// TP-106: horas laborales (Cancún) para el primer contacto de un lead.
function addWorkMinutesLocal(start, minutes, { workStart = '09:00', workEnd = '20:00' } = {}) {
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const open = toMin(workStart), closeAt = toMin(workEnd);
  let ms = Date.parse(`${String(start).slice(0, 19).replace(' ', 'T')}Z`);
  if (closeAt <= open) return new Date(ms + minutes * 60000).toISOString().slice(0, 16).replace('T', ' ');
  let left = minutes;
  for (let guard = 0; guard < 400; guard += 1) {
    const day = Math.floor(ms / 86400000) * 86400000, now = (ms - day) / 60000;
    if (now < open) { ms = day + open * 60000; continue; }
    if (now >= closeAt) { ms = day + 86400000 + open * 60000; continue; }
    if (left <= closeAt - now) { ms += left * 60000; break; }
    left -= closeAt - now; ms = day + 86400000 + open * 60000;
  }
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
// Estado del primer contacto: null (no aplica), { due, late } mientras falta contactar.
function contactState(l) {
  const r = db.reminders;
  if (!l || l.stage !== 'Nuevo' || l.contacted_at || !l.assigned_at || !r || r.enabled === false) return null;
  const due = addWorkMinutesLocal(l.assigned_at, Math.round(Number(r.contactHours || 2) * 60), r);
  return { due, late: Boolean(l.contact_alert_at) || due <= nowLocal().toISOString().slice(0, 16).replace('T', ' ') };
}
function contactChip(l) {
  const st = contactState(l);
  if (!st) return '';
  return st.late
    ? `<span class="contact-chip late" title="Pasó el tiempo para el primer contacto">⚠ Sin contacto</span>`
    : `<span class="contact-chip" title="Tiempo para el primer contacto (horario laboral)">⏰ Contactar antes de ${escapeHtml(fmtDue(`${st.due}:00`).replace(/^Hoy, /, ''))}</span>`;
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
  if (!response.ok) { const error = new Error(payload.error || 'No se pudo completar la solicitud'); error.status = response.status; error.payload = payload; throw error; }
  return payload;
}
const send = (method, url, body) => api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

async function loadAll() {
  try {
    const data = await api('/api/crm');
    for (const key of ['clients', 'leads', 'quotes', 'trips', 'followups', 'users', 'suppliers']) db[key] = data[key] || [];
    db.agency = data.settings?.agency || {};
    db.documents = data.settings?.documents || {};
    db.leadQuestions = data.settings?.leadQuestions || [];
    db.reminders = data.settings?.reminders || null;
    db.payments = data.settings?.payments || null;
    db.me = data.me || null;
    db.goals = data.goals || { base: 'venta', sellers: {} }; // TP-206
    db.customFields = data.settings?.customFields || { leads: [], clients: [], trips: [] }; // TP-306
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
  if (typeof renderCampaigns === 'function') renderCampaigns(); // TP-310
  if (typeof renderReservas === 'function') renderReservas(); // TP-304/305
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

  if (typeof renderGoalPanel === 'function') renderGoalPanel(); // TP-206
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
function filteredLeads(ignoreStage = false) {
  const q = ui.leadQuery.toLowerCase();
  return db.leads.filter((l) => {
    if (!ignoreStage && ui.leadStage && l.stage !== ui.leadStage) return false;
    if (ui.leadOwner && String(l.owner_id) !== ui.leadOwner) return false;
    if (!q) return true;
    const c = clientById(l.client_id);
    return [c?.name, c?.phone, c?.email, l.destination, l.stage, l.notes, l.source, ...Object.values(l.custom || {}).flat()].join(' ').toLowerCase().includes(q);
  });
}
function renderLeads() {
  const admin = isAdmin();
  const filter = $('#ownerFilter');
  filter.classList.toggle('hidden', !admin);
  if (admin) filter.innerHTML = options(sellers().map((u) => [u.id, u.name]), ui.leadOwner, { blank: 'Todos los vendedores' });
  const board = leadView() === 'board';
  document.querySelectorAll('[data-lead-view]').forEach((b) => { b.classList.toggle('active', (b.dataset.leadView === 'board') === board); b.setAttribute('aria-selected', String((b.dataset.leadView === 'board') === board)); });
  $('#leadBoard').classList.toggle('hidden', !board);
  $('#leadListPanel').classList.toggle('hidden', board);
  $('#stageFilter').classList.toggle('hidden', board);
  if (board) { renderBoard(); return; }
  $('#leadHead').innerHTML = ['Lead', 'Destino', 'Fechas', 'Etapa', 'Prioridad', ...(admin ? ['Vendedor'] : []), 'Seguimiento'].map((h) => `<th>${h}</th>`).join('');
  const shared = admin ? sharedClientIds() : new Set();
  const list = filteredLeads();
  const cols = admin ? 7 : 6;
  $('#leadRows').innerHTML = list.length ? list.map((l) => {
    const badge = shared.has(l.client_id) ? '<span class="badge-shared" title="Este cliente tiene leads con más de un vendedor">Cliente compartido</span>' : '';
    return `<tr class="clickable" data-lead="${l.id}"><td>${clientCell(clientById(l.client_id))}</td><td>${escapeHtml(l.destination)}${badge}${String(l.notes || '').includes('🤖 Bot de WhatsApp') ? '<span class="bot-chip" title="Llegó por el bot de WhatsApp">🤖 Bot</span>' : ''}${String(l.notes || '').includes('🌐 Formulario web') ? '<span class="bot-chip web" title="Llegó por el formulario web">🌐 Web</span>' : ''}${qualChip(l)}${typeof customChipsHtml === 'function' ? customChipsHtml('leads', l) : ''}</td><td>${escapeHtml(fmtRange(l.start_date, l.end_date))}</td><td><span class="status ${statusClass(l.stage)}">${escapeHtml(l.stage)}</span></td><td>${escapeHtml(l.priority)}</td>${admin ? `<td>${escapeHtml(userName(l.owner_id))}</td>` : ''}<td>${escapeHtml(fmtDue(nextFollowupFor(l.id)?.due_at))}</td></tr>`;
  }).join('') : emptyRow(cols, db.leads.length ? 'Ningún lead coincide con la búsqueda.' : 'Aún no hay leads registrados.');
}
/* ---------- tablero Kanban de oportunidades (TP-103) ---------- */
const BOARD_STAGES = ['Nuevo', 'Calificado', 'Cotizado', 'Negociación', 'Vendido'];
const STAGE_LIMIT_DAYS = { Nuevo: 1, Calificado: 3, Cotizado: 5, Negociación: 7 };
const LOST_REASONS = ['Precio', 'Eligió otra agencia', 'No respondió', 'Pospuso o canceló el viaje', 'Sin disponibilidad en sus fechas', 'Otro'];
const leadView = () => { try { return localStorage.getItem('tp.leadView') || 'board'; } catch { return 'board'; } };
const setLeadView = (v) => { try { localStorage.setItem('tp.leadView', v); } catch { /* sin almacenamiento */ } };
const stampDate = (s) => new Date(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
// Días en la etapa actual (hora de Cancún).
function daysInStage(l) {
  const from = l.stage_changed_at || (CLOSED.includes(l.stage) ? l.closed_at : null) || l.created_at;
  if (!from) return 0;
  return Math.max(0, Math.floor((nowLocal() - stampDate(from)) / 86400000));
}
// Valor de la oportunidad: cotización aceptada, si no la cotización más reciente, si no el presupuesto.
function boardValue(l) {
  const quotes = db.quotes.filter((q) => q.lead_id === l.id && q.status !== 'Rechazada').sort((a, b) => b.id - a.id);
  const accepted = quotes.find((q) => q.status === 'Aceptada');
  return Number((accepted || quotes[0])?.price ?? l.budget ?? 0) || 0;
}
const thisMonth = (stamp) => String(stamp || '').slice(0, 7) === todayStr().slice(0, 7);
function boardCard(l, admin) {
  const c = clientById(l.client_id);
  const days = daysInStage(l);
  const limit = STAGE_LIMIT_DAYS[l.stage];
  const late = limit !== undefined && days > limit;
  const next = nextFollowupFor(l.id);
  const overdue = next && next.due_at.slice(0, 16) < nowLocal().toISOString().slice(0, 16).replace('T', ' ');
  const notes = String(l.notes || '');
  const chips = `${contactChip(l)}${notes.includes('🤖 Bot de WhatsApp') ? '<span class="bot-chip">🤖 Bot</span>' : ''}${notes.includes('🌐 Formulario web') ? '<span class="bot-chip web">🌐 Web</span>' : ''}${qualChip(l)}${typeof customChipsHtml === 'function' ? customChipsHtml('leads', l) : ''}`;
  const value = boardValue(l);
  const canMove = canWrite('leads');
  return `<div class="kb-card${late ? ' late' : ''}" data-lead="${l.id}"${canMove ? ' draggable="true"' : ''} tabindex="0" aria-label="${escapeHtml(`${c?.name || ''}, ${l.destination}, ${l.stage}`)}">
    <div class="kb-top"><b>${escapeHtml(c?.name || 'Sin cliente')}</b>${value ? `<span class="kb-val">${money(value)}</span>` : ''}</div>
    <div class="kb-dest">${escapeHtml(l.destination)}${l.start_date ? ` · ${escapeHtml(fmtRange(l.start_date, l.end_date))}` : ''}</div>
    ${chips ? `<div class="kb-chips">${chips}</div>` : ''}
    <div class="kb-foot"><span class="kb-days${late ? ' late' : ''}" title="${late ? `Lleva más de ${limit} ${limit === 1 ? 'día' : 'días'} en ${escapeHtml(l.stage)}` : 'Días en esta etapa'}">⏱ ${days === 0 ? 'Hoy' : `${days} ${days === 1 ? 'día' : 'días'}`}</span>
      ${next ? `<span class="kb-next${overdue ? ' late' : ''}" title="Próximo seguimiento">📅 ${escapeHtml(fmtDue(next.due_at))}</span>` : ''}
      <span class="kb-actions">${contactState(l) && canMove ? `<button type="button" class="kb-move kb-contacted" data-mark-contacted="${l.id}" title="Ya lo contacté" aria-label="Marcar como contactado">✅</button>` : ''}${admin ? `<button type="button" class="kb-owner" data-kb-owner="${l.id}" title="Vendedor: ${escapeHtml(userName(l.owner_id))} · clic para reasignar" aria-label="Reasignar (vendedor: ${escapeHtml(userName(l.owner_id))})">${escapeHtml(initials(userName(l.owner_id)))}</button>` : ''}
      ${canMove ? `<button type="button" class="kb-move" data-kb-move="${l.id}" title="Mover a otra etapa" aria-label="Mover a otra etapa">⇄</button>` : ''}</span></div>
  </div>`;
}
function renderBoard() {
  const admin = isAdmin();
  const list = filteredLeads(true);
  const cols = BOARD_STAGES.map((stage) => {
    let items = list.filter((l) => l.stage === stage);
    if (stage === 'Vendido') items = items.filter((l) => thisMonth(l.closed_at || l.stage_changed_at || l.updated_at));
    items.sort((a, b) => daysInStage(b) - daysInStage(a) || b.id - a.id);
    const total = items.reduce((s, l) => s + boardValue(l), 0);
    return `<section class="kb-col${stage === 'Vendido' ? ' won' : ''}" data-stage="${escapeHtml(stage)}">
      <div class="kb-head"><div><b>${escapeHtml(stage)}</b>${stage === 'Vendido' ? '<small>este mes</small>' : ''}<em>${items.length}</em></div><span class="kb-total">${money(total)}</span></div>
      <div class="kb-list">${items.map((l) => boardCard(l, admin)).join('') || '<p class="kb-empty">Arrastra aquí</p>'}</div>
    </section>`;
  }).join('');
  const lostMonth = list.filter((l) => l.stage === 'Perdido' && thisMonth(l.closed_at || l.stage_changed_at));
  const active = list.filter((l) => !CLOSED.includes(l.stage));
  $('#leadBoard').innerHTML = `<div class="kb-summary"><span>Oportunidades abiertas: <b>${active.length}</b> · <b>${money(active.reduce((s, l) => s + boardValue(l), 0))}</b></span><span class="muted-note">⏱ en rojo: Nuevo +1 día · Calificado +3 · Cotizado +5 · Negociación +7</span></div>
    <div class="kb-cols">${cols}</div>
    ${canWrite('leads') ? `<div class="kb-lost" data-stage="Perdido"><b>🗑 Perdido</b> Arrastra aquí un lead perdido · este mes: ${lostMonth.length} (${money(lostMonth.reduce((s, l) => s + boardValue(l), 0))})</div>` : ''}`;
}
// Cambio de etapa desde el tablero.
function moveLead(id, stage) {
  const lead = leadById(id);
  if (!lead || lead.stage === stage) return;
  if (stage === 'Vendido') { saleModal(lead); return; }
  if (stage === 'Perdido') { lostModal(lead); return; }
  mutate(() => send('PATCH', `/api/leads/${lead.id}`, { stage }), `${clientName(lead.client_id)} → ${stage}`);
}
function moveMenu(id) {
  const lead = leadById(id);
  if (!lead) return;
  openModal('MOVER LEAD', `${clientName(lead.client_id)} · ${lead.destination}`, `<div class="modal-form"><p class="full">Etapa actual: <b>${escapeHtml(lead.stage)}</b></p>
    <div class="full kb-move-opts">${[...BOARD_STAGES, 'Perdido'].map((s) => `<button type="button" class="btn ${s === lead.stage ? 'primary' : 'secondary'}" data-move-to="${escapeHtml(s)}"${s === lead.stage ? ' disabled' : ''}>${escapeHtml(s)}</button>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button></div></div>`);
  $('#modalBody').querySelectorAll('[data-move-to]').forEach((b) => { b.onclick = () => { close(); moveLead(lead.id, b.dataset.moveTo); }; });
}
// TP-207: motivo de pérdida (obligatorio) y recontacto programado.
const RECONTACT = [['', 'No programar'], ['30', 'En 1 mes'], ['90', 'En 3 meses'], ['180', 'En 6 meses'], ['365', 'En 1 año']];
const RECONTACT_BY_REASON = { 'Pospuso o canceló el viaje': '90', 'Sin disponibilidad en sus fechas': '30', Precio: '180' };
function splitLost(text) {
  const t = String(text || '');
  const reason = LOST_REASONS.find((r) => t === r || t.startsWith(`${r}:`)) || (t ? 'Otro' : '');
  const detail = reason && t.startsWith(reason) ? t.slice(reason.length).replace(/^:\s*/, '') : t;
  return { reason, detail };
}
const lostCategory = (text) => splitLost(text).reason || 'Sin motivo';
function lostFieldsHtml(lead, { hidden = false } = {}) {
  const cur = splitLost(lead?.stage === 'Perdido' ? lead.lost_reason : '');
  return `<div class="full lost-box${hidden ? ' hidden' : ''}" id="lostBox">
    <p class="lost-title">¿Por qué se perdió? <small>Obligatorio · así ves en qué estás perdiendo ventas</small></p>
    <div class="kb-reasons">${LOST_REASONS.map((r) => `<label class="kb-reason"><input type="radio" name="reason" value="${escapeHtml(r)}"${cur.reason === r ? ' checked' : ''}> ${escapeHtml(r)}</label>`).join('')}</div>
    <div class="lost-row">${field('Detalle (opcional)', `<input name="detail" maxlength="120" placeholder="Ej. eligió un paquete de otra agencia" value="${escapeHtml(cur.detail)}">`)}
    ${field('Volver a contactarlo', `<select name="recontact">${options(RECONTACT, '')}</select>`)}</div>
  </div>`;
}
function bindLostFields(root) {
  let touched = false;
  const sel = root.querySelector('[name=recontact]');
  if (!sel) return;
  sel.addEventListener('change', () => { touched = true; });
  root.querySelectorAll('[name=reason]').forEach((r) => r.addEventListener('change', () => { if (!touched) sel.value = RECONTACT_BY_REASON[r.value] || ''; }));
}
const lostReasonOf = (v) => [v.reason, String(v.detail || '').trim()].filter(Boolean).join(': ').slice(0, 160);
async function scheduleRecontact(lead, v) {
  if (!v.recontact) return;
  const due = `${addDays(todayStr(), Number(v.recontact))} 10:00`;
  await send('POST', '/api/followups', { lead_id: lead.id, type: 'WhatsApp', title: `Recontactar a ${clientName(lead.client_id)} · ${lead.destination}`.slice(0, 160), details: `Lead perdido: ${lostReasonOf(v)}. Pregúntale si ya tiene fechas o si quiere nuevas opciones.`.slice(0, 2000), due_at: due });
}
function lostModal(lead, extra = {}) {
  openModal('LEAD PERDIDO', `${clientName(lead.client_id)} · ${lead.destination}`, `<form class="modal-form">
    ${lostFieldsHtml(lead)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Marcar como perdido</button></div></form>`);
  bindLostFields($('#modalBody'));
  bindForm(async (v) => {
    if (!v.reason) { toast('Elige el motivo de pérdida'); return false; }
    const ok = await mutate(async () => {
      await send('PATCH', `/api/leads/${lead.id}`, { ...extra, stage: 'Perdido', lost_reason: lostReasonOf(v) });
      await scheduleRecontact(lead, v);
    }, `${clientName(lead.client_id)} marcado como perdido${v.recontact ? ' · recontacto programado' : ''}`);
    return ok;
  });
}
// Vendido: la venta se registra aceptando la cotización (así cuenta en Ventas y Reportes).
function saleModal(lead) {
  const quotes = db.quotes.filter((q) => q.lead_id === lead.id && q.status !== 'Rechazada').sort((a, b) => b.id - a.id);
  if (!quotes.length) {
    openModal('REGISTRAR VENTA', `${clientName(lead.client_id)} · ${lead.destination}`, `<div class="modal-form">
      <p class="full">Este lead todavía no tiene cotización. Para que la venta cuente en <b>Ventas y Reportes</b>, crea la cotización con el monto vendido y márcala como <b>Aceptada</b>.</p>
      <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="button" class="btn secondary" id="saleNoQuote">Solo marcar Vendido</button><button type="button" class="btn primary" id="saleNewQuote">Crear cotización</button></div></div>`);
    $('#saleNewQuote').onclick = () => { close(); quoteModal(null, { clientId: lead.client_id, leadId: lead.id }); };
    $('#saleNoQuote').onclick = () => { close(); mutate(() => send('PATCH', `/api/leads/${lead.id}`, { stage: 'Vendido' }), `${clientName(lead.client_id)} → Vendido (sin cotización)`); };
    return;
  }
  openModal('REGISTRAR VENTA', `${clientName(lead.client_id)} · ${lead.destination}`, `<form class="modal-form">
    <p class="full">Elige la cotización que compró el cliente. Se marcará como <b>Aceptada</b> y la venta aparecerá en Ventas y Reportes.</p>
    <div class="full kb-reasons">${quotes.map((q, i) => `<label class="kb-reason kb-quote"><input type="radio" name="quote" value="${q.id}"${(q.status === 'Aceptada' || i === 0) && !quotes.some((x, j) => j < i && x.status === 'Aceptada') ? ' checked' : ''} required> <span><b>${escapeHtml(q.folio || `#${q.id}`)}</b> · ${escapeHtml(q.hotel || q.destination)} <small>${escapeHtml(q.status)}</small></span><b class="kb-val">${money(q.price)}</b></label>`).join('')}</div>
    <label class="full kb-check"><input type="checkbox" name="trip" checked> Crear el viaje ahora (fechas y datos de la cotización)</label>
    <small class="full">¿El monto final cambió? Primero edita la cotización y luego márcala como vendida.</small>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Registrar venta</button></div></form>`);
  bindForm(async (v, form) => {
    const quoteId = Number(v.quote);
    const quote = quoteById(quoteId);
    const createTrip = form.querySelector('[name=trip]').checked && !db.trips.some((t) => t.quote_id === quoteId);
    const ok = await mutate(() => (quote.status === 'Aceptada' ? send('PATCH', `/api/leads/${lead.id}`, { stage: 'Vendido' }) : send('PATCH', `/api/quotes/${quoteId}`, { status: 'Aceptada' })), `Venta registrada: ${money(quote.price)}`);
    if (ok && createTrip) setTimeout(() => tripModal(null, { quoteId }), 50);
    return ok;
  });
}

// Arrastrar y soltar (ratón). En celular se usa el botón ⇄.
(function bindBoardDnD() {
  const boardEl = $('#leadBoard');
  if (!boardEl) return;
  let dragId = null;
  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kb-card');
    if (!card) return;
    dragId = Number(card.dataset.lead);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragId)); } catch { /* algunos navegadores */ }
  });
  boardEl.addEventListener('dragend', (e) => {
    e.target.closest?.('.kb-card')?.classList.remove('dragging');
    boardEl.querySelectorAll('.drop-over').forEach((x) => x.classList.remove('drop-over'));
    dragId = null;
  });
  boardEl.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-stage]');
    if (!zone || dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    boardEl.querySelectorAll('.drop-over').forEach((x) => { if (x !== zone) x.classList.remove('drop-over'); });
    zone.classList.add('drop-over');
  });
  boardEl.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-stage]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drop-over');
  });
  boardEl.addEventListener('drop', (e) => {
    const zone = e.target.closest('[data-stage]');
    if (!zone || dragId == null) return;
    e.preventDefault();
    zone.classList.remove('drop-over');
    const id = dragId;
    dragId = null;
    moveLead(id, zone.dataset.stage);
  });
})();

/* ---------- asignación de leads y avisos (TP-104) ---------- */
const bell = { latestId: 0, unread: 0, items: [], receivesLeads: false, available: true, timer: null, first: true };
function fmtAgo(stamp) {
  if (!stamp) return '';
  const mins = Math.max(0, Math.round((nowLocal() - stampDate(stamp)) / 60000));
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 24 * 60) return `hace ${Math.round(mins / 60)} h`;
  return fmtDate(stamp.slice(0, 10));
}
async function refreshBell() {
  if (!currentUser) return;
  try {
    const r = await api('/api/notifications');
    const fresh = bell.first ? [] : r.items.filter((i) => i.id > bell.latestId && !i.read);
    Object.assign(bell, { items: r.items, unread: r.unread, receivesLeads: r.receivesLeads, available: r.available, latestId: r.latestId, first: false });
    const count = $('#bellCount');
    count.textContent = bell.unread > 9 ? '9+' : String(bell.unread);
    count.classList.toggle('hidden', !bell.unread);
    if (!$('#bellPanel').classList.contains('hidden')) renderBellPanel();
    if (fresh.length) { toast(`🔔 ${fresh[0].title}`, 7000); loadAll(); }
  } catch { /* sin conexión: se reintenta en el siguiente ciclo */ }
}
function startBell() {
  clearInterval(bell.timer);
  Object.assign(bell, { first: true, latestId: 0 });
  refreshBell();
  bell.timer = setInterval(() => { if (!document.hidden) refreshBell(); }, 60000);
}
const BELL_ICONS = { assigned: '🎯', lead: '🎯', lead_update: '🔄', new_lead: '🆕', reminder: '⏰', contact_alert: '⏰', contact_escalation: '⚠', quote_viewed: '👀', payment: '💰', followup_overdue: '⏰', payment_due: '💳', payment_overdue: '⚠', quote_accepted: '🎉' };
function renderBellPanel() {
  const panel = $('#bellPanel');
  panel.innerHTML = `<div class="bell-head"><b>Avisos</b>${bell.unread ? '<button type="button" class="link" id="bellReadAll">Marcar todo como leído</button>' : ''}</div>
    ${bell.receivesLeads ? `<label class="bell-avail"><input type="checkbox" id="bellAvail" ${bell.available ? 'checked' : ''}> <span>Recibir leads nuevos <small>${bell.available ? 'Estás disponible en los turnos' : 'No disponible: tu turno se salta'}</small></span></label>` : ''}
    <div class="bell-tabs"><button type="button" data-bell-filter="all" class="${bell.filter === 'unread' ? '' : 'active'}">Todos</button><button type="button" data-bell-filter="unread" class="${bell.filter === 'unread' ? 'active' : ''}">Sin leer${bell.unread ? ` (${bell.unread})` : ''}</button></div>
    <div class="bell-list">${(() => { const list = bell.items.filter((n) => bell.filter !== 'unread' || !n.read); return list.length ? list.map((n) => `<button type="button" class="bell-item${n.read ? '' : ' unread'} k-${escapeHtml(n.kind || '')}" data-bell-id="${n.id}" data-bell-lead="${n.leadId || ''}" data-bell-link="${escapeHtml(n.link || '')}"><b>${/^\p{Extended_Pictographic}/u.test(n.title) ? '' : `${BELL_ICONS[n.kind] || '🔔'} `}${escapeHtml(n.title)}</b><small>${escapeHtml(n.body)}${n.body ? ' · ' : ''}${escapeHtml(fmtAgo(n.createdAt))}</small></button>`).join('') : `<p class="bell-empty">${bell.filter === 'unread' ? 'Todo leído. 👌' : 'Sin avisos por ahora.'}</p>`; })()}</div>`;
  if ($('#bellReadAll')) $('#bellReadAll').onclick = async () => { await send('POST', '/api/notifications/read', { all: true }).catch(() => {}); refreshBell(); };
  if ($('#bellAvail')) $('#bellAvail').onchange = async (e) => {
    try { await send('PUT', '/api/assignment/availability', { available: e.target.checked }); toast(e.target.checked ? 'Estás disponible para recibir leads' : 'No recibirás leads nuevos hasta que te vuelvas a activar'); refreshBell(); } catch (error) { toast(error.message); e.target.checked = !e.target.checked; }
  };
}
function toggleBell(open) {
  const panel = $('#bellPanel');
  const show = open ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !show);
  $('#bellBtn').setAttribute('aria-expanded', String(show));
  if (show) { renderBellPanel(); refreshBell(); }
}
$('#bellBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
$('#bellPanel').addEventListener('click', async (e) => {
  e.stopPropagation();
  const tab = e.target.closest('[data-bell-filter]');
  if (tab) { bell.filter = tab.dataset.bellFilter; renderBellPanel(); return; }
  const item = e.target.closest('[data-bell-id]');
  if (!item) return;
  const leadId = Number(item.dataset.bellLead);
  const [linkType, linkId] = String(item.dataset.bellLink || '').split(':');
  if (linkType === 'campaigns') { send('POST', '/api/notifications/read', { ids: [Number(item.dataset.bellId)] }).then(refreshBell).catch(() => {}); toggleBell(false); navigate('campaigns'); return; } // TP-310
  if (linkType && Number(linkId)) {
    send('POST', '/api/notifications/read', { ids: [Number(item.dataset.bellId)] }).then(refreshBell).catch(() => {});
    toggleBell(false);
    const id = Number(linkId);
    const open = () => {
      if (linkType === 'quote' && quoteById(id)) { navigate('quotes'); quoteModal(id); return true; }
      if (linkType === 'payplan' && quoteById(id)) { navigate('quotes'); payPlanModal(id); return true; }
      if (linkType === 'client' && clientById(id)) { navigate('clients'); clientFile(id); return true; }
      if (linkType === 'followup' && followupById(id)) { navigate('followups'); followupModal(id); return true; }
      if (linkType === 'trip' && tripById(id)) { navigate('trips'); tripModal(id); return true; } // TP-307
      return false;
    };
    if (!open()) { await loadAll(); if (!open()) toast('Ese registro ya no está disponible'); }
    return;
  }
  send('POST', '/api/notifications/read', { ids: [Number(item.dataset.bellId)] }).then(refreshBell).catch(() => {});
  toggleBell(false);
  if (leadId) {
    navigate('leads');
    if (leadById(leadId)) leadModal(leadId); else { await loadAll(); if (leadById(leadId)) leadModal(leadId); else toast('Ese lead ya no está asignado a ti'); }
  } else navigate('leads');
});
document.addEventListener('click', () => { if (!$('#bellPanel').classList.contains('hidden')) toggleBell(false); });

// Configuración → Asignación de leads (administrador).
async function renderAssignment() {
  const box = $('#assignmentBody');
  try {
    const st = await api('/api/assignment');
    const name = (id) => st.sellers.find((u) => u.id === id)?.name || '';
    box.innerHTML = `<div class="as-modes">
        <label class="as-mode"><input type="radio" name="asMode" value="turnos" ${st.mode === 'turnos' ? 'checked' : ''}><span><b>Por turnos</b><small>Uno y uno entre los vendedores marcados. Si alguien está “No disponible”, su turno se salta.</small></span></label>
        <label class="as-mode"><input type="radio" name="asMode" value="fijo" ${st.mode === 'fijo' ? 'checked' : ''}><span><b>Vendedor fijo</b><small>Todos los leads a una sola persona (si no está disponible, entra el turno).</small></span></label>
      </div>
      <div class="table"><table><thead><tr><th>Vendedor</th><th>Participa en turnos</th><th>Disponibilidad</th></tr></thead><tbody>
      ${st.sellers.map((u) => `<tr><td>${escapeHtml(u.name)} <small class="muted">${escapeHtml(ROLE_LABELS[u.role] || u.role)}</small></td>
        <td><label class="as-check"><input type="checkbox" data-as-part="${u.id}" ${st.participants.includes(u.id) ? 'checked' : ''}> En turnos</label></td>
        <td><button type="button" class="btn small ${st.away.includes(u.id) ? 'secondary' : 'as-on'}" data-as-avail="${u.id}" data-on="${st.away.includes(u.id) ? '0' : '1'}">${st.away.includes(u.id) ? '⏸ No disponible' : '● Disponible'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <label class="as-fixed ${st.mode === 'fijo' ? '' : 'hidden'}">Vendedor fijo <select id="asFixed">${options(st.sellers.map((u) => [u.id, u.name]), st.fixedId, { blank: 'Elige…' })}</select></label>
      <p class="as-next">${st.next ? `Siguiente lead automático: <b>${escapeHtml(st.next.name)}</b>` : '⚠ Nadie está disponible: los leads quedarán con el administrador.'}</p>
      <ul class="as-rules"><li>Si escribe un cliente que ya existe, va con <b>su vendedor de siempre</b> (si está activo y disponible).</li><li>El vendedor recibe <b>correo</b> y un aviso en la <b>campanita 🔔</b>. Cada vendedor puede pausarse desde su campanita.</li><li>Para pasar leads a otra persona usa la ficha del lead, las iniciales en la tarjeta del tablero o <b>Reasignar varios</b> en Leads.</li></ul>
      <div class="actions"><button class="btn primary" id="asSave">Guardar asignación</button></div>`;
    box.querySelectorAll('[name=asMode]').forEach((r) => { r.onchange = () => box.querySelector('.as-fixed').classList.toggle('hidden', r.value !== 'fijo' || !r.checked); });
    box.querySelectorAll('[data-as-avail]').forEach((b) => { b.onclick = async () => {
      try { await send('PUT', '/api/assignment/availability', { userId: Number(b.dataset.asAvail), available: b.dataset.on !== '1' }); renderAssignment(); refreshBell(); } catch (error) { toast(error.message); }
    }; });
    $('#asSave').onclick = async () => {
      const mode = box.querySelector('[name=asMode]:checked')?.value || 'turnos';
      const participants = [...box.querySelectorAll('[data-as-part]:checked')].map((c) => Number(c.dataset.asPart));
      const fixedId = $('#asFixed').value ? Number($('#asFixed').value) : null;
      try {
        const r = await send('PUT', '/api/assignment', { mode, participants, fixedId });
        toast(`Asignación guardada${r.next ? ` · siguiente: ${r.next.name}` : ''}`);
        renderAssignment();
      } catch (error) { toast(error.message, 6000); }
    };
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
}

// TP-106: configuración de recordatorios automáticos.
async function renderReminders() {
  const box = $('#remindersBody');
  try {
    const st = await api('/api/reminders');
    const hoursSel = (name, list, value) => `<select name="${name}">${list.map(([v, label]) => `<option value="${v}"${Number(v) === Number(value) ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
    box.innerHTML = `<form class="modal-form rem-form">
      <label class="full kb-check"><input type="checkbox" name="enabled" ${st.enabled ? 'checked' : ''}> Recordatorios activos</label>
      ${field('Cotización “Enviada” sin respuesta', hoursSel('quoteHours', [[24, '24 horas'], [48, '48 horas'], [72, '72 horas'], [96, '4 días']], st.quoteHours))}
      ${field('Lead nuevo sin contacto', hoursSel('contactHours', [[0.5, '30 minutos'], [1, '1 hora'], [2, '2 horas'], [4, '4 horas']], st.contactHours))}
      ${field('Avisar al administrador si sigue sin contacto', hoursSel('escalateHours', [[0, 'No avisar'], [1, '1 hora después'], [2, '2 horas después'], [4, '4 horas después']], st.escalateHours))}
      ${field('Avisos por correo', `<select name="email"><option value="1"${st.email ? ' selected' : ''}>Campanita y correo</option><option value="0"${st.email ? '' : ' selected'}>Solo campanita</option></select>`)}
      ${field('Horario laboral: entrada', `<input name="workStart" type="time" value="${escapeHtml(st.workStart)}" required>`)}
      ${field('Horario laboral: salida', `<input name="workEnd" type="time" value="${escapeHtml(st.workEnd)}" required>`)}
      <ul class="full as-rules">
        <li>Las horas del lead sin contacto cuentan <b>solo en horario laboral</b> (todos los días). Un lead que llega de noche se alerta la mañana siguiente.</li>
        <li>Cuenta como contactado si el lead sale de <b>Nuevo</b>, si se marca hecho un seguimiento del lead o si el vendedor toca <b>✅ Ya lo contacté</b>. Los leads que registra el propio vendedor ya cuentan como contactados.</li>
        <li>La cotización sin respuesta crea un seguimiento “Cotización” al vendedor (si no tiene ya uno pendiente) y le avisa. Si la cotización cambia de estado y se vuelve a enviar, el tiempo empieza de nuevo.</li>
      </ul>
      <p class="full as-next">Última revisión: ${st.state.lastRunAt ? `${escapeHtml(fmtDue(st.state.lastRunAt))} · ${escapeHtml(st.state.lastResult || '')}` : 'aún no corre'}${st.state.lastAlertAt ? ` · Último aviso: ${escapeHtml(fmtDue(st.state.lastAlertAt))} (${escapeHtml(st.state.lastAlert)})` : ''}</p>
      <div class="modal-actions"><button type="button" class="btn secondary" id="remRun">Revisar ahora</button><button type="submit" class="btn primary">Guardar recordatorios</button></div></form>`;
    const form = box.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try {
        await send('PUT', '/api/reminders', { enabled: Boolean(v.enabled), quoteHours: Number(v.quoteHours), contactHours: Number(v.contactHours), escalateHours: Number(v.escalateHours), email: v.email === '1', workStart: v.workStart, workEnd: v.workEnd });
        toast('Recordatorios guardados');
        await loadAll(); renderReminders();
      } catch (error) { toast(error.message, 6000); }
    };
    $('#remRun').onclick = async () => {
      try {
        const r = (await send('POST', '/api/reminders/run')).result;
        const total = r.quotes + r.contact + r.escalated + (r.payments || 0);
        toast(total ? `Se enviaron ${total} avisos` : 'Revisado: no hay pendientes');
        await loadAll(); renderReminders(); refreshBell();
      } catch (error) { toast(error.message); }
    };
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
}

// Cambiar el vendedor de un lead (administrador) desde el tablero.
function ownerModal(id) {
  const lead = leadById(id);
  if (!lead) return;
  openModal('ASIGNAR LEAD', `${clientName(lead.client_id)} · ${lead.destination}`, `<form class="modal-form">
    <p class="full">Vendedor actual: <b>${escapeHtml(userName(lead.owner_id))}</b>. El nuevo vendedor recibe un correo y un aviso en su campanita.</p>
    ${field('Asignar a', `<select name="owner_id">${options(sellers().map((u) => [u.id, u.name]), lead.owner_id)}</select>`, true)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Asignar</button></div></form>`);
  bindForm((v) => (Number(v.owner_id) === lead.owner_id ? (close(), true) : mutate(() => send('PATCH', `/api/leads/${lead.id}`, { owner_id: Number(v.owner_id) }), `Lead asignado a ${userName(Number(v.owner_id))}`)));
}
// Reasignar varios leads abiertos a la vez.
function reassignModal() {
  const open = db.leads.filter((l) => !CLOSED.includes(l.stage));
  if (!open.length) { toast('No hay leads abiertos'); return; }
  openModal('REASIGNAR LEADS', 'Pasar varios leads a otro vendedor', `<form class="modal-form">
    ${field('Leads de', `<select id="raFrom">${options(sellers().map((u) => [u.id, u.name]), '', { blank: 'Todos los vendedores' })}</select>`)}
    ${field('Asignar a', `<select name="owner_id" required>${options(sellers().map((u) => [u.id, u.name]), '', { blank: 'Elige…' })}</select>`)}
    <label class="full kb-check"><input type="checkbox" id="raAll"> Seleccionar todos</label>
    <div class="full ra-list" id="raList"></div>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary" id="raSubmit">Reasignar</button></div></form>`, { wide: true });
  const paint = () => {
    const from = $('#raFrom').value;
    const list = open.filter((l) => !from || String(l.owner_id) === from);
    $('#raList').innerHTML = list.length ? list.map((l) => `<label class="kb-reason"><input type="checkbox" name="ids" value="${l.id}"> <span><b>${escapeHtml(clientName(l.client_id))}</b> · ${escapeHtml(l.destination)} <small>${escapeHtml(l.stage)} · ${escapeHtml(userName(l.owner_id))}</small></span><b class="kb-val">${money(boardValue(l))}</b></label>`).join('') : '<p class="muted">Sin leads abiertos.</p>';
    $('#raAll').checked = false;
  };
  $('#raFrom').onchange = paint;
  $('#raAll').onchange = (e) => $('#raList').querySelectorAll('[name=ids]').forEach((c) => { c.checked = e.target.checked; });
  paint();
  bindForm((v, form) => {
    const ids = [...form.querySelectorAll('[name=ids]:checked')].map((c) => Number(c.value));
    if (!ids.length) { toast('Elige al menos un lead'); return null; }
    return mutate(() => send('POST', '/api/leads/reassign', { ids, owner_id: Number(v.owner_id) }), `${ids.length} ${ids.length === 1 ? 'lead reasignado' : 'leads reasignados'} a ${userName(Number(v.owner_id))}`);
  });
}

// Exportar a Excel o CSV: cada rol descarga solo lo que puede ver.
const EXPORT_SECTIONS = [['clients', 'Clientes'], ['leads', 'Leads'], ['quotes', 'Cotizaciones'], ['sales', 'Ventas'], ['trips', 'Viajes'], ['followups', 'Seguimientos'], ['users', 'Usuarios']];
const EXPORT_BY_ROLE = { admin: ['clients', 'leads', 'quotes', 'sales', 'trips', 'followups', 'users'], travel_partner: ['clients', 'leads', 'quotes', 'sales', 'trips', 'followups'], operaciones: ['trips', 'followups'], consulta: [] };
function exportModal(preset) {
  const allowed = EXPORT_BY_ROLE[currentUser?.role] || [];
  if (!allowed.length) { toast('Tu rol no permite exportar información'); return; }
  const chosen = preset ? [preset] : allowed.filter((k) => k !== 'users');
  const scopeNote = isAdmin() ? 'Incluye la información de todos los vendedores.' : isOps() ? 'Incluye los viajes y seguimientos que gestionas.' : 'Incluye solo tus clientes, leads y ventas.';
  openModal('EXPORTAR', 'Descargar información', `<form class="modal-form">
    <p class="full muted">${scopeNote}</p>
    <div class="full"><b class="exp-label">Secciones</b><div class="cz-svc">${EXPORT_SECTIONS.filter(([k]) => allowed.includes(k)).map(([k, label]) => `<label><input type="checkbox" name="sec" value="${k}" ${chosen.includes(k) ? 'checked' : ''}> ${label}</label>`).join('')}</div></div>
    <div class="full"><b class="exp-label">Formato</b><div class="cz-kind exp-format"><label><input type="radio" name="format" value="xlsx" checked> Excel (.xlsx) · una hoja por sección</label><label><input type="radio" name="format" value="csv"> CSV · un archivo por sección</label></div></div>
    ${field('Desde (opcional)', '<input name="from" type="date">')}
    ${field('Hasta (opcional)', '<input name="to" type="date">')}
    <p class="full muted">Las fechas filtran por fecha de registro (ventas: fecha de venta; seguimientos: fecha programada). La descarga queda registrada en la bitácora.</p>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">Descargar</button></div></form>`);
  bindForm(async (v, form) => {
    const sections = [...form.querySelectorAll('[name="sec"]:checked')].map((el) => el.value);
    if (!sections.length) { toast('Elige al menos una sección'); return false; }
    if (v.from && v.to && v.to < v.from) { toast('La fecha “hasta” no puede ser anterior a “desde”'); return false; }
    const params = new URLSearchParams({ format: v.format, sections: sections.join(',') });
    if (v.from) params.set('from', v.from);
    if (v.to) params.set('to', v.to);
    return downloadFile(`/api/export?${params}`);
  });
}
// Descarga con la sesión actual y avisa si hay error.
async function downloadFile(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401 && currentUser) showLogin();
      throw new Error(payload.error || 'No se pudo descargar');
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'descarga';
    const blobUrl = URL.createObjectURL(await response.blob());
    const a = Object.assign(document.createElement('a'), { href: blobUrl, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    toast(`Descargado: ${name}`);
    return true;
  } catch (error) { toast(error.message, 6000); return false; }
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
  renderPayDue();
  $('#quoteGrid').innerHTML = list.length ? list.map((x) =>
    `<article class="card"><div class="card-top"><div>${editable ? `<label class="quote-select"><input type="checkbox" data-select-quote="${x.id}" ${selectedQuoteIds.has(x.id) ? 'checked' : ''}> Seleccionar PDF</label>` : ''}<span class="status ${statusClass(x.status)}">${escapeHtml(x.status)}</span>${x.status === 'Enviada' && x.reminder_at ? '<span class="contact-chip late" title="Se programó un seguimiento automático">⏰ Sin respuesta</span>' : ''}${x.status === 'Aceptada' && x.acceptance?.by === 'cliente' ? `<span class="contact-chip seen" title="Aceptada por ${escapeHtml(x.acceptance.name)} el ${escapeHtml(fmtDue(x.acceptance.at))}">✅ En línea</span>` : ''}${x.viewed_at ? `<span class="contact-chip seen" title="El cliente abrió la liga ${x.view_count || 1} ${Number(x.view_count) === 1 ? 'vez' : 'veces'}">👀 Vista</span>` : ''}<h3>${escapeHtml(x.folio)}${(x.details?.proposals?.length || 0) > 1 ? `<span class="proposals-chip">${x.details.proposals.length} propuestas</span>` : ''}</h3><p>${escapeHtml(clientName(x.client_id))}</p></div>${editable ? `<div class="icon-row"><button class="icon" data-edit-quote="${x.id}" title="Editar cotización" aria-label="Editar cotización">✎</button><button class="icon" data-duplicate="${x.id}" title="Duplicar cotización" aria-label="Duplicar cotización">⧉</button></div>` : ''}</div><div class="price">${money(x.price)}</div><small>${escapeHtml(x.mode)}</small><div class="meta"><div><span>Destino</span><b>${escapeHtml(x.destination)}</b></div><div><span>Vigencia</span><b>${escapeHtml(x.valid_until ? fmtDate(x.valid_until) : 'Por definir')}</b></div></div><p><b>${escapeHtml(x.hotel)}</b></p>${editable ? `<label class="inline-select">Estado<select data-quote-status="${x.id}">${options(QUOTE_STATUSES, x.status)}</select></label>` : ''}${payStrip(x)}<div class="card-actions"><button class="btn secondary small" data-pdf="${x.id}">Ver PDF</button>${editable ? `<button class="btn secondary small" data-share-quote="${x.id}" title="Liga privada para el cliente">🔗 Liga</button><button class="btn primary small" data-whatsapp="${x.id}">WhatsApp</button>` : ''}</div></article>`).join('')
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
  if ($('#clients').classList.contains('active')) renderDuplicatesBanner();
  const q = ui.clientQuery.toLowerCase();
  const list = db.clients.filter((c) => !q || [c.name, c.phone, c.email, c.tags].join(' ').toLowerCase().includes(q));
  $('#clientGrid').innerHTML = list.length ? list.map((c) => {
    const quotes = db.quotes.filter((x) => x.client_id === c.id);
    const trips = db.trips.filter((t) => t.client_id === c.id).length;
    const value = quotes.filter((x) => x.status === 'Aceptada').reduce((s, x) => s + x.price, 0);
    const destinations = [...new Set(db.leads.filter((l) => l.client_id === c.id).map((l) => l.destination))].slice(0, 2);
    const tags = [...destinations, ...String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean)].slice(0, 5);
    return `<article class="card"><div class="card-top">${clientCell(c, c.phone || c.email || '')}<button class="icon" data-client="${c.id}" title="Ver cliente" aria-label="Ver cliente">⋮</button></div><div class="client-stats"><div><b>${quotes.length}</b><span>Cotizaciones</span></div><div><b>${trips}</b><span>Viajes</span></div><div><b>${money(value)}</b><span>Vendido</span></div></div><p>Preferencias</p><div class="tags">${tags.length ? tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('') : '<small class="muted">Sin preferencias registradas</small>'}</div><div class="card-actions"><button class="btn secondary small" data-client="${c.id}">Ficha 360</button>${canWrite('quotes') ? `<button class="btn primary small" data-quote-for="${c.id}">Cotizar</button>` : `<button class="btn primary small" data-new-trip-client="${c.id}">Nuevo viaje</button>`}</div></article>`;
  }).join('') : `<p class="empty-note">${db.clients.length ? 'Ningún cliente coincide con la búsqueda.' : 'Los clientes se crean al registrar un lead o con “+ Nuevo cliente”.'}</p>`;
}

/* ---------- viajes ---------- */
function renderTrips() {
  const today = todayStr();
  const card = (t, label) => `<article class="trip-card clickable" data-trip="${t.id}"><small>${escapeHtml(label)}</small><h4>${escapeHtml(t.destination)}</h4><p>${escapeHtml(clientName(t.client_id))}</p><p>${escapeHtml(t.status)}${t.confirmation ? ' · ✓ Confirmación' : ''}</p>${tripBadges(t)}${tripBookingBadge(t)}${typeof customChipsHtml === 'function' ? customChipsHtml('trips', t) : ''}</article>`;
  const open = db.trips.filter((t) => t.status !== 'Cerrado');
  const upcoming = open.filter((t) => t.start_date > today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const active = open.filter((t) => t.start_date <= today && t.end_date >= today);
  const past = open.filter((t) => t.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const empty = (text) => `<p class="empty-note">${text}</p>`;
  $('#upcoming').innerHTML = upcoming.map((t) => card(t, fmtDate(t.start_date).toUpperCase())).join('') || empty('Sin salidas próximas.');
  $('#activeTrips').innerHTML = active.map((t) => card(t, t.start_date === today ? 'SALE HOY' : `REGRESA ${fmtDate(t.end_date).toUpperCase()}`)).join('') || empty('Nadie está de viaje hoy.');
  $('#pastTrips').innerHTML = past.map((t) => card(t, fmtDate(t.end_date).toUpperCase())).join('') || empty('Sin viajes por cerrar.');
}

/* ---------- seguimientos: calendario día / semana / mes ---------- */
const FOLLOWUP_ICONS = { Llamada: '📞', WhatsApp: '💬', 'Cotización': '📄', Pago: '💰', Otro: '📌' };
const FOLLOWUP_CLASS = { Llamada: 'call', WhatsApp: 'wa', 'Cotización': 'quote', Pago: 'pay', Otro: 'other' };
const CAL_SLOT = 30; // minutos por renglón en día y semana
const CAL_ROW = 26; // px por renglón
const WEEKDAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const nowLocalStr = () => nowLocal().toISOString().slice(0, 16).replace('T', ' ');
const minutesOf = (dueAt) => Number(dueAt.slice(11, 13)) * 60 + Number(dueAt.slice(14, 16));
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const weekStart = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7)); // lunes
const isLateFollowup = (f) => !f.done && f.due_at.slice(0, 16) < nowLocalStr();

function calFollowups() {
  return db.followups.filter((f) => !ui.calOwner || String(f.owner_id) === String(ui.calOwner));
}
function calChip(f, { long = false } = {}) {
  const c = clientById(f.client_id);
  const drag = canWrite('followups') && !f.done;
  const cls = ['cal-ev', FOLLOWUP_CLASS[f.type] || 'other', f.done ? 'done' : '', isLateFollowup(f) ? 'late' : ''].join(' ');
  const who = c?.name && !f.title.includes(c.name) ? ` · ${c.name}` : '';
  const tip = `${f.due_at.slice(11, 16)} · ${f.type} · ${f.title}${who}${isAdmin() ? ` · ${userName(f.owner_id)}` : ''}`;
  return `<div class="${cls}" data-followup="${f.id}"${drag ? ' draggable="true"' : ''} title="${escapeHtml(tip)}" role="button" tabindex="0">
    <span class="t">${f.due_at.slice(11, 16)}</span> ${FOLLOWUP_ICONS[f.type] || '📌'} <b>${escapeHtml(long ? f.title : (c?.name || f.title))}</b>${long ? `<small>${escapeHtml([c?.name && !f.title.includes(c.name) ? c.name : '', f.details].filter(Boolean).join(' · '))}</small>` : ''}</div>`;
}

function renderCalendar() {
  if (!ui.calDay) ui.calDay = todayStr();
  const view = ui.calView;
  const today = todayStr();
  $$('[data-cal-view]').forEach((b) => b.classList.toggle('active', b.dataset.calView === view));

  // Filtro por vendedor (solo administrador)
  const ownerSel = $('#calOwner');
  ownerSel.classList.toggle('hidden', !isAdmin());
  if (isAdmin()) ownerSel.innerHTML = options(sellers().map((u) => [u.id, u.name]), ui.calOwner, { blank: 'Todo el equipo' });
  $('#calLegend').innerHTML = FOLLOWUP_TYPES.map((t) => `<span class="cal-ev-dot ${FOLLOWUP_CLASS[t]}">${FOLLOWUP_ICONS[t]} ${t}</span>`).join('') +
    `<span class="cal-ev-dot late">Vencido</span>${canWrite('followups') ? '<span class="muted-note">Arrastra un seguimiento para reprogramarlo</span>' : ''}`;

  const list = calFollowups();
  const byDay = new Map();
  list.forEach((f) => { const d = f.due_at.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(f); });
  byDay.forEach((arr) => arr.sort((a, b) => a.due_at.localeCompare(b.due_at)));

  if (view === 'month') {
    const { y, m } = parts(ui.calDay);
    $('#calTitle').textContent = `${MONTHS_LONG[m - 1]} ${y}`;
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    let day = weekStart(first);
    const cells = WEEKDAYS_SHORT.map((d) => `<div class="cal-wd">${d}</div>`);
    for (let i = 0; i < 42; i++, day = addDays(day, 1)) {
      if (i === 35 && parts(day).m !== m) break;
      const items = byDay.get(day) || [];
      const pending = items.filter((f) => !f.done).length;
      const cls = ['cal-cell', parts(day).m !== m ? 'out' : '', day === today ? 'today' : '', day === ui.calDay ? 'selected' : ''].join(' ');
      cells.push(`<div class="${cls}" data-day="${day}" data-drop-day="${day}" tabindex="0" aria-label="${parts(day).d} de ${MONTHS_LONG[parts(day).m - 1]}: ${pending} pendientes">
        <span class="n">${parts(day).d}</span>${items.slice(0, 3).map((f) => calChip(f)).join('')}${items.length > 3 ? `<span class="more">+${items.length - 3} más</span>` : ''}</div>`);
    }
    $('#calendar').className = 'cal-month';
    $('#calendar').innerHTML = cells.join('');
  } else {
    const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(ui.calDay), i)) : [ui.calDay];
    const a = parts(days[0]), b = parts(days[days.length - 1]);
    $('#calTitle').textContent = view === 'day'
      ? `${WEEKDAYS[new Date(`${ui.calDay}T00:00:00Z`).getUTCDay()].toLowerCase().replace(/^./, (c) => c.toUpperCase())} ${a.d} de ${MONTHS_LONG[a.m - 1].toLowerCase()} ${a.y}`
      : a.m === b.m ? `${a.d}–${b.d} de ${MONTHS_LONG[a.m - 1].toLowerCase()} ${a.y}` : `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
    // Horario visible: 7:00 a 21:00, o más si hay seguimientos fuera de ese rango.
    const inRange = days.flatMap((d) => byDay.get(d) || []);
    let startMin = 7 * 60, endMin = 21 * 60;
    inRange.forEach((f) => { const mm = minutesOf(f.due_at); startMin = Math.min(startMin, Math.floor(mm / 60) * 60); endMin = Math.max(endMin, Math.ceil((mm + CAL_SLOT) / 60) * 60); });
    const rows = (endMin - startMin) / CAL_SLOT;
    const head = `<div class="cal-corner"></div>${days.map((d) => {
      const p = parts(d), dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
      const n = (byDay.get(d) || []).filter((f) => !f.done).length;
      return `<div class="cal-dayhead${d === today ? ' today' : ''}${d === ui.calDay ? ' selected' : ''}" data-day="${d}" data-drop-day="${d}" tabindex="0"><small>${WEEKDAYS_SHORT[dow]}</small><b>${p.d}</b>${n ? `<em>${n}</em>` : ''}</div>`;
    }).join('')}`;
    const gutter = Array.from({ length: rows }, (_, i) => `<div class="cal-hour" style="height:${CAL_ROW}px">${(startMin + i * CAL_SLOT) % 60 === 0 ? hhmm(startMin + i * CAL_SLOT) : ''}</div>`).join('');
    const nowMin = minutesOf(nowLocalStr());
    const cols = days.map((d) => {
      const slots = Array.from({ length: rows }, (_, i) => `<div class="cal-slot${(startMin + i * CAL_SLOT) % 60 === 0 ? ' hour' : ''}" style="height:${CAL_ROW}px" data-drop-day="${d}" data-drop-time="${hhmm(startMin + i * CAL_SLOT)}"></div>`).join('');
      // Seguimientos que se enciman (menos de 30 min de diferencia) se reparten el ancho.
      const items = byDay.get(d) || [];
      const placed = [];
      let cluster = [], clusterEnd = -1;
      const flush = () => { const lanes = []; cluster.forEach((f) => { let lane = lanes.findIndex((end) => end <= minutesOf(f.due_at)); if (lane < 0) { lane = lanes.length; lanes.push(0); } lanes[lane] = minutesOf(f.due_at) + CAL_SLOT; placed.push({ f, lane, lanesRef: lanes }); }); cluster = []; };
      items.forEach((f) => { const mm = minutesOf(f.due_at); if (mm >= clusterEnd) flush(); cluster.push(f); clusterEnd = Math.max(clusterEnd, mm + CAL_SLOT); });
      flush();
      const events = placed.map(({ f, lane, lanesRef }) => {
        const top = ((minutesOf(f.due_at) - startMin) / CAL_SLOT) * CAL_ROW;
        const w = 100 / lanesRef.length;
        const compact = view === 'week' && lanesRef.length > 1;
        return `<div class="cal-place${compact ? ' compact' : ''}" style="top:${top}px;height:${CAL_ROW - 2}px;left:calc(${lane * w}% + 2px);width:calc(${w}% - 4px)">${calChip(f, { long: view === 'day' })}</div>`;
      }).join('');
      const nowLine = d === today && nowMin >= startMin && nowMin <= endMin ? `<div class="cal-now" style="top:${((nowMin - startMin) / CAL_SLOT) * CAL_ROW}px"></div>` : '';
      return `<div class="cal-col${d === today ? ' today' : ''}">${slots}${events}${nowLine}</div>`;
    }).join('');
    $('#calendar').className = `cal-grid ${view}`;
    $('#calendar').innerHTML = `<div class="cal-head" style="--days:${days.length}">${head}</div>
      <div class="cal-body" style="--days:${days.length}"><div class="cal-gutter">${gutter}</div>${cols}</div>`;
    const body = $('#calendar .cal-body');
    const target = Math.max(0, ((8 * 60 - startMin) / CAL_SLOT) * CAL_ROW);
    if (!body.dataset.scrolled) { body.scrollTop = target; body.dataset.scrolled = '1'; }
  }
  renderAgenda(list);
}

function renderAgenda(list) {
  const items = list.filter((f) => f.due_at.slice(0, 10) === ui.calDay).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const isToday = ui.calDay === todayStr();
  $('#agendaTitle').textContent = isToday ? 'Agenda de hoy' : `Agenda del ${fmtDate(ui.calDay)}`;
  const pending = items.filter((f) => !f.done).length;
  $('#agendaNote').textContent = items.length ? `${pending} pendientes de ${items.length} actividades` : 'Sin actividades programadas';
  const overdue = isToday ? list.filter((f) => !f.done && f.due_at.slice(0, 10) < ui.calDay).sort((a, b) => a.due_at.localeCompare(b.due_at)) : [];
  const row = (f, label) => `<div class="item${f.done ? ' done' : ''}"><span class="time">${escapeHtml(label)}</span><i class="dot ${FOLLOWUP_CLASS[f.type] || ''}"></i><div class="event-card"><label class="check"><input type="checkbox" data-done="${f.id}" ${f.done ? 'checked' : ''}${canWrite('followups') ? '' : ' disabled'}><span><b>${FOLLOWUP_ICONS[f.type] || ''} ${escapeHtml(f.type)} · ${escapeHtml(f.title)}</b><small>${escapeHtml([clientName(f.client_id), f.details, isAdmin() ? userName(f.owner_id) : ''].filter(Boolean).join(' · '))}</small></span></label><button class="link" data-followup="${f.id}">Abrir</button></div></div>`;
  $('#timeline').innerHTML =
    (overdue.length ? `<p class="section-label">Vencidos</p>${overdue.map((f) => row(f, fmtDate(f.due_at))).join('')}<p class="section-label">Hoy</p>` : '') +
    (items.map((f) => row(f, f.due_at.slice(11, 16))).join('') || '<p class="empty-note">Nada programado para este día.</p>');
}

function calShift(dir) {
  const v = ui.calView;
  if (v === 'day') ui.calDay = addDays(ui.calDay, dir);
  else if (v === 'week') ui.calDay = addDays(ui.calDay, dir * 7);
  else { const { y, m } = parts(ui.calDay); const d = new Date(Date.UTC(y, m - 1 + dir, 1)); ui.calDay = d.toISOString().slice(0, 10); }
  renderCalendar();
}
function setCalView(view) {
  ui.calView = view;
  try { localStorage.setItem('tp.calView', view); } catch { /* sin almacenamiento */ }
  const body = $('#calendar .cal-body'); if (body) delete body.dataset.scrolled;
  renderCalendar();
}

// Reprogramar: mueve la fecha (y la hora si se suelta en un horario) sin abrir la ficha.
async function rescheduleFollowup(id, day, time) {
  const f = followupById(id);
  if (!f || !canWrite('followups')) return;
  const next = `${day} ${time || f.due_at.slice(11, 16)}`;
  if (next === f.due_at.slice(0, 16)) return;
  ui.calDay = day;
  await mutate(() => send('PATCH', `/api/followups/${id}`, { due_at: next.replace(' ', 'T') }), `Reprogramado: ${fmtDue(`${next}:00`)}`);
}

// Liga "Agregar a Google Calendar" para un seguimiento.
function googleCalendarLink(f) {
  const c = clientById(f.client_id), lead = leadById(f.lead_id);
  const start = f.due_at.slice(0, 16).replace(/[-: ]/g, (ch) => (ch === ' ' ? 'T' : '')) + '00';
  const endDate = new Date(`${f.due_at.slice(0, 10)}T${f.due_at.slice(11, 16)}:00Z`); endDate.setUTCMinutes(endDate.getUTCMinutes() + CAL_SLOT);
  const end = endDate.toISOString().slice(0, 19).replace(/[-:]/g, '');
  const details = [`${f.type}`, c ? `Cliente: ${c.name}${c.phone ? ` · ${c.phone}` : ''}` : '', lead ? `Lead: ${lead.destination} · ${lead.stage}` : '', f.details || '', `CRM: ${location.origin}`].filter(Boolean).join('\n');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: `${FOLLOWUP_ICONS[f.type] || ''} ${f.title}`.trim(), dates: `${start}/${end}`, ctz: 'America/Cancun', details });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

async function googleCalendarModal() {
  let url = '';
  try { url = (await api('/api/calendar/feed')).url; } catch (error) { toast(error.message); return; }
  const html = `<div class="gcal">
    <p>Agrega tus seguimientos a <b>Google Calendar</b> una sola vez y se actualizarán solos. Verás ahí los seguimientos que tienes asignados, con aviso 10 minutos antes.</p>
    <label class="gcal-url">Tu liga privada<span><input id="gcalUrl" readonly value="${escapeHtml(url)}"><button type="button" class="btn primary small" id="gcalCopy">Copiar</button></span></label>
    <ol>
      <li>Abre <a href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl" target="_blank" rel="noopener">Google Calendar › Agregar desde URL</a> en la computadora.</li>
      <li>Pega la liga y haz clic en <b>Agregar calendario</b>.</li>
      <li>Listo: aparecerá como “Seguimientos CRM”. En el celular se ve en la app de Google Calendar con la misma cuenta.</li>
    </ol>
    <p class="muted-note">Google revisa la liga cada pocas horas, así que un cambio puede tardar en verse allá. Para agregar uno al instante, abre el seguimiento y usa “Agregar a Google Calendar”. Lo que muevas en Google no regresa al CRM.</p>
    <p class="muted-note">La liga es personal: no la compartas. Si alguien más la tiene, genera una nueva (la anterior deja de funcionar y tendrás que volver a agregarla).</p>
    <div class="modal-actions"><button type="button" class="btn secondary small" id="gcalReset">Generar liga nueva</button><button type="button" class="btn primary close">Listo</button></div>
  </div>`;
  openModal('PRODUCTIVIDAD', 'Conectar con Google Calendar', html);
  $('#gcalCopy').onclick = async () => {
    const input = $('#gcalUrl');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    toast('Liga copiada');
  };
  $('#gcalReset').onclick = async () => {
    if (!confirm('¿Generar una liga nueva? La anterior dejará de funcionar y tendrás que agregarla otra vez en Google Calendar.')) return;
    try { $('#gcalUrl').value = (await send('POST', '/api/calendar/feed/reset')).url; toast('Liga nueva generada'); } catch (error) { toast(error.message); }
  };
}

// Arrastrar y soltar en el calendario.
document.addEventListener('dragstart', (e) => {
  const ev = e.target.closest?.('.cal-ev[draggable="true"]');
  if (!ev) return;
  e.dataTransfer.setData('text/plain', ev.dataset.followup);
  e.dataTransfer.effectAllowed = 'move';
  // Se aplica después de iniciar el arrastre: cambiar estilos dentro de dragstart puede cancelarlo en Chrome.
  setTimeout(() => { ev.classList.add('dragging'); document.body.classList.add('cal-dragging'); }, 0);
});
document.addEventListener('dragend', () => {
  $$('.cal-ev.dragging').forEach((x) => x.classList.remove('dragging'));
  $$('.drop-over').forEach((x) => x.classList.remove('drop-over'));
  document.body.classList.remove('cal-dragging');
});
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('text/plain') || !document.querySelector('.cal-ev.dragging, body.cal-dragging')) return;
  const target = e.target.closest?.('[data-drop-day]');
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!target.classList.contains('drop-over')) { $$('.drop-over').forEach((x) => x.classList.remove('drop-over')); target.classList.add('drop-over'); }
});
document.addEventListener('drop', (e) => {
  if (!document.body.classList.contains('cal-dragging')) return;
  const target = e.target.closest?.('[data-drop-day]');
  if (!target) return;
  e.preventDefault();
  const id = Number(e.dataTransfer.getData('text/plain'));
  document.body.classList.remove('cal-dragging');
  $$('.drop-over').forEach((x) => x.classList.remove('drop-over'));
  if (id) rescheduleFollowup(id, target.dataset.dropDay, target.dataset.dropTime);
});

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
  renderLostReport();
  if (typeof renderPostventaReport === 'function') renderPostventaReport(); // TP-308/309
  if (typeof renderPerformance === 'function') renderPerformance(); // TP-311
  if (typeof renderSellerCommissions === 'function') renderSellerCommissions(); // TP-206
  $('#sourceLegend').innerHTML = counts.length ? counts.map(([s, n], i) => `<p><i class="swatch" style="background:${SOURCE_COLORS[i % SOURCE_COLORS.length]}"></i>${escapeHtml(s)} ${Math.round((n / total) * 100)}%</p>`).join('') : '<p>Sin leads todavía</p>';
}

// TP-207: reporte de motivos de pérdida
function renderLostReport() {
  const box = $('#lostReport');
  if (!box) return;
  const range = $('#lostRange').value;
  const from = range === 'all' ? '' : addDays(todayStr(), -Number(range));
  const lost = db.leads.filter((l) => l.stage === 'Perdido' && String(l.closed_at || l.updated_at || '').slice(0, 10) >= from);
  const won = db.leads.filter((l) => l.stage === 'Vendido' && String(l.closed_at || '').slice(0, 10) >= from).length;
  if (!lost.length) { box.innerHTML = '<p class="empty-note">Sin leads perdidos en este periodo. 🙌</p>'; return; }
  const value = (l) => Number(boardValue(l)) || 0;
  const group = (keyFn) => { const m = new Map(); lost.forEach((l) => { const k = keyFn(l); const g = m.get(k) || { k, n: 0, v: 0, reasons: new Map() }; g.n += 1; g.v += value(l); const r = lostCategory(l.lost_reason); g.reasons.set(r, (g.reasons.get(r) || 0) + 1); m.set(k, g); }); return [...m.values()].sort((a, b) => b.n - a.n); };
  const byReason = group((l) => lostCategory(l.lost_reason));
  const max = byReason[0].n;
  const top = (g) => [...g.reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  const totalV = lost.reduce((s2, l) => s2 + value(l), 0);
  const table = (title, rows) => `<div class="lost-table"><b>${title}</b>${rows.map((g) => { const t = top(g); return `<div><span>${escapeHtml(g.k)}</span><span>${g.n} · ${money(g.v)}</span><small>Más común: ${escapeHtml(t[0])} (${t[1]})</small></div>`; }).join('')}</div>`;
  box.innerHTML = `<div class="lost-kpis"><div><b>${lost.length}</b><span>Leads perdidos</span></div><div><b>${money(totalV)}</b><span>Valor perdido</span></div><div><b>${won + lost.length ? Math.round((lost.length / (won + lost.length)) * 100) : 0}%</b><span>De los leads cerrados</span></div></div>
    <div class="lost-bars">${byReason.map((g) => `<div class="lost-bar"><span>${escapeHtml(g.k)}</span><i><em style="width:${Math.max(4, Math.round((g.n / max) * 100))}%"></em></i><b>${g.n} · ${Math.round((g.n / lost.length) * 100)}%</b><small>${money(g.v)}</small></div>`).join('')}</div>
    <div class="lost-tables">${isAdmin() ? table('Por vendedor', group((l) => userName(l.owner_id) || 'Sin asignar')) : ''}${table('Por origen', group((l) => l.source || 'Otro'))}</div>
    <details class="lost-list"><summary>Ver los ${lost.length} leads</summary>${lost.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at))).map((l) => `<button type="button" class="lead-fup" data-lead="${l.id}"><span>${escapeHtml(clientName(l.client_id))} · ${escapeHtml(l.destination)}</span><small>${escapeHtml(l.lost_reason || 'Sin motivo')} · ${escapeHtml(fmtDate(String(l.closed_at || '').slice(0, 10)))}</small></button>`).join('')}</details>`;
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
  $('#modalBg .modal').classList.toggle('xwide', Boolean(opts.xwide)); // TP-302: lienzo
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

// TP-106: primer contacto en la ficha del lead.
function leadContactHtml(lead) {
  if (lead.contacted_at) return `<p class="full lead-contact ok">✅ Contactado · ${escapeHtml(fmtDate(lead.contacted_at))} ${escapeHtml(String(lead.contacted_at).slice(11, 16))}</p>`;
  const st = contactState(lead);
  if (!st && lead.stage !== 'Nuevo') return '';
  return `<div class="full lead-contact${st?.late ? ' late' : ''}"><span>${st ? (st.late ? '⚠ <b>Sin contacto:</b> ya pasó el tiempo para el primer contacto.' : `⏰ <b>Primer contacto</b> antes de ${escapeHtml(fmtDue(`${st.due}:00`))}.`) : 'Aún no se registra el primer contacto.'}</span><button type="button" class="btn primary small" data-mark-contacted="${lead.id}">✅ Ya lo contacté</button></div>`;
}
// Seguimientos del lead dentro de su ficha (pendientes primero).
function leadFollowupsHtml(lead) {
  const list = db.followups.filter((f) => f.lead_id === lead.id).sort((a, b) => Number(a.done) - Number(b.done) || (a.done ? b.due_at.localeCompare(a.due_at) : a.due_at.localeCompare(b.due_at))).slice(0, 5);
  if (!list.length) return '<p class="full lead-fups-empty">Sin seguimientos programados para este lead.</p>';
  return `<div class="full lead-fups"><b>Seguimientos</b>${list.map((f) => `<button type="button" class="lead-fup${f.done ? ' done' : ''}${isLateFollowup(f) ? ' late' : ''}" data-followup="${f.id}"><span>${FOLLOWUP_ICONS[f.type] || '📌'} ${escapeHtml(f.title)}</span><small>${f.done ? 'Hecho' : escapeHtml(fmtDue(f.due_at))}</small></button>`).join('')}</div>`;
}
function leadModal(id, presetClientId) {
  if (!canWrite('leads')) return;
  const lead = id ? leadById(id) : null;
  const client = lead ? clientById(lead.client_id) : presetClientId ? clientById(presetClientId) : null;
  const clientFields = client
    ? `<div class="full fixed-client">${clientCell(client)}<button type="button" class="link" data-client="${client.id}">Ver cliente</button></div>`
    : field('Nombre*', '<input name="name" required maxlength="120">') + field('WhatsApp*', '<input name="phone" required maxlength="40" placeholder="998 123 4567">') + field('Correo', '<input name="email" type="email" maxlength="254">') + '<p class="full dupe-warn hidden"></p>';
  const html = `<form class="modal-form">${clientFields}
    ${field('Destino*', `<input name="destination" required maxlength="120" value="${escapeHtml(lead?.destination)}">`)}
    ${field('Origen', `<select name="source">${options(SOURCES, lead?.source || 'WhatsApp')}</select>`)}
    ${field('Salida', `<input name="start_date" type="date" value="${escapeHtml(lead?.start_date)}">`)}
    ${field('Regreso', `<input name="end_date" type="date" value="${escapeHtml(lead?.end_date)}">`)}
    ${field('Viajeros', `<input name="travelers" type="number" min="1" max="500" value="${escapeHtml(lead?.travelers)}">`)}
    ${field('Presupuesto (MXN)', `<input name="budget" type="number" min="0" step="1" value="${escapeHtml(lead?.budget)}">`)}
    ${lead ? field('Etapa', `<select name="stage">${options(STAGES, lead.stage)}</select>`) : field('Primer seguimiento', '<input name="first_followup_at" type="datetime-local">')}
    ${lead ? lostFieldsHtml(lead, { hidden: lead.stage !== 'Perdido' }) : ''}
    ${isAdmin() ? field('Vendedor asignado', `<select name="owner_id">${options([...(lead ? [] : [['auto', 'Automático (según la asignación)']]), ...sellers().map((u) => [u.id, `${u.name} · ${ROLE_LABELS[u.role]}`])], lead?.owner_id ?? currentUser.id)}</select>`) : ''}
    ${field('Notas', `<textarea name="notes" rows="3" maxlength="4000">${escapeHtml(lead?.notes)}</textarea>`, true)}
    ${typeof customFieldsHtml === 'function' ? customFieldsHtml('leads', lead?.custom) : ''}
    ${lead ? autoScoreHtml(lead) : ''}
    ${qualHtml(lead)}
    ${lead ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}">Nueva cotización</button><button type="button" class="btn secondary small" data-cv-lead="${lead.id}">🧩 Armar en Canvas${lead.canvas?.blocks?.length ? ` (${lead.canvas.blocks.length})` : ''}</button><button type="button" class="btn primary small" data-wa-lead="${lead.id}">💬 Plantilla WhatsApp</button><button type="button" class="btn secondary small" data-client="${lead.client_id}">Ficha 360</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}" data-followup-type="Llamada">📞 Programar llamada</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}" data-followup-type="WhatsApp">💬 Programar WhatsApp</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}">Otro seguimiento</button><small>Creado ${escapeHtml(fmtDate(lead.created_at))}</small></div>` : ''}
    ${lead ? '<div class="full" id="leadRef"></div>' : ''}
    ${lead ? leadContactHtml(lead) : ''}
    ${lead ? leadFollowupsHtml(lead) : ''}
    ${lead ? historyButton('leads', lead.id) : ''}
    ${deleteBlock('lead', lead?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${lead ? 'Guardar cambios' : 'Guardar lead'}</button></div></form>`;
  openModal('REGISTRO COMERCIAL', lead ? `Lead de ${client?.name || ''}` : 'Nuevo lead', html);
  bindQualification();
  if (lead) {
    bindLostFields($('#modalBody'));
    const stageSel = $('#modalBody [name=stage]');
    stageSel.addEventListener('change', () => $('#lostBox').classList.toggle('hidden', stageSel.value !== 'Perdido'));
  }
  if (!client) { const f = $('#modalBody form'); f.dataset.kind = 'lead'; bindDuplicateCheck(f); }
  if (lead && typeof paintLeadReferral === 'function') paintLeadReferral(lead); // TP-309
  bindForm(async (v, form) => {
    const body = clean({
      destination: v.destination, source: v.source, start_date: v.start_date || null, end_date: v.end_date || null,
      travelers: v.travelers || null, budget: v.budget || null, notes: v.notes || null
    });
    if (db.leadQuestions.length) body.qualification = readQualification();
    if (typeof readCustomFields === 'function') { const cfv = readCustomFields('leads', form); if (cfv) body.custom = cfv; } // TP-306
    if (v.owner_id) body.owner_id = v.owner_id === 'auto' ? 'auto' : Number(v.owner_id);
    if (lead) {
      const reassigned = body.owner_id && body.owner_id !== lead.owner_id;
      if (v.stage === 'Perdido') {
        if (!v.reason) { toast('Elige el motivo de pérdida'); return false; }
        body.lost_reason = lostReasonOf(v);
        return mutate(async () => { await send('PATCH', `/api/leads/${lead.id}`, { ...body, stage: v.stage }); await scheduleRecontact(lead, v); }, lead.stage === 'Perdido' ? 'Lead actualizado' : `${clientName(lead.client_id)} marcado como perdido${v.recontact ? ' · recontacto programado' : ''}`);
      }
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
      ${i('hotel', 'Hotel', 'placeholder="Hyatt Ziva Cancún" maxlength="120" list="tpSupList"', 'span2')}
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
      ${quote?.status === 'Aceptada' ? `<div class="quick-actions"><button type="button" class="btn secondary small" data-pay-plan="${quote.id}">💳 Plan de pagos y liga</button><button type="button" class="btn secondary small" data-trip-from-quote="${quote.id}">Crear viaje con esta cotización</button></div>` : ''}
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
    if (det.canvas) out.canvas = det.canvas; // TP-302: se conserva el lienzo de origen
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
  if (id) return clientFile(id); // TP-108: ficha 360
  const c = null;
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
    ${typeof customFieldsHtml === 'function' ? customFieldsHtml('clients', c?.custom) : ''}
    <p class="full dupe-warn hidden"></p>
    </fieldset>
    ${c ? `<div class="full quick-actions">${canWrite('leads') ? `<button type="button" class="btn secondary small" data-new-lead-client="${c.id}">Nuevo lead</button>` : ''}${canWrite('quotes') ? `<button type="button" class="btn secondary small" data-quote-for="${c.id}">Nueva cotización</button>` : ''}${canWrite('trips') ? `<button type="button" class="btn secondary small" data-new-trip-client="${c.id}">Nuevo viaje</button>` : ''}</div>` : ''}
    ${history}
    ${c ? historyButton('clients', c.id) : ''}
    ${deleteBlock('cliente y todo su historial', c?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">${readonly ? 'Cerrar' : 'Cancelar'}</button>${readonly ? '' : `<button type="submit" class="btn primary">${c ? 'Guardar cambios' : 'Guardar cliente'}</button>`}</div></form>`;
  openModal('CLIENTE', c ? c.name : 'Nuevo cliente', html);
  bindForm((v, form) => {
    const body = clean({ name: v.name, phone: v.phone || null, email: v.email || null, tags: v.tags || null, notes: v.notes || null });
    if (typeof readCustomFields === 'function') { const cfv = readCustomFields('clients', form); if (cfv) body.custom = cfv; } // TP-306
    if (c) return mutate(() => send('PATCH', `/api/clients/${c.id}`, body), 'Cliente actualizado');
    // TP-111: si ya existe, avisar antes de crear otro.
    return (async () => {
      try { await send('POST', '/api/clients', body); await loadAll(); toast('Cliente creado'); return true; } catch (error) {
        if (error.status !== 409) { toast(error.message); return false; }
        const names = (error.payload?.duplicates || []).map((d) => d.name).join(', ');
        if (!confirm(`Ya existe un cliente con ese WhatsApp o correo: ${names}. ¿Crear otro de todos modos?`)) return false;
        return mutate(() => send('POST', '/api/clients', { ...body, force: true }), 'Cliente creado');
      }
    })();
  });
  bindDuplicateCheck($('#modalBody form'));
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
    ${typeof customFieldsHtml === 'function' ? customFieldsHtml('trips', t?.custom) : ''}
    ${t ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-confirmation="${t.id}">${t.confirmation ? 'Editar confirmación de servicios' : 'Preparar confirmación de servicios'}</button><button type="button" class="btn secondary small" data-res-pdf="${t.id}">Ver PDF de confirmación</button><button type="button" class="btn secondary small" data-itinerary="${t.id}">📱 Itinerario digital</button><button type="button" class="btn secondary small" data-pax-trip="${t.id}">${escapeHtml(tripPaxButtonLabel(t))}</button><button type="button" class="btn secondary small" data-cv-trip="${t.id}">🧩 Canvas</button><button type="button" class="btn secondary small" data-bk-trip="${t.id}">${escapeHtml(tripBookingLabel(t))}</button><button type="button" class="btn secondary small" data-survey-trip="${t.id}">${escapeHtml(surveyLabel(t))}</button><button type="button" class="btn secondary small" data-wa-trip="${t.id}">💬 WhatsApp</button>${t.confirmation ? '<small>✓ Confirmación lista</small>' : ''}</div>` : ''}
    ${t ? historyButton('trips', t.id) : ''}
    ${deleteBlock('viaje', t?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${t ? 'Guardar cambios' : 'Guardar viaje'}</button></div></form>`;
  openModal('OPERACIÓN', t ? `Viaje a ${t.destination}` : 'Nuevo viaje', html);
  const form = bindForm((v, f) => {
    const body = clean({ client_id: Number(v.client_id), quote_id: v.quote_id ? Number(v.quote_id) : null, destination: v.destination, start_date: v.start_date, end_date: v.end_date, status: v.status, notes: v.notes || null });
    if (typeof readCustomFields === 'function') { const cfv = readCustomFields('trips', f); if (cfv) body.custom = cfv; } // TP-306
    return t ? mutate(() => send('PATCH', `/api/trips/${t.id}`, body), 'Viaje actualizado') : mutate(() => send('POST', '/api/trips', body), 'Viaje registrado');
  });
  form.client_id.onchange = () => { form.quote_id.innerHTML = quoteOptions(form.client_id.value); };
  if (t) bindDelete(`/api/trips/${t.id}`, 'Viaje eliminado');
}

function followupModal(id, preset = {}) {
  const f = id ? followupById(id) : null;
  const lead = preset.leadId ? leadById(preset.leadId) : null;
  const clientId = f?.client_id ?? lead?.client_id ?? '';
  const type = f?.type || preset.type || 'Llamada';
  const leadOptions = (cid) => options(db.leads.filter((l) => l.client_id === Number(cid)).map((l) => [l.id, `${l.destination} · ${l.stage}`]), f?.lead_id ?? lead?.id, { blank: 'Sin lead' });
  const defaultTitle = (t, cid) => {
    const name = clientById(Number(cid))?.name || '';
    if (!name) return '';
    return { Llamada: `Llamar a ${name}`, WhatsApp: `Mensaje de WhatsApp a ${name}`, 'Cotización': `Enviar cotización a ${name}`, Pago: `Confirmar pago de ${name}` }[t] || `Seguimiento a ${name}`;
  };
  // Hora sugerida: en 1 hora (redondeada a media hora); si ya es tarde, mañana a las 10:00. Si se eligió un día futuro, ese día a las 10:00.
  const soon = Math.ceil((minutesOf(nowLocalStr()) + 60) / 30) * 30;
  const due = f ? toInputDateTime(f.due_at) : preset.due || (ui.calDay && ui.calDay > todayStr() ? `${ui.calDay}T10:00` : soon <= 20 * 60 ? `${todayStr()}T${hhmm(soon)}` : `${addDays(todayStr(), 1)}T10:00`);
  // Atajos de fecha y hora (también sirven para reprogramar desde el celular).
  const base = f ? f.due_at.slice(0, 16).replace(' ', 'T') : null;
  const nextMonday = addDays(todayStr(), 7 - ((new Date(`${todayStr()}T00:00:00Z`).getUTCDay() + 6) % 7));
  const inOneHour = (() => { const mm = Math.ceil((minutesOf(nowLocalStr()) + 60) / 30) * 30; return mm < 24 * 60 ? `${todayStr()}T${hhmm(mm)}` : `${addDays(todayStr(), 1)}T09:00`; })();
  const quick = [['En 1 hora', inOneHour], ['Hoy 17:00', `${todayStr()}T17:00`], ['Mañana 10:00', `${addDays(todayStr(), 1)}T10:00`], ['En 3 días', `${addDays(todayStr(), 3)}T10:00`], ['Lunes 10:00', `${nextMonday}T10:00`]]
    .filter(([, v], i, all) => v.replace('T', ' ') > nowLocalStr() && all.findIndex(([, w]) => w === v) === i);
  if (base) quick.push(['+1 semana', `${addDays(base.slice(0, 10), 7)}T${base.slice(11, 16)}`]);
  const client = clientById(clientId);
  const waPhone = client?.phone ? String(client.phone).replace(/\D/g, '') : '';
  const html = `<form class="modal-form">
    ${field('Tipo', `<div class="type-pick">${FOLLOWUP_TYPES.map((t) => `<label class="${FOLLOWUP_CLASS[t]}"><input type="radio" name="type" value="${escapeHtml(t)}"${t === type ? ' checked' : ''}><span>${FOLLOWUP_ICONS[t]} ${escapeHtml(t)}</span></label>`).join('')}</div>`, true)}
    ${field('Fecha y hora*', `<input name="due_at" type="datetime-local" required value="${escapeHtml(due)}">`)}
    <div class="quick-times">${quick.map(([label, value]) => `<button type="button" class="chip-btn" data-quick-due="${value}">${label}</button>`).join('')}</div>
    ${field('Actividad*', `<input name="title" required maxlength="160" value="${escapeHtml(f?.title ?? defaultTitle(type, clientId))}">`, true)}
    ${field('Cliente', `<select name="client_id">${options(db.clients.map((c) => [c.id, c.name]), clientId, { blank: 'Sin cliente' })}</select>`)}
    ${field('Lead', `<select name="lead_id">${leadOptions(clientId)}</select>`)}
    ${field('Detalles', `<textarea name="details" rows="2" maxlength="2000" placeholder="Qué vas a decir o qué falta">${escapeHtml(f?.details)}</textarea>`, true)}
    ${f ? `<label class="full check"><input type="checkbox" name="done" ${f.done ? 'checked' : ''}> Marcar como hecho</label>` : ''}
    ${f?.auto ? `<p class="full muted-note">🤖 Creado por la automatización “${escapeHtml(f.auto.rule)}”.${f.auto.template ? ' Abre la plantilla, revísala y envíala por WhatsApp.' : ''}</p>` : ''}
    ${f?.auto?.template && client?.phone ? `<div class="full"><button type="button" class="btn primary small" data-fup-template="${f.id}">💬 Abrir plantilla de WhatsApp</button></div>` : ''}
    ${f ? `<div class="full quick-actions"><a class="btn secondary small" href="${escapeHtml(googleCalendarLink(f))}" target="_blank" rel="noopener">📅 Agregar a Google Calendar</a>${waPhone ? `<a class="btn secondary small" href="https://wa.me/${waPhone}" target="_blank" rel="noopener">💬 Abrir WhatsApp</a><a class="btn secondary small" href="tel:+${waPhone}">📞 Llamar</a>` : ''}${f.lead_id ? `<button type="button" class="btn secondary small" data-lead="${f.lead_id}">Ver lead</button>` : ''}${isAdmin() ? `<small>Vendedor: ${escapeHtml(userName(f.owner_id))}</small>` : ''}</div>` : ''}
    ${deleteBlock('seguimiento', f?.id)}
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="submit" class="btn primary">${f ? 'Guardar cambios' : 'Programar'}</button></div></form>`;
  openModal('PRODUCTIVIDAD', f ? 'Editar seguimiento' : preset.type === 'Llamada' ? 'Programar llamada' : preset.type === 'WhatsApp' ? 'Programar mensaje de WhatsApp' : 'Nuevo seguimiento', html);
  const form = bindForm((v) => {
    const body = clean({ type: v.type, due_at: v.due_at, title: v.title, client_id: v.client_id ? Number(v.client_id) : null, lead_id: v.lead_id ? Number(v.lead_id) : null, details: v.details || null });
    ui.calDay = v.due_at.slice(0, 10);
    if (f) return mutate(() => send('PATCH', `/api/followups/${f.id}`, { ...body, done: v.done === 'on' }), 'Seguimiento actualizado');
    return mutate(() => send('POST', '/api/followups', body), 'Seguimiento programado');
  });
  // El título sugerido cambia con el tipo y el cliente mientras no se haya escrito uno propio.
  let autoTitle = form.title.value === defaultTitle(type, clientId);
  form.title.oninput = () => { autoTitle = false; };
  const refreshTitle = () => { if (autoTitle) form.title.value = defaultTitle(form.querySelector('[name=type]:checked')?.value, form.client_id.value); };
  form.querySelectorAll('[name=type]').forEach((r) => { r.onchange = refreshTitle; });
  form.client_id.onchange = () => { form.lead_id.innerHTML = leadOptions(form.client_id.value); refreshTitle(); };
  form.querySelectorAll('[data-quick-due]').forEach((b) => { b.onclick = () => { form.due_at.value = b.dataset.quickDue; form.querySelectorAll('[data-quick-due]').forEach((x) => x.classList.toggle('active', x === b)); }; });
  if (f) bindDelete(`/api/followups/${f.id}`, 'Seguimiento eliminado');
  // TP-307: tarea de WhatsApp creada por una automatización → abre la plantilla lista; al enviarla se marca hecha.
  const tpl = $('#modalBody [data-fup-template]');
  if (tpl) tpl.onclick = () => waModal({ clientId: f.client_id, leadId: f.lead_id || '', quoteId: f.auto.quote_id || undefined, tripId: f.auto.trip_id || undefined, templateId: f.auto.template, onSent: () => send('PATCH', `/api/followups/${f.id}`, { done: true }).then(loadAll).catch(() => {}) });
}

/* ---------- TP-107 Plantillas de WhatsApp por etapa ---------- */
const WA_STAGE_ICONS = { primer_contacto: '👋', cotizacion: '📄', seguimiento: '🔁', cierre: '🤝', postviaje: '🌴', recompra: '🎁' };
async function loadTemplates(force = false) {
  if (db.templates && !force) return db.templates;
  db.templates = await api('/api/templates');
  return db.templates;
}
const MONTHS_FULL = MONTHS_LONG.map((m) => m.toLowerCase());
function fmtLongRange(start, end) {
  if (!start) return '';
  const a = parts(start), b = end ? parts(end) : null;
  if (!b) return `${a.d} de ${MONTHS_FULL[a.m - 1]}`;
  if (a.y === b.y && a.m === b.m) return `${a.d} al ${b.d} de ${MONTHS_FULL[a.m - 1]}`;
  return `${a.d} de ${MONTHS_FULL[a.m - 1]} al ${b.d} de ${MONTHS_FULL[b.m - 1]}`;
}
function suggestedStage({ lead, trip }) {
  const today = todayStr();
  if (lead && !CLOSED.includes(lead.stage)) return { Nuevo: 'primer_contacto', Calificado: 'cotizacion', Cotizado: 'seguimiento', 'Negociación': 'cierre' }[lead.stage] || 'seguimiento';
  if (trip && trip.end_date && trip.end_date < today) return 'postviaje';
  if (trip) return 'cierre';
  return { Nuevo: 'primer_contacto', Calificado: 'cotizacion', Cotizado: 'seguimiento', 'Negociación': 'cierre', Vendido: 'cierre', Perdido: 'seguimiento' }[lead?.stage] || 'primer_contacto';
}
// TP-202: datos del siguiente pago para las plantillas.
function payVars(quote) {
  const plan = planOf(quote);
  const n = nextInst(plan);
  return { liga_pago: plan ? payUrlOf(quote) : '', concepto_pago: n ? n.label.toLowerCase() : '', monto_pago: n ? money(instLeft(n)) : '', fecha_pago: n ? fmtLongRange(n.due) : '', saldo: plan ? money(plan.balance) : '' };
}
function templateVars({ client, lead, quote, trip, extra }) {
  const first = String(client?.name || '').trim().split(/\s+/)[0] || '';
  const dates = trip ? fmtLongRange(trip.start_date, trip.end_date) : lead?.start_date ? fmtLongRange(lead.start_date, lead.end_date) : '';
  return {
    nombre: first, nombre_completo: client?.name || '', destino: trip?.destination || quote?.destination || lead?.destination || '',
    fechas: dates, viajeros: lead?.travelers ? String(lead.travelers) : '', folio: quote?.folio || '', hotel: quote?.hotel || '',
    precio: quote ? `${money(quote.price)}${quote.mode && quote.mode !== 'Total' ? ` ${quote.mode.toLowerCase()}` : ''}` : '',
    vigencia: quote?.valid_until ? fmtLongRange(quote.valid_until) : '', vendedor: String(currentUser?.name || '').trim(),
    agencia: db.agency?.name || 'Viajes Casal', liga_resenas: db.templates?.reviewLink || '', liga_cotizacion: quote ? db.shareUrls?.[quote.id] || '' : '',
    ...payVars(quote),
    liga_itinerario: trip?.share_token ? `${location.origin}/viaje/${trip.share_token}` : '',
    ...(typeof postventaVars === 'function' ? postventaVars({ client, trip }) : {}), // TP-308/309
    ...(extra || {}) // TP-310: datos de la campaña
  };
}
// Reemplaza {variable}; lo que falta queda como [variable] para que el vendedor lo complete.
function fillTemplate(body, vars) {
  const missing = new Set();
  const out = String(body || '').replace(/\{([a-z_]+)\}/g, (m, key) => {
    if (!(key in vars)) return m;
    if (vars[key]) return vars[key];
    missing.add(key);
    return `[${key.replace(/_/g, ' ')}]`;
  });
  return { text: out, missing: [...missing] };
}
const waPhone = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length === 10 ? `52${d}` : d; };

async function waModal(preset = {}) {
  let tpl;
  try { tpl = await loadTemplates(); } catch (error) { toast(error.message); return; }
  const client = clientById(preset.clientId);
  if (!client) { toast('Este registro no tiene cliente'); return; }
  const leads = db.leads.filter((l) => l.client_id === client.id).sort((a, b) => b.id - a.id);
  const quotes = db.quotes.filter((q) => q.client_id === client.id).sort((a, b) => b.id - a.id);
  const trips = db.trips.filter((t) => t.client_id === client.id).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  const state = {
    leadId: preset.leadId ?? (leads.find((l) => !CLOSED.includes(l.stage)) || leads[0])?.id ?? '',
    quoteId: preset.quoteId ?? '', tripId: preset.tripId ?? '', stage: preset.stage || '', templateId: ''
  };
  if (!state.quoteId) state.quoteId = (quotes.find((q) => q.lead_id === Number(state.leadId) && q.status !== 'Rechazada') || quotes.find((q) => q.status !== 'Rechazada'))?.id ?? '';
  // Viaje sugerido: el de la cotización elegida; si no hay lead abierto, el más reciente (para postviaje).
  if (!state.tripId && preset.tripId === undefined) {
    const openLead = leads.some((l) => !CLOSED.includes(l.stage));
    state.tripId = (trips.find((t) => state.quoteId && t.quote_id === Number(state.quoteId)) || (!openLead ? trips.find((t) => t.end_date >= addDays(todayStr(), -60)) : null))?.id ?? '';
  }
  const current = () => ({ client, lead: leadById(state.leadId), quote: quoteById(state.quoteId), trip: tripById(state.tripId), extra: preset.vars || null });
  if (!state.stage && preset.templateId) state.stage = tpl.templates.find((t) => t.id === preset.templateId)?.stage || ''; // TP-307
  if (!state.stage) state.stage = suggestedStage(current());
  const phone = waPhone(client.phone);
  const sel = (name, list, value, blank) => `<select data-wa="${name}">${options(list, value, { blank })}</select>`;
  const html = `<div class="wa-modal">
    <div class="wa-context">
      ${field('Lead', sel('leadId', leads.map((l) => [l.id, `${l.destination} · ${l.stage}`]), state.leadId, 'Sin lead'))}
      ${field('Cotización', sel('quoteId', quotes.map((q) => [q.id, `${q.folio} · ${q.hotel}`]), state.quoteId, 'Sin cotización'))}
      ${field('Viaje', sel('tripId', trips.map((t) => [t.id, `${t.destination} · ${fmtRange(t.start_date, t.end_date)}`]), state.tripId, 'Sin viaje'))}
    </div>
    <div class="wa-stages" role="tablist">${tpl.stages.map((s) => `<button type="button" role="tab" data-wa-stage="${s.id}">${WA_STAGE_ICONS[s.id] || ''} ${escapeHtml(s.label)}</button>`).join('')}</div>
    <div class="wa-body">
      <div class="wa-list" id="waList"></div>
      <div class="wa-editor">
        <textarea id="waText" rows="10" maxlength="4000" placeholder="Elige una plantilla o escribe tu mensaje"></textarea>
        <p class="wa-missing hidden" id="waMissing"></p>
        <label class="wa-mark hidden" id="waMarkWrap"><input type="checkbox" id="waMark" checked> Marcar la cotización como “Enviada”</label>
        <p class="muted-note">${phone ? `Se abrirá WhatsApp con el chat de <b>${escapeHtml(client.name)}</b> (${escapeHtml(client.phone)}) y el mensaje listo para enviar.` : '⚠ Este cliente no tiene WhatsApp registrado: copia el mensaje.'} Queda registrado en su ficha 360.</p>
      </div>
    </div>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="button" class="btn secondary" id="waCopy">Copiar</button><button type="button" class="btn primary" id="waSend"${phone ? '' : ' disabled'}>💬 Abrir WhatsApp</button></div>
  </div>`;
  openModal('WHATSAPP', `Mensaje para ${client.name}`, html, { wide: true });
  const text = $('#waText');
  let edited = false;
  text.oninput = () => { edited = true; paintMissing(); };
  function paintMissing() {
    const miss = [...new Set((text.value.match(/\[[a-z ]+\]/g) || []).map((m) => m.slice(1, -1)))];
    $('#waMissing').classList.toggle('hidden', !miss.length);
    $('#waMissing').textContent = miss.length ? `Completa antes de enviar: ${miss.join(', ')}` : '';
    const q = quoteById(state.quoteId);
    $('#waMarkWrap').classList.toggle('hidden', !(state.stage === 'cotizacion' && q && ['Borrador', 'PDF generado'].includes(q.status) && canWrite('quotes')));
  }
  function apply(templateId) {
    const t = tpl.templates.find((x) => x.id === templateId);
    if (!t) return;
    if (edited && text.value.trim() && !confirm('¿Reemplazar el mensaje que escribiste?')) return;
    // TP-110: la liga de la cotización se genera al usarla en el mensaje.
    if (t.body.includes('{liga_cotizacion}') && state.quoteId && !db.shareUrls[state.quoteId] && canWrite('quotes')) {
      quoteShareUrl(Number(state.quoteId)).then(() => { edited = false; apply(templateId); }).catch(() => {});
    }
    state.templateId = t.id;
    text.value = fillTemplate(t.body, templateVars(current())).text;
    edited = false;
    paintList(); paintMissing();
  }
  function paintList() {
    $$('[data-wa-stage]').forEach((b) => b.classList.toggle('active', b.dataset.waStage === state.stage));
    const list = tpl.templates.filter((t) => t.stage === state.stage);
    $('#waList').innerHTML = list.length ? list.map((t) => `<button type="button" class="wa-tpl${t.id === state.templateId ? ' active' : ''}" data-wa-tpl="${escapeHtml(t.id)}"><b>${escapeHtml(t.name)}</b><small>${escapeHtml(fillTemplate(t.body, templateVars(current())).text.slice(0, 110))}…</small></button>`).join('') : '<p class="muted-note">Sin plantillas en esta etapa.</p>';
  }
  $('#modalBody').onclick = (e) => {
    const st = e.target.closest('[data-wa-stage]');
    if (st) { state.stage = st.dataset.waStage; state.templateId = ''; paintList(); const first = tpl.templates.find((t) => t.stage === state.stage); if (first && !edited) apply(first.id); else paintMissing(); return; }
    const tb = e.target.closest('[data-wa-tpl]');
    if (tb) apply(tb.dataset.waTpl);
  };
  $('#modalBody').onchange = (e) => {
    const s = e.target.closest('[data-wa]');
    if (!s) return;
    state[s.dataset.wa] = s.value;
    if (state.templateId && !edited) { const keep = state.templateId; state.templateId = ''; apply(keep); } else paintList();
  };
  paintList();
  const first = (preset.templateId && tpl.templates.find((t) => t.id === preset.templateId && t.stage === state.stage)) || tpl.templates.find((t) => t.stage === state.stage);
  if (first) apply(first.id); else paintMissing();

  async function record(channel) {
    const t = tpl.templates.find((x) => x.id === state.templateId);
    const body = { type: 'message', body: text.value, title: t?.name || 'Mensaje libre', stage: state.stage, template: t?.id || null, channel, lead_id: state.leadId || null, quote_id: state.quoteId || null, trip_id: state.tripId || null };
    try {
      await send('POST', `/api/clients/${client.id}/events`, body);
      const q = quoteById(state.quoteId);
      if (!$('#waMarkWrap').classList.contains('hidden') && $('#waMark').checked && q) await send('PATCH', `/api/quotes/${q.id}`, { status: 'Enviada' });
      if (preset.onSent) await preset.onSent(channel); // TP-310: marca el contacto de la campaña
      await loadAll();
      toast(channel === 'whatsapp' ? 'Mensaje listo en WhatsApp · registrado en la ficha' : 'Mensaje copiado · registrado en la ficha');
    } catch (error) { toast(error.message); }
  }
  $('#waCopy').onclick = async () => {
    if (!text.value.trim()) { toast('Escribe o elige un mensaje'); return; }
    try { await navigator.clipboard.writeText(text.value); } catch { text.select(); document.execCommand('copy'); }
    await record('copiado');
  };
  $('#waSend').onclick = () => {
    if (!text.value.trim()) { toast('Escribe o elige un mensaje'); return; }
    if (/\[[a-z ]+\]/.test(text.value) && !confirm('El mensaje tiene datos sin completar entre [corchetes]. ¿Abrir WhatsApp de todos modos?')) return;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text.value)}`, '_blank', 'noopener');
    record('whatsapp').then(close);
  };
}

// Configuración › Plantillas de WhatsApp (administrador)
async function renderTemplatesSettings() {
  const box = $('#templatesBody');
  let tpl;
  try { tpl = await loadTemplates(true); } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; return; }
  let list = tpl.templates.map((t) => ({ ...t }));
  const sample = { nombre: 'Ana', nombre_completo: 'Ana López', destino: 'Cancún', fechas: '10 al 14 de diciembre', viajeros: '2', folio: 'COT-2026-0012', hotel: 'Riu Palace Peninsula', precio: '$45,000', vigencia: '20 de octubre', vendedor: currentUser?.name || 'Paulina', agencia: db.agency?.name || 'Viajes Casal', liga_resenas: tpl.reviewLink || '[liga de reseñas]' };
  let lastFocus = null;
  const paint = () => {
    box.innerHTML = `<p class="muted-note">Variables (toca una para insertarla donde está el cursor): ${tpl.variables.map(([k, label]) => `<button type="button" class="chip-btn" data-var="${k}" title="${escapeHtml(label)}">{${k}}</button>`).join(' ')}</p>
      <label class="tpl-link">Liga para reseñas (Google, TripAdvisor…)<input id="tplReview" placeholder="https://g.page/r/…/review" value="${escapeHtml(tpl.reviewLink || '')}"></label>
      ${tpl.stages.map((s) => `<section class="tpl-stage"><h4>${WA_STAGE_ICONS[s.id] || ''} ${escapeHtml(s.label)}</h4>
        ${list.map((t, i) => (t.stage === s.id ? `<div class="tpl-card"><div class="tpl-row"><input data-tpl-name="${i}" maxlength="60" value="${escapeHtml(t.name)}" aria-label="Nombre de la plantilla"><button type="button" class="link danger-link" data-tpl-del="${i}">Eliminar</button></div>
          <textarea data-tpl-body="${i}" rows="4" maxlength="1500">${escapeHtml(t.body)}</textarea>
          <small class="tpl-preview">Vista previa: ${escapeHtml(fillTemplate(t.body, sample).text)}</small></div>` : '')).join('')}
        <button type="button" class="btn secondary small" data-tpl-add="${s.id}">+ Agregar plantilla</button></section>`).join('')}
      <div class="actions"><button type="button" class="btn secondary" id="tplRestore">Restaurar plantillas originales</button><button type="button" class="btn primary" id="tplSave">Guardar plantillas</button></div>`;
  };
  paint();
  box.oninput = (e) => {
    const n = e.target.dataset.tplName, b = e.target.dataset.tplBody;
    if (n !== undefined) list[n].name = e.target.value;
    if (b !== undefined) { list[b].body = e.target.value; e.target.nextElementSibling.textContent = `Vista previa: ${fillTemplate(e.target.value, sample).text}`; }
  };
  box.onfocusin = (e) => { if (e.target.matches('[data-tpl-body]')) lastFocus = e.target; };
  box.onclick = async (e) => {
    const t = e.target;
    if (t.dataset.var && lastFocus) {
      const pos = lastFocus.selectionStart ?? lastFocus.value.length;
      lastFocus.value = `${lastFocus.value.slice(0, pos)}{${t.dataset.var}}${lastFocus.value.slice(lastFocus.selectionEnd ?? pos)}`;
      lastFocus.dispatchEvent(new Event('input', { bubbles: true }));
      lastFocus.focus();
      return;
    }
    if (t.dataset.tplAdd) { list.push({ id: '', stage: t.dataset.tplAdd, name: 'Nueva plantilla', body: 'Hola {nombre}, ' }); paint(); return; }
    if (t.dataset.tplDel !== undefined) { if (confirm(`¿Eliminar la plantilla “${list[t.dataset.tplDel].name}”?`)) { list.splice(Number(t.dataset.tplDel), 1); paint(); } return; }
    if (t.id === 'tplSave') {
      try { db.templates = { ...tpl, ...(await send('PUT', '/api/templates', { templates: list, reviewLink: $('#tplReview').value.trim() })) }; toast('Plantillas guardadas'); renderTemplatesSettings(); } catch (error) { toast(error.message, 6000); }
      return;
    }
    if (t.id === 'tplRestore') {
      if (!confirm('¿Volver a las plantillas originales? Se perderán los cambios.')) return;
      try { await send('PUT', '/api/templates', { restoreDefaults: true, reviewLink: $('#tplReview').value.trim() }); toast('Plantillas restauradas'); renderTemplatesSettings(); } catch (error) { toast(error.message); }
    }
  };
}

/* ---------- TP-108 Ficha 360 del cliente ---------- */
const PAY_METHODS = ['Transferencia', 'Depósito', 'Tarjeta', 'Efectivo', 'Liga de pago', 'Otro'];
const REVIEW_PLATFORMS = ['Google', 'TripAdvisor', 'Facebook', 'WhatsApp', 'Otro'];
const TL_FILTERS = [['all', 'Todo'], ['message', '💬 Mensajes'], ['quote', '📄 Cotizaciones'], ['payment', '💰 Pagos'], ['trip', '✈️ Viajes'], ['note', '📝 Notas'], ['review', '⭐ Reseñas'], ['lead', '🎯 Leads'], ['followup', '✓ Seguimientos']];
const moneyAt = (n) => money(n);
function buildTimeline(c, events) {
  const items = [];
  const push = (at, kind, icon, title, sub = '', attrs = '', extra = {}) => { if (at) items.push({ at: String(at).slice(0, 16), seq: items.length, kind, icon, title, sub: String(sub || '').replace(/^ · /, ''), attrs, ...extra }); };
  push(c.created_at, 'lead', '🧑', 'Cliente registrado', c.email || '');
  db.leads.filter((l) => l.client_id === c.id).forEach((l) => {
    push(l.created_at, 'lead', '🎯', `Lead: ${l.destination}`, `${l.source} · ${fmtRange(l.start_date, l.end_date)}${l.travelers ? ` · ${l.travelers} viajeros` : ''} · ${userName(l.owner_id)}`, `data-lead="${l.id}"`, { stage: l.stage });
    if (l.contacted_at && l.contacted_at.slice(0, 16) !== String(l.created_at).slice(0, 16)) push(l.contacted_at, 'lead', '✅', `Primer contacto · ${l.destination}`, '', `data-lead="${l.id}"`);
    if (l.closed_at) push(l.closed_at, 'lead', l.stage === 'Vendido' ? '🏆' : '✖', `Lead ${l.stage.toLowerCase()}: ${l.destination}`, l.lost_reason || '', `data-lead="${l.id}"`);
  });
  db.quotes.filter((q) => q.client_id === c.id).forEach((q) => {
    push(q.created_at, 'quote', '📄', `Cotización ${q.folio} creada`, `${q.hotel} · ${money(q.price)} · ${q.status}`, `data-edit-quote="${q.id}"`);
    if (q.sent_at) push(q.sent_at, 'quote', '📤', `Cotización ${q.folio} enviada`, q.destination, `data-edit-quote="${q.id}"`);
    if (q.accepted_at) push(q.accepted_at, 'quote', '🎉', `Cotización ${q.folio} aceptada`, money(q.price), `data-edit-quote="${q.id}"`);
  });
  db.trips.filter((t) => t.client_id === c.id).forEach((t) => {
    const pay = t.confirmation?.paymentStatus ? ` · ${t.confirmation.paymentStatus}` : '';
    push(`${t.start_date} 00:00`, 'trip', '✈️', `Viaje a ${t.destination}`, `${fmtRange(t.start_date, t.end_date)} · ${t.status}${pay}`, `data-trip="${t.id}"`);
    if (t.end_date && t.end_date <= todayStr()) push(`${t.end_date} 23:59`, 'trip', '🏠', `Regreso de ${t.destination}`, '', `data-trip="${t.id}"`);
  });
  db.followups.filter((f) => f.client_id === c.id && f.done).forEach((f) => push(f.due_at, 'followup', '✓', `${FOLLOWUP_ICONS[f.type] || ''} ${f.title}`, f.details || '', `data-followup="${f.id}"`));
  const icons = { message: '💬', payment: '💰', review: '⭐', note: '📝' };
  events.forEach((e) => {
    const who = e.created_by_name ? ` · ${e.created_by_name}` : '';
    const trip = e.trip_id ? tripById(e.trip_id) : null;
    if (e.type === 'message') push(e.event_at, 'message', '💬', `WhatsApp: ${e.title}`, `${e.meta?.channel === 'copiado' ? 'Copiado' : 'Abierto en WhatsApp'}${who}`, '', { body: e.body, eventId: e.id });
    else if (e.type === 'payment') push(e.event_at, 'payment', '💰', `Pago: ${e.title} · ${moneyAt(e.amount)}`, `${e.meta?.method || ''}${trip ? ` · ${trip.destination}` : ''}${who}`, '', { body: e.body, eventId: e.id });
    else if (e.type === 'review') push(e.event_at, 'review', '⭐', `${'★'.repeat(e.rating)}${'☆'.repeat(5 - e.rating)} Reseña en ${e.meta?.platform || 'Otro'}`, [trip?.destination, e.created_by_name].filter(Boolean).join(' · '), '', { body: e.body, eventId: e.id });
    else push(e.event_at, 'note', icons[e.type] || '📝', 'Nota', who.slice(3), '', { body: e.body, eventId: e.id });
  });
  return items.sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
}
function clientStats(c, events) {
  const sold = db.quotes.filter((q) => q.client_id === c.id && q.status === 'Aceptada').reduce((s, q) => s + Number(q.price || 0), 0);
  const paid = events.filter((e) => e.type === 'payment').reduce((s, e) => s + Number(e.amount || 0), 0);
  const reviews = events.filter((e) => e.type === 'review');
  const contacts = [...events.filter((e) => e.type === 'message').map((e) => e.event_at), ...db.followups.filter((f) => f.client_id === c.id && f.done).map((f) => f.due_at)].sort().reverse();
  return { sold, paid, balance: Math.max(sold - paid, 0), trips: db.trips.filter((t) => t.client_id === c.id).length, rating: reviews.length ? reviews.reduce((s, e) => s + e.rating, 0) / reviews.length : null, reviews: reviews.length, lastContact: contacts[0] || null };
}
async function clientFile(id, opts = {}) {
  const c = clientById(id);
  if (!c) return;
  const tab = opts.tab || 'timeline';
  openModal('FICHA 360', c.name, '<p class="muted">Cargando la ficha…</p>', { wide: true });
  let events = [];
  try { events = (await api(`/api/clients/${c.id}/events`)).events; } catch (error) { toast(error.message); }
  if ($('#modalTitle').textContent !== c.name) return; // el usuario ya abrió otra cosa
  const st = clientStats(c, events);
  const write = canWrite('followups');
  const upcoming = db.followups.filter((f) => f.client_id === c.id && !f.done).sort((a, b) => a.due_at.localeCompare(b.due_at)).slice(0, 3);
  const readonly = !canWrite('clients');
  let filter = 'all';
  const html = `<div class="c360">
    <div class="c360-head">${clientCell(c, [c.phone, c.email].filter(Boolean).join(' · '))}
      <div class="c360-stats"><div><b>${money(st.sold)}</b><span>Vendido</span></div><div><b>${money(st.paid)}</b><span>Pagado</span></div>${st.sold ? `<div class="${st.balance ? 'warn' : 'ok'}"><b>${money(st.balance)}</b><span>Saldo</span></div>` : ''}<div><b>${st.trips}</b><span>Viajes</span></div><div><b>${st.rating ? `${st.rating.toFixed(1)} ★` : '—'}</b><span>${st.reviews ? `${st.reviews} reseña${st.reviews === 1 ? '' : 's'}` : 'Reseñas'}</span></div><div><b>${st.lastContact ? escapeHtml(fmtDate(st.lastContact)) : '—'}</b><span>Último contacto</span></div></div>
    </div>
    <div class="c360-actions">
      ${c.phone ? `<button type="button" class="btn primary small" data-c360="wa">💬 WhatsApp</button>` : ''}
      ${write ? '<button type="button" class="btn secondary small" data-c360="payment">💰 Registrar pago</button><button type="button" class="btn secondary small" data-c360="review">⭐ Registrar reseña</button><button type="button" class="btn secondary small" data-c360="note">📝 Agregar nota</button>' : ''}
      ${canWrite('leads') ? `<button type="button" class="btn secondary small" data-new-lead-client="${c.id}">+ Lead</button>` : ''}${canWrite('quotes') ? `<button type="button" class="btn secondary small" data-quote-for="${c.id}">+ Cotización</button>` : ''}${canWrite('trips') ? `<button type="button" class="btn secondary small" data-new-trip-client="${c.id}">+ Viaje</button>` : ''}
    </div>
    <div class="c360-tabs"><button type="button" data-c360-tab="timeline">Línea de tiempo</button><button type="button" data-c360-tab="data">Datos del cliente</button></div>
    <section class="c360-pane" data-pane="timeline">
      ${c.notes || c.tags ? `<div class="c360-pinned">${c.tags ? `<div class="tags">${String(c.tags).split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}${c.notes ? `<p>📌 ${escapeHtml(c.notes)}</p>` : ''}</div>` : ''}
      ${typeof customSummaryHtml === 'function' ? customSummaryHtml('clients', c) : ''}
      ${payPlanSummaryHtml(c.id)}
      ${upcoming.length ? `<div class="c360-next"><b>Próximos pasos</b>${upcoming.map((f) => `<button type="button" class="lead-fup${isLateFollowup(f) ? ' late' : ''}" data-followup="${f.id}"><span>${FOLLOWUP_ICONS[f.type] || ''} ${escapeHtml(f.title)}</span><small>${escapeHtml(fmtDue(f.due_at))}</small></button>`).join('')}</div>` : ''}
      <div class="c360-filters">${TL_FILTERS.map(([k, label]) => `<button type="button" class="chip-btn" data-tl-filter="${k}">${label}</button>`).join('')}</div>
      <div class="c360-timeline" id="c360Timeline"></div>
    </section>
    <section class="c360-pane" data-pane="data">
      <form class="modal-form"><fieldset class="readonly"${readonly ? ' disabled' : ''}>
        ${field('Nombre*', `<input name="name" required maxlength="120" value="${escapeHtml(c.name)}">`)}
        ${field('WhatsApp', `<input name="phone" maxlength="40" value="${escapeHtml(c.phone)}">`)}
        ${field('Correo', `<input name="email" type="email" maxlength="254" value="${escapeHtml(c.email)}">`)}
        ${field('Preferencias (separadas por coma)', `<input name="tags" maxlength="255" placeholder="Pareja, Todo incluido" value="${escapeHtml(c.tags)}">`)}
        ${field('Fecha de nacimiento', `<input name="birth_date" type="date" value="${escapeHtml(c.birth_date)}">`)}
        <label class="kb-check"><input type="checkbox" name="no_marketing" ${c.no_marketing ? 'checked' : ''}> No contactar en campañas de recompra</label>
        ${field('Notas fijas del cliente', `<textarea name="notes" rows="3" maxlength="4000">${escapeHtml(c.notes)}</textarea>`, true)}
        ${typeof customFieldsHtml === 'function' ? customFieldsHtml('clients', c.custom) : ''}
        <p class="full dupe-warn hidden"></p>
        </fieldset>
        ${historyButton('clients', c.id)}
        ${deleteBlock('cliente y todo su historial', c.id)}
        <div class="modal-actions"><button type="button" class="btn secondary close">${readonly ? 'Cerrar' : 'Cancelar'}</button>${readonly ? '' : '<button type="submit" class="btn primary">Guardar cambios</button>'}</div></form>
      <div class="c360-companions" id="c360Referral"></div>
      <div class="c360-companions" id="c360Companions"></div>
    </section>
  </div>`;
  $('#modalBody').innerHTML = html;
  const paintTimeline = () => {
    const all = buildTimeline(c, events).filter((it) => filter === 'all' || it.kind === filter);
    $$('[data-tl-filter]').forEach((b) => b.classList.toggle('active', b.dataset.tlFilter === filter));
    let month = '';
    $('#c360Timeline').innerHTML = all.length ? all.map((it) => {
      const m = it.at.slice(0, 7);
      const head = m !== month ? `<p class="section-label">${MONTHS_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}</p>` : '';
      month = m;
      return `${head}<div class="tl-item ${it.kind}"><span class="tl-icon">${it.icon}</span><div class="tl-main"${it.attrs ? ` ${it.attrs} role="button" tabindex="0"` : ''}><b>${escapeHtml(it.title)}</b>${it.stage ? ` <span class="status ${statusClass(it.stage)}">${escapeHtml(it.stage)}</span>` : ''}<small>${escapeHtml(fmtDate(it.at))} ${it.at.slice(11, 16) !== '00:00' && it.at.slice(11, 16) !== '23:59' ? escapeHtml(it.at.slice(11, 16)) : ''}${it.sub ? ` · ${escapeHtml(it.sub)}` : ''}</small>${it.body ? `<p class="tl-body">${escapeHtml(it.body)}</p>` : ''}</div>${it.eventId && isAdmin() ? `<button type="button" class="link danger-link" data-del-event="${it.eventId}" title="Eliminar registro">✕</button>` : ''}</div>`;
    }).join('') : '<p class="empty-note">Sin registros en esta vista.</p>';
  };
  const showTab = (name) => { $$('[data-c360-tab]').forEach((b) => b.classList.toggle('active', b.dataset.c360Tab === name)); $$('.c360-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; }); };
  showTab(tab);
  paintTimeline();
  paintCompanions(c); // TP-303
  if (typeof paintClientReferral === 'function') paintClientReferral(c); // TP-309
  $('#modalBody').onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-c360-tab]')) { showTab(t.closest('[data-c360-tab]').dataset.c360Tab); return; }
    if (t.closest('[data-tl-filter]')) { filter = t.closest('[data-tl-filter]').dataset.tlFilter; paintTimeline(); return; }
    const del = t.closest('[data-del-event]');
    if (del) {
      e.stopPropagation();
      if (!confirm('¿Eliminar este registro de la ficha? No se puede deshacer.')) return;
      try { await send('DELETE', `/api/client-events/${del.dataset.delEvent}`); toast('Registro eliminado'); clientFile(c.id); } catch (error) { toast(error.message); }
      return;
    }
    const act = t.closest('[data-c360]');
    if (!act) return;
    const a = act.dataset.c360;
    if (a === 'wa') waModal({ clientId: c.id });
    else if (a === 'payment') eventModal(c, 'payment');
    else if (a === 'review') eventModal(c, 'review');
    else if (a === 'note') eventModal(c, 'note');
  };
  bindForm((v, form) => {
    const body = clean({ name: v.name, phone: v.phone || null, email: v.email || null, tags: v.tags || null, notes: v.notes || null, birth_date: v.birth_date || null, no_marketing: Boolean(v.no_marketing) });
    if (typeof readCustomFields === 'function') { const cfv = readCustomFields('clients', form); if (cfv) body.custom = cfv; } // TP-306
    return mutate(() => send('PATCH', `/api/clients/${c.id}`, body), 'Cliente actualizado');
  });
  const dataForm = $('#modalBody form');
  bindDuplicateCheck(dataForm, c.id);
  if (isAdmin() && (c.phone || c.email)) {
    api(`/api/clients/duplicates/check?${new URLSearchParams({ phone: c.phone || '', email: c.email || '', exclude: c.id })}`).then(({ matches }) => {
      if (!matches.length || !$('.c360-head')) return;
      $('.c360-head').insertAdjacentHTML('afterend', `<div class="dupe-warn">⚠ <b>Posible duplicado:</b> ${matches.map((m) => `${escapeHtml(m.name)} (mismo ${m.reasons.join(' y ')})`).join(', ')} <button type="button" class="btn secondary small" id="c360Dupes">Revisar y fusionar</button></div>`);
      $('#c360Dupes').onclick = duplicatesModal;
    }).catch(() => {});
  }
  bindDelete(`/api/clients/${c.id}`, 'Cliente eliminado');
}
function eventModal(c, type) {
  const trips = db.trips.filter((t) => t.client_id === c.id).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
  const quotes = db.quotes.filter((q) => q.client_id === c.id && q.status === 'Aceptada');
  const tripSel = trips.length ? field('Viaje', `<select name="trip_id">${options(trips.map((t) => [t.id, `${t.destination} · ${fmtRange(t.start_date, t.end_date)}`]), trips[0].id, { blank: 'Sin viaje' })}</select>`) : '';
  const forms = {
    payment: ['Registrar pago', `${field('Monto (MXN)*', '<input name="amount" type="number" min="1" step="0.01" required inputmode="decimal">')}
      ${field('Concepto*', `<input name="title" required maxlength="120" list="payConcepts" value="Anticipo"><datalist id="payConcepts"><option>Anticipo</option><option>Abono</option><option>Liquidación</option><option>Pago completo</option></datalist>`)}
      ${field('Forma de pago', `<select name="method">${options(PAY_METHODS, 'Transferencia')}</select>`)}
      ${field('Fecha del pago', `<input name="date" type="date" max="${todayStr()}" value="${todayStr()}">`)}
      ${tripSel}${quotes.length ? field('Cotización', `<select name="quote_id">${options(quotes.map((q) => [q.id, `${q.folio} · ${money(q.price)}`]), quotes[0].id, { blank: 'Sin cotización' })}</select>`) : ''}
      ${field('Referencia o nota', '<input name="body" maxlength="1000" placeholder="Folio de transferencia, banco…">', true)}`],
    review: ['Registrar reseña', `<div class="full stars-pick" role="radiogroup" aria-label="Calificación">${[5, 4, 3, 2, 1].map((n) => `<label><input type="radio" name="rating" value="${n}"${n === 5 ? ' checked' : ''}><span>${'★'.repeat(n)}</span></label>`).join('')}</div>
      ${field('Dónde la dejó', `<select name="platform">${options(REVIEW_PLATFORMS, 'Google')}</select>`)}${tripSel}
      ${field('Comentario del cliente', '<textarea name="body" rows="3" maxlength="2000"></textarea>', true)}`],
    note: ['Agregar nota', field('Nota*', '<textarea name="body" rows="4" maxlength="2000" required placeholder="Lo que el equipo debe saber de este cliente"></textarea>', true)]
  };
  const [title, inner] = forms[type];
  openModal('FICHA 360', `${title} · ${c.name}`, `<form class="modal-form">${inner}<div class="modal-actions"><button type="button" class="btn secondary" data-back-c360>Volver a la ficha</button><button type="submit" class="btn primary">Guardar</button></div></form>`);
  $('#modalBody [data-back-c360]').onclick = () => clientFile(c.id);
  bindForm(async (v) => {
    const body = { type, ...v };
    ['trip_id', 'quote_id'].forEach((k) => { body[k] = v[k] ? Number(v[k]) : null; });
    if (type === 'review') body.rating = Number(v.rating);
    try { await send('POST', `/api/clients/${c.id}/events`, body); toast({ payment: 'Pago registrado', review: 'Reseña registrada', note: 'Nota agregada' }[type]); await loadAll(); clientFile(c.id); return false; } catch (error) { toast(error.message); return false; }
  });
}

/* ---------- TP-109 Calificación automática ---------- */
const RESPONSE_OPTS = [['rapido', '⚡ Responde rápido'], ['tarda', '🕒 Tarda'], ['no_responde', '😶 No responde']];
function autoScoreHtml(lead) {
  const a = lead?.auto;
  if (!a) return '';
  const cls = LEVEL_CLASS[a.level] || '';
  return `<div class="full auto-score" id="autoScore">
    <div class="auto-head"><b>Calificación automática</b><span class="qual-chip ${cls}">${a.level === 'Caliente' ? '🔥 ' : ''}${a.score} · ${escapeHtml(a.level)}</span><small>Prioridad: <b>${escapeHtml(a.priority)}</b> (se calcula sola)</small></div>
    <div class="qual-bar"><i class="bar-${cls}" style="width:${a.score}%"></i></div>
    <div class="auto-parts">${a.parts.map((p) => `<div class="auto-part"><span>${escapeHtml(p.label)}</span><div class="auto-mini"><i style="width:${Math.round(p.factor * 100)}%"></i></div><b>${p.points}/${p.max}</b><small>${escapeHtml(p.detail || '')}</small></div>`).join('')}</div>
    <div class="auto-resp"><span>¿Cómo responde el cliente?</span>${RESPONSE_OPTS.map(([v, label]) => `<button type="button" class="chip-btn${lead.response === v ? ' active' : ''}" data-lead-response="${v}" data-lead-id="${lead.id}">${label}</button>`).join('')}${lead.response ? `<button type="button" class="link" data-lead-response="" data-lead-id="${lead.id}">Quitar</button>` : ''}</div>
  </div>`;
}
async function setLeadResponse(id, value) {
  const ok = await mutate(() => send('POST', `/api/leads/${id}/response`, { value: value || null }), value ? 'Respuesta del cliente registrada' : 'Respuesta quitada');
  if (ok && $('#autoScore')) leadModal(id);
}
// Configuración › Calificación: pesos del puntaje automático.
async function renderScoringSettings() {
  const box = $('#scoringBody');
  if (!box) return;
  try {
    const st = await api('/api/scoring');
    const labels = { budget: 'Presupuesto por persona', dates: 'Cercanía de fechas', group: 'Tamaño del grupo', response: 'Respuesta del cliente', questions: 'Preguntas (si se contestan)' };
    box.innerHTML = `<div class="scoring-grid">${Object.entries(labels).map(([k, label]) => `<label>${label}<span><input type="range" min="0" max="50" step="5" data-w="${k}" value="${st.weights[k]}"><b data-wv="${k}">${st.weights[k]}</b></span></label>`).join('')}</div>
      <div class="scoring-grid two"><label>🔥 Caliente desde<input type="number" id="scHot" min="2" max="100" value="${st.hot}"></label><label>Tibio desde<input type="number" id="scWarm" min="1" max="99" value="${st.warm}"></label></div>
      <p class="muted-note">Los pesos son relativos: lo que cuenta es la proporción entre ellos. Caliente = prioridad Alta, Tibio = Media, Frío = Baja. Si un lead no contestó las preguntas, su peso se reparte entre los demás.</p>
      <div class="actions"><button type="button" class="btn primary" id="scSave">Guardar puntaje</button></div>`;
    box.oninput = (e) => { if (e.target.dataset.w) box.querySelector(`[data-wv="${e.target.dataset.w}"]`).textContent = e.target.value; };
    $('#scSave').onclick = async () => {
      const weights = Object.fromEntries([...box.querySelectorAll('[data-w]')].map((i) => [i.dataset.w, Number(i.value)]));
      try { await send('PUT', '/api/scoring', { weights, hot: Number($('#scHot').value), warm: Number($('#scWarm').value) }); toast('Puntaje guardado: los leads se recalculan'); loadAll(); } catch (error) { toast(error.message, 6000); }
    };
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
}

/* ---------- TP-110 Liga de la cotización ---------- */
db.shareUrls = {};
async function quoteShareUrl(quoteId) {
  if (db.shareUrls[quoteId]) return db.shareUrls[quoteId];
  const r = await send('POST', `/api/quotes/${quoteId}/share`, {});
  db.shareUrls[quoteId] = r.url;
  return r.url;
}
async function shareModal(quoteId) {
  const q = quoteById(quoteId);
  if (!q) return;
  let r;
  try { r = await send('POST', `/api/quotes/${q.id}/share`, {}); db.shareUrls[q.id] = r.url; } catch (error) { toast(error.message); return; }
  openModal('COTIZACIÓN', `Liga para ${clientName(q.client_id)}`, `<div class="gcal">
    <p>Tu cliente ve la cotización <b>${escapeHtml(q.folio)}</b> con el mismo diseño del PDF, sin cuenta ni contraseña, puede descargarla y <b>elegir una opción y aceptarla en línea</b> (si sigue vigente). Al aceptar se arma su plan de pagos y te llega un aviso. Cuando la abra te llega un aviso en la campanita 🔔.</p>
    <label class="gcal-url">Liga privada<span><input id="shareUrl" readonly value="${escapeHtml(r.url)}"><button type="button" class="btn primary small" id="shareCopy">Copiar</button></span></label>
    <p class="muted-note">${q.viewed_at ? `👀 El cliente la ha abierto ${q.view_count || 1} ${Number(q.view_count) === 1 ? 'vez' : 'veces'} · última: ${escapeHtml(fmtDue(q.viewed_at))}` : 'Aún no la ha abierto.'} La plantilla “Envío de cotización” incluye esta liga con <b>{liga_cotizacion}</b>.</p>
    <div class="modal-actions"><button type="button" class="btn secondary small" id="shareOff">Desactivar liga</button><a class="btn secondary small" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Ver como cliente</a><button type="button" class="btn primary close">Listo</button></div></div>`);
  $('#shareCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.url); } catch { $('#shareUrl').select(); document.execCommand('copy'); } toast('Liga copiada'); };
  $('#shareOff').onclick = async () => {
    if (!confirm('¿Desactivar la liga? El cliente ya no podrá abrirla; si la vuelves a activar se genera una nueva.')) return;
    try { await send('POST', `/api/quotes/${q.id}/share`, { enabled: false }); delete db.shareUrls[q.id]; toast('Liga desactivada'); close(); } catch (error) { toast(error.message); }
  };
}

/* ---------- TP-201/202: plan de pagos y liga de pago ---------- */
const payUrlOf = (q) => (q?.pay_token ? `${location.origin}/pagar/${q.pay_token}` : '');
const planOf = (q) => (q?.status === 'Aceptada' && q.payment_plan ? q.payment_plan : null);
const nextInst = (plan) => plan?.installments?.find((i) => i.status !== 'pagado') || null;
const daysTo = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayStr()}T00:00:00Z`)) / 86400000);
const instLeft = (i) => Math.round((Number(i.amount) - Number(i.paid || 0)) * 100) / 100;
function dueText(i) {
  if (i.status === 'pagado') return 'Pagado';
  const d = daysTo(i.due);
  return d < 0 ? `venció hace ${-d} ${d === -1 ? 'día' : 'días'}` : d === 0 ? 'vence hoy' : d === 1 ? 'vence mañana' : `vence en ${d} días`;
}
function instChip(i) {
  if (i.status === 'pagado') return '<span class="pp-chip ok">Pagado ✓</span>';
  const d = daysTo(i.due);
  const cls = d < 0 ? 'late' : d <= 3 ? 'soon' : 'wait';
  return `${i.pending ? '<span class="pp-chip soon">⏳ En proceso</span>' : ''}${i.status === 'parcial' ? `<span class="pp-chip part">Abonado ${money(i.paid)}</span>` : ''}<span class="pp-chip ${cls}">${escapeHtml(dueText(i))}</span>`;
}
// Tira de cobro en la tarjeta de la cotización aceptada
function payStrip(q) {
  if (q.status !== 'Aceptada') return '';
  const plan = planOf(q);
  if (!plan) return canWrite('quotes') ? `<button type="button" class="pay-strip empty" data-pay-plan="${q.id}">💳 Armar plan de pagos y liga</button>` : '';
  const pct = plan.total ? Math.min(100, Math.round((plan.paid / plan.total) * 100)) : 0;
  const n = nextInst(plan);
  const late = n && daysTo(n.due) < 0;
  return `<button type="button" class="pay-strip${late ? ' late' : ''}" data-pay-plan="${q.id}" title="Plan de pagos"><span class="pay-bar"><i style="width:${pct}%"></i></span><span class="pay-line"><b>💳 ${money(plan.paid)}</b> de ${money(plan.total)}</span><small>${n ? `${escapeHtml(n.label)} ${money(instLeft(n))} · ${escapeHtml(dueText(n))}` : '✅ Liquidado'}</small></button>`;
}
// Cobros vencidos y de los próximos 7 días (página de cotizaciones)
function renderPayDue() {
  const box = $('#payDue');
  if (!box) return;
  const rows = [];
  db.quotes.forEach((q) => { const plan = planOf(q); (plan?.installments || []).forEach((i) => { if (i.status !== 'pagado' && daysTo(i.due) <= 7) rows.push({ q, i }); }); });
  rows.sort((a, b) => a.i.due.localeCompare(b.i.due));
  box.classList.toggle('hidden', !rows.length);
  if (!rows.length) { box.innerHTML = ''; return; }
  const total = rows.reduce((s, r) => s + instLeft(r.i), 0);
  box.innerHTML = `<div class="pp-due-head"><b>💳 Por cobrar esta semana</b><span>${rows.length} ${rows.length === 1 ? 'pago' : 'pagos'} · ${money(total)}</span></div><div class="pp-due-list">${rows.slice(0, 8).map(({ q, i }) => `<button type="button" class="pp-due-item${daysTo(i.due) < 0 ? ' late' : ''}" data-pay-plan="${q.id}"><b>${escapeHtml(clientName(q.client_id))}</b><span>${escapeHtml(i.label)} · ${money(instLeft(i))}</span><small>${escapeHtml(fmtDate(i.due))} · ${escapeHtml(dueText(i))}</small></button>`).join('')}</div>`;
}
function payPlanSummaryHtml(clientId) {
  const list = db.quotes.filter((q) => q.client_id === clientId && planOf(q));
  if (!list.length) return '';
  return `<div class="c360-next"><b>Planes de pago</b>${list.map((q) => { const p = q.payment_plan; const n = nextInst(p); return `<button type="button" class="lead-fup${n && daysTo(n.due) < 0 ? ' late' : ''}" data-pay-plan="${q.id}"><span>💳 ${escapeHtml(q.folio)} · ${money(p.paid)} de ${money(p.total)}</span><small>${n ? `${escapeHtml(n.label)} ${money(instLeft(n))} · ${escapeHtml(fmtDate(n.due))}` : '✅ Liquidado'}</small></button>`; }).join('')}</div>`;
}

async function payPlanModal(quoteId, opts = {}) {
  let q = quoteById(quoteId);
  if (!q) return;
  if (q.status !== 'Aceptada') { toast('El plan de pagos se arma cuando la cotización está Aceptada'); return; }
  const write = canWrite('quotes');
  if (!q.payment_plan) {
    if (!write) { toast('Esta venta aún no tiene plan de pagos'); return; }
    try { await send('POST', `/api/quotes/${q.id}/payment-plan`, {}); await loadAll(); q = quoteById(quoteId); } catch (error) { toast(error.message); return; }
  }
  const plan = q.payment_plan;
  const url = payUrlOf(q);
  const client = clientById(q.client_id);
  const pct = plan.total ? Math.min(100, Math.round((plan.paid / plan.total) * 100)) : 0;
  const cfg = db.payments || {};
  const how = cfg.mercadoPago
    ? '✅ El cliente puede pagar en línea con <b>Mercado Pago</b> (tarjeta, OXXO o SPEI) y el pago se registra solo.'
    : cfg.bank?.clabe || cfg.bank?.cuenta
      ? 'La liga muestra los datos de transferencia de la agencia. Cuando el cliente te mande su comprobante, toca <b>Registrar pago</b>.'
      : '⚠ Aún no hay forma de pago en la liga: pega una liga (Clip u otra) al editar el plan, o configura los datos bancarios en <b>Configuración › Cobros</b>.';
  if (opts.edit && write) return payPlanEditor(q);
  const rows = plan.installments.map((i) => `<div class="pp-row${i.status === 'pagado' ? ' done' : ''}">
      <div class="pp-main"><b>${escapeHtml(i.label)}</b> ${instChip(i)}<small>Fecha límite: ${escapeHtml(fmtDate(i.due))}${i.link_url ? ' · con liga manual' : ''}${(i.payments || []).length ? ` · ${i.payments.map((p) => `${money(p.amount)} ${escapeHtml(p.method)}${p.provider ? ' (en línea)' : ''} el ${escapeHtml(fmtDate(String(p.at).slice(0, 10)))}`).join(', ')}` : ''}</small></div>
      <div class="pp-amt">${money(i.amount)}</div>
      <div class="pp-acts">${write && i.status !== 'pagado' ? `<button type="button" class="btn primary small" data-pp-pay="${i.id}">Registrar pago</button>${client?.phone ? `<button type="button" class="btn secondary small" data-pp-remind="${i.id}">💬 Recordar</button>` : ''}` : ''}${isAdmin() && (i.payments || []).length ? `<button type="button" class="link danger-link" data-pp-undo="${i.id}" title="Deshacer el último pago">Deshacer</button>` : ''}</div>
    </div>`).join('');
  openModal('PLAN DE PAGOS', `${q.folio} · ${client?.name || ''}`, `<div class="pp">
    <div class="pp-sum"><div><span>Total</span><b>${money(plan.total)}</b></div><div><span>Pagado</span><b>${money(plan.paid)}</b></div><div class="${plan.balance > 0.5 ? 'warn' : 'ok'}"><span>Saldo</span><b>${money(plan.balance)}</b></div></div>
    <div class="pay-bar big"><i style="width:${pct}%"></i></div>
    <label class="gcal-url">Liga de pago para el cliente<span><input id="ppUrl" readonly value="${escapeHtml(url)}"><button type="button" class="btn secondary small" id="ppCopy">Copiar</button></span></label>
    <p class="muted-note">${how} La liga muestra su plan, lo que lleva pagado y el siguiente pago. Las plantillas “Liga para apartar” y “Recordatorio de pago” la incluyen con <b>{liga_pago}</b>.</p>
    ${typeof contractPlanHtml === 'function' ? contractPlanHtml(q) : ''}
    <div class="pp-list">${rows}</div>
    <p class="muted-note">🔔 Recordatorios automáticos: ${Number(cfg.reminderDays ?? 3)} días antes y el día de cada vencimiento te llega un aviso (y un seguimiento “Pago” en tu calendario)${cfg.emailClient !== false ? '; si el cliente tiene correo, también le llega un recordatorio con la liga' : ''}. Si se vence, se avisa también al administrador.</p>
    <div class="modal-actions">${write ? '<button type="button" class="btn secondary" id="ppEdit">✎ Editar plan</button>' : ''}<a class="btn secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ver como cliente</a>${write && client?.phone && nextInst(plan) ? '<button type="button" class="btn primary" id="ppSend">💬 Enviar liga por WhatsApp</button>' : '<button type="button" class="btn primary close">Listo</button>'}</div>
  </div>`, { wide: true });
  $('#ppCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); } catch { $('#ppUrl').select(); document.execCommand('copy'); } toast('Liga copiada'); };
  const remind = (instId) => {
    const anticipoPending = plan.installments[0]?.status !== 'pagado' && (!instId || instId === plan.installments[0].id);
    waModal({ clientId: q.client_id, leadId: q.lead_id || '', quoteId: q.id, stage: 'cierre', templateId: anticipoPending ? 'ci3' : 'ci4' });
  };
  if ($('#ppSend')) $('#ppSend').onclick = () => remind(nextInst(plan)?.id);
  if ($('#ppEdit')) $('#ppEdit').onclick = () => payPlanEditor(q);
  $('#modalBody').onclick = async (e) => {
    const pay = e.target.closest('[data-pp-pay]');
    if (pay) { registerPayModal(q.id, pay.dataset.ppPay); return; }
    const rem = e.target.closest('[data-pp-remind]');
    if (rem) { remind(rem.dataset.ppRemind); return; }
    const undo = e.target.closest('[data-pp-undo]');
    if (undo) {
      if (!confirm('¿Deshacer el último pago de esta parcialidad? También se quita de la ficha 360.')) return;
      const ok = await mutate(() => send('POST', `/api/quotes/${q.id}/payment-plan/${undo.dataset.ppUndo}/undo`), 'Pago deshecho');
      if (ok) payPlanModal(q.id);
    }
  };
}

function registerPayModal(quoteId, instId) {
  const q = quoteById(quoteId);
  const inst = q?.payment_plan?.installments.find((i) => i.id === instId);
  if (!inst) return;
  openModal('REGISTRAR PAGO', `${inst.label} · ${q.folio}`, `<form class="modal-form">
    ${field('Monto recibido (MXN)*', `<input name="amount" inputmode="decimal" required value="${instLeft(inst)}">`)}
    ${field('Forma de pago', `<select name="method">${options(PAY_METHODS, 'Transferencia')}</select>`)}
    ${field('Fecha del pago', `<input name="date" type="date" max="${todayStr()}" value="${todayStr()}">`)}
    ${field('Nota (opcional)', '<input name="note" maxlength="300" placeholder="Folio del comprobante, banco…">')}
    <p class="full muted-note">Queda en la ficha 360 del cliente, se actualiza la liga de pago y la confirmación del viaje, y se avisa al administrador${db.payments?.emailClient !== false && clientById(q.client_id)?.email ? '. El cliente recibe su recibo por correo' : ''}.</p>
    <div class="modal-actions"><button type="button" class="btn secondary" id="ppBack">Volver</button><button type="submit" class="btn primary">Registrar pago</button></div></form>`);
  $('#ppBack').onclick = () => payPlanModal(q.id);
  const form = $('#modalBody form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const amount = Number(String(v.amount).replace(/[^\d.]/g, ''));
    if (!(amount > 0)) { toast('Escribe el monto'); return; }
    if (amount > instLeft(inst) + 0.5 && !confirm(`El monto es mayor a lo que falta de ${inst.label} (${money(instLeft(inst))}). ¿Registrarlo de todos modos?`)) return;
    const ok = await mutate(() => send('POST', `/api/quotes/${q.id}/payment-plan/${inst.id}/pay`, { amount, method: v.method, date: v.date, note: v.note }), `Pago registrado: ${money(amount)}`);
    if (ok) payPlanModal(q.id);
  };
}

function payPlanEditor(q) {
  const plan = q.payment_plan;
  const rows = plan.installments.map((i) => ({ ...i }));
  const rowHtml = (i, idx) => `<div class="pp-edit-row" data-idx="${idx}">
      <input data-f="label" maxlength="40" value="${escapeHtml(i.label)}" aria-label="Concepto">
      <input data-f="due" type="date" value="${escapeHtml(i.due)}" aria-label="Fecha límite">
      <input data-f="amount" inputmode="decimal" value="${escapeHtml(i.amount)}" aria-label="Monto">
      <input data-f="link_url" maxlength="500" placeholder="Liga manual (Clip…) opcional" value="${escapeHtml(i.link_url || '')}" aria-label="Liga manual">
      <button type="button" class="icon" data-pp-del="${idx}" title="${i.paid ? 'Tiene pagos: no se puede quitar' : 'Quitar pago'}"${i.paid ? ' disabled' : ''}>✕</button>
    </div>`;
  const paint = () => {
    const sum = rows.reduce((s, r) => s + (Number(String(r.amount).replace(/[^\d.]/g, '')) || 0), 0);
    const total = Number(String($('#ppTotal').value).replace(/[^\d.]/g, '')) || 0;
    const diff = Math.round((total - sum) * 100) / 100;
    $('#ppSum').className = `pp-sumline ${Math.abs(diff) <= 1 ? 'ok' : 'warn'}`;
    $('#ppSum').textContent = Math.abs(diff) <= 1 ? `✓ Los pagos suman ${money(sum)}` : `Los pagos suman ${money(sum)} · ${diff > 0 ? `faltan ${money(diff)}` : `sobran ${money(-diff)}`}`;
  };
  openModal('PLAN DE PAGOS', `Editar · ${q.folio}`, `<div class="pp">
    <div class="modal-form"><label>Total de la venta (MXN)<input id="ppTotal" inputmode="decimal" value="${escapeHtml(plan.total)}"></label><span></span></div>
    <div class="pp-edit-head"><span>Concepto</span><span>Fecha límite</span><span>Monto</span><span>Liga manual</span><span></span></div>
    <div id="ppRows">${rows.map(rowHtml).join('')}</div>
    <div class="pp-edit-foot"><button type="button" class="btn secondary small" id="ppAdd">+ Agregar pago</button><span id="ppSum"></span></div>
    <p class="muted-note">Lo ya pagado se conserva. Si cambias fecha o monto, los recordatorios de ese pago vuelven a programarse. La liga manual (Clip u otra) aparece en la liga del cliente como “Pagar con tarjeta”.</p>
    <div class="modal-actions">${plan.paid ? '' : '<button type="button" class="btn secondary" id="ppRebuild" title="Volver a armarlo con el anticipo de la cotización">Rearmar desde la cotización</button>'}<button type="button" class="btn secondary" id="ppBack">Volver</button><button type="button" class="btn primary" id="ppSave">Guardar plan</button></div>
  </div>`, { wide: true });
  const body = $('#modalBody');
  const repaint = () => { $('#ppRows').innerHTML = rows.map(rowHtml).join(''); paint(); };
  body.oninput = (e) => {
    const row = e.target.closest('[data-idx]');
    if (row && e.target.dataset.f) rows[Number(row.dataset.idx)][e.target.dataset.f] = e.target.value;
    paint();
  };
  body.onclick = (e) => {
    const del = e.target.closest('[data-pp-del]');
    if (del && !del.disabled) { rows.splice(Number(del.dataset.ppDel), 1); repaint(); }
  };
  $('#ppAdd').onclick = () => {
    if (rows.length >= 12) { toast('Máximo 12 pagos'); return; }
    const last = rows[rows.length - 1];
    const total = Number(String($('#ppTotal').value).replace(/[^\d.]/g, '')) || 0;
    const sum = rows.reduce((s, r) => s + (Number(String(r.amount).replace(/[^\d.]/g, '')) || 0), 0);
    rows.push({ label: `Pago ${rows.length + 1}`, due: last ? addDays(last.due, 15) : addDays(todayStr(), 7), amount: Math.max(0, Math.round((total - sum) * 100) / 100), link_url: '', paid: 0 });
    repaint();
  };
  $('#ppBack').onclick = () => payPlanModal(q.id);
  if ($('#ppRebuild')) $('#ppRebuild').onclick = async () => {
    if (!confirm('¿Volver a armar el plan con el anticipo y las fechas de la cotización? Se pierden los cambios que hiciste.')) return;
    const ok = await mutate(() => send('POST', `/api/quotes/${q.id}/payment-plan`, { rebuild: true }), 'Plan rearmado');
    if (ok) payPlanModal(q.id);
  };
  $('#ppSave').onclick = async () => {
    const body = { total: $('#ppTotal').value, installments: rows.map((r) => ({ id: r.id, label: r.label, due: r.due, amount: r.amount, link_url: r.link_url })) };
    const ok = await mutate(() => send('PUT', `/api/quotes/${q.id}/payment-plan`, body), 'Plan de pagos guardado');
    if (ok) payPlanModal(q.id);
  };
  paint();
}

async function renderPaymentsSettings() {
  const box = $('#paymentsBody');
  if (!box) return;
  try {
    const st = await api('/api/payments/settings');
    const b = st.bank || {};
    const sel = (name, list, value) => `<select name="${name}">${list.map(([v, label]) => `<option value="${v}"${Number(v) === Number(value) ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
    box.innerHTML = `<form class="modal-form">
      <div class="full pp-mp ${st.mercadoPago.configured ? 'on' : 'off'}">${st.mercadoPago.configured
        ? `<b>✅ Mercado Pago conectado${st.mercadoPago.sandbox ? ' (modo de prueba)' : ''}</b><span>Tus clientes pagan en línea con tarjeta, OXXO o SPEI desde su liga y el pago se registra solo en el CRM.</span>`
        : `<b>Mercado Pago: sin conectar</b><span>Mientras tanto la liga muestra tus datos de transferencia y la liga manual que pegue el vendedor. Para conectarlo: 1) Abre tu cuenta de Mercado Pago (negocio). 2) En <i>Tus integraciones</i> crea una aplicación de “Pagos online / Checkout Pro”. 3) Copia el <i>Access Token</i> de producción. 4) En Hostinger agrégalo como variable de entorno <code>MP_ACCESS_TOKEN</code> y reinicia la app. El aviso de pago llega solo a <code>${escapeHtml(st.mercadoPago.webhook)}</code>.</span>`}</div>
      ${field('Anticipo cuando la cotización no lo trae', sel('anticipoPct', [[20, '20 %'], [25, '25 %'], [30, '30 %'], [40, '40 %'], [50, '50 %']], st.anticipoPct))}
      ${field('Plazo para pagar el anticipo', sel('anticipoDays', [[1, '1 día'], [2, '2 días'], [3, '3 días'], [5, '5 días'], [7, '7 días']], st.anticipoDays))}
      ${field('La liquidación vence', sel('saldoDaysBefore', [[15, '15 días antes de la salida'], [21, '21 días antes'], [30, '30 días antes'], [45, '45 días antes'], [60, '60 días antes']], st.saldoDaysBefore))}
      ${field('Recordatorio antes de cada vencimiento', sel('reminderDays', [[1, '1 día antes'], [2, '2 días antes'], [3, '3 días antes'], [5, '5 días antes'], [7, '7 días antes']], st.reminderDays))}
      <label class="full kb-check"><input type="checkbox" name="emailClient" ${st.emailClient ? 'checked' : ''}> Enviar correo al cliente: recordatorio de pago (antes y el día) y recibo cuando se registra un pago</label>
      <p class="full section-label">Datos para transferencia (aparecen en la liga de pago)</p>
      ${field('Banco', `<input name="banco" maxlength="60" value="${escapeHtml(b.banco)}" placeholder="BBVA">`)}
      ${field('Titular', `<input name="titular" maxlength="120" value="${escapeHtml(b.titular)}" placeholder="Viajes Bumeran Casal">`)}
      ${field('CLABE (18 dígitos)', `<input name="clabe" maxlength="22" inputmode="numeric" value="${escapeHtml(b.clabe)}">`)}
      ${field('Número de cuenta (opcional)', `<input name="cuenta" maxlength="30" value="${escapeHtml(b.cuenta)}">`)}
      ${field('Indicaciones (opcional)', `<textarea name="notas" rows="2" maxlength="400" placeholder="Usa tu folio como referencia y envía tu comprobante por WhatsApp.">${escapeHtml(b.notas)}</textarea>`, true)}
      <div class="modal-actions"><button type="submit" class="btn primary">Guardar cobros</button></div></form>`;
    const form = box.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try {
        await send('PUT', '/api/payments/settings', { anticipoPct: Number(v.anticipoPct), anticipoDays: Number(v.anticipoDays), saldoDaysBefore: Number(v.saldoDaysBefore), reminderDays: Number(v.reminderDays), emailClient: Boolean(v.emailClient), bank: { banco: v.banco, titular: v.titular, clabe: v.clabe, cuenta: v.cuenta, notas: v.notas } });
        toast('Cobros guardados');
        await loadAll(); renderPaymentsSettings();
      } catch (error) { toast(error.message, 6000); }
    };
  } catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
}

/* ---------- TP-301: itinerario digital para el celular ---------- */
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const IT_WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const dayLabel = (iso) => `${IT_WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${fmtDate(iso)}`;
async function itineraryModal(tripId) {
  const t = tripById(tripId);
  if (!t) return;
  let share, payload;
  try { [share, payload] = await Promise.all([send('POST', `/api/trips/${t.id}/share`, {}), api(`/api/documents/trip/${t.id}`)]); } catch (error) { toast(error.message); return; }
  t.share_token = share.url.split('/').pop();
  const c = TPDocs.mergeConfirmation(payload.trip.confirmation, TPDocs.confirmationDefaults(payload));
  const auto = () => TPDocs.buildItinerary(c, payload);
  const saved = Array.isArray(t.itinerary?.days) && t.itinerary.days.length;
  let days = (saved ? t.itinerary.days : auto()).map((d) => ({ date: d.date, title: d.title || '', text: d.text || '', place: d.place || '' }));
  let vouchers = share.vouchers || [];
  const client = clientById(t.client_id);
  const stale = saved && (days[0]?.date !== t.start_date || days[days.length - 1]?.date !== t.end_date);
  const paintVouchers = () => {
    $('#itVouchers').innerHTML = vouchers.length ? vouchers.map((v) => `<div class="it-doc"><span>${v.mime === 'application/pdf' ? '📄' : '🖼'} <b>${escapeHtml(v.name)}</b> <small>${fmtSize(v.size)}</small></span><span><a class="link" href="/api/media/${v.id}" target="_blank" rel="noopener">Ver</a><button type="button" class="link danger-link" data-it-del="${v.id}">Quitar</button></span></div>`).join('') : '<p class="muted-note">Aún no hay documentos. Sube vouchers, boletos de avión, pólizas o reservaciones de tours.</p>';
  };
  const dayHtml = (d, i) => `<div class="it-day" data-i="${i}"><div class="it-day-head"><b>Día ${i + 1}</b><span>${escapeHtml(dayLabel(d.date))}</span></div>
    <input data-f="title" maxlength="80" placeholder="Título del día" value="${escapeHtml(d.title)}">
    <textarea data-f="text" rows="3" maxlength="1500" placeholder="Una actividad por renglón. Empieza con la hora si aplica: 10:00 Tour a Isla Mujeres">${escapeHtml(d.text)}</textarea>
    <input data-f="place" maxlength="120" placeholder="Lugar para el mapa (opcional): hotel, parque, restaurante…" value="${escapeHtml(d.place)}"></div>`;
  openModal('ITINERARIO DIGITAL', `${client?.name || ''} · ${t.destination}`, `<div class="it">
    <label class="gcal-url">Liga para el celular del cliente<span><input id="itUrl" readonly value="${escapeHtml(share.url)}"><button type="button" class="btn secondary small" id="itCopy">Copiar</button></span></label>
    <p class="muted-note">Incluye el día por día, vuelos, hotel con mapa, traslados, los documentos que subas, su saldo pendiente con la liga de pago y tus datos de contacto. ${share.viewed_at ? `👀 El cliente lo abrió el ${escapeHtml(fmtDue(share.viewed_at))}.` : 'Aún no lo abre.'}</p>
    <div class="it-acts"><a class="btn secondary small" href="${escapeHtml(share.url)}" target="_blank" rel="noopener">Ver como cliente</a>${client?.phone ? '<button type="button" class="btn primary small" id="itWa">💬 Enviar por WhatsApp</button>' : ''}<button type="button" class="btn secondary small" id="itOff">Desactivar liga</button></div>
    <h4 class="it-h">Documentos de viaje</h4>
    <div id="itVouchers"></div>
    <label class="btn secondary small it-upload">⬆ Subir PDF o foto<input type="file" id="itFile" accept="application/pdf,image/jpeg,image/png,image/webp" multiple hidden></label>
    <h4 class="it-h">Día por día ${saved ? '' : '<small>· armado automático con la confirmación</small>'}</h4>
    ${stale ? '<p class="note-warn">Las fechas del viaje cambiaron. Toca “Regenerar desde la confirmación” para ajustar los días.</p>' : ''}
    ${t.confirmation ? '' : '<p class="muted-note">Tip: completa la Confirmación de servicios (vuelos, hotel, traslados) y el itinerario se llena solo.</p>'}
    <div id="itDays">${days.map(dayHtml).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn secondary" id="itRegen">↺ Regenerar desde la confirmación</button><button type="button" class="btn secondary close">Cerrar</button><button type="button" class="btn primary" id="itSave">Guardar itinerario</button></div>
  </div>`, { wide: true });
  paintVouchers();
  const body = $('#modalBody');
  body.oninput = (e) => { const row = e.target.closest('[data-i]'); if (row && e.target.dataset.f) days[Number(row.dataset.i)][e.target.dataset.f] = e.target.value; };
  body.onclick = async (e) => {
    const del = e.target.closest('[data-it-del]');
    if (!del) return;
    if (!confirm('¿Quitar este documento del itinerario?')) return;
    try { vouchers = (await send('DELETE', `/api/trips/${t.id}/vouchers/${del.dataset.itDel}`)).vouchers; paintVouchers(); toast('Documento quitado'); } catch (error) { toast(error.message); }
  };
  $('#itCopy').onclick = async () => { try { await navigator.clipboard.writeText(share.url); } catch { $('#itUrl').select(); document.execCommand('copy'); } toast('Liga copiada'); };
  if ($('#itWa')) $('#itWa').onclick = async () => { await loadAll(); waModal({ clientId: t.client_id, tripId: t.id, quoteId: t.quote_id || '', stage: 'cierre', templateId: 'ci5' }); };
  $('#itOff').onclick = async () => {
    if (!confirm('¿Desactivar la liga? El cliente ya no podrá abrir su itinerario; si la vuelves a activar se genera una nueva.')) return;
    try { await send('POST', `/api/trips/${t.id}/share`, { enabled: false }); t.share_token = null; toast('Liga desactivada'); close(); } catch (error) { toast(error.message); }
  };
  $('#itFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      if (file.size > 4 * 1024 * 1024) { toast(`${file.name} pesa más de 4 MB`); continue; }
      try {
        const r = await fetch(`/api/trips/${t.id}/vouchers`, { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) }, body: file });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || 'No se pudo subir');
        vouchers = out.vouchers; paintVouchers(); toast(`Subido: ${file.name}`);
      } catch (error) { toast(`${file.name}: ${error.message}`, 6000); }
    }
  };
  $('#itRegen').onclick = () => {
    if (!confirm('¿Volver a armar el día por día con la confirmación del viaje? Se reemplazan los cambios que no hayas guardado.')) return;
    days = auto().map((d) => ({ date: d.date, title: d.title, text: d.text, place: d.place || '' }));
    $('#itDays').innerHTML = days.map(dayHtml).join('');
  };
  $('#itSave').onclick = async () => {
    const ok = await mutate(() => send('PATCH', `/api/trips/${t.id}`, { itinerary: { days, updated_at: nowLocalStr() } }), 'Itinerario guardado');
    if (ok) close();
  };
}

/* ---------- TP-111 Duplicados ---------- */
async function checkDuplicates(form, excludeId) {
  const box = form.querySelector('.dupe-warn');
  if (!box) return;
  const phone = form.phone?.value.trim() || '', email = form.email?.value.trim() || '';
  if (phone.replace(/\D/g, '').length < 10 && !email.includes('@')) { box.classList.add('hidden'); return; }
  try {
    const q = new URLSearchParams({ phone, email, ...(excludeId ? { exclude: excludeId } : {}) });
    const { matches } = await api(`/api/clients/duplicates/check?${q}`);
    box.classList.toggle('hidden', !matches.length);
    box.innerHTML = matches.length ? `⚠ <b>Posible duplicado:</b> ${matches.map((m) => `${escapeHtml(m.name)} (mismo ${m.reasons.join(' y ')})${m.visible ? ` <button type="button" class="link" data-client="${m.id}">Abrir ficha</button>` : m.owners.length ? ` · lo atiende ${escapeHtml(m.owners.join(', '))}` : ''}`).join(' · ')}${form.dataset.kind === 'lead' ? '<br><small>Al guardar, el lead se agrega a ese cliente en lugar de crear uno nuevo.</small>' : ''}` : '';
  } catch { box.classList.add('hidden'); }
}
function bindDuplicateCheck(form, excludeId) {
  if (!form || !form.querySelector('.dupe-warn')) return;
  ['phone', 'email'].forEach((n) => { if (form[n]) form[n].addEventListener('change', () => checkDuplicates(form, excludeId)); });
}
async function duplicatesModal() {
  let groups;
  try { groups = (await api('/api/duplicates')).groups; } catch (error) { toast(error.message); return; }
  const card = (c, g) => `<div class="dupe-card"><b>${escapeHtml(c.name)}</b><small>${escapeHtml([c.phone, c.email].filter(Boolean).join(' · ') || 'Sin datos de contacto')}</small><small>${c.leads} leads · ${c.quotes} cotizaciones · ${c.trips} viajes · desde ${escapeHtml(fmtDate(c.created_at))}</small>
    <div class="dupe-acts"><button type="button" class="link" data-client="${c.id}">Ver ficha</button>${g.clients.length > 1 ? `<button type="button" class="btn primary small" data-keep="${c.id}" data-group="${groups.indexOf(g)}">Conservar este</button>` : ''}</div></div>`;
  openModal('CLIENTES', 'Posibles duplicados', `<div class="dupes">${groups.length ? groups.map((g) => `<section class="dupe-group${g.strong ? ' strong' : ''}"><p><b>${escapeHtml(g.reasons.join(' · '))}</b>${g.strong ? '' : ' <small>(revisa bien: solo coincide el nombre)</small>'}</p><div class="dupe-row">${g.clients.map((c) => card(c, g)).join('')}</div></section>`).join('') : '<p class="empty-note">No hay posibles duplicados. 🎉</p>'}
    <p class="muted-note">“Conservar este” pasa al cliente elegido todos los leads, cotizaciones, viajes, seguimientos y la ficha 360 de los otros, completa su WhatsApp, correo y preferencias si le faltan, y elimina los demás registros.</p>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div></div>`, { wide: true });
  $('#modalBody').onclick = async (e) => {
    const b = e.target.closest('[data-keep]');
    if (!b) return;
    const g = groups[Number(b.dataset.group)];
    const keep = g.clients.find((c) => c.id === Number(b.dataset.keep));
    const others = g.clients.filter((c) => c.id !== keep.id);
    if (!confirm(`¿Fusionar ${others.map((c) => c.name).join(', ')} dentro de “${keep.name}”? No se puede deshacer.`)) return;
    try {
      for (const o of others) await send('POST', '/api/clients/merge', { keep_id: keep.id, merge_id: o.id });
      toast(`Clientes fusionados en ${keep.name}`);
      await loadAll();
      duplicatesModal();
    } catch (error) { toast(error.message, 6000); }
  };
}
async function renderDuplicatesBanner() {
  const el = $('#dupeBanner');
  if (!el) return;
  if (!isAdmin()) { el.classList.add('hidden'); return; }
  try {
    const { groups } = await api('/api/duplicates');
    const strong = groups.filter((g) => g.strong).length;
    el.classList.toggle('hidden', !groups.length);
    el.innerHTML = groups.length ? `⚠ ${groups.length} ${groups.length === 1 ? 'posible duplicado' : 'posibles duplicados'}${strong ? ` (${strong} con mismo WhatsApp o correo)` : ''} <button type="button" class="btn secondary small" id="dupeReview">Revisar y fusionar</button>` : '';
    if ($('#dupeReview')) $('#dupeReview').onclick = duplicatesModal;
  } catch { el.classList.add('hidden'); }
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
          ${(payload.trip.passengers?.list || []).length ? `<label class="span2">Pasajeros <small>· se toman de 👥 Pasajeros del viaje</small><textarea rows="3" readonly>${escapeHtml(c.passengers)}</textarea><button type="button" class="link" data-pax-trip="${tripId}">Editar pasajeros</button></label>` : a('passengers', 'Pasajeros (uno por línea)', 'rows="3"', 'span2')}
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
      if (e.target.closest('[data-reset-conf]')) { c = TPDocs.mergeConfirmation(null, defaults); render(); toast('Datos tomados del viaje y la cotización. Guarda para conservarlos.'); return; }
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
  // TP-109: puntaje automático (datos del lead + respuesta + preguntas)
  if (lead?.auto) return `<span class="qual-chip ${LEVEL_CLASS[lead.auto.level] || 'none'}" title="${escapeHtml(lead.auto.parts.map((p) => `${p.label}: ${p.points}/${p.max}`).join(' · '))}">${lead.auto.level === 'Caliente' ? '🔥 ' : ''}${lead.auto.score} ${escapeHtml(lead.auto.level)}</span>`;
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
  return `<div class="qual full" id="qualBox"><div class="qual-head"><b>Preguntas de calificación <small class="muted">(opcional · suman al puntaje)</small></b><span class="qual-score" id="qualScore">${html}</span></div>
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

/* ---------- Configuración: respaldos ---------- */
const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const fmtLocal = (value) => { const v = String(value || '').replace('T', ' '); return v ? `${fmtDate(v.slice(0, 10))} ${v.slice(0, 4)}, ${v.slice(11, 16)}` : ''; };
async function loadBackups() {
  try {
    const data = await api('/api/backups');
    const lastAuto = data.backups.find((b) => b.kind === 'auto');
    const emailOk = data.settings.sendEmail && data.mailConfigured;
    $('#backupStatus').innerHTML = `
      <div><span>Próximo automático</span><b>${escapeHtml(fmtLocal(data.nextRun))}</b></div>
      <div><span>Último automático</span><b>${lastAuto ? escapeHtml(fmtLocal(lastAuto.createdAt)) : 'Aún no se hace'}</b></div>
      <div><span>Copia por correo</span><b class="${emailOk ? 'mail-ok' : 'mail-off'}">${!data.settings.sendEmail ? 'Desactivada' : data.mailConfigured ? escapeHtml(data.recipients || 'Sin destinatario') : 'Correo de la plataforma sin configurar'}</b></div>
      <div><span>Guardados</span><b>${data.backups.length} de ${data.keep}</b></div>`;
    $('#backupSendEmail').checked = Boolean(data.settings.sendEmail);
    $('#backupEmail').value = data.settings.email || '';
    $('#backupEmail').placeholder = data.recipients ? `Vacío = ${data.recipients}` : 'correo@ejemplo.com';
    $('#backupRows').innerHTML = data.backups.length ? data.backups.map((b) => `<tr>
      <td>${escapeHtml(fmtLocal(b.createdAt))}</td>
      <td>${b.kind === 'auto' ? 'Automático' : `Manual${b.createdBy ? ` · ${escapeHtml(b.createdBy)}` : ''}`}</td>
      <td>${escapeHtml(Object.entries(b.summary.counts || {}).filter(([k]) => k !== 'Usuarios').map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · '))}</td>
      <td class="${/^Enviado/.test(b.emailStatus || '') ? 'mail-ok' : 'muted'}">${escapeHtml(b.emailStatus || '—')}</td>
      <td><div class="user-actions"><button class="link" data-backup-dl="${b.id}:xlsx">Excel (${kb(b.xlsxSize)})</button><button class="link" data-backup-dl="${b.id}:json" title="Copia completa para restaurar">Copia técnica</button></div></td></tr>`).join('')
      : emptyRow(5, 'Todavía no hay respaldos. Usa “Hacer respaldo ahora” o espera al automático de las 2:00 a.m.');
  } catch (error) { toast(error.message); }
}
$('#backupNow').onclick = async () => {
  const button = $('#backupNow');
  button.disabled = true;
  button.textContent = 'Respaldando…';
  try { const r = await send('POST', '/api/backups'); toast(`Respaldo listo · ${r.emailStatus}`, 7000); await loadBackups(); }
  catch (error) { toast(error.message, 6000); }
  finally { button.disabled = false; button.textContent = 'Hacer respaldo ahora'; }
};
$('#saveBackupSettings').onclick = async () => {
  try { await send('PUT', '/api/backups/settings', { sendEmail: $('#backupSendEmail').checked, email: $('#backupEmail').value }); toast('Configuración de respaldos guardada'); loadBackups(); }
  catch (error) { toast(error.message, 6000); }
};
$('#backupRows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-backup-dl]');
  if (!btn) return;
  const [id, type] = btn.dataset.backupDl.split(':');
  downloadFile(`/api/backups/${id}/download?type=${type}`);
});

/* ---------- Configuración: integraciones ---------- */
/* ---------- Bot de WhatsApp (Botpress) ---------- */
const BOT_URL = () => `${location.origin}/api/integrations/botpress/lead`;
function botpressCode(token) {
  return `// Viajes Casal · envía la solicitud al CRM (pegar al final de Traspaso_TravelPartner)
const w = workflow
const tags = (event && event.tags && event.tags.conversation) || {}
try {
  await axios.post('${BOT_URL()}', {
    telefono: tags['whatsapp:userPhone'] || '',
    nombre: w.nombre,
    producto: w.producto,
    destino: w.destinoViaje,
    ciudadSalida: w.ciudadSalida || w.svCiudadSalida,
    fechaVuelo: w.svFechaViaje,
    personas: w.numAdultos || w.personasTours,
    presupuesto: w.presupuesto,
    tipoHospedaje: w.tipoHospedaje,
    tipoExperiencia: w.tipoExperiencia,
    preferencias: w.preferenciasHotel || w.preferenciasVuelo,
    traslado: w.trasladoRentaAuto,
    etapa: w.etapaDecisin,
    resumen: w.resumen
  }, { headers: { 'X-TP-Token': '${token}' }, timeout: 8000 })
} catch (e) {
  console.log('El CRM no recibió el lead: ' + ((e.response && e.response.status) || e.message))
}`;
}
async function renderBotCard() {
  const card = $('#botCard');
  if (!card) return;
  try {
    const st = await api('/api/integrations/botpress');
    card.innerHTML = `<div class="int-main"><b>Bot de WhatsApp → CRM ${st.enabled ? '<span class="tag-ok">Activo</span>' : '<span class="tag-soon">Inactivo</span>'}</b>
      <small>Al terminar la calificación en Botpress, el bot crea el lead (o actualiza el que ya está abierto) con nombre, WhatsApp, destino, fechas, personas y presupuesto, y programa un seguimiento a 15 minutos.</small>
      <p>${st.lastAt ? `Último lead recibido: <b>${escapeHtml(fmtLocal(st.lastAt))}</b> · ${escapeHtml(st.lastResult || '')}` : 'Aún no llega ningún lead del bot.'}${st.hasToken ? ` · Clave que termina en <b>…${escapeHtml(st.tokenHint)}</b>` : ''}</p>
      <div class="bot-row">Los leads del bot se reparten según <button type="button" class="link" data-settings-tab="assignmentPanel">Asignación de leads</button>.</div></div>
      <div class="int-side">${st.hasToken ? `<button class="btn secondary small" id="botToggle">${st.enabled ? 'Desactivar' : 'Activar'}</button>` : ''}<button class="btn ${st.hasToken ? 'secondary' : 'primary'} small" id="botToken">${st.hasToken ? 'Generar clave nueva' : 'Conectar bot'}</button></div>`;
    if ($('#botToggle')) $('#botToggle').onclick = async () => { try { await send('PUT', '/api/integrations/botpress', { enabled: !st.enabled }); renderBotCard(); } catch (error) { toast(error.message); } };
    $('#botToken').onclick = () => botTokenModal(st.hasToken);
  } catch (error) { card.innerHTML = `<div class="int-main"><b>Bot de WhatsApp → CRM</b><small>${escapeHtml(error.message)}</small></div>`; }
}
function botTokenModal(replacing) {
  openModal('BOT DE WHATSAPP', replacing ? 'Generar clave nueva' : 'Conectar el bot de Botpress', `<div class="modal-form">
    <p class="full">${replacing ? 'La clave anterior <b>dejará de funcionar</b>: tendrás que pegar el código nuevo en Botpress.' : 'Se crea una clave secreta para que solo tu bot pueda crear leads en el CRM.'}</p>
    <div class="modal-actions"><button type="button" class="btn secondary close">Cancelar</button><button type="button" class="btn primary" id="botGen">Generar clave y código</button></div></div>`);
  $('#botGen').onclick = async () => {
    try {
      const r = await send('POST', '/api/integrations/botpress/token');
      const code = botpressCode(r.token);
      openModal('BOT DE WHATSAPP', 'Código para pegar en Botpress', `<div class="modal-form">
        <p class="full note-warn">Este código incluye la clave secreta y <b>solo se muestra ahora</b>. Cópialo y pégalo en Botpress; no lo compartas por otro lado.</p>
        <ol class="full bot-steps"><li>En Botpress abre el flujo y el nodo <b>Traspaso_TravelPartner</b>.</li><li>Abajo de la tarjeta “Ejecutar código” que arma el resumen, agrega otra tarjeta <b>Ejecutar código</b> (Execute code).</li><li>Pega este código y da clic en <b>Publicar</b>.</li><li>Haz una prueba desde WhatsApp: el lead aparece en Leads con un seguimiento a 15 minutos.</li></ol>
        <textarea id="botCode" class="full code-box" rows="14" readonly>${escapeHtml(code)}</textarea>
        <div class="modal-actions"><button type="button" class="btn secondary close">Listo</button><button type="button" class="btn primary" id="botCopy">Copiar código</button></div></div>`, { wide: true });
      $('#botCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#botCode').value); toast('Código copiado'); } catch { $('#botCode').select(); toast('Selecciona y copia con Ctrl+C'); } };
      renderBotCard();
    } catch (error) { toast(error.message, 6000); }
  };
}

// Formulario web (TP-102): enlace, código para el sitio y a quién llegan los leads.
function webformLinks(origen) {
  const tag = String(origen || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const base = location.origin;
  return {
    tag,
    link: `${base}/formulario${tag ? `?origen=${tag}` : ''}`,
    code: `<script src="${base}/formulario-embed.js"${tag ? ` data-origen="${tag}"` : ''} async></script>`,
    iframe: `<iframe src="${base}/formulario?embed=1${tag ? `&origen=${tag}` : ''}" title="Formulario para cotizar tu viaje" style="width:100%;max-width:680px;height:1100px;border:0" loading="lazy"></iframe>`
  };
}
async function renderWebformCard() {
  const card = $('#webformCard');
  if (!card) return;
  try {
    const st = await api('/api/integrations/webform');
    const l = webformLinks('');
    card.innerHTML = `<div class="int-main"><b>Formulario web → CRM ${st.enabled ? '<span class="tag-ok">Activo</span>' : '<span class="tag-soon">Pausado</span>'}</b>
      <small>Reemplaza a Tally: el cliente contesta con botones (paquete, solo vuelo, solo hospedaje, tours o asesoría) y el lead entra a Leads ya calificado, con seguimiento a 15 minutos${st.notifyEmail ? ' y aviso por correo al vendedor' : ''}.</small>
      <p><a href="${escapeHtml(l.link)}" target="_blank" rel="noopener">${escapeHtml(l.link)}</a></p>
      <p>${st.lastAt ? `Último lead recibido: <b>${escapeHtml(fmtLocal(st.lastAt))}</b> · ${escapeHtml(st.lastResult || '')}` : 'Aún no llega ningún lead del formulario.'}</p>
      ${st.blockedCount ? `<p class="note-warn">Bloqueados como posible spam: <b>${st.blockedCount}</b> · último ${escapeHtml(fmtLocal(st.lastBlockedAt))} · ${escapeHtml(st.lastBlocked || '')}</p>` : ''}
      <div class="bot-row">Los leads del formulario se reparten según <button type="button" class="link" data-settings-tab="assignmentPanel">Asignación de leads</button>.</div>
      <div class="bot-row"><label><input type="checkbox" id="wfNotify" ${st.notifyEmail ? 'checked' : ''}> Avisar por correo al vendedor</label></div>
      <div class="bot-row"><label>WhatsApp del botón “Escríbenos” <input id="wfWa" class="wf-wa" value="${escapeHtml(st.whatsapp)}" placeholder="El de la agencia" maxlength="25"> <button class="btn secondary small" id="wfWaSave" type="button">Guardar</button></label></div></div>
      <div class="int-side"><img class="qr-mini" src="/api/qr?data=${encodeURIComponent(l.link)}" alt="Código QR del formulario"><button class="btn primary small" id="wfCode" type="button">Código para tu sitio</button><button class="btn secondary small" data-copy="${escapeHtml(l.link)}">Copiar enlace</button><button class="btn secondary small" id="wfToggle" type="button">${st.enabled ? 'Pausar' : 'Activar'}</button></div>`;
    const save = async (body, msg) => { try { await send('PUT', '/api/integrations/webform', body); toast(msg); renderWebformCard(); } catch (error) { toast(error.message); } };
    $('#wfNotify').onchange = (e) => save({ notifyEmail: e.target.checked }, e.target.checked ? 'Se avisará por correo' : 'Sin aviso por correo');
    $('#wfWaSave').onclick = () => save({ whatsapp: $('#wfWa').value }, 'WhatsApp del formulario guardado');
    $('#wfToggle').onclick = () => save({ enabled: !st.enabled }, st.enabled ? 'Formulario pausado: muestra solo el botón de WhatsApp' : 'Formulario activo');
    $('#wfCode').onclick = () => webformCodeModal();
  } catch (error) { card.innerHTML = `<div class="int-main"><b>Formulario web → CRM</b><small>${escapeHtml(error.message)}</small></div>`; }
}
function webformCodeModal() {
  openModal('FORMULARIO WEB', 'Ponlo en tu sitio o landing', `<div class="modal-form">
    <label class="full">Nombre de la página o campaña (opcional)<input id="wfTag" maxlength="40" placeholder="Ej. landing-cancun, instagram, sitio-inicio"><small>Aparece en el lead como “Origen” para saber de dónde llegó.</small></label>
    <p class="full"><b>1. Código para pegar</b> (Hostinger, WordPress, Wix: bloque “Código / HTML / Embed”). El formulario se ajusta solo al alto de la página.</p>
    <textarea id="wfSnippet" class="full code-box" rows="3" readonly></textarea>
    <div class="full"><button type="button" class="btn primary small" data-copy-from="wfSnippet">Copiar código</button></div>
    <p class="full"><b>2. Enlace directo</b> para la bio de Instagram, anuncios o botones.</p>
    <input id="wfLink" class="full" readonly>
    <div class="full"><button type="button" class="btn secondary small" data-copy-from="wfLink">Copiar enlace</button> <a class="btn secondary small" id="wfOpen" target="_blank" rel="noopener">Abrir formulario</a></div>
    <details class="full"><summary>¿Tu sitio no acepta scripts? Usa este iframe</summary><textarea id="wfIframe" class="code-box" rows="3" readonly></textarea><button type="button" class="btn secondary small" data-copy-from="wfIframe">Copiar iframe</button></details>
    <div class="modal-actions"><button type="button" class="btn secondary close">Listo</button></div></div>`, { wide: true });
  const update = () => { const l = webformLinks($('#wfTag').value); $('#wfSnippet').value = l.code; $('#wfLink').value = l.link; $('#wfIframe').value = l.iframe; $('#wfOpen').href = l.link; };
  $('#wfTag').oninput = update;
  update();
  $('#modalBody').querySelectorAll('[data-copy-from]').forEach((b) => { b.onclick = async () => { const el = $(`#${b.dataset.copyFrom}`); try { await navigator.clipboard.writeText(el.value); toast('Copiado'); } catch { el.select(); toast('Selecciona y copia con Ctrl+C'); } }; });
}

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
    + '<div id="botCard" class="integration"><div class="int-main"><b>Bot de WhatsApp → CRM</b><small>Cargando…</small></div></div>'
    + '<div id="webformCard" class="integration"><div class="int-main"><b>Formulario web → CRM</b><small>Cargando…</small></div></div>'
    + `<div class="int-soon"><div><b>Respaldos y exportación <span class="tag-ok">Activo</span></b>Copia diaria a las 2:00 a.m. y descarga a Excel/CSV. <button class="link" data-settings-tab="backupsPanel">Ver respaldos</button></div></div>`;
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
  crm_settings_update: 'Cambió la configuración', profile_update: 'Actualizó el perfil para documentos',
  backup_auto: 'Respaldo automático diario', backup_manual: 'Hizo un respaldo', backup_download: 'Descargó un respaldo', data_export: 'Exportó información', crm_shared_client: 'Registró un cliente que ya atiende otro vendedor', crm_automation: '🤖 Automatización'
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
  if (tab === 'integrationsPanel') { loadMailStatus(); renderIntegrations(); renderBotCard(); renderWebformCard(); }
  if (tab === 'pdfPanel') renderDocSettings();
  if (tab === 'questionsPanel') { renderQuestionsEditor(true); renderScoringSettings(); }
  if (tab === 'backupsPanel') loadBackups();
  if (tab === 'assignmentPanel') renderAssignment();
  if (tab === 'remindersPanel') renderReminders();
  if (tab === 'templatesPanel') renderTemplatesSettings();
  if (tab === 'paymentsPanel') renderPaymentsSettings();
  if (tab === 'postventaPanel' && typeof renderPostventaSettings === 'function') renderPostventaSettings(); // TP-308/309
  if (tab === 'campaignPanel' && typeof renderCampaignSettings === 'function') renderCampaignSettings(); // TP-310
  if (tab === 'contractPanel' && typeof renderContractSettings === 'function') renderContractSettings(); // TP-204
  if (tab === 'goalsPanel' && typeof renderGoalsSettings === 'function') renderGoalsSettings(); // TP-206
  if (tab === 'fieldsPanel' && typeof renderCustomFieldsSettings === 'function') renderCustomFieldsSettings(); // TP-306
  if (tab === 'automationsPanel' && typeof renderAutomations === 'function') renderAutomations(); // TP-307
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
  clearInterval(bell.timer);
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
  else { loadAll(); startBell(); }
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
  if (page === 'clients') renderDuplicatesBanner();
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
  if ((el = hit('[data-new-followup-lead]'))) { followupModal(null, { leadId: Number(el.dataset.newFollowupLead), type: el.dataset.followupType }); return; }
  if ((el = hit('[data-new-lead-client]'))) { leadModal(null, Number(el.dataset.newLeadClient)); return; }
  if ((el = hit('[data-new-trip-client]'))) { tripModal(null, { clientId: Number(el.dataset.newTripClient) }); return; }
  if ((el = hit('[data-itinerary]'))) { itineraryModal(Number(el.dataset.itinerary)); return; }
  if ((el = hit('[data-pay-plan]'))) { payPlanModal(Number(el.dataset.payPlan)); return; }
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
  if ((el = hit('[data-lead-view]'))) { setLeadView(el.dataset.leadView); renderLeads(); return; }
  if ((el = hit('[data-lead-response]'))) { setLeadResponse(Number(el.dataset.leadId), el.dataset.leadResponse); return; }
  if ((el = hit('[data-share-quote]'))) { shareModal(Number(el.dataset.shareQuote)); return; }
  if ((el = hit('[data-wa-lead]'))) { const l = leadById(el.dataset.waLead); if (l) waModal({ clientId: l.client_id, leadId: l.id }); return; }
  if ((el = hit('[data-wa-trip]'))) { const tr = tripById(el.dataset.waTrip); if (tr) waModal({ clientId: tr.client_id, tripId: tr.id, quoteId: tr.quote_id || undefined }); return; }
  if ((el = hit('[data-mark-contacted]'))) {
    const id = Number(el.dataset.markContacted);
    el.disabled = true;
    mutate(() => send('POST', `/api/leads/${id}/contacted`), 'Lead marcado como contactado').then((ok) => { if (ok && !$('#modalBg').classList.contains('hidden') && $('#modalBody [data-mark-contacted]')) leadModal(id); });
    return;
  }
  if ((el = hit('[data-kb-move]'))) { moveMenu(Number(el.dataset.kbMove)); return; }
  if ((el = hit('[data-kb-owner]'))) { ownerModal(Number(el.dataset.kbOwner)); return; }
  if ((el = hit('#reassignLeads'))) { reassignModal(); return; }
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
$('#exportLeads').onclick = () => exportModal('leads');
$('#exportBtn').onclick = () => exportModal();
$('#quoteSearch').oninput = (e) => { ui.quoteQuery = e.target.value; renderQuotes(); };
$('#lostRange').onchange = () => renderLostReport();
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
$('#calPrev').onclick = () => calShift(-1);
$('#calNext').onclick = () => calShift(1);
$('#calToday').onclick = () => { ui.calDay = todayStr(); renderCalendar(); };
$$('[data-cal-view]').forEach((b) => { b.onclick = () => setCalView(b.dataset.calView); });
$('#calOwner').onchange = (e) => { ui.calOwner = e.target.value; renderCalendar(); };
$('#calGoogle').onclick = () => googleCalendarModal();
// Doble clic en un horario vacío: nuevo seguimiento a esa hora.
$('#calendar').addEventListener('dblclick', (e) => {
  const slot = e.target.closest('.cal-slot, .cal-cell');
  if (!slot || e.target.closest('.cal-ev') || !canWrite('followups')) return;
  followupModal(null, { due: `${slot.dataset.dropDay}T${slot.dataset.dropTime || '10:00'}` });
});
$('#saveSettings').onclick = () => mutate(() => send('PUT', '/api/settings/agency', {
  name: $('#setName').value, whatsapp: $('#setWhatsapp').value, email: $('#setEmail').value, website: $('#setWebsite').value
}), 'Configuración guardada');
$('#cancelSettings').onclick = renderSettings;

// Refresca la fecha y los datos cada 5 minutos para que el dashboard no se quede en el día anterior.
setInterval(() => { if (currentUser && !currentUser.mustChangePassword && $('#modalBg').classList.contains('hidden')) loadAll(); }, 5 * 60 * 1000);

// El enlace del correo también funciona si se pega en una pestaña donde la plataforma ya está abierta.
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#reset=')) handleResetLink(); });

restoreSession();
