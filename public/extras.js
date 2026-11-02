'use strict';

/* =========================================================
   TP-314 · Piezas compartidas del portal del cliente y del itinerario digital:
   - Redes sociales con iconos (Instagram, Facebook, TikTok, YouTube)
   - Apartado "¿Qué necesito para mi viaje?" con documentos, consejos y dudas rápidas por WhatsApp
   ========================================================= */
(function (global) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safe = (u) => { const v = String(u || '').trim(); return /^https:\/\/[^\s<>"']+$/i.test(v) ? v : ''; };
  const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  const style = document.createElement('style');
  style.textContent = `
    .tp-social{display:flex;justify-content:center;gap:14px;margin:0 0 10px}
    .tp-social a{display:inline-flex;width:40px;height:40px;border-radius:50%;align-items:center;justify-content:center;background:rgba(0,184,200,.12)}
    .tp-social img{width:22px;height:22px;object-fit:contain;display:block;filter:invert(24%) sepia(34%) saturate(1520%) hue-rotate(163deg) brightness(86%) contrast(94%)}
    @media (prefers-color-scheme:dark){.tp-social a{background:rgba(255,255,255,.12)}.tp-social img{filter:brightness(0) invert(1)}}
    .tp-prep h3{margin:14px 0 6px;font-size:15px}.tp-prep h3:first-child{margin-top:0}
    .tp-prep ul{margin:0;padding-left:0;list-style:none}.tp-prep li{padding:5px 0 5px 26px;position:relative;font-size:14px}
    .tp-prep li:before{content:"✓";position:absolute;left:4px;color:var(--ok,#18815d);font-weight:bold}
    .tp-ask{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
    .tp-ask a{display:block;text-align:center;text-decoration:none;padding:11px 8px;border-radius:12px;font-size:13px;font-weight:bold;border:1px solid var(--line,#dce6ea);color:var(--text,#203342);background:var(--card,#fff)}
  `;
  document.head.append(style);

  const NETWORKS = [['instagram', 'Instagram', 'icon-instagram.png'], ['facebook', 'Facebook', 'icon-facebook.png'], ['tiktok', 'TikTok', 'icon-tiktok.png'], ['youtube', 'YouTube', 'icon-youtube.png']];

  /** Iconos de redes sociales con la liga que el administrador configuró en Documentos. */
  function social(documents) {
    const items = NETWORKS.map(([key, label, file]) => [safe(documents?.[key]), label, file]).filter(([url]) => url);
    if (!items.length) return '';
    return `<div class="tp-social">${items.map(([url, label, file]) => `<a href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}"><img src="/doc-assets/${file}" alt="${esc(label)}"></a>`).join('')}</div>`;
  }

  /** Apartado "¿Qué necesito para mi viaje?". waLink(texto) debe devolver la liga de WhatsApp del asesor (o ''). */
  function prepare({ documents = {}, destination = '', waLink = () => '' } = {}) {
    const docs = lines(documents.resDocuments);
    const tips = lines(documents.resFlightTips);
    const topics = [['📄 Documentos y requisitos', 'los documentos y requisitos'], ['💳 Pagos', 'mis pagos'], ['🧳 Equipaje', 'el equipaje'], ['🚐 Traslados y horarios', 'mis traslados y horarios'], ['🏨 Mi hotel', 'mi hotel'], ['💬 Otra duda', 'una duda']];
    const ask = topics.map(([label, topic]) => { const href = waLink(`Hola, tengo una duda sobre ${topic} de mi viaje${destination ? ` a ${destination}` : ''}.`); return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : ''; }).join('');
    if (!docs.length && !tips.length && !ask) return '';
    return `<div class="card tp-prep">
      ${docs.length ? `<h3>📋 Lo que necesitas llevar</h3><ul>${docs.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      ${tips.length ? `<h3>✈️ Antes de salir</h3><ul>${tips.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      ${ask ? `<h3>¿Tienes una duda? Pregúntale a tu Travel Partner</h3><div class="tp-ask">${ask}</div>` : ''}</div>`;
  }

  global.TPExtras = { social, prepare };
}(window));
