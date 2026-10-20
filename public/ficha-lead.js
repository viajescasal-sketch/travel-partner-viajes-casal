'use strict';

/* =========================================================
   TP-008 · Ficha del lead (Registro comercial)
   Encabezado con el cliente y botones de contacto, barra de etapas clicable,
   acciones rápidas y pestañas: Resumen · Viaje · Cotizaciones · Seguimientos · Calificación · Historial.
   Usa las utilidades de app.js (db, send, mutate, openModal…). El alta de un lead nuevo sigue con el formulario de siempre.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const TABS = [['summary', 'Resumen'], ['trip', 'Viaje y datos'], ['quotes', 'Cotizaciones'], ['followups', 'Seguimientos'], ['qual', 'Calificación'], ['history', 'Historial']];
  const STAGE_ICONS = { Nuevo: '🆕', Calificado: '🎯', Cotizado: '📄', 'Negociación': '🤝', Vendido: '🏆', Perdido: '✖' };
  const view = { id: null, tab: 'summary' };
  const waLink = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length === 10 ? `52${d}` : d}` : ''; };
  const telLink = (phone) => { const d = String(phone || '').replace(/[^\d+]/g, ''); return d ? `tel:${d}` : ''; };
  const leadQuotes = (lead) => db.quotes.filter((q) => q.lead_id === lead.id).sort((a, b) => b.id - a.id);
  const leadFups = (lead) => db.followups.filter((f) => f.lead_id === lead.id);
  const pendingFups = (lead) => leadFups(lead).filter((f) => !f.done).sort((a, b) => a.due_at.localeCompare(b.due_at));

  function scoreChip(lead) {
    const a = lead.auto;
    if (!a) return '';
    const cls = LEVEL_CLASS[a.level] || '';
    return `<span class="qual-chip ${cls}" title="Calificación automática · prioridad ${H(a.priority)}">${a.level === 'Caliente' ? '🔥 ' : ''}${a.score} · ${H(a.level)}</span>`;
  }
  // Siguiente paso sugerido según la etapa y lo que falta.
  function nextStep(lead) {
    const next = pendingFups(lead)[0];
    if (next) return { icon: FOLLOWUP_ICONS[next.type] || '📌', text: `${next.title}`, sub: fmtDue(next.due_at), late: isLateFollowup(next), attr: `data-followup="${next.id}"` };
    const quotes = leadQuotes(lead);
    if (['Vendido', 'Perdido'].includes(lead.stage)) return null;
    if (!lead.contacted_at && lead.stage === 'Nuevo') return { icon: '📞', text: 'Hacer el primer contacto', sub: 'Llámale o escríbele y márcalo como contactado', attr: '' };
    if (!quotes.length) return { icon: '📄', text: 'Preparar la cotización', sub: 'Aún no hay cotización para este lead', attr: `data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}"` };
    if (quotes.some((q) => q.status === 'Enviada')) return { icon: '⏰', text: 'Dar seguimiento a la cotización enviada', sub: 'Programa una llamada o WhatsApp', attr: `data-new-followup-lead="${lead.id}" data-followup-type="WhatsApp"` };
    return { icon: '⏰', text: 'Programar el siguiente seguimiento', sub: 'No hay seguimientos pendientes', attr: `data-new-followup-lead="${lead.id}"` };
  }
  const quoteRow = (q) => {
    const ext = q.details?.external;
    return `<div class="lf-quote"><button type="button" class="lf-quote-main" data-edit-quote="${q.id}"><span><b>${H(q.folio)}</b>${ext ? ` <span class="contact-chip ext-chip">📎 ${ext.kind === 'link' ? 'Link' : 'Adjunta'}</span>` : ''}<small>${H(q.hotel)} · ${H(q.destination)}</small></span><span class="lf-quote-price">${money(q.price)}<span class="status ${statusClass(q.status)}">${H(q.status)}</span></span></button>
      <span class="lf-quote-acts"><button type="button" class="btn secondary small" data-pdf="${q.id}">${ext ? (ext.kind === 'link' ? '🔗 Abrir' : '📄 Abrir') : 'Ver PDF'}</button>${canWrite('quotes') ? `<button type="button" class="btn secondary small" data-whatsapp="${q.id}">💬</button>` : ''}${q.status === 'Aceptada' && canWrite('quotes') ? `<button type="button" class="btn secondary small" data-pay-plan="${q.id}">💳</button>` : ''}</span></div>`;
  };
  const fupRow = (f) => `<button type="button" class="lead-fup${f.done ? ' done' : ''}${isLateFollowup(f) ? ' late' : ''}" data-followup="${f.id}"><span>${FOLLOWUP_ICONS[f.type] || '📌'} ${H(f.title)}</span><small>${f.done ? 'Hecho' : H(fmtDue(f.due_at))}</small></button>`;

  /* ---------------- pestañas ---------------- */
  function summaryTab(lead) {
    const step = nextStep(lead);
    const quotes = leadQuotes(lead);
    const facts = [['Destino', lead.destination], ['Fechas', fmtRange(lead.start_date, lead.end_date)], ['Viajeros', lead.travelers || '—'], ['Presupuesto', lead.budget ? money(lead.budget) : '—'], ['Origen', lead.source || '—'], ['Vendedor', userName(lead.owner_id)]];
    const custom = typeof customSummaryHtml === 'function' ? customSummaryHtml('leads', lead) : '';
    return `${step ? `<button type="button" class="lf-next${step.late ? ' late' : ''}" ${step.attr || 'data-lf-tab="followups"'}><span class="lf-next-ico">${step.icon}</span><span><small>Siguiente paso</small><b>${H(step.text)}</b><em>${H(step.sub)}</em></span><span>›</span></button>` : ''}
      ${leadContactHtml(lead)}
      <div class="lf-facts">${facts.map(([k, v]) => `<button type="button" data-lf-tab="trip"><small>${H(k)}</small><b>${H(v)}</b></button>`).join('')}</div>
      ${custom}
      <div class="lf-block"><div class="lf-block-head"><b>Cotizaciones (${quotes.length})</b><button type="button" class="link" data-lf-tab="quotes">Ver todas</button></div>${quotes.slice(0, 2).map(quoteRow).join('') || '<p class="lead-fups-empty">Aún no hay cotizaciones. Crea una o adjunta la que ya habías trabajado.</p>'}</div>
      <div class="lf-block"><div class="lf-block-head"><b>Notas</b><button type="button" class="link" data-lf-tab="trip">Editar</button></div><p class="lf-notes">${lead.notes ? H(lead.notes) : '<span class="muted">Sin notas.</span>'}</p></div>
      <div id="leadRef"></div>`;
  }
  function tripTab(lead) {
    return `<form class="modal-form" id="lfTripForm">
      ${field('Destino*', `<input name="destination" required maxlength="120" value="${H(lead.destination)}">`)}
      ${field('Origen', `<select name="source">${options(SOURCES, lead.source || 'WhatsApp')}</select>`)}
      ${field('Salida', `<input name="start_date" type="date" value="${H(lead.start_date)}">`)}
      ${field('Regreso', `<input name="end_date" type="date" value="${H(lead.end_date)}">`)}
      ${field('Viajeros', `<input name="travelers" type="number" min="1" max="500" value="${H(lead.travelers)}">`)}
      ${field('Presupuesto (MXN)', `<input name="budget" type="number" min="0" step="1" value="${H(lead.budget)}">`)}
      ${isAdmin() ? field('Vendedor asignado', `<select name="owner_id">${options(sellers().map((u) => [u.id, `${u.name} · ${ROLE_LABELS[u.role]}`]), lead.owner_id ?? currentUser.id)}</select>`, true) : ''}
      ${field('Notas', `<textarea name="notes" rows="4" maxlength="4000">${H(lead.notes)}</textarea>`, true)}
      ${typeof customFieldsHtml === 'function' ? customFieldsHtml('leads', lead.custom) : ''}
      ${deleteBlock('lead', lead.id)}
      <div class="modal-actions"><button type="submit" class="btn primary">Guardar datos</button></div></form>`;
  }
  function quotesTab(lead) {
    const quotes = leadQuotes(lead);
    const w = canWrite('quotes');
    return `${w ? `<div class="lf-tab-actions"><button type="button" class="btn primary small" data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}">📄 Nueva cotización</button><button type="button" class="btn secondary small" data-attach-quote-lead="${lead.id}">📎 Adjuntar cotización ya trabajada</button><button type="button" class="btn secondary small" data-cv-lead="${lead.id}">🧩 Armar en Canvas${lead.canvas?.blocks?.length ? ` (${lead.canvas.blocks.length})` : ''}</button></div>` : ''}
      ${quotes.map(quoteRow).join('') || '<p class="lead-fups-empty">Sin cotizaciones. Si ya la habías trabajado antes del CRM, usa “📎 Adjuntar cotización” (PDF, foto o link).</p>'}`;
  }
  function followupsTab(lead) {
    const list = leadFups(lead).sort((a, b) => Number(a.done) - Number(b.done) || (a.done ? b.due_at.localeCompare(a.due_at) : a.due_at.localeCompare(b.due_at)));
    return `<div class="lf-tab-actions"><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}" data-followup-type="Llamada">📞 Programar llamada</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}" data-followup-type="WhatsApp">💬 Programar WhatsApp</button><button type="button" class="btn secondary small" data-new-followup-lead="${lead.id}">📌 Otro seguimiento</button></div>
      ${leadContactHtml(lead)}
      <div class="lead-fups">${list.map(fupRow).join('') || '<p class="lead-fups-empty">Sin seguimientos para este lead.</p>'}</div>`;
  }
  function qualTab(lead) {
    const q = qualHtml(lead);
    return `${autoScoreHtml(lead) || '<p class="muted">La calificación automática aparece cuando el lead tiene datos.</p>'}
      ${q ? `<form id="lfQualForm" class="modal-form">${q}<div class="modal-actions"><button type="submit" class="btn primary">Guardar calificación</button></div></form>` : '<p class="muted-note">Puedes agregar preguntas de calificación en Configuración › Calificación de leads.</p>'}`;
  }
  function historyTab(lead) {
    const ev = [];
    const push = (at, icon, text) => { if (at) ev.push({ at: String(at), icon, text }); };
    push(lead.created_at, '🆕', `Lead registrado · origen ${lead.source || '—'}`);
    push(lead.assigned_at, '👤', `Asignado a ${userName(lead.owner_id)}`);
    push(lead.contacted_at, '✅', 'Primer contacto');
    leadQuotes(lead).forEach((q) => { push(q.created_at, '📄', `Cotización ${q.folio} · ${money(q.price)}`); push(q.sent_at, '📤', `Cotización ${q.folio} enviada`); push(q.accepted_at, '🎉', `Cotización ${q.folio} aceptada`); });
    leadFups(lead).filter((f) => f.done).forEach((f) => push(f.completed_at || f.due_at, FOLLOWUP_ICONS[f.type] || '📌', `${f.title} (hecho)`));
    push(lead.stage_changed_at, STAGE_ICONS[lead.stage] || '•', `Etapa actual: ${lead.stage}`);
    ev.sort((a, b) => b.at.localeCompare(a.at));
    return `<div class="lf-timeline">${ev.map((e) => `<div><span>${e.icon}</span><p>${H(e.text)}<small>${H(fmtDate(e.at.slice(0, 10)))} ${H(e.at.slice(11, 16))}</small></p></div>`).join('')}</div>${historyButton('leads', lead.id)}`;
  }

  /* ---------------- ficha ---------------- */
  function leadFile(id, tab) {
    const lead = leadById(id);
    if (!lead) return;
    if (view.id !== lead.id || $('#modalBg').classList.contains('hidden')) { view.id = lead.id; view.tab = 'summary'; } // al abrirla de nuevo empieza en Resumen
    if (tab) view.tab = tab;
    const client = clientById(lead.client_id) || {};
    const wa = waLink(client.phone);
    const tel = telLink(client.phone);
    const quotes = leadQuotes(lead);
    const pend = pendingFups(lead);
    const counts = { quotes: quotes.length, followups: pend.length };
    const stageIdx = BOARD_STAGES.indexOf(lead.stage);
    const html = `<div class="lf">
      <div class="lf-head">
        <div class="lf-who">${clientCell(client, [client.phone, client.email].filter(Boolean).join(' · '))}<span class="lf-chips"><span class="lf-stage s-${H(lead.stage)}">${STAGE_ICONS[lead.stage] || ''} ${H(lead.stage)}</span>${scoreChip(lead)}${typeof contactChip === 'function' ? contactChip(lead) : ''}${typeof customChipsHtml === 'function' ? customChipsHtml('leads', lead) : ''}</span></div>
        <div class="lf-contact">${wa ? `<a class="btn secondary small" href="${H(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}${tel ? `<a class="btn secondary small" href="${H(tel)}">📞 Llamar</a>` : ''}${client.email ? `<a class="btn secondary small" href="mailto:${H(client.email)}">✉️ Correo</a>` : ''}<button type="button" class="btn secondary small" data-client="${lead.client_id}">👤 Ficha 360</button></div>
      </div>
      <p class="lf-sub">✈️ <b>${H(lead.destination)}</b> · ${H(fmtRange(lead.start_date, lead.end_date))} · ${H(lead.travelers ? `${lead.travelers} viajero${lead.travelers > 1 ? 's' : ''}` : 'viajeros por definir')}${lead.budget ? ` · presupuesto ${money(lead.budget)}` : ''} · <small>creado ${H(fmtDate(lead.created_at))}</small></p>
      <div class="lf-stages" role="group" aria-label="Etapa del lead">${BOARD_STAGES.map((s, i) => `<button type="button" data-lf-stage="${H(s)}" class="${s === lead.stage ? 'on' : i < stageIdx ? 'done' : ''}"${s === lead.stage ? ' aria-current="step"' : ''}>${STAGE_ICONS[s]} ${H(s)}</button>`).join('')}<button type="button" data-lf-stage="Perdido" class="lost${lead.stage === 'Perdido' ? ' on' : ''}">✖ Perdido</button></div>
      ${lead.stage === 'Perdido' && lead.lost_reason ? `<p class="lf-lost">Perdido: ${H(lead.lost_reason)}</p>` : ''}
      <div class="lf-actions">
        <button type="button" data-wa-lead="${lead.id}"><span>💬</span>Plantilla WhatsApp</button>
        ${canWrite('quotes') ? `<button type="button" data-quote-for="${lead.client_id}" data-quote-lead="${lead.id}"><span>📄</span>Nueva cotización</button><button type="button" data-attach-quote-lead="${lead.id}"><span>📎</span>Adjuntar cotización</button>` : ''}
        <button type="button" data-new-followup-lead="${lead.id}" data-followup-type="Llamada"><span>📞</span>Programar llamada</button>
        <button type="button" data-new-followup-lead="${lead.id}" data-followup-type="WhatsApp"><span>⏰</span>Programar seguimiento</button>
        <button type="button" data-cv-lead="${lead.id}"><span>🧩</span>Canvas</button>
      </div>
      <nav class="lf-tabs" role="tablist">${TABS.map(([k, label]) => `<button type="button" role="tab" data-lf-tab="${k}" aria-selected="${view.tab === k}" class="${view.tab === k ? 'on' : ''}">${label}${counts[k] ? ` <em>${counts[k]}</em>` : ''}</button>`).join('')}</nav>
      <div class="lf-panel">${({ summary: summaryTab, trip: tripTab, quotes: quotesTab, followups: followupsTab, qual: qualTab, history: historyTab })[view.tab](lead)}</div>
    </div>`;
    openModal('REGISTRO COMERCIAL', `Lead de ${client.name || ''}`, html, { wide: true });
    bind(lead);
  }
  window.leadFile = leadFile;

  function bind(lead) {
    const body = $('#modalBody');
    if (view.tab === 'summary' && typeof paintLeadReferral === 'function') paintLeadReferral(lead);
    body.onclick = (e) => {
      const tab = e.target.closest('[data-lf-tab]');
      if (tab && !tab.matches('[data-followup],[data-quote-for],[data-new-followup-lead]')) { leadFile(lead.id, tab.dataset.lfTab); return; }
      const st = e.target.closest('[data-lf-stage]');
      if (st) {
        const stage = st.dataset.lfStage;
        if (stage === lead.stage) return;
        if (stage === 'Vendido' || stage === 'Perdido') { moveLead(lead.id, stage); return; }
        st.disabled = true;
        mutate(() => send('PATCH', `/api/leads/${lead.id}`, { stage }), `${clientName(lead.client_id)} → ${stage}`).then((ok) => { if (ok) leadFile(lead.id); else st.disabled = false; });
      }
    };
    const tripForm = $('#lfTripForm');
    if (tripForm) {
      bindDelete(`/api/leads/${lead.id}`, 'Lead eliminado');
      tripForm.onsubmit = async (e) => {
        e.preventDefault();
        const v = formValues(tripForm);
        const payload = clean({ destination: v.destination, source: v.source, start_date: v.start_date || null, end_date: v.end_date || null, travelers: v.travelers || null, budget: v.budget || null, notes: v.notes || null });
        if (typeof readCustomFields === 'function') { const cf = readCustomFields('leads', tripForm); if (cf) payload.custom = cf; }
        if (v.owner_id) payload.owner_id = Number(v.owner_id);
        const reassigned = payload.owner_id && payload.owner_id !== lead.owner_id;
        const btn = tripForm.querySelector('button.primary');
        btn.disabled = true;
        const ok = await mutate(() => send('PATCH', `/api/leads/${lead.id}`, payload), reassigned ? `Lead reasignado a ${userName(payload.owner_id)}` : 'Datos del lead guardados');
        btn.disabled = false;
        if (ok) leadFile(lead.id, 'summary');
      };
    }
    const qualForm = $('#lfQualForm');
    if (qualForm) {
      bindQualification();
      qualForm.onsubmit = async (e) => {
        e.preventDefault();
        const ok = await mutate(() => send('PATCH', `/api/leads/${lead.id}`, { qualification: readQualification() }), 'Calificación guardada');
        if (ok) leadFile(lead.id, 'qual');
      };
    }
  }
}());
