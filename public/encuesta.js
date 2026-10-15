'use strict';

// TP-308: encuesta postviaje del cliente (/encuesta/<token>).
(function () {
  const token = (location.pathname.match(/\/encuesta\/([a-f0-9]{40})/) || [])[1];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN`;
  const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmt = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${M[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
  const answers = { overall: 0, hotel: 0, transfer: 0, partner: 0, nps: null };
  let data = null;

  async function load() {
    if (!token) return fail('Liga incompleta. Pide a tu Travel Partner una liga nueva.');
    try {
      const r = await fetch(`/api/public/survey/${token}`, { cache: 'no-store' });
      data = await r.json();
      if (!r.ok || !data.ok) return fail(data.error || 'Esta encuesta ya no está disponible.');
      $('#title').textContent = data.client.first ? `${data.client.first}, ¿cómo te fue?` : '¿Cómo te fue?';
      $('#sub').textContent = `${data.trip.destination} · ${fmt(data.trip.start_date)} al ${fmt(data.trip.end_date)}`;
      if (data.answered) thanks(); else form();
    } catch { fail('No pudimos cargar la encuesta. Revisa tu conexión e intenta de nuevo.'); }
  }
  function fail(msg) { $('#app').innerHTML = `<div class="card center"><p>${esc(msg)}</p></div>`; }
  const stars = (k, small) => `<div class="stars${small ? ' sm' : ''}" data-k="${k}" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}" aria-label="${n} estrella${n > 1 ? 's' : ''}" class="${answers[k] >= n ? 'on' : ''}">★</button>`).join('')}</div>`;

  function form() {
    const partner = data.seller ? `Atención de ${esc(data.seller.first)}, tu Travel Partner` : 'Atención de tu Travel Partner';
    $('#app').innerHTML = `<form class="card" id="f" novalidate>
      <h2>Tu opinión nos ayuda a mejorar</h2><p class="muted">4 preguntas · menos de un minuto</p>
      <div class="q"><b>¿Cómo calificas tu viaje en general?</b>${stars('overall')}</div>
      <div class="q"><b>Y en detalle <small>(opcional)</small></b>
        <small>Hotel</small>${stars('hotel', true)}<small>Traslados</small>${stars('transfer', true)}<small>${partner}</small>${stars('partner', true)}</div>
      <div class="q"><b>¿Qué tan probable es que nos recomiendes con familia o amigos?</b>
        <div class="nps">${Array.from({ length: 11 }, (_, n) => `<button type="button" data-nps="${n}">${n}</button>`).join('')}</div><div class="nps-l"><span>Nada probable</span><span>Muy probable</span></div></div>
      <div class="q"><b>¿Algo que quieras contarnos? <small>(opcional)</small></b><textarea id="comment" maxlength="2000" placeholder="Lo que más te gustó, o lo que podemos mejorar…"></textarea>
        <label class="check"><input type="checkbox" id="publish"> Pueden compartir mi comentario (solo con mi primer nombre) en sus redes o sitio.</label></div>
      <button class="btn" id="send" type="submit">Enviar mis respuestas</button><p class="err" id="err"></p></form>`;
    const f = $('#f');
    f.onclick = (e) => {
      const st = e.target.closest('[data-v]');
      if (st) { const k = st.parentElement.dataset.k; answers[k] = Number(st.dataset.v); st.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) <= answers[k])); return; }
      const n = e.target.closest('[data-nps]');
      if (n) { answers.nps = Number(n.dataset.nps); f.querySelectorAll('[data-nps]').forEach((b) => b.classList.toggle('on', b === n)); }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!answers.overall) { $('#err').textContent = 'Elige cuántas estrellas le das a tu viaje.'; return; }
      const btn = $('#send'); btn.disabled = true; $('#err').textContent = '';
      try {
        const body = { overall: answers.overall, hotel: answers.hotel || null, transfer: answers.transfer || null, partner: answers.partner || null, nps: answers.nps, comment: $('#comment').value, publish: $('#publish').checked };
        const r = await fetch(`/api/public/survey/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = await r.json();
        if (!r.ok || !out.ok) throw new Error(out.error || 'No se pudo enviar');
        data = out; thanks(true);
        scrollTo({ top: 0, behavior: 'smooth' });
      } catch (error) { $('#err').textContent = error.message; btn.disabled = false; }
    };
  }

  function thanks(fresh) {
    const a = data.answers || {};
    const good = a.overall >= (data.reviews.goodRating || 4);
    const reviewBtns = [data.reviews.google && `<a class="btn teal" data-review="google" href="${esc(data.reviews.google)}" target="_blank" rel="noopener">⭐ Dejar mi reseña en Google</a>`, data.reviews.tripadvisor && `<a class="btn alt" data-review="tripadvisor" href="${esc(data.reviews.tripadvisor)}" target="_blank" rel="noopener">🦉 Opinar en TripAdvisor</a>`].filter(Boolean).join('');
    const ref = data.referral;
    const share = ref ? `Te invito a planear tu viaje con ${data.agency.name}. Con mi liga tienes ${money(ref.welcomeAmount)} de descuento en tu primer viaje: ${ref.url}` : '';
    $('#app').innerHTML = `<div class="card center"><div class="big">${good ? '💙' : '🙏'}</div><h2>${fresh ? '¡Gracias por tus respuestas!' : 'Ya recibimos tus respuestas'}</h2>
        <p>${good ? 'Nos alegra muchísimo que hayas disfrutado tu viaje.' : 'Lamentamos que no todo haya salido como esperabas. Tu Travel Partner te contactará para escucharte.'}</p>
        ${good && reviewBtns ? `<p class="muted">¿Nos ayudas con una reseña? Toma 30 segundos y ayuda a otros viajeros a confiar en nosotros.</p>${reviewBtns}` : ''}</div>
      ${ref && good ? `<div class="card center"><h2>🎁 Invita a tus amigos y gana</h2><p>Ellos reciben <b>${money(ref.welcomeAmount)}</b> de descuento en su primer viaje y tú ganas <b>${money(ref.referrerAmount)}</b> para tu próxima aventura cuando viajen.</p>
        <div class="code"><span class="muted">Tu código</span><b>${esc(ref.code)}</b></div>
        <a class="btn wa" href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener">💬 Compartir por WhatsApp</a><button class="btn alt" id="copy" type="button">Copiar mi liga</button></div>` : ''}`;
    document.querySelectorAll('[data-review]').forEach((el) => { el.onclick = () => { fetch(`/api/public/survey/${token}/review-click`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: el.dataset.review }) }).catch(() => {}); }; });
    const copy = $('#copy');
    if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(ref.url); copy.textContent = '✓ Liga copiada'; } catch { prompt('Copia tu liga:', ref.url); } };
  }

  load();
})();
