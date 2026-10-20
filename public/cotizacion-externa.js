'use strict';

/* =========================================================
   TP-113 · Adjuntar cotización hecha fuera del CRM (PDF, imagen o link)
   Queda como una cotización real (folio, monto, estado) marcada 📎 Adjunta.
   Usa las utilidades de app.js.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const MAX = 5 * 1024 * 1024;
  window.isExternalQuote = (q) => Boolean(q && q.details && q.details.external);
  const fileUrl = (ext) => (ext.kind === 'link' ? ext.url : `/api/media/${Number(ext.media_id)}`);
  window.openExternalQuote = (q, win) => {
    const url = fileUrl(q.details.external);
    if (win) { win.location.href = url; return; }
    const opened = window.open(url, '_blank'); // sin 'noopener': con él window.open devuelve null
    if (opened) opened.opener = null; else location.href = url;
  };

  // after: qué abrir al terminar (por ejemplo, volver a la ficha del lead).
  function externalQuoteModal(id, preset = {}) {
    const quote = id ? quoteById(id) : null;
    const editable = canWrite('quotes');
    if (!quote && !editable) return;
    const lead = preset.leadId ? leadById(preset.leadId) : quote?.lead_id ? leadById(quote.lead_id) : null;
    const ext = { kind: 'file', ...(quote?.details?.external || {}) };
    const state = {
      client_id: quote?.client_id ?? preset.clientId ?? lead?.client_id ?? '',
      lead_id: quote?.lead_id ?? lead?.id ?? '',
      kind: ext.kind, media_id: ext.media_id || null, name: ext.name || '', mime: ext.mime || '', url: ext.kind === 'link' ? ext.url : ''
    };
    const back = () => { if (preset.after) preset.after(); else close(); };
    const leadChoices = () => db.leads.filter((l) => l.client_id === Number(state.client_id)).map((l) => [l.id, `${l.destination} · ${fmtRange(l.start_date, l.end_date)} · ${l.stage}`]);
    const fileBox = () => (state.media_id
      ? `<div class="xq-file"><span>${state.mime === 'application/pdf' ? '📄' : '🖼'} <a class="link" href="/api/media/${Number(state.media_id)}" target="_blank" rel="noopener">${H(state.name || 'Archivo')}</a></span>${editable ? '<label class="btn secondary small">Cambiar archivo<input type="file" data-xq-file accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label>' : ''}</div>`
      : `<label class="xq-drop" data-xq-drop><input type="file" data-xq-file accept="application/pdf,image/jpeg,image/png,image/webp" hidden><b>📄 Elige el PDF o la foto de la cotización</b><small>o arrástralo aquí · máximo 5 MB</small><span class="xq-busy hidden">Subiendo…</span></label>`);
    const html = `<form class="modal-form xq">
      <p class="full muted-note">Para clientes o leads que ya trabajaste antes del CRM: queda registrada como cotización (cuenta en el embudo y reportes) y, si se acepta, sigue el flujo normal de plan de pagos y viaje.</p>
      ${quote ? '' : field('Cliente*', `<select name="client_id" required>${options(db.clients.map((c) => [c.id, c.name]), state.client_id, { blank: 'Elige el cliente' })}</select>`)}
      ${quote ? `<div class="full fixed-client">${clientCell(clientById(quote.client_id))}<b>${H(quote.folio)}</b></div>` : field('Lead (opcional)', `<select name="lead_id">${options(leadChoices(), state.lead_id, { blank: 'Sin lead' })}</select>`)}
      <div class="full xq-kind" role="group" aria-label="Tipo de adjunto"><button type="button" data-xq-kind="file" class="${state.kind === 'file' ? 'on' : ''}">📄 Subir PDF o imagen</button><button type="button" data-xq-kind="link" class="${state.kind === 'link' ? 'on' : ''}">🔗 Pegar link</button></div>
      <div class="full" id="xqFile"${state.kind === 'file' ? '' : ' hidden'}>${fileBox()}</div>
      <label class="full" id="xqLink"${state.kind === 'link' ? '' : ' hidden'}>Link de la cotización (Drive, Canva, portal del mayorista…)<input name="url" type="url" maxlength="600" placeholder="https://" value="${H(state.url)}"></label>
      ${field('Destino*', `<input name="destination" required maxlength="120" value="${H(quote?.destination ?? lead?.destination ?? '')}">`)}
      ${field('Hotel o descripción', `<input name="hotel" maxlength="200" value="${H(quote?.hotel ?? '')}" placeholder="Riu Palace · 4 noches todo incluido" list="tpSupList">`)}
      ${field('Monto total (MXN)*', `<input name="price" required inputmode="decimal" maxlength="14" value="${H(quote?.price ?? '')}">`)}
      ${field('Modalidad', `<select name="mode">${options(QUOTE_MODES, quote?.mode || 'Total')}</select>`)}
      ${field('Estado', `<select name="status">${options(QUOTE_STATUSES, quote?.status || 'Enviada')}</select>`)}
      ${field('Vigencia', `<input name="valid_until" type="date" value="${H(quote?.valid_until || '')}">`)}
      ${field('Fecha en que se cotizó', `<input name="date" type="date" value="${H(ext.date || '')}">`)}
      ${field('Folio o referencia original', `<input name="ref" maxlength="60" value="${H(ext.ref || '')}" placeholder="HOTELDO-7788">`)}
      ${field('Notas', `<textarea name="notes" rows="2" maxlength="500">${H(ext.notes || '')}</textarea>`, true)}
      ${quote && quote.status === 'Aceptada' ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-pay-plan="${quote.id}">💳 Plan de pagos y liga</button><button type="button" class="btn secondary small" data-trip-from-quote="${quote.id}">Crear viaje con esta cotización</button></div>` : ''}
      ${quote ? `<div class="full quick-actions"><button type="button" class="btn secondary small" data-pdf="${quote.id}">${ext.kind === 'link' ? '🔗 Abrir link' : '📄 Abrir archivo'}</button>${editable ? `<button type="button" class="btn secondary small" data-whatsapp="${quote.id}">💬 WhatsApp</button>` : ''}</div>${historyButton('quotes', quote.id)}${deleteBlock('cotización', quote.id)}` : ''}
      <div class="modal-actions"><button type="button" class="btn secondary" data-xq-back>${preset.after ? 'Volver' : 'Cancelar'}</button>${editable ? `<button type="submit" class="btn primary">${quote ? 'Guardar cambios' : 'Guardar cotización'}</button>` : ''}</div>
    </form>`;
    openModal('COTIZACIÓN ADJUNTA', quote ? `${quote.folio} · ${clientName(quote.client_id)}` : 'Adjuntar cotización ya trabajada', html);
    if (typeof paintDatalist === 'function') paintDatalist();
    const body = $('#modalBody');
    const form = body.querySelector('form');
    if (!editable) form.querySelectorAll('input,select,textarea').forEach((el) => { el.disabled = true; });

    async function upload(file) {
      if (!file) return;
      if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.type)) { toast('Sube un PDF o una imagen JPG, PNG o WebP'); return; }
      if (file.size > MAX) { toast(`${file.name} pesa más de 5 MB. Comprímelo o usa un link.`, 6000); return; }
      body.querySelector('.xq-busy')?.classList.remove('hidden');
      try {
        const res = await fetch('/api/quote-files', { method: 'POST', headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) }, body: file });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'No se pudo subir el archivo');
        Object.assign(state, { media_id: out.media_id, name: out.name || file.name, mime: out.mime });
        $('#xqFile').innerHTML = fileBox();
        toast('Archivo listo. Completa los datos y guarda.');
      } catch (error) { toast(error.message, 6000); body.querySelector('.xq-busy')?.classList.add('hidden'); }
    }
    body.onchange = (e) => {
      if (e.target.matches('[data-xq-file]')) upload(e.target.files[0]);
      if (e.target.name === 'client_id') { state.client_id = e.target.value; form.querySelector('[name=lead_id]').innerHTML = options(leadChoices(), '', { blank: 'Sin lead' }); }
      if (e.target.name === 'lead_id' && e.target.value) { const l = leadById(e.target.value); const d = form.querySelector('[name=destination]'); if (l && !d.value) d.value = l.destination; }
    };
    body.onclick = (e) => {
      const k = e.target.closest('[data-xq-kind]');
      if (k) { state.kind = k.dataset.xqKind; body.querySelectorAll('[data-xq-kind]').forEach((b) => b.classList.toggle('on', b === k)); $('#xqFile').hidden = state.kind !== 'file'; $('#xqLink').hidden = state.kind !== 'link'; return; }
      if (e.target.closest('[data-xq-back]')) back();
    };
    const drop = () => body.querySelector('[data-xq-drop]');
    body.ondragover = (e) => { if (drop()) { e.preventDefault(); drop().classList.add('over'); } };
    body.ondragleave = () => drop()?.classList.remove('over');
    body.ondrop = (e) => { if (!drop()) return; e.preventDefault(); drop().classList.remove('over'); upload(e.dataTransfer.files[0]); };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      const external = state.kind === 'link'
        ? { kind: 'link', url: String(v.url || '').trim() }
        : { kind: 'file', media_id: state.media_id, name: state.name };
      if (external.kind === 'file' && !external.media_id) { toast('Sube el PDF o la imagen de la cotización'); return; }
      if (external.kind === 'link' && !/^https?:\/\//i.test(external.url)) { toast('Pega el link completo (empieza con https://)'); return; }
      Object.assign(external, { ref: v.ref, date: v.date, notes: v.notes });
      const price = Number(String(v.price).replace(/[^0-9.]/g, ''));
      if (!(price > 0)) { toast('Escribe el monto total de la cotización'); return; }
      const payload = { destination: v.destination, hotel: v.hotel || '', price, mode: v.mode, status: v.status, valid_until: v.valid_until || null, details: { external } };
      if (!quote) { payload.client_id = Number(v.client_id); payload.lead_id = v.lead_id ? Number(v.lead_id) : null; }
      const btn = form.querySelector('button.primary');
      btn.disabled = true;
      const res = await mutate(() => (quote ? send('PATCH', `/api/quotes/${quote.id}`, payload) : send('POST', '/api/quotes', payload)), quote ? 'Cotización actualizada' : 'Cotización adjunta registrada');
      btn.disabled = false;
      if (res) back();
    };
    if (quote) bindDelete(`/api/quotes/${quote.id}`, 'Cotización eliminada');
  }
  window.externalQuoteModal = externalQuoteModal;

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-attach-quote],[data-attach-quote-client],[data-attach-quote-lead]');
    if (!el || !canWrite('quotes')) return;
    if (el.dataset.attachQuoteLead) { const id = Number(el.dataset.attachQuoteLead); externalQuoteModal(null, { leadId: id, after: () => leadFile(id, 'quotes') }); }
    else if (el.dataset.attachQuoteClient) externalQuoteModal(null, { clientId: Number(el.dataset.attachQuoteClient) });
    else externalQuoteModal(null, {});
  });
}());
