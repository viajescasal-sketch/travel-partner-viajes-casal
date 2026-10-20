'use strict';

/* =========================================================
   TP-313 · Portal del cliente
   Una sola página con: cotizaciones, pagos y contrato, mis viajes, encuesta y referidos,
   contacto con su asesor y "pedir nueva cotización". Mismo diseño que el itinerario digital.
   ========================================================= */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (location.pathname.match(/\/mi-portal\/([a-f0-9]{40})/) || [])[1];
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmt = (d) => { if (!/^\d{4}-\d{2}-\d{2}/.test(String(d || ''))) return ''; const [y, m, day] = d.slice(0, 10).split('-').map(Number); return `${day} ${MONTHS[m - 1]} ${y}`; };
  const range = (a, b) => (a && b ? `${fmt(a)} – ${fmt(b)}` : fmt(a || b) || 'Fechas por definir');
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`;
  const wa = (phone, text) => { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 10 ? `https://wa.me/${d.length === 10 ? `52${d}` : d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : ''; };

  async function call(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) throw Object.assign(new Error(out.error || 'No se pudo completar'), { status: res.status });
    return out;
  }
  const api = `/api/public/portal/${token}`;
  const fail = (title, text) => { $('#heroTitle').textContent = title; $('#app').innerHTML = `<div class="err"><p>${esc(text)}</p></div>`; };

  /* ---------- Entrar con código ---------- */
  function codeScreen(p) {
    $('#heroTitle').textContent = `Hola${p.client?.first ? `, ${p.client.first}` : ''} 👋`;
    $('#heroSub').textContent = 'Tus cotizaciones, pagos y viajes en un solo lugar.';
    $('#app').innerHTML = `<div class="card code-card">
      <b>Confirma que eres tú</b>
      <p class="muted">${p.byEmail ? `Te enviaremos un código de 6 dígitos a <b>${esc(p.emailMasked)}</b>.` : 'Tu Travel Partner te enviará un código de 6 dígitos por WhatsApp.'} Solo se pide la primera vez en este equipo.</p>
      <button class="btn" id="sendCode" type="button">Enviarme el código</button>
      <form id="codeForm" class="hidden"><input class="code-in" id="codeIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="Código de 6 dígitos"><button class="btn" type="submit">Entrar</button><button class="btn alt" type="button" id="resend">Enviar otro código</button></form>
      <p class="msg" id="codeMsg" role="status"></p></div>`;
    const msg = (t, ok) => { $('#codeMsg').textContent = t; $('#codeMsg').className = `msg ${ok ? 'ok-t' : 'err-t'}`; };
    const send = async (btn) => {
      btn.disabled = true;
      try {
        const r = await call('POST', `${api}/code`);
        $('#sendCode').classList.add('hidden'); $('#codeForm').classList.remove('hidden'); $('#codeIn').focus();
        msg(r.via === 'email' ? `Listo: revisa tu correo ${r.emailMasked} (también la carpeta de spam).` : 'Listo: avisamos a tu Travel Partner para que te mande el código por WhatsApp.', true);
      } catch (e) { msg(e.message); }
      btn.disabled = false;
    };
    $('#sendCode').onclick = (e) => send(e.currentTarget);
    $('#resend').onclick = (e) => send(e.currentTarget);
    $('#codeForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.currentTarget.querySelector('[type=submit]');
      btn.disabled = true;
      try { await call('POST', `${api}/verify`, { code: $('#codeIn').value }); load(); } catch (err) { msg(err.message); btn.disabled = false; }
    };
  }

  /* ---------- Portal ---------- */
  function render(p) {
    const s = p.seller;
    const sec = [];
    const add = (id, label, html) => sec.push({ id, label, html });
    const next = p.trips.find((t) => t.phase !== 'pasado');
    $('#heroTitle').textContent = `Hola, ${p.client.first || p.client.name} 👋`;
    $('#heroSub').textContent = next ? `${next.destination} · ${range(next.start_date, next.end_date)}${next.days != null ? ` · faltan ${next.days} día${next.days === 1 ? '' : 's'}` : ''}` : 'Tus cotizaciones, pagos y viajes en un solo lugar.';

    // Pagos pendientes primero: es lo más urgente para el cliente.
    const due = p.payments.filter((x) => x.balance > 0.5);
    if (p.payments.length) add('pagos', 'Pagos', p.payments.map((x) => {
      const pct = x.total ? Math.min(100, Math.round((x.paid / x.total) * 100)) : 0;
      const contract = x.contract.state === 'pending' ? `<a class="btn coral" href="${esc(x.contract.url)}">✍️ Firmar mi contrato</a>` : x.contract.state === 'signed' ? '<p class="muted">✓ Contrato firmado</p>' : '';
      return `<div class="card${x.balance > 0.5 ? ' pay' : ''}"><div class="q-head"><b>${esc(x.destination)}</b><small>${esc(x.folio)}</small></div>
        <div class="bar"><i style="width:${pct}%"></i></div><p class="muted">Pagado ${money(x.paid)} de ${money(x.total)} · ${x.balance > 0.5 ? `saldo <b>${money(x.balance)}</b>` : '<b>¡Liquidado! ✓</b>'}</p>
        ${x.next ? `<p>${x.next.late ? '⚠ ' : ''}Próximo pago: <b>${esc(x.next.label)} · ${money(x.next.amount)}</b>${x.next.due ? ` · ${x.next.late ? 'venció el' : 'antes del'} ${esc(fmt(x.next.due))}` : ''}</p>` : ''}
        ${x.installments.map((i) => `<div class="inst"><span>${esc(i.label)}<br><em>${esc(fmt(i.due))}</em></span><span>${money(i.amount)} ${i.status === 'pagado' ? '<span class="pill ok">Pagado</span>' : i.paid ? '<span class="pill warn">Parcial</span>' : '<span class="pill off">Pendiente</span>'}</span></div>`).join('')}
        ${contract}${x.url && x.balance > 0.5 ? `<a class="btn" href="${esc(x.url)}">💳 Pagar o ver datos de pago</a>` : x.url ? `<a class="btn alt" href="${esc(x.url)}">Ver mis pagos</a>` : ''}</div>`;
    }).join(''));

    add('viajes', 'Mis viajes', p.trips.length ? p.trips.map((t) => `<div class="card day${t.phase === 'en curso' ? ' today' : t.phase === 'pasado' ? ' past' : ''}">
        <div class="trip-h"><div><h3>${esc(t.destination)}</h3><p class="muted">${esc(range(t.start_date, t.end_date))}</p></div><span class="pill${t.phase === 'pasado' ? ' off' : t.phase === 'en curso' ? ' warn' : ''}">${t.phase === 'próximo' ? (t.days != null ? `Faltan ${t.days} días` : 'Próximo') : t.phase === 'en curso' ? '¡De viaje!' : 'Realizado'}</span></div>
        ${t.services ? `<p class="muted">🧾 ${t.confirmed} de ${t.services} servicios confirmados</p>` : ''}
        ${t.itinerary ? `<a class="btn" href="${esc(t.itinerary)}">🗺️ Ver itinerario, vouchers y documentos</a>` : '<p class="muted">Tu itinerario digital estará aquí en cuanto tu Travel Partner lo prepare.</p>'}
        ${t.survey ? `<a class="btn coral" href="${esc(t.survey)}">⭐ Cuéntanos cómo te fue (1 minuto)</a>` : ''}</div>`).join('') : '<div class="card"><p class="muted">Aún no tienes viajes confirmados. Cuando aceptes una cotización, aquí verás tu viaje.</p></div>');

    add('cotizaciones', 'Cotizaciones', p.quotes.length ? p.quotes.map((q) => `<div class="card"><div class="q-head"><b>${esc(q.destination)}</b><small>${esc(q.folio)}</small></div>
        <p class="muted">${esc(q.hotel)}${q.proposals > 1 ? ` · ${q.proposals} opciones` : ''}</p>
        <div class="q-price">${money(q.price)} <small class="muted">${esc(String(q.mode || '').toLowerCase())}</small></div>
        <p>${q.status === 'Aceptada' ? '<span class="pill ok">✓ Aceptada</span>' : q.expired ? '<span class="pill off">Vigencia terminada · pide una actualización</span>' : `<span class="pill">Por decidir${q.valid_until ? ` · vigente al ${esc(fmt(q.valid_until))}` : ''}</span>`}</p>
        <a class="btn${q.status === 'Aceptada' || q.expired ? ' alt' : ''}" href="${esc(q.url)}" ${q.external ? 'target="_blank" rel="noopener"' : ''}>${q.external ? '📄 Ver cotización' : q.status === 'Aceptada' || q.expired ? 'Ver cotización' : 'Ver y aceptar cotización'}</a></div>`).join('') : '<div class="card"><p class="muted">No tienes cotizaciones pendientes.</p></div>');

    add('nueva', 'Nueva cotización', `<div class="card"><b>¿Planeas otro viaje?</b><p class="muted">Cuéntanos y ${s ? esc(s.name.split(' ')[0]) : 'tu Travel Partner'} te prepara una propuesta.</p>
      <form class="form" id="reqForm">
        <label>¿A dónde quieres ir?*<input name="destination" required maxlength="120" placeholder="Ej. Europa, Los Cabos, Disney"></label>
        <div class="two"><label>Salida<input name="start" type="date"></label><label>Regreso<input name="end" type="date"></label></div>
        <div class="two"><label>Viajeros<input name="travelers" type="number" min="1" max="99" inputmode="numeric"></label><label>Presupuesto aprox.<input name="budget" inputmode="numeric" placeholder="$"></label></div>
        <label>Comentarios<textarea name="notes" rows="3" maxlength="1000" placeholder="Ocasión especial, tipo de hotel, edades de los niños…"></textarea></label>
        <button class="btn" type="submit">Pedir cotización</button><p class="msg" id="reqMsg" role="status"></p></form></div>`);

    if (p.referral) add('referidos', 'Recomienda', `<div class="card"><b>🤝 Recomienda y gana</b><p class="muted">Comparte tu código: tus recomendados reciben <b>${money(p.referral.welcomeAmount)}</b> de descuento y tú ganas <b>${money(p.referral.referrerAmount)}</b> de crédito para tu próximo viaje cuando reserven.</p>
      <div class="ref-code">${esc(p.referral.code)}</div>
      <div class="row2"><a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(`Te recomiendo a Viajes Casal para tu próximo viaje ✈️ Con mi código ${p.referral.code} tienes ${money(p.referral.welcomeAmount)} de descuento: ${p.referral.url}`)}" target="_blank" rel="noopener">Compartir</a><button class="btn alt" type="button" id="copyRef">Copiar liga</button></div></div>`);

    const sellerWa = wa(s?.phone || p.agency.whatsapp, `Hola${s ? ` ${s.name.split(' ')[0]}` : ''}, te escribo desde mi portal de Viajes Casal.`);
    add('contacto', 'Mi asesor', `<div class="card">${s ? `<div class="contact">${s.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="${esc(s.name)}">` : `<span class="av">${esc(s.name.slice(0, 1))}</span>`}<div><b>${esc(s.name)}</b><div class="muted">Tu Travel Partner · antes, durante y después de tu viaje</div></div></div>` : ''}
      ${sellerWa ? `<a class="btn wa" href="${esc(sellerWa)}" target="_blank" rel="noopener">💬 Escribir por WhatsApp</a>` : ''}
      ${s?.email ? `<div class="phone"><span>Correo</span><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></div>` : ''}
      ${p.agency.website ? `<div class="phone"><span>${esc(p.agency.name)}</span><a href="${esc(p.agency.website)}" target="_blank" rel="noopener">Sitio web</a></div>` : ''}</div>`);

    $('#chips').innerHTML = sec.map((x) => `<a href="#${x.id}">${esc(x.label)}${x.id === 'pagos' && due.length ? ' ⚠' : ''}</a>`).join('');
    $('#chips').classList.remove('hidden');
    $('#app').innerHTML = sec.map((x) => `<section id="${x.id}"><h2>${esc(x.label)}</h2>${x.html}</section>`).join('');
    $('#foot').innerHTML = `${esc(p.agency.name)} · Portal privado de ${esc(p.client.name)}<br><button class="logout" id="logout" type="button">Salir en este equipo</button>`;

    $('#reqForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      const btn = f.querySelector('[type=submit]');
      const out = $('#reqMsg');
      btn.disabled = true;
      try {
        const r = await call('POST', `${api}/request`, Object.fromEntries(new FormData(f)));
        f.reset();
        out.className = 'msg ok-t';
        out.textContent = `¡Listo! ${r.seller ? r.seller.split(' ')[0] : 'Tu Travel Partner'} ya recibió tu solicitud y te contactará pronto.`;
      } catch (err) { out.className = 'msg err-t'; out.textContent = err.message; }
      btn.disabled = false;
    };
    const copy = $('#copyRef');
    if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(p.referral.url); copy.textContent = '✓ Copiada'; } catch { prompt('Copia tu liga:', p.referral.url); } };
    $('#logout').onclick = async () => { try { await call('POST', `${api}/logout`); } catch { /* sin conexión */ } location.reload(); };
  }

  async function load() {
    if (!token) { fail('Portal no disponible', 'La liga no es válida. Pide a tu Travel Partner una liga nueva.'); return; }
    try {
      const p = await call('GET', api);
      if (p.needsCode) codeScreen(p); else render(p);
    } catch (e) { fail('Portal no disponible', e.message); }
  }
  load();
}());
