'use strict';

// TP-309: página de invitación del programa de referidos (/r/<código>).
(function () {
  const code = (location.pathname.match(/\/r\/(VC-[A-Z0-9]{5,7})/i) || [])[1];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN`;
  async function load() {
    try {
      const r = await fetch(`/api/public/ref/${encodeURIComponent(code || '')}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Esta invitación ya no está disponible.');
      $('#title').textContent = `${d.referrer} te invita a viajar ✈️`;
      $('#sub').textContent = `con ${d.agency}`;
      const msg = `Hola${d.seller ? ` ${d.seller}` : ''}, vengo recomendado por ${d.referrer} (código ${d.code}). Quiero cotizar un viaje.`;
      $('#app').innerHTML = `<div class="card center">
        ${d.welcomeAmount ? `<div class="big">🎁</div><h2>Tienes ${money(d.welcomeAmount)} de descuento</h2><p>en tu primer viaje con nosotros, por venir recomendado por ${esc(d.referrer)}.</p>` : `<h2>Planeemos tu próximo viaje</h2>`}
        <div class="code"><span class="muted">Tu código</span><b>${esc(d.code)}</b></div>
        <p class="muted">Cuéntanos a dónde quieres ir y ${d.seller ? esc(d.seller) : 'tu Travel Partner'} te arma opciones a tu medida: hotel, vuelos, traslados y tours, con acompañamiento antes, durante y después del viaje.</p>
        ${d.whatsapp ? `<a class="btn wa" href="https://wa.me/${esc(d.whatsapp)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">💬 Cotizar por WhatsApp</a>` : ''}
        <a class="btn alt" href="/formulario?ref=${encodeURIComponent(d.code)}&origen=referido">📝 Prefiero llenar un formulario</a></div>`;
    } catch (error) { $('#app').innerHTML = `<div class="card center"><p>${esc(error.message)}</p></div>`; }
  }
  load();
})();
