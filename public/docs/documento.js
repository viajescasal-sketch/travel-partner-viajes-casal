'use strict';

/* Vista imprimible de la cotización (?tipo=cotizacion&id=) o de la confirmación de servicios (?tipo=reserva&id=). */
(function () {
  const D = window.TPDocs;
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  // TP-110: liga privada para el cliente (/cotizacion/<token>): solo ver e imprimir.
  const shareToken = (location.pathname.match(/^\/cotizacion\/([a-f0-9]{40})$/) || [])[1] || null;
  const type = params.get('tipo') === 'reserva' ? 'reserva' : 'cotizacion';
  const id = Number(params.get('id'));
  let state = null;

  function toast(text, ms = 3200) {
    const el = $('#docToast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), ms);
  }
  async function api(url, opts = {}) {
    const response = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error || 'No se pudo cargar el documento'); error.status = response.status; throw error; }
    return body;
  }
  const button = (label, cls, onClick, extra = {}) => {
    const el = document.createElement(extra.href ? 'a' : 'button');
    el.className = `doc-btn ${cls || ''}`;
    el.textContent = label;
    if (extra.href) { el.href = extra.href; el.target = '_blank'; el.rel = 'noopener'; } else el.type = 'button';
    if (onClick) el.addEventListener('click', onClick);
    $('#docActions').append(el);
    return el;
  };
  function note(text, kind = '') {
    const el = $('#docNote');
    el.textContent = text;
    el.className = `doc-note ${kind}`;
  }
  async function copyMessage() {
    const text = $('#docMsgText').value;
    try { await navigator.clipboard.writeText(text); toast('Mensaje copiado. Pégalo en WhatsApp junto con el PDF.'); }
    catch { $('#docMsgText').select(); document.execCommand('copy'); toast('Mensaje copiado.'); }
  }
  // Espera las imágenes antes de imprimir para que salgan en el PDF.
  function waitImages() {
    const imgs = [...document.querySelectorAll('#docRoot img')].filter((i) => i.src && !i.complete);
    return Promise.all(imgs.map((img) => new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); setTimeout(res, 4000); })));
  }

  /* ---------- Cotización ---------- */
  function showTab(i) {
    document.querySelectorAll('#docRoot .sheet').forEach((s, idx) => { s.hidden = idx !== i; });
    document.querySelectorAll('#docTabs button').forEach((b, idx) => b.classList.toggle('active', idx === i));
    state.tab = i;
  }
  async function printQuote(all) {
    const sheets = [...document.querySelectorAll('#docRoot .sheet')];
    if (all) sheets.forEach((s) => { s.hidden = false; });
    await waitImages();
    window.print();
    if (all) showTab(state.tab);
    const q = state.payload.quote;
    if (state.payload.canEdit && q.status === 'Borrador') {
      try { await api(`/api/quotes/${q.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'PDF generado' }) }); q.status = 'PDF generado'; } catch { /* sin cambios */ }
    }
  }
  function renderQuote(payload) {
    const circuit = payload.quote.details?.kind === 'circuito';
    $('#docStyles').href = circuit ? '/docs/circuito.css?v=tp006' : '/docs/cotizacion.css?v=tp006';
    const model = circuit ? D.circuitModel(payload) : D.quoteModel(payload);
    if (circuit) model.dataList = [null];
    state = { payload, model, tab: 0 };
    document.title = `${payload.quote.folio} · ${payload.client?.name || 'Cotización'}`;
    $('#docTitle').textContent = `Cotización ${payload.quote.folio} · ${payload.client?.name || ''}`;
    $('#docRoot').innerHTML = circuit ? D.renderCircuitSheet(model) : D.renderQuoteSheets(model);
    const count = model.dataList.length;
    $('#docTabs').innerHTML = count > 1 ? model.dataList.map((d, i) => `<button type="button" data-tab="${i}">Propuesta ${i + 1} · ${D.esc(D.optionLabel(model.g.varying, d))}</button>`).join('') : '';
    $('#docTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(Number(b.dataset.tab)); };
    showTab(0);
    $('#docMsgText').value = circuit ? D.buildCircuitMessage(model) : D.buildQuoteMessage(model);
    $('#docMsg').classList.remove('hidden');

    button('Imprimir / Guardar PDF', '', () => printQuote(false));
    if (count > 1) button('PDF con todas las propuestas', 'ghost', () => printQuote(true));
    button('Copiar mensaje de WhatsApp', 'coral', copyMessage);
    const wa = D.waLink(payload.client?.phone, $('#docMsgText').value);
    if (wa) button('Abrir chat del cliente', 'wa', null, { href: wa });
    if (payload.canEdit && ['Borrador', 'PDF generado'].includes(payload.quote.status)) {
      const sent = button('Marcar como enviada', 'ghost', async () => {
        sent.disabled = true;
        try { await api(`/api/quotes/${payload.quote.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Enviada' }) }); toast('Cotización marcada como enviada'); sent.remove(); }
        catch (error) { toast(error.message); sent.disabled = false; }
      });
    }
    if (!payload.quote.details) note('Esta cotización se capturó antes del cotizador. Edítala en la plataforma para agregar vuelo, fotos, propuestas y forma de pago.', 'info');
    else if (!payload.seller?.phone) note('Tip: agrega tu WhatsApp y tu foto en “Mi cuenta → Mi perfil para documentos” para que aparezcan en la cotización.', 'info');
  }

  /* ---------- Confirmación de servicios ---------- */
  function checkOverflow() {
    const pages = [...document.querySelectorAll('#docRoot .pdf-page')];
    const full = pages.filter((p) => p.scrollHeight > p.clientHeight + 2);
    pages.forEach((p) => p.classList.toggle('overflow', full.includes(p)));
    if (full.length) note(`La hoja ${full.map((p) => (p.classList.contains('pdf-page-one') ? 1 : 2)).join(' y ')} tiene más texto del que cabe en A4 y se recortará. Acorta textos largos (tips, datos del hotel, actividades) en la confirmación del viaje.`);
  }
  function renderReservation(payload) {
    $('#docStyles').href = '/docs/reserva.css?v=tp006';
    const c = D.mergeConfirmation(payload.trip.confirmation, D.confirmationDefaults(payload));
    state = { payload, c };
    document.title = `${c.reservation} · ${c.holder || 'Confirmación'}`;
    $('#docTitle').textContent = `Confirmación ${c.reservation} · ${c.holder || ''}`;
    $('#docRoot').innerHTML = `<div class="rd-pages">${D.renderReservation(c, payload)}</div>`;
    $('#docMsgText').value = D.buildReservationMessage(c, payload);
    $('#docMsg').classList.remove('hidden');
    button('Imprimir / Guardar PDF', '', async () => { await waitImages(); window.print(); });
    button('Copiar mensaje de WhatsApp', 'coral', copyMessage);
    const wa = D.waLink(payload.client?.phone, $('#docMsgText').value);
    if (wa) button('Abrir chat del cliente', 'wa', null, { href: wa });
    if (!payload.trip.confirmation) note('Vista previa con los datos del viaje y de la cotización. Completa vuelos, hotel y traslados en “Confirmación de servicios” dentro del viaje.', 'info');
    waitImages().then(() => setTimeout(checkOverflow, 50));
  }

  function renderPublicQuote(payload) {
    document.body.classList.add('doc-public');
    const back = document.querySelector('.doc-toolbar a.ghost');
    if (back) back.remove();
    const circuit = payload.quote.details?.kind === 'circuito';
    $('#docStyles').href = circuit ? '/docs/circuito.css?v=tp006' : '/docs/cotizacion.css?v=tp006';
    const model = circuit ? D.circuitModel(payload) : D.quoteModel(payload);
    if (circuit) model.dataList = [null];
    state = { payload, model, tab: 0 };
    document.title = `Tu cotización ${payload.quote.folio} · ${payload.agency?.name || 'Viajes Casal'}`;
    $('#docTitle').textContent = `Tu cotización · ${payload.quote.destination}`;
    $('#docRoot').innerHTML = circuit ? D.renderCircuitSheet(model) : D.renderQuoteSheets(model);
    const count = model.dataList.length;
    $('#docTabs').innerHTML = count > 1 ? model.dataList.map((d, i) => `<button type="button" data-tab="${i}">Opción ${i + 1} · ${D.esc(D.optionLabel(model.g.varying, d))}</button>`).join('') : '';
    $('#docTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(Number(b.dataset.tab)); };
    showTab(0);
    if (payload.payUrl) button(payload.payLabel || 'Pagar mi anticipo', '', null, { href: payload.payUrl });
    button('Descargar PDF', '', async () => { await waitImages(); window.print(); });
    const sellerPhone = payload.seller?.phone || payload.agency?.whatsapp;
    const wa = D.waLink(sellerPhone, `Hola, vi la cotización ${payload.quote.folio} para ${payload.quote.destination} y tengo una pregunta.`);
    if (wa) button('Escribir a mi Travel Partner', 'wa', null, { href: wa });
    acceptUi(payload, count);
  }

  /* ---------- TP-203: elegir opción y aceptar en línea ---------- */
  const fmtMoney = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  function acceptUi(payload, count) {
    const a = payload.accept;
    if (!a) return;
    document.querySelector('#acceptBar')?.remove();
    if (a.accepted) {
      const opt = a.options.find((o) => o.index === a.acceptedOption);
      note(`✅ ¡Aceptaste esta cotización${opt && a.options.length > 1 ? ` (opción ${opt.index + 1}: ${opt.label})` : ''}! Tu Travel Partner ya fue avisado.${payload.payUrl ? ' Ya puedes apartar tu viaje con el anticipo.' : ''}`, 'info');
      if (a.options.length > 1 && Number.isInteger(a.acceptedOption)) showTab(a.acceptedOption);
      return;
    }
    if (a.expired) { note('La vigencia de esta cotización terminó. Escríbele a tu Travel Partner para actualizar precios y disponibilidad.'); return; }
    if (!a.canAccept) return;
    const bar = document.createElement('div');
    bar.id = 'acceptBar';
    bar.className = 'accept-bar';
    document.body.append(bar);
    const paint = () => {
      const opt = a.options[count > 1 ? state.tab : 0] || a.options[0];
      bar.innerHTML = `<div><b>${count > 1 ? `Opción ${opt.index + 1}: ` : ''}${D.esc(opt.label)}</b><span>${opt.total ? `${fmtMoney(opt.total)} MXN` : ''}${count > 1 ? ' · cambia de opción con las pestañas de arriba' : ''}</span></div><button type="button" class="doc-btn coral" id="acceptOpen">${count > 1 ? 'Elegir esta opción' : 'Aceptar cotización'}</button>`;
      bar.querySelector('#acceptOpen').onclick = () => openAccept(payload, opt);
    };
    paint();
    $('#docTabs').addEventListener('click', () => setTimeout(paint, 0));
  }
  function openAccept(payload, opt) {
    const a = payload.accept;
    const wrap = document.createElement('div');
    wrap.className = 'accept-modal';
    wrap.innerHTML = `<form class="accept-card">
      <h3>Aceptar y apartar mi viaje</h3>
      <div class="accept-sum">${a.options.length > 1 ? `<small>Opción ${opt.index + 1} de ${a.options.length}</small>` : ''}<b>${D.esc(opt.label)}</b><span>${D.esc(payload.quote.destination)} · ${D.esc(payload.quote.folio)}</span>${opt.total ? `<strong>${fmtMoney(opt.total)} MXN</strong>` : ''}</div>
      <label>Tu nombre completo<input name="name" required minlength="3" maxlength="120" autocomplete="name" value="${D.esc(payload.client?.name || '')}"></label>
      <label class="accept-check"><input type="checkbox" name="terms" required> Acepto esta propuesta, sus condiciones y políticas. Sé que los precios y la disponibilidad se garantizan al pagar el anticipo.</label>
      <p class="accept-err hidden"></p>
      <div class="accept-acts"><button type="button" class="doc-btn ghost" data-x>Cancelar</button><button type="submit" class="doc-btn coral">Aceptar cotización</button></div>
    </form>`;
    document.body.append(wrap);
    const form = wrap.querySelector('form');
    const closeIt = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-x]')) closeIt(); });
    form.name.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await api(`/api/public/quote/${shareToken}/accept`, { method: 'POST', body: JSON.stringify({ option: opt.index, name: form.name.value, terms: form.terms.checked }) });
        form.innerHTML = `<h3>🎉 ¡Listo, cotización aceptada!</h3><p>Tu Travel Partner ya recibió el aviso y te confirmará tu reserva.</p>${r.payUrl ? `<p>Para apartar tu viaje y garantizar precio y disponibilidad, paga tu anticipo:</p><a class="doc-btn coral" href="${D.esc(r.payUrl)}">Pagar mi anticipo</a>` : ''}<div class="accept-acts"><button type="button" class="doc-btn ghost" data-x>Cerrar</button></div>`;
        const fresh = await api(`/api/public/quote/${shareToken}`);
        $('#docActions').innerHTML = '';
        renderPublicQuote(fresh);
      } catch (error) {
        const err = form.querySelector('.accept-err');
        err.textContent = error.message; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Aceptar cotización';
      }
    };
  }

  async function init() {
    if (shareToken) {
      try { renderPublicQuote(await api(`/api/public/quote/${shareToken}`)); }
      catch (error) { $('#docTitle').textContent = 'Cotización'; $('#docRoot').innerHTML = `<div class="doc-error"><h2>${D.esc(error.message)}</h2></div>`; }
      return;
    }
    if (!Number.isInteger(id) || id < 1) { $('#docRoot').innerHTML = '<div class="doc-error"><h2>Documento no encontrado</h2></div>'; return; }
    try {
      const payload = await api(`/api/documents/${type === 'reserva' ? 'trip' : 'quote'}/${id}`);
      if (type === 'reserva') renderReservation(payload); else renderQuote(payload);
    } catch (error) {
      $('#docTitle').textContent = 'Documento';
      $('#docRoot').innerHTML = `<div class="doc-error"><h2>${error.status === 401 ? 'Inicia sesión para ver este documento' : D.esc(error.message)}</h2><p><a class="doc-btn" href="/">Ir a la plataforma</a></p></div>`;
    }
  }
  init();
}());
