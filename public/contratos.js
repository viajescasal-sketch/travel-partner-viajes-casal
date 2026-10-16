'use strict';

/* =========================================================
   TP-204 Contrato y términos con firma electrónica
   Estado del contrato en el plan de pagos y Configuración › Contrato.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const C = window.TPContract;
  const contractUrl = (q) => (q.pay_token ? `${location.origin}/contrato/${q.pay_token}` : '');
  const when = (dt) => `${fmtDate(String(dt || '').slice(0, 10))} ${String(dt || '').slice(11, 16)}`;

  // Renglón del contrato dentro del plan de pagos.
  window.contractPlanHtml = (q) => {
    if (!C || !q.payment_plan) return '';
    const st = C.state(q);
    const write = canWrite('quotes');
    const c = q.contract || {};
    const view = q.pay_token && st !== 'none' ? `<a class="btn secondary small" href="${H(contractUrl(q))}" target="_blank" rel="noopener">Ver contrato</a>` : '';
    let body = '';
    if (st === 'none') body = `<b>📝 Contrato:</b> esta venta no pide firma en línea.${write ? ' <button type="button" class="btn secondary small" data-ct-act="require">Pedir firma al cliente</button>' : ''}`;
    else if (st === 'pending') body = `<b>📝 Contrato pendiente de firma.</b> Su liga de pago le pide firmarlo primero y no puede pagar en línea hasta hacerlo. Envíale la liga por WhatsApp (“Liga para apartar”).<span class="ct-acts">${view}${isAdmin() ? '<button type="button" class="link" data-ct-act="waive">Lo firmó en papel</button>' : ''}</span>`;
    else if (st === 'signed') {
      const changed = c.signed.total != null && Math.abs(Number(c.signed.total) - Number(q.payment_plan.total)) > 0.5;
      body = `<b>✅ Contrato firmado</b> por ${H(c.signed.name)} el ${H(when(c.signed.at))} · huella ${H(String(c.signed.hash).slice(0, 12))}…<span class="ct-acts">${view}</span>${changed ? `<span class="pax-alert warn">⚠ El total del plan cambió después de la firma (firmó por ${money(c.signed.total)}). Si el cambio es importante, pide una nueva firma por escrito.</span>` : ''}`;
    } else if (st === 'waived') body = `<b>📄 Contrato fuera de línea:</b> ${H(c.waived?.reason || 'firmado en papel')} (${H(when(c.waived?.at))}).<span class="ct-acts">${view}</span>`;
    return `<div class="ct-row ct-${st}" data-ct-quote="${q.id}">${body}</div>`;
  };

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ct-act]');
    if (!btn) return;
    const row = btn.closest('[data-ct-quote]');
    const id = Number(row?.dataset.ctQuote);
    if (!id) return;
    const action = btn.dataset.ctAct;
    let reason = '';
    if (action === 'waive') {
      reason = prompt('¿Cómo se firmó el contrato? (por ejemplo: “Firmado en papel en oficina el 12 de octubre”)', 'Firmado en papel');
      if (reason === null) return;
    }
    btn.disabled = true;
    const ok = await mutate(() => send('POST', `/api/quotes/${id}/contract`, { action, reason }), action === 'require' ? 'Listo: el cliente firmará antes de pagar' : 'Contrato registrado como firmado fuera de línea');
    if (ok) payPlanModal(id); else btn.disabled = false;
  });

  /* ---------------- Configuración › Contrato ---------------- */
  window.renderContractSettings = async () => {
    const box = $('#contractSettingsBody');
    if (!box || !C) return;
    let s;
    try { s = await api('/api/contract/settings'); } catch (error) { box.innerHTML = `<p class="muted">${H(error.message)}</p>`; return; }
    box.innerHTML = `<form class="modal-form" id="ctForm">
      <label class="full kb-check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Pedir firma del contrato antes del anticipo en cada venta nueva</label>
      <p class="full muted-note">Cuando una cotización se acepta (en línea o en la plataforma), su liga de pago primero muestra el contrato: el cliente escribe su nombre, acepta y firma con el dedo o el mouse. Se guarda la copia firmada con fecha, hora, IP, dispositivo y huella SHA-256 del documento. Las ventas anteriores no cambian; desde su plan de pagos puedes “Pedir firma al cliente”.</p>
      ${field('Título del contrato', `<input name="title" maxlength="120" value="${H(s.title)}">`)}
      ${field('Ciudad (jurisdicción)', `<input name="city" maxlength="80" value="${H(s.city)}">`)}
      <label class="full">Cláusulas <small class="muted">(una por párrafo, separadas por un renglón en blanco; se numeran solas)</small><textarea name="clauses" rows="18" maxlength="15000">${H(s.clauses)}</textarea></label>
      <div class="full ct-vars"><b>Variables:</b> ${s.placeholders.map(([k, label]) => `<button type="button" class="chip-btn" data-ct-var="${H(k)}" title="${H(label)}">${H(k)}</button>`).join(' ')}</div>
      <p class="full muted-note">El contrato también incluye solo los datos del viaje (folio, destino, fechas, servicio), el total y el plan de pagos. <b>{politicas}</b> y <b>{terminos}</b> toman los textos de Configuración › Plantilla PDF (Confirmación de servicios).</p>
      <p class="full note-warn">⚖️ El texto sugerido es un punto de partida: revísalo con tu abogado antes de usarlo, y confirma con él si tu contrato de adhesión debe registrarse ante PROFECO.</p>
      <div class="modal-actions"><button type="button" class="btn secondary" id="ctReset">Restaurar texto sugerido</button><button type="button" class="btn secondary" id="ctPreview">Vista previa</button><button type="submit" class="btn primary">Guardar</button></div></form>`;
    const form = $('#ctForm');
    let lastFocus = form.clauses;
    form.clauses.addEventListener('focus', () => { lastFocus = form.clauses; });
    form.onclick = (e) => {
      const v = e.target.closest('[data-ct-var]');
      if (v) {
        const ta = lastFocus; const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, pos) + v.dataset.ctVar + ta.value.slice(ta.selectionEnd ?? pos);
        ta.focus(); ta.selectionStart = ta.selectionEnd = pos + v.dataset.ctVar.length;
        return;
      }
      if (e.target.id === 'ctReset') { if (confirm('¿Reemplazar las cláusulas por el texto sugerido?')) { form.clauses.value = s.defaults.clauses; form.title.value = s.defaults.title; } return; }
      if (e.target.id === 'ctPreview') preview(formValues(form));
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try { await send('PUT', '/api/contract/settings', { enabled: Boolean(v.enabled), title: v.title, city: v.city, clauses: v.clauses }); toast('Contrato guardado'); } catch (error) { toast(error.message, 6000); }
    };
  };

  // Vista previa con una venta de ejemplo (o la última aceptada).
  function preview(v) {
    const q = [...db.quotes].filter((x) => x.payment_plan).sort((a, b) => String(b.accepted_at).localeCompare(String(a.accepted_at)))[0];
    const sample = q ? { quote: q, client: clientById(q.client_id) || {}, lead: q.lead_id ? db.leads.find((l) => l.id === q.lead_id) : null, plan: q.payment_plan }
      : { quote: { folio: 'COT-0001', destination: 'Cancún', hotel: 'Hotel de ejemplo — Todo incluido', price: 30000 }, client: { name: 'Cliente de ejemplo' }, lead: { start_date: todayStr(), end_date: addDays(todayStr(), 5), travelers: 2 }, plan: { total: 30000, installments: [{ label: 'Anticipo', amount: 9000, due: addDays(todayStr(), 3) }, { label: 'Liquidación', amount: 21000, due: addDays(todayStr(), 30) }] } };
    const doc = C.build({ cfg: { title: v.title, clauses: v.clauses, city: v.city }, documents: db.documents, agency: db.agency, ...sample });
    openModal('VISTA PREVIA DEL CONTRATO', q ? `Con los datos de ${q.folio}` : 'Con una venta de ejemplo', `<div class="ct-doc"><h3>${H(doc.title)}</h3><p>${H(doc.intro)}</p>${doc.blocks.map((b) => `<h4>${H(b.h)}</h4>${b.rows ? `<table>${b.rows.map(([k, val]) => `<tr><td>${H(k)}</td><td>${H(val)}</td></tr>`).join('')}</table>` : ''}${b.items ? `<ol>${b.items.map((t) => `<li>${H(t)}</li>`).join('')}</ol>` : ''}`).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn secondary" id="ctBack">Volver</button></div>`, { wide: true });
    $('#ctBack').onclick = () => { close(); };
  }
}());
