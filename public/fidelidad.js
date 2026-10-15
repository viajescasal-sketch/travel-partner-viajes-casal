'use strict';

/* =========================================================
   TP-308 Encuesta y reseña postviaje · TP-309 Programa de referidos
   Pantallas de la plataforma (usa las utilidades de app.js).
   ========================================================= */
(function () {
  const H = escapeHtml;
  let cfg = null; // configuración de postviaje y referidos
  const loadCfg = async () => { try { cfg = await api('/api/postventa/settings'); } catch { cfg = cfg || null; } return cfg; };
  loadCfg();
  const stars = (n) => (n ? `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` : '—');

  // Variables de las plantillas de WhatsApp.
  window.postventaVars = ({ client, trip }) => {
    const code = client?.referral?.code || '';
    return {
      liga_encuesta: trip?.survey?.token ? `${location.origin}/encuesta/${trip.survey.token}` : '',
      codigo_referido: code, liga_referido: code ? `${location.origin}/r/${code}` : '',
      beneficio_referido: cfg ? money(cfg.referrerAmount) : '', descuento_referido: cfg ? money(cfg.welcomeAmount) : ''
    };
  };

  /* ---------------- TP-308 · Encuesta del viaje ---------------- */
  window.surveyLabel = (t) => (t.survey?.answers ? `⭐ Encuesta ${t.survey.answers.overall}★` : t.survey?.sent_at ? '⭐ Encuesta enviada' : '⭐ Encuesta');
  async function surveyModal(tripId) {
    let t = tripById(tripId);
    if (!t) return;
    const client = clientById(t.client_id);
    let r;
    try { r = await send('POST', `/api/trips/${t.id}/survey`, {}); } catch (error) { toast(error.message); return; }
    t.survey = r.survey;
    const s = r.survey;
    const a = s.answers;
    const status = a ? `✅ Contestada el ${fmtDue(s.answered_at)}` : s.opened_at ? `👀 La abrió el ${fmtDue(s.opened_at)}, sin contestar` : s.sent_at ? `📤 Enviada el ${fmtDue(s.sent_at)}${s.email_sent_at ? ' (también por correo)' : ''}` : 'Aún no se envía. Se manda sola un día después del regreso.';
    openModal('ENCUESTA POSTVIAJE', `${client?.name || ''} · ${t.destination}`, `<div class="it">
      <label class="gcal-url">Liga de la encuesta<span><input id="svUrl" readonly value="${H(r.url)}"><button type="button" class="btn secondary small" id="svCopy">Copiar</button></span></label>
      <p class="muted-note">${H(status)}</p>
      ${a ? `<div class="sv-answers"><div><span>General</span><b>${stars(a.overall)}</b></div><div><span>Hotel</span><b>${stars(a.hotel)}</b></div><div><span>Traslados</span><b>${stars(a.transfer)}</b></div><div><span>Travel Partner</span><b>${stars(a.partner)}</b></div><div><span>Recomendaría</span><b>${a.nps != null ? `${a.nps}/10` : '—'}</b></div>${a.comment ? `<p class="full">“${H(a.comment)}”${a.publish ? ' <small>· autorizó publicarlo</small>' : ''}</p>` : ''}${s.review_click_at ? `<p class="full">⭐ Abrió la liga de reseña (${H(s.review_platform || '')}).</p>` : ''}</div>` : ''}
      <div class="it-acts">${client?.phone ? '<button type="button" class="btn primary small" id="svWa">💬 Enviar por WhatsApp</button>' : ''}${client?.email && !a ? '<button type="button" class="btn secondary small" id="svMail">✉️ Enviar por correo</button>' : ''}${!s.sent_at ? '<button type="button" class="btn secondary small" id="svMark">Marcar como enviada</button>' : ''}<a class="btn secondary small" href="${H(r.url)}" target="_blank" rel="noopener">Ver como cliente</a></div>
      <div class="modal-actions"><button type="button" class="btn secondary" data-sv-back>Volver al viaje</button></div></div>`);
    $('#svCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.url); } catch { $('#svUrl').select(); document.execCommand('copy'); } toast('Liga copiada'); };
    const body = $('#modalBody');
    body.onclick = (e) => { if (e.target.closest('[data-sv-back]')) tripModal(t.id); };
    if ($('#svWa')) $('#svWa').onclick = async () => { if (!s.sent_at) { try { await send('POST', `/api/trips/${t.id}/survey`, { markSent: true }); } catch { /* sigue */ } } await loadAll(); waModal({ clientId: t.client_id, tripId: t.id, stage: 'postviaje', templateId: 'pv3' }); };
    if ($('#svMail')) $('#svMail').onclick = async (e) => { e.target.disabled = true; if (await mutate(() => send('POST', `/api/trips/${t.id}/survey`, { email: true }), `Encuesta enviada a ${client.email}`)) surveyModal(t.id); else e.target.disabled = false; };
    if ($('#svMark')) $('#svMark').onclick = async () => { if (await mutate(() => send('POST', `/api/trips/${t.id}/survey`, { markSent: true }), 'Encuesta marcada como enviada')) surveyModal(t.id); };
  }
  window.surveyModal = surveyModal;

  /* ---------------- TP-309 · Referidos ---------------- */
  // Ficha del lead: quién lo refirió y su descuento de bienvenida.
  window.paintLeadReferral = (lead) => {
    const box = $('#leadRef');
    if (!box) return;
    const r = lead.referral;
    if (r) {
      box.innerHTML = `<div class="ref-box"><span>🤝 <b>Referido por ${H(r.referrer_name)}</b> <small>· ${H(r.code)} · ${H(r.via || '')}</small></span>
        ${Number(r.welcome_amount) ? `<label class="ref-welcome">Descuento de bienvenida ${money(r.welcome_amount)} <select id="refWelcome">${options(['Por aplicar', 'Aplicado', 'Sin descuento'], r.welcome_status)}</select></label>` : ''}
        ${canWrite('leads') ? '<button type="button" class="link danger-link" id="refRemove">Quitar</button>' : ''}${r.rewarded_at ? `<small>🎁 ${H(r.referrer_name)} ya ganó su crédito</small>` : ''}</div>`;
      const sel = $('#refWelcome');
      if (sel) sel.onchange = async () => { if (await mutate(() => send('PATCH', `/api/leads/${lead.id}/referral`, { welcome_status: sel.value }), `Descuento de bienvenida: ${sel.value}`)) lead.referral.welcome_status = sel.value; };
      const rm = $('#refRemove');
      if (rm) rm.onclick = async () => { if (!confirm(`¿Quitar a ${r.referrer_name} como quien refirió este lead?`)) return; const out = await mutate(() => send('PUT', `/api/leads/${lead.id}/referral`, { code: '' }), 'Referido quitado'); if (out) { lead.referral = null; paintLeadReferral(lead); } };
      return;
    }
    if (!canWrite('leads') || (cfg && !cfg.referralEnabled)) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="ref-box"><span>🤝 ¿Viene recomendado?</span><input id="refCode" maxlength="12" placeholder="Código VC-…" autocomplete="off"><button type="button" class="btn secondary small" id="refLink">Ligar referido</button></div>`;
    $('#refLink').onclick = async () => {
      const code = $('#refCode').value.trim().toUpperCase();
      if (!code) { toast('Escribe el código de quien lo recomendó'); return; }
      const out = await mutate(() => send('PUT', `/api/leads/${lead.id}/referral`, { code }), 'Lead ligado a quien lo refirió');
      if (out?.record) { lead.referral = out.record.referral; paintLeadReferral(lead); }
    };
  };

  // Ficha 360 › Datos del cliente: su código, liga, a quién ha referido y créditos ganados.
  window.paintClientReferral = async (c) => {
    const box = $('#c360Referral');
    if (!box) return;
    let r;
    try { r = await api(`/api/clients/${c.id}/referral`); } catch { box.innerHTML = ''; return; }
    if (!r.enabled && !r.rewards.length) { box.innerHTML = ''; return; }
    const local = clientById(c.id);
    if (local && r.code) local.referral = { ...(local.referral || {}), code: r.code, rewards: r.rewards };
    const pending = r.rewards.filter((x) => x.status === 'Pendiente').reduce((s, x) => s + x.amount, 0);
    box.innerHTML = `<b>🎁 Programa de referidos</b>
      ${r.code ? `<div class="ref-code"><span>Código <b>${H(r.code)}</b></span><input readonly value="${H(r.url)}" id="refUrl"><button type="button" class="btn secondary small" id="refCopy">Copiar liga</button>${c.phone ? '<button type="button" class="btn primary small" id="refWa">💬 Invitar por WhatsApp</button>' : ''}</div>
      <p class="muted-note">Sus amigos reciben ${money(r.settings.welcomeAmount)} de descuento y ${H(c.name.split(' ')[0])} gana ${money(r.settings.referrerAmount)} cuando compran.</p>` : '<p class="muted-note">El programa está pausado.</p>'}
      ${r.referred.length ? `<div class="lead-fups"><b>Ha referido a ${r.referred.length}</b>${r.referred.map((x) => `<button type="button" class="lead-fup" data-lead="${x.id}"><span>${H(x.client_name)} · ${H(x.destination)}</span><small>${H(x.stage)}</small></button>`).join('')}</div>` : ''}
      ${r.rewards.length ? `<div class="ref-rewards"><b>Créditos ganados${pending ? ` · ${money(pending)} por aplicar` : ''}</b>${r.rewards.map((w) => `<div class="comp-row"><span><b>${money(w.amount)}</b> por ${H(w.client_name)} (${H(w.destination)})<small>${H(fmtDate(w.created_at))}${w.applied_at ? ` · aplicado ${H(fmtDate(w.applied_at))}` : ''}${w.note ? ` · ${H(w.note)}` : ''}</small></span>${canWrite('clients') ? `<select data-rw="${H(w.id)}">${options(['Pendiente', 'Aplicado', 'Cancelado'], w.status)}</select>` : `<small>${H(w.status)}</small>`}</div>`).join('')}</div>` : ''}`;
    const copy = $('#refCopy');
    if (copy) copy.onclick = async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(r.url); } catch { $('#refUrl').select(); document.execCommand('copy'); } toast('Liga copiada'); };
    const wa = $('#refWa');
    if (wa) wa.onclick = (e) => { e.stopPropagation(); waModal({ clientId: c.id, stage: 'postviaje', templateId: 'pv4' }); };
    box.onchange = async (e) => {
      const sel = e.target.closest('[data-rw]');
      if (!sel) return;
      const note = sel.value === 'Aplicado' ? (prompt('¿Dónde se aplicó? (ej. folio de la cotización)', '') || '') : '';
      try { await send('PATCH', `/api/clients/${c.id}/referral/rewards/${sel.dataset.rw}`, { status: sel.value, note }); toast(`Crédito: ${sel.value}`); paintClientReferral(c); } catch (error) { toast(error.message); }
    };
  };

  /* ---------------- Configuración ---------------- */
  window.renderPostventaSettings = async () => {
    const box = $('#postventaBody');
    if (!box) return;
    const s = await loadCfg();
    if (!s) { box.innerHTML = '<p class="muted">No se pudo cargar.</p>'; return; }
    box.innerHTML = `<form class="modal-form" id="pvForm">
      <p class="full section-label">⭐ Encuesta postviaje</p>
      <label class="full kb-check"><input type="checkbox" name="surveyEnabled" ${s.surveyEnabled ? 'checked' : ''}> Generar la encuesta sola al regreso de cada viaje (aviso + seguimiento al vendedor con el WhatsApp listo)</label>
      ${field('¿Cuándo?', `<select name="delayDays">${options([[0, 'El día del regreso'], [1, '1 día después del regreso'], [2, '2 días después'], [3, '3 días después'], [7, '1 semana después']], s.delayDays)}</select>`)}
      ${field('Pedir reseña pública desde', `<select name="goodRating">${options([[5, '5 estrellas'], [4, '4 estrellas o más'], [3, '3 estrellas o más']], s.goodRating)}</select>`)}
      <label class="full kb-check"><input type="checkbox" name="emailClient" ${s.emailClient ? 'checked' : ''}> Enviar también la encuesta por correo al cliente (si tiene correo)</label>
      ${field('Liga de TripAdvisor (opcional)', `<input name="tripadvisorUrl" maxlength="300" value="${H(s.tripadvisorUrl)}" placeholder="https://www.tripadvisor.com.mx/…">`, true)}
      <p class="full muted-note">La liga de Google se toma de Configuración › Plantilla PDF (Reseñas de Google). Calificaciones de 3 estrellas o menos avisan al vendedor y al administrador.</p>
      <p class="full section-label">🎁 Programa de referidos</p>
      <label class="full kb-check"><input type="checkbox" name="referralEnabled" ${s.referralEnabled ? 'checked' : ''}> Programa de referidos activo</label>
      ${field('Crédito para quien refiere (MXN)', `<input name="referrerAmount" type="number" min="0" step="50" value="${H(s.referrerAmount)}">`)}
      ${field('Descuento de bienvenida para el referido (MXN)', `<input name="welcomeAmount" type="number" min="0" step="50" value="${H(s.welcomeAmount)}">`)}
      <p class="full muted-note">Cada cliente tiene un código (VC-…) y una liga para compartir. El crédito se genera cuando el referido compra (lead en Vendido).</p>
      <div class="modal-actions"><button type="submit" class="btn primary">Guardar</button></div></form>`;
    const form = $('#pvForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try {
        cfg = await send('PUT', '/api/postventa/settings', { surveyEnabled: Boolean(v.surveyEnabled), delayDays: Number(v.delayDays), goodRating: Number(v.goodRating), emailClient: Boolean(v.emailClient), tripadvisorUrl: v.tripadvisorUrl, referralEnabled: Boolean(v.referralEnabled), referrerAmount: Number(v.referrerAmount), welcomeAmount: Number(v.welcomeAmount) });
        toast('Postviaje y referidos guardados');
      } catch (error) { toast(error.message, 6000); }
    };
  };

  /* ---------------- Reportes ---------------- */
  window.renderPostventaReport = async () => {
    const box = $('#postventaReport');
    if (!box) return;
    let r;
    try { r = await api('/api/postventa/stats'); } catch { box.innerHTML = ''; return; }
    const s = r.survey, f = r.referrals;
    if ($('#repSat')) { $('#repSat').textContent = s.overall ? `${s.overall}★` : '—'; $('#repSatNote').textContent = s.answered ? `${s.answered} encuesta${s.answered === 1 ? '' : 's'} · NPS ${s.nps ?? '—'}` : 'Sin encuestas contestadas aún'; }
    box.innerHTML = `<div class="grid two">
      <article class="panel"><h3>⭐ Satisfacción postviaje</h3><p class="panel-sub">Encuestas enviadas al regreso de cada viaje</p>
        <div class="mini sv-kpis"><div>Respondidas<b>${s.answered}/${s.sent}</b><small>${s.rate}%</small></div><div>Calificación<b>${s.overall ?? '—'}${s.overall ? '★' : ''}</b></div><div>NPS<b>${s.nps ?? '—'}</b><small>${s.npsCount ? `${s.npsCount} respuesta${s.npsCount === 1 ? '' : 's'}` : ''}</small></div><div>A reseña<b>${s.reviewClicks}</b><small>${s.low ? `${s.low} bajas` : ''}</small></div></div>
        <p class="muted-note">Hotel ${s.hotel ?? '—'} · Traslados ${s.transfer ?? '—'} · Travel Partner ${s.partner ?? '—'}</p>
        ${r.comments.length ? r.comments.map((c) => `<div class="comp-row clickable" data-client="${c.client_id}"><span><b>${stars(c.overall)}</b> ${H(c.destination)}<small>${H(fmtDate(c.at))}${c.nps != null ? ` · recomendaría ${c.nps}/10` : ''}${c.publish ? ' · se puede publicar' : ''}</small>${c.comment ? `<small>“${H(c.comment)}”</small>` : ''}</span></div>`).join('') : '<p class="empty-note">Aún no hay respuestas.</p>'}</article>
      <article class="panel"><h3>🎁 Referidos</h3><p class="panel-sub">Leads que llegaron recomendados por clientes</p>
        <div class="mini sv-kpis"><div>Leads referidos<b>${f.leads}</b></div><div>Vendidos<b>${f.sold}</b><small>${f.leads ? `${Math.round((f.sold / f.leads) * 100)}%` : ''}</small></div><div>Créditos por aplicar<b>${money(f.pending)}</b></div><div>Aplicados<b>${money(f.applied)}</b></div></div>
        ${f.top.length ? `<b>Los que más recomiendan</b>${f.top.map((t) => `<div class="comp-row clickable" data-client="${t.id}"><span><b>${H(t.name)}</b><small>${t.leads} referido${t.leads > 1 ? 's' : ''} · ${t.sold} vendido${t.sold === 1 ? '' : 's'}</small></span></div>`).join('')}` : '<p class="empty-note">Aún no hay referidos.</p>'}</article></div>`;
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-survey-trip]');
    if (el) surveyModal(Number(el.dataset.surveyTrip));
  });
}());
