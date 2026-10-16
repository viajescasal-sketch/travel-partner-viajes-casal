'use strict';

// TP-204: contrato del viaje con firma electrónica: /contrato/<token>
(function () {
  const token = (location.pathname.match(/\/contrato\/([a-f0-9]{40})/) || [])[1];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const when = (dt) => { const s = String(dt || ''); return s.length >= 16 ? `${Number(s.slice(8, 10))} de ${MONTHS[Number(s.slice(5, 7)) - 1]} de ${s.slice(0, 4)}, ${s.slice(11, 16)} h (hora de Cancún)` : s; };
  let data = null;

  async function load() {
    if (!token) return fail('Liga incompleta. Pide a tu Travel Partner una liga nueva.');
    try {
      const r = await fetch(`/api/public/contract/${token}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) return fail(d.error || 'Este contrato no está disponible.');
      data = d;
      render();
    } catch { fail('No pudimos cargar tu contrato. Revisa tu conexión e intenta de nuevo.'); }
  }
  function fail(msg) { $('#subtitle').textContent = ''; $('#app').innerHTML = `<div class="card"><p>${esc(msg)}</p></div>`; }

  const docHtml = (doc) => `<div class="doc"><h2>${esc(doc.title)}</h2><p class="intro">${esc(doc.intro)}</p>
    ${doc.blocks.map((b) => `<h3>${esc(b.h)}</h3>${b.rows ? `<table>${b.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}${b.items ? `<ol>${b.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` : ''}`).join('')}</div>`;

  function render(note = '') {
    const d = data;
    const first = String(d.client.name || '').trim().split(/\s+/)[0];
    $('#title').textContent = d.state === 'signed' ? 'Contrato firmado ✅' : `Hola${first ? `, ${first}` : ''} 👋`;
    $('#subtitle').textContent = d.state === 'pending' ? 'Lee tu contrato y fírmalo para apartar tu viaje' : `Contrato de tu viaje · ${d.folio}`;
    document.title = `Contrato · ${d.folio}`;
    const steps = `<div class="steps noprint"><span class="${d.state === 'pending' ? 'on' : 'done'}">${d.state === 'pending' ? '1' : '✓'} Firma tu contrato</span><span class="${d.state === 'pending' ? '' : 'on'}">2 Paga tu anticipo</span></div>`;
    const payBtn = d.balance > 0.5 ? `<a class="btn noprint" href="${esc(d.payUrl)}">Continuar: pagar mi anticipo</a>` : `<a class="btn alt noprint" href="${esc(d.payUrl)}">Ver mi plan de pagos</a>`;
    const signedBox = d.signed ? `<div class="signed"><img src="/api/public/contract/${token}/signature" alt="Firma de ${esc(d.signed.name)}"><b>${esc(d.signed.name)}</b><span class="muted">EL CLIENTE · firmado electrónicamente el ${esc(when(d.signed.at))}</span>
      <p class="audit">Registro de firma: IP ${esc(d.signed.ip || '—')} · ${esc(d.signed.device || '')}<br>Huella del documento (SHA-256): ${esc(d.signed.hash)}</p></div>` : '';
    let tail = '';
    if (d.state === 'pending') {
      tail = `<form class="card noprint" id="signForm" novalidate>
        <h2 style="margin-top:0;color:var(--navy);font-size:18px">Firma tu contrato</h2>
        <label for="signName">Tu nombre completo</label><input type="text" id="signName" maxlength="120" autocomplete="name" value="${esc(d.client.name)}">
        <label>Tu firma <span class="muted" style="font-weight:normal">(con el dedo o el mouse)</span></label>
        <div class="pad-wrap"><canvas id="pad"></canvas><div class="pad-line"></div><div class="pad-hint" id="padHint">Firma aquí</div></div>
        <div class="pad-acts"><span>Al firmar se registran fecha, hora, IP y dispositivo.</span><button type="button" class="link" id="padClear">Borrar firma</button></div>
        <label class="check"><input type="checkbox" id="signAccept"> Leí y acepto este contrato, sus cláusulas y las políticas de cambios y cancelación. Mi firma electrónica tiene la misma validez que mi firma autógrafa.</label>
        <p class="err hidden" id="signErr"></p>
        <button class="btn" id="signBtn">Firmar contrato</button>
      </form>`;
    } else {
      tail = `<div class="card noprint">${payBtn}<button type="button" class="btn alt" id="printBtn">Descargar PDF / imprimir</button></div>`;
    }
    $('#app').innerHTML = `${note}${steps}${d.state === 'waived' ? '<div class="note info">Tu Travel Partner registró tu contrato firmado por otro medio. Aquí puedes consultarlo.</div>' : ''}<div class="card">${docHtml(d.doc)}${signedBox}</div>${tail}`;
    $('#foot').innerHTML = `${esc(d.agency.name || 'Viajes Casal')}${d.agency.whatsapp ? ` · WhatsApp ${esc(d.agency.whatsapp)}` : ''}${d.agency.email ? ` · ${esc(d.agency.email)}` : ''}`;
    if ($('#printBtn')) $('#printBtn').onclick = () => window.print();
    if (d.state === 'pending') setupSign();
  }

  function setupSign() {
    const canvas = $('#pad');
    const ctx = canvas.getContext('2d');
    let drawing = false, strokes = 0, last = null;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * ratio); canvas.height = Math.round(r.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b2540';
      strokes = 0; $('#padHint').classList.remove('hidden');
    };
    size();
    let width = canvas.getBoundingClientRect().width;
    window.addEventListener('resize', () => { const w = canvas.getBoundingClientRect().width; if (Math.abs(w - width) > 2 && !strokes) { width = w; size(); } });
    const point = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; last = point(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#0b2540'; ctx.fill(); strokes += 1; $('#padHint').classList.add('hidden'); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); const p = point(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; strokes += 1; });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop); canvas.addEventListener('pointerleave', stop);
    $('#padClear').onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); size(); };
    $('#signForm').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#signErr');
      const show = (m) => { err.textContent = m; err.classList.remove('hidden'); };
      err.classList.add('hidden');
      const name = $('#signName').value.trim();
      if (name.length < 3) return show('Escribe tu nombre completo.');
      if (strokes < 8) return show('Dibuja tu firma en el recuadro.');
      if (!$('#signAccept').checked) return show('Marca la casilla para confirmar que aceptas el contrato.');
      const btn = $('#signBtn');
      btn.disabled = true; btn.textContent = 'Firmando…';
      try {
        const r = await fetch(`/api/public/contract/${token}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, accept: true, signature: canvas.toDataURL('image/png'), hash: data.hash }) });
        const out = await r.json();
        if (r.status === 409 && out.doc) { data = out; render(`<div class="note info">${esc(out.error)}</div>`); return; }
        if (!r.ok || !out.ok) throw new Error(out.error || 'No pudimos registrar tu firma');
        data = out;
        render(`<div class="note ok">✅ ¡Listo! Tu contrato quedó firmado.${out.emailed ? ' Te enviamos una copia por correo.' : ''} ${out.balance > 0.5 ? 'Ya puedes pagar tu anticipo.' : ''}</div>`);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (error) { show(error.message); btn.disabled = false; btn.textContent = 'Firmar contrato'; }
    };
  }

  load();
})();
