'use strict';

/* =========================================================
   Documentos para el cliente: Cotización y Confirmación de servicios.
   Diseños de Viajes Casal (Cotizador y Confirmación V8) alimentados
   con los datos del CRM. Se usa en documento.html y en la plataforma.
   ========================================================= */
(function (global) {
  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
  const str = (v) => String(v ?? '').trim();
  const lines = (v) => String(v || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  // Solo enlaces http(s); cualquier otra cosa se descarta.
  const safeUrl = (u) => { const v = str(u); if (!v) return ''; const full = /^https?:\/\//i.test(v) ? v : (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v) ? `https://${v}` : ''); return /^https?:\/\/[^\s<>"']+$/i.test(full) ? full : ''; };
  const media = (id) => (Number(id) > 0 ? `/api/media/${Number(id)}` : '');
  const digits = (p) => String(p || '').replace(/\D/g, '');
  // Números de 10 dígitos se consideran de México (+52).
  const waNumber = (p) => { const d = digits(p); return d.length === 10 ? `52${d}` : d; };
  const waLink = (p, text) => { const n = waNumber(p); return n ? `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}` : ''; };
  const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; };
  const hasNum = (v) => /\d/.test(String(v ?? ''));
  const money = (v) => `$${num(v).toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN`;
  const firstName = (n) => str(n).split(/\s+/)[0] || '';
  const titleCase = (s) => str(s).toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  const MESES_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const MESES_CAP = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const parseISO = (iso) => { if (!/^\d{4}-\d{2}-\d{2}/.test(iso || '')) return null; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const nightsBetween = (a, b) => { const s = parseISO(a), e = parseISO(b); return s && e ? Math.round((e - s) / 86400000) : null; };
  function formatDateRange(sISO, eISO) {
    const s = parseISO(sISO), e = parseISO(eISO);
    if (!s || !e || e < s) return '';
    const nights = Math.round((e - s) / 86400000);
    let range;
    if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) range = `${s.getDate()}–${e.getDate()} ${MESES_FULL[s.getMonth()]} ${s.getFullYear()}`;
    else if (s.getFullYear() === e.getFullYear()) range = `${s.getDate()} ${MESES_SHORT[s.getMonth()]} – ${e.getDate()} ${MESES_SHORT[e.getMonth()]} ${s.getFullYear()}`;
    else range = `${s.getDate()} ${MESES_SHORT[s.getMonth()]} ${s.getFullYear()} – ${e.getDate()} ${MESES_SHORT[e.getMonth()]} ${e.getFullYear()}`;
    return `${range} · ${nights + 1} días / ${nights} noches`;
  }
  const formatSingleDate = (iso) => { const d = parseISO(iso); return d ? `${d.getDate()} ${MESES_SHORT[d.getMonth()]} ${d.getFullYear()}` : ''; };
  const shortDate = (iso) => { const d = parseISO(iso); return d ? `${String(d.getDate()).padStart(2, '0')} ${MESES_CAP[d.getMonth()]} ${d.getFullYear()}` : ''; };
  const longDate = (iso) => { const d = parseISO(iso); return d ? `${String(d.getDate()).padStart(2, '0')} de ${MESES_FULL[d.getMonth()]} de ${d.getFullYear()}` : ''; };

  /* ---------- Íconos (mismo set del Cotizador) ---------- */
  const ICONS = {
    vuelo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    hotel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="7" rx="1.5"/><path d="M3 11V8a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3"/><path d="M13 11V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 18v2"/><path d="M21 18v2"/></svg>',
    traslados: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h11.2a2 2 0 0 1 1.9 1.5L21 13"/><rect x="2" y="13" width="20" height="5" rx="1.5"/><circle cx="7" cy="18.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="18.5" r="1.4" fill="currentColor" stroke="none"/></svg>',
    tours: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-2 5-1 1-2-5 2-1z" fill="currentColor" stroke="none"/></svg>',
    seguro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    partner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2" y="13" width="4" height="6" rx="1.5"/><rect x="18" y="13" width="4" height="6" rx="1.5"/><path d="M20 19v1a3 3 0 0 1-3 3h-3"/></svg>',
    tarjeta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>',
    transferencia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>',
    facilidades: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
    facebook: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 9h-2a2 2 0 0 0-2 2v2H8v3h2v6h3v-6h2.2l.3-3H13v-1.5c0-.5.2-1 1-1h1.5V8.2A20 20 0 0 0 14 8Z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v11"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/><circle cx="17" cy="16" r="2" fill="currentColor" stroke="none"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="3"/><path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" stroke="none"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l6-6"/><path d="M11 7l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M13 17l-1 1a3.5 3.5 0 0 1-5-5l1-1"/></svg>',
    guia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/></svg>',
    alimentos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v7M11 3v7M7 10a4 4 0 0 0 4 0M9 10v11"/><path d="M17 3c-1.5 1.5-1.5 5 0 6.5V21"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>',
    cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5" fill="currentColor" stroke="none"/></svg>',
    blog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5V4.5Z"/><path d="M4 19a2.5 2.5 0 0 1 2.5-2.5H20"/><path d="M8 7h8M8 10.5h8"/></svg>'
  };

  const SERVICES = [
    { key: 'vuelo', label: 'Vuelo' }, { key: 'hotel', label: 'Hotel' }, { key: 'traslados', label: 'Traslados' },
    { key: 'tours', label: 'Tours' }, { key: 'seguro', label: 'Seguro' }
  ];
  const LOGO = '/brand/logo-mark.png';

  /* =========================================================
     COTIZACIÓN
     ========================================================= */
  // Convierte lo guardado (o una cotización antigua sin cotizador) a la estructura del cotizador.
  function normalizeDetails(quote, lead) {
    const d = quote?.details && typeof quote.details === 'object' ? JSON.parse(JSON.stringify(quote.details)) : null;
    if (d?.kind === 'circuito') return normalizeCircuit(d, lead);
    if (d && Array.isArray(d.proposals) && d.proposals.length) {
      d.services = { vuelo: false, hotel: false, traslados: false, tours: false, seguro: false, ...(d.services || {}) };
      if (!SERVICES.some((s) => s.key === d.varying)) d.varying = SERVICES.find((s) => d.services[s.key])?.key || 'hotel';
      d.fixed = d.fixed || {};
      d.proposals = d.proposals.slice(0, 4).map((p) => ({ ...p, price: p.price || {}, pay: p.pay || { esquema: 'anticipo' } }));
      d.principal = Math.min(Math.max(Number(d.principal) || 0, 0), d.proposals.length - 1);
      d.startDate = d.startDate || lead?.start_date || '';
      d.endDate = d.endDate || lead?.end_date || '';
      d.pax = d.pax ?? (lead?.travelers ? `${lead.travelers} ${lead.travelers === 1 ? 'pasajero' : 'pasajeros'}` : '');
      return d;
    }
    return {
      version: 1,
      pax: lead?.travelers ? `${lead.travelers} ${lead.travelers === 1 ? 'pasajero' : 'pasajeros'}` : '',
      startDate: lead?.start_date || '', endDate: lead?.end_date || '', linkOnline: '', heroMediaId: null,
      services: { vuelo: false, hotel: true, traslados: false, tours: false, seguro: false },
      varying: 'hotel', fixed: {}, principal: 0,
      proposals: [{ hotel: { hotel: quote?.hotel || '', stars: '5', room: '', plan: '', desc: quote?.services || '' }, price: { total: quote?.price ? String(quote.price) : '', pp: '', base: '' }, pay: { esquema: 'anticipo' } }]
    };
  }

  // Etiqueta corta de cada propuesta (para pestañas, mensaje y el campo "Hotel / paquete" del CRM).
  function optionLabel(varying, d) {
    if (varying === 'hotel') return d.hotel?.hotel ? d.hotel.hotel + (d.hotel.plan ? ` — ${d.hotel.plan}` : '') : 'Hotel por confirmar';
    if (varying === 'vuelo') return d.vuelo?.aerolinea ? `Vuelo ${d.vuelo.aerolinea}` : 'Vuelo';
    if (varying === 'traslados') return `Traslados${d.traslados?.tipo ? ` — ${d.traslados.tipo}` : ''}`;
    if (varying === 'seguro') return 'Seguro de viaje';
    if (varying === 'tours') return (d.tours?.items || []).find((t) => t && str(t.nombre))?.nombre || 'Tours';
    return 'Propuesta';
  }

  function quoteModel(payload) {
    const { quote, client = {}, lead, seller = {}, documents = {}, agency = {} } = payload;
    const details = normalizeDetails(quote, lead);
    const brand = documents.brandName || 'VIAJES CASAL';
    const g = {
      folio: quote.folio || 'Cotización',
      cliente: client?.name || 'Nombre del cliente',
      clienteTel: client?.phone || '',
      vigencia: quote.valid_until || '',
      partner: seller?.name || 'Tu Travel Partner',
      partnerTel: seller?.phone || documents.supportWhatsapp || agency.whatsapp || '',
      partnerPhoto: seller?.photoUrl || '',
      partnerBio: seller?.bio || '',
      partnerWebsite: safeUrl(seller?.website),
      linkOnline: safeUrl(details.linkOnline),
      destino: quote.destination || 'Destino por confirmar',
      pax: details.pax || '',
      fechaSalida: details.startDate, fechaRegreso: details.endDate,
      fechasTexto: formatDateRange(details.startDate, details.endDate),
      heroImg: media(details.heroMediaId),
      services: details.services,
      varying: details.varying,
      brand,
      brandName: titleCase(brand)
    };
    const fixed = {};
    SERVICES.forEach((s) => { if (details.services[s.key] && s.key !== details.varying && details.fixed[s.key]) fixed[s.key] = details.fixed[s.key]; });
    const dataList = details.proposals.map((p) => ({ ...fixed, [details.varying]: p[details.varying] || {}, price: p.price || {}, pay: p.pay || {} }));
    return { g, dataList, details, documents, quote };
  }

  function sheetHTML(model, d, idx) {
    const { g, dataList, documents } = model;
    const count = dataList.length;
    const price = d.price || {};
    const folio = `${g.folio}${count > 1 ? `-${idx + 1}` : ''}`;
    const vigenciaTxt = g.vigencia ? formatSingleDate(g.vigencia) : '—';
    const clienteNombre = firstName(g.cliente) || g.cliente;
    const wa = waLink(g.partnerTel);
    const style = (name, url) => (url ? ` style="--${name}:url('${url}')"` : '');

    const activeServices = SERVICES.filter((s) => g.services[s.key] && s.key !== 'tours');
    const includeIcons = activeServices.map((s) => `<div><span class="ico">${ICONS[s.key]}</span><b>${s.label}</b></div>`).join('') + `<div><span class="ico">${ICONS.partner}</span><b>Travel Partner</b></div>`;

    let hotelCard = '';
    if (g.services.hotel && d.hotel) {
      const stars = '★'.repeat(Math.min(Math.max(parseInt(d.hotel.stars, 10) || 5, 1), 5));
      hotelCard = `<section class="card hotel"><div class="hotelimg"${style('hotelimg', media(d.hotel.mediaId))}></div><div>
        <div class="lbl">Tu hotel</div><h3>${esc(d.hotel.hotel || 'Hotel por confirmar')}</h3><div class="stars">${stars}</div>
        ${d.hotel.room ? `<p>${esc(d.hotel.room)}</p>` : ''}${d.hotel.plan ? `<p><b>Plan:</b> ${esc(d.hotel.plan)}</p>` : ''}
        ${g.fechasTexto ? `<p><b>Estancia:</b> ${esc(g.fechasTexto)}</p>` : ''}
        <div class="chips"><span class="chip">✓ Acompañamiento ${esc(g.brandName)}</span><span class="chip">✓ Reserva verificada</span></div>
        ${d.hotel.desc ? `<p>${esc(d.hotel.desc)}</p>` : ''}</div></section>`;
    }
    let vueloCard = '', trasladosCard = '';
    if (g.services.vuelo && d.vuelo) {
      const v = d.vuelo;
      const ida = g.fechaSalida ? `${formatSingleDate(g.fechaSalida)} | ${v.origen || ''} → ${g.destino} | ${v.hsIda || ''}${v.hlIda ? `–${v.hlIda}` : ''}` : '';
      const reg = g.fechaRegreso ? `${formatSingleDate(g.fechaRegreso)} | ${g.destino} → ${v.origen || ''} | ${v.hsReg || ''}${v.hlReg ? `–${v.hlReg}` : ''}` : '';
      vueloCard = `<section class="card detail"><h3><span class="iconLabel">${ICONS.vuelo}Vuelo</span><span>${esc(v.aerolinea)}</span></h3>
        ${ida ? `<p><b>Ida:</b> ${esc(ida)}</p>` : ''}${reg ? `<p><b>Regreso:</b> ${esc(reg)}</p>` : ''}
        <p><b>Equipaje:</b> ${esc(v.equipaje || 'artículo personal + equipaje de mano')}</p></section>`;
    }
    if (g.services.traslados && d.traslados) {
      trasladosCard = `<section class="card detail"><h3><span class="iconLabel">${ICONS.traslados}Traslados</span><span>${esc(d.traslados.tipo)}</span></h3>
        <p>${esc(d.traslados.desc || 'Servicio coordinado según tus horarios de vuelo.')}</p></section>`;
    }
    const two = [vueloCard, trasladosCard].filter(Boolean);
    const twoColHTML = two.length ? `<div class="twocol" style="grid-template-columns:${two.length > 1 ? '1fr 1fr' : '1fr'}">${two.join('')}</div>` : '';

    let toursCard = '';
    const tourItems = (d.tours?.items || []).filter((t) => t && str(t.nombre));
    if (g.services.tours && tourItems.length) {
      toursCard = `<section class="card"><div class="cardtitle iconLabel">${ICONS.tours}TOURS Y EXPERIENCIAS <span style="font-weight:600;font-size:11px;color:#6b8580;margin-left:6px;text-transform:none">· complemento a tu paquete, con costo adicional</span></div>
        ${d.tours.promo ? `<div class="chip" style="background:var(--coral);color:#fff;font-weight:800;margin-bottom:14px;display:inline-block">${esc(d.tours.promo)}</div>` : ''}
        <div class="experiences" style="grid-template-columns:repeat(${Math.min(tourItems.length, 3)},1fr)">
        ${tourItems.map((t) => `<div class="exp">${media(t.mediaId) ? `<div class="hotelimg" style="height:110px;margin-bottom:10px;--hotelimg:url('${media(t.mediaId)}')"></div>` : ''}<b>${esc(t.nombre)}</b>${t.precio ? `<p style="color:var(--coral);font-weight:800;margin:4px 0 2px">${esc(t.precio)}</p>` : ''}${t.desc ? `<p>${esc(t.desc)}</p>` : ''}</div>`).join('')}
        </div></section>`;
    }
    let seguroCard = '';
    if (g.services.seguro && d.seguro) {
      seguroCard = `<section class="card"><div class="cardtitle iconLabel">${ICONS.seguro}SEGURO DE VIAJE</div>
        <p style="font-size:13px;line-height:1.5">${esc(d.seguro.cobertura || 'Cobertura por confirmar.')}</p>
        ${g.fechasTexto ? `<p style="font-size:12px;color:#6b8580"><b>Vigencia del seguro:</b> ${esc(g.fechasTexto)}</p>` : ''}</section>`;
    }

    const pay = d.pay || {};
    const pagos = (pay.pagos || []).filter((p) => p && (p.fecha || p.monto));
    const deposit = pay.esquema === 'plan' && pagos.length
      ? `<span>PLAN DE PAGOS</span><ul class="payplan">${pagos.map((p, i) => `<li><span>${i === pagos.length - 1 && pagos.length > 1 ? `Pago ${i + 1} (liquidación)` : `Pago ${i + 1}`}${p.fecha ? ` · ${esc(formatSingleDate(p.fecha))}` : ''}</span><b>${esc(money(p.monto))}</b></li>`).join('')}</ul>`
      : `<span>APARTA TU VIAJE CON</span><br><strong>${esc(money(pay.anticipo))}</strong>
         <p>Saldo pendiente: ${esc(money(num(price.total) - num(pay.anticipo)))}</p>
         <p><b>Vigencia:</b> ${esc(pay.anticipoFecha ? formatSingleDate(pay.anticipoFecha) : vigenciaTxt)}</p>`;
    const reserveText = `Hola ${g.partner}, quiero reservar mi viaje — Cotización ${folio}. ¡Vamos con esta opción!`;
    const benefits = lines(documents.partnerBenefits);
    const bio = g.partnerBio || `Soy ${firstName(g.partner)}, tu Travel Partner en ${g.brandName}. Te acompaño desde el primer mensaje hasta que regresas a casa, cuidando cada detalle de tu viaje para que tú solo pienses en disfrutarlo.`;
    const blog = safeUrl(documents.blogUrl);
    const socials = [['web', documents.website, 'Sitio web'], ['instagram', documents.instagram, 'Instagram'], ['facebook', documents.facebook, 'Facebook'], ['tiktok', documents.tiktok, 'TikTok'], ['youtube', documents.youtube, 'YouTube']]
      .map(([k, u, label]) => [k, safeUrl(u), label]).filter(([, u]) => u);
    const reviews = safeUrl(documents.reviewsUrl);

    return `<div class="sheet" id="sheet-${idx}" data-sheet="${idx}">
    <section class="hero"${style('heroimg', g.heroImg)}>
      <div class="heroTop"><div class="brandmark"><span class="logoBadge"><img src="${LOGO}" alt=""></span>${esc(g.brand)} <span class="wave">≋</span></div></div>
      <div>
        <div class="greeting">Hola, ${esc(clienteNombre)} — preparamos esto pensando en ti</div>
        <h1>Tu próxima<br>experiencia</h1>
        <p class="partnerMsg">Tu Travel Partner, <b>${esc(g.partner)}</b>, armó esta propuesta a tu medida — con cada detalle listo para que solo te enfoques en disfrutarla.</p>
      </div>
      <div class="heroBottom"><div class="quotebox"><small>COTIZACIÓN</small><strong>${esc(folio)}</strong><span>Vigencia: ${esc(vigenciaTxt)}</span>${count > 1 ? `<span class="propTag">Propuesta ${idx + 1} de ${count}</span>` : ''}</div></div>
    </section>
    <div class="content">
      <section class="card trip"><div class="cardtitle">≋ INFORMACIÓN DE TU VIAJE</div>
        <div class="tripgrid">
          <div><div class="lbl">Viajero</div><div class="val">${esc(g.cliente)}</div></div>
          <div><div class="lbl">Pasajeros</div><div class="val">${esc(g.pax || '—')}</div></div>
          <div><div class="lbl">Fechas</div><div class="val">${esc(g.fechasTexto || '—')}</div></div>
          <div><div class="lbl">Destino</div><div class="val">${esc(g.destino)}</div></div>
          <div class="support"><b>TU TRAVEL PARTNER</b><div class="val">${esc(g.partner)}</div>
            ${wa ? `<a class="wabtn" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp ↗</a>` : ''}
            ${g.linkOnline ? `<a class="linkbtn" href="${esc(g.linkOnline)}" target="_blank" rel="noopener">${ICONS.link}Ver en línea</a>` : ''}
          </div>
        </div>
      </section>
      <section class="card"><div class="cardtitle">≋ TU VIAJE INCLUYE</div><div class="services" style="grid-template-columns:repeat(${activeServices.length + 1},1fr)">${includeIcons}</div></section>
      ${hotelCard}${twoColHTML}${toursCard}${seguroCard}
      <section class="price">
        <div><h2>INVERSIÓN DE TU VIAJE</h2><div class="total">${esc(money(price.total))}</div>
          <div class="per">${hasNum(price.pp) ? `${esc(money(price.pp))} por persona · ` : ''}${price.base ? `Base ${esc(price.base)}` : ''}</div>
          ${wa ? `<a class="cta" href="${esc(waLink(g.partnerTel, reserveText))}" target="_blank" rel="noopener">RESERVAR MI VIAJE →</a>` : '<span class="cta">RESERVAR MI VIAJE →</span>'}
        </div>
        <div class="deposit">${deposit}</div>
      </section>
      <section class="card"><div class="cardtitle">FORMAS DE PAGO</div>
        <div class="services" style="grid-template-columns:repeat(3,1fr)"><div><span class="ico">${ICONS.tarjeta}</span><b>Tarjeta</b></div><div><span class="ico">${ICONS.transferencia}</span><b>Transferencia</b></div><div><span class="ico">${ICONS.facilidades}</span><b>Facilidades</b></div></div>
        ${str(documents.paymentInstructions) ? `<div class="payInfo">${esc(documents.paymentInstructions)}</div>` : ''}
      </section>
      <section class="legal">
        <div><b>ⓘ INFORMACIÓN IMPORTANTE</b><p>${esc(documents.quoteImportant)}</p></div>
        <div><b>⚙ POLÍTICAS</b><p>${esc(documents.quotePolicies)}</p></div>
        <div><b>◇ ESTA COTIZACIÓN</b><p>${esc(documents.quoteNote)}</p></div>
      </section>
      <section class="card"><div class="cardtitle">¿LISTO PARA VIAJAR?</div>
        <div class="steps"><div><span class="stepn">1</span><p>Confirma que la propuesta te gusta</p></div><div><span class="stepn">2</span><p>Verificamos disponibilidad</p></div><div><span class="stepn">3</span><p>Realizas tu anticipo</p></div><div><span class="stepn">4</span><p>Recibes tu confirmación</p></div></div>
      </section>
      <section class="card partnerIntro"><div class="cardtitle iconLabel">${ICONS.partner}CONOCE A TU TRAVEL PARTNER</div>
        <div class="partnerIntroBody"><div class="partnerPhoto"${style('partnerimg', g.partnerPhoto)}></div>
          <div class="partnerText"><h3>${esc(g.partner)}</h3><p class="bio">${esc(bio)}</p>
            ${benefits.length ? `<ul class="partnerBenefits">${benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
            ${blog ? `<p class="blogHint iconLabel">${ICONS.blog}En nuestro blog de viajes encontrarás guías útiles para planear tu próximo destino.</p>` : ''}
            <div class="partnerLinks">${g.partnerWebsite ? `<a class="linkbtn" href="${esc(g.partnerWebsite)}" target="_blank" rel="noopener">${ICONS.web}Conoce más de mí</a>` : ''}${blog ? `<a class="linkbtn" href="${esc(blog)}" target="_blank" rel="noopener">${ICONS.blog}Guías de viaje</a>` : ''}</div>
          </div></div>
      </section>
      ${documents.tagline ? `<div class="tagline">"${esc(documents.tagline)}"</div>` : ''}
    </div>
    <footer class="footer">
      <div><h2>¡Gracias por permitirnos ser parte de tu próximo viaje!</h2><small>Estamos contigo antes, durante y después de tu viaje.</small></div>
      <div><div class="socialIcons">${socials.map(([k, u, label]) => `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${label}">${ICONS[k]}</a>`).join('')}</div>
        ${safeUrl(documents.website) ? `<small style="letter-spacing:0">${esc(hostOf(safeUrl(documents.website)))}</small>` : ''}</div>
      ${reviews ? `<div class="reviews"><a href="${esc(reviews)}" target="_blank" rel="noopener">Conoce nuestras reseñas<br><span class="gold">★★★★★</span></a></div>` : '<div></div>'}
    </footer>
  </div>`;
  }

  function renderQuoteSheets(model) { return model.dataList.map((d, i) => sheetHTML(model, d, i)).join(''); }

  function buildQuoteMessage(model) {
    const { g, dataList } = model;
    let msg = `¡Hola${g.cliente !== 'Nombre del cliente' ? ` ${g.cliente}` : ''}! 👋 Soy ${g.partner}, tu Travel Partner en ${g.brandName}.\n\n`;
    msg += `Aquí tienes tu${dataList.length > 1 ? 's propuestas' : ' propuesta'} para tu viaje a ${g.destino}`;
    if (g.fechasTexto) msg += ` (${g.fechasTexto})`;
    msg += ':\n\n';
    dataList.forEach((d, i) => {
      msg += `${i + 1}️⃣ *${optionLabel(g.varying, d)}*\n`;
      msg += `   💰 ${money(d.price.total)}${hasNum(d.price.pp) ? ` (${money(d.price.pp)} por persona)` : ''}\n\n`;
    });
    const included = SERVICES.filter((s) => g.services[s.key] && s.key !== 'tours').map((s) => s.label.toLowerCase());
    msg += `Esta propuesta incluye ${included.length ? `${included.join(', ')} y ` : ''}mi acompañamiento antes, durante y después de tu viaje.\n\n`;
    if (g.services.tours && g.varying !== 'tours') {
      const tours = dataList[0]?.tours;
      const items = (tours?.items || []).filter((t) => t && str(t.nombre));
      if (items.length) {
        msg += '✨ Además, puedes agregar estos tours a tu paquete (costo adicional):\n';
        if (tours.promo) msg += `${tours.promo}\n`;
        items.forEach((t) => { msg += `• ${t.nombre}${t.precio ? ` — ${t.precio}` : ''}\n`; });
        msg += '\n';
      }
    }
    msg += 'Te comparto también el PDF con todos los detalles 📄\n';
    if (g.linkOnline) msg += `También puedes verla en línea aquí: ${g.linkOnline}\n`;
    msg += `\nCualquier duda aquí estoy. ${model.documents.tagline || 'Viajar tranquilo también se planea.'} ✈️🌊\n`;
    msg += `— ${g.partner} · ${g.brandName}`;
    return msg;
  }

  /* =========================================================
     COTIZACIÓN DE CIRCUITO
     ========================================================= */
  const CIRCUIT_SERVICES = [
    { key: 'vuelo', label: 'Vuelo' }, { key: 'traslados', label: 'Traslados' }, { key: 'hotel', label: 'Hospedaje' },
    { key: 'tours', label: 'Tours y entradas' }, { key: 'alimentos', label: 'Alimentos' }, { key: 'guia', label: 'Guía' }, { key: 'seguro', label: 'Seguro' }
  ];
  const DEFAULT_OCCUPANCIES = ['Sencilla', 'Doble', 'Triple', 'Cuádruple'];

  function normalizeCircuit(d, lead) {
    const c = d.circuit && typeof d.circuit === 'object' ? d.circuit : {};
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
    const occupancies = arr(c.occupancies).map((o) => str(typeof o === 'object' ? o.nombre : o));
    return {
      version: 1, kind: 'circuito',
      pax: d.pax ?? (lead?.travelers ? `${lead.travelers} ${lead.travelers === 1 ? 'pasajero' : 'pasajeros'}` : ''),
      startDate: d.startDate || lead?.start_date || '', linkOnline: d.linkOnline || '', heroMediaId: d.heroMediaId || null,
      circuit: {
        nombre: c.nombre || '', tipoTraslado: c.tipoTraslado || '', idiomaGuia: c.idiomaGuia || '',
        ruta: arr(c.ruta).map((x) => str(x)),
        services: { vuelo: true, traslados: true, hotel: true, tours: true, alimentos: true, guia: true, seguro: true, ...(c.services || {}) },
        days: arr(c.days).map((x) => ({ titulo: x.titulo || '', descripcion: x.descripcion || '', desayuno: !!x.desayuno, comida: !!x.comida, cena: !!x.cena })),
        categories: arr(c.categories).map((x) => ({ nombre: x.nombre || '', estrellas: String(x.estrellas || '3'), hoteles: arr(x.hoteles).map((h) => ({ ciudad: h.ciudad || '', hotel: h.hotel || '' })), precios: arr(x.precios).map((v) => str(v)) })),
        occupancies: occupancies.length ? occupancies : [...DEFAULT_OCCUPANCIES],
        incluye: arr(c.incluye).map((x) => str(x)), excluye: arr(c.excluye).map((x) => str(x))
      }
    };
  }
  function newCircuitDetails(lead) {
    const d = normalizeCircuit({ kind: 'circuito', circuit: {} }, lead);
    d.circuit.ruta = ['', ''];
    d.circuit.days = [{ titulo: '', descripcion: '', desayuno: true, comida: false, cena: false }];
    d.circuit.categories = [{ nombre: 'Estándar', estrellas: '3', hoteles: [{ ciudad: '', hotel: '' }], precios: [] }];
    d.circuit.incluye = ['', ''];
    d.circuit.excluye = ['Propinas y gastos personales', ''];
    return d;
  }
  const circuitNights = (c) => Math.max((c.days.length || 1) - 1, 0);
  function circuitEndDate(d) {
    const s = parseISO(d.startDate);
    if (!s) return '';
    s.setDate(s.getDate() + circuitNights(d.circuit));
    return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
  }
  // Precio "desde": el más bajo de la tabla de tarifas.
  function circuitDesde(c) {
    let best = null;
    c.categories.forEach((cat, ci) => c.occupancies.forEach((occ, oi) => {
      const v = cat.precios[oi];
      if (!hasNum(v)) return;
      const n = num(v);
      if (n > 0 && (!best || n < best.min)) best = { min: n, cat: cat.nombre || `Categoría ${ci + 1}`, occ };
    }));
    return best;
  }
  const dn = (c) => { const dias = c.days.length || 1, noches = circuitNights(c); return `${dias} día${dias > 1 ? 's' : ''} / ${noches} noche${noches !== 1 ? 's' : ''}`; };

  function circuitModel(payload) {
    const { quote, client = {}, lead, seller = {}, documents = {}, agency = {} } = payload;
    const details = normalizeDetails(quote, lead);
    const brand = documents.brandName || 'VIAJES CASAL';
    return {
      kind: 'circuito', details, documents, quote,
      g: {
        folio: quote.folio || 'Cotización', cliente: client?.name || 'Nombre del cliente', clienteTel: client?.phone || '',
        vigencia: quote.valid_until || '', partner: seller?.name || 'Tu Travel Partner',
        partnerTel: seller?.phone || documents.supportWhatsapp || agency.whatsapp || '', partnerPhoto: seller?.photoUrl || '',
        partnerBio: seller?.bio || '', partnerWebsite: safeUrl(seller?.website), linkOnline: safeUrl(details.linkOnline),
        circuito: details.circuit.nombre || quote.destination || 'Tu próximo circuito', destino: quote.destination || '',
        pax: details.pax || '', fechaSalida: details.startDate, heroImg: media(details.heroMediaId),
        brand, brandName: titleCase(brand)
      }
    };
  }

  // Bloques compartidos con la cotización de paquete (pago, legales, Travel Partner y pie).
  function closingBlocks(g, documents, legal) {
    const benefits = lines(documents.partnerBenefits);
    const bio = g.partnerBio || `Soy ${firstName(g.partner)}, tu Travel Partner en ${g.brandName}. Te acompaño desde el primer mensaje hasta que regresas a casa, cuidando cada detalle de tu viaje para que tú solo pienses en disfrutarlo.`;
    const blog = safeUrl(documents.blogUrl);
    const style = (name, url) => (url ? ` style="--${name}:url('${url}')"` : '');
    const socials = [['web', documents.website, 'Sitio web'], ['instagram', documents.instagram, 'Instagram'], ['facebook', documents.facebook, 'Facebook'], ['tiktok', documents.tiktok, 'TikTok'], ['youtube', documents.youtube, 'YouTube']]
      .map(([k, u, label]) => [k, safeUrl(u), label]).filter(([, u]) => u);
    const reviews = safeUrl(documents.reviewsUrl);
    return `
      <section class="card"><div class="cardtitle">FORMAS DE PAGO</div>
        <div class="services" style="grid-template-columns:repeat(3,1fr)"><div><span class="ico">${ICONS.tarjeta}</span><b>Tarjeta</b></div><div><span class="ico">${ICONS.transferencia}</span><b>Transferencia</b></div><div><span class="ico">${ICONS.facilidades}</span><b>Facilidades</b></div></div>
        ${str(documents.paymentInstructions) ? `<div class="payInfo">${esc(documents.paymentInstructions)}</div>` : ''}
      </section>
      <section class="legal">
        <div><b>ⓘ INFORMACIÓN IMPORTANTE</b><p>${esc(legal[0])}</p></div>
        <div><b>⚙ POLÍTICAS</b><p>${esc(legal[1])}</p></div>
        <div><b>◇ ESTA COTIZACIÓN</b><p>${esc(legal[2])}</p></div>
      </section>
      <section class="card partnerIntro"><div class="cardtitle iconLabel">${ICONS.partner}CONOCE A TU TRAVEL PARTNER</div>
        <div class="partnerIntroBody"><div class="partnerPhoto"${style('partnerimg', g.partnerPhoto)}></div>
          <div class="partnerText"><h3>${esc(g.partner)}</h3><p class="bio">${esc(bio)}</p>
            ${benefits.length ? `<ul class="partnerBenefits">${benefits.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
            ${blog ? `<p class="blogHint iconLabel">${ICONS.blog}En nuestro blog de viajes encontrarás guías útiles para planear tu próximo destino.</p>` : ''}
            <div class="partnerLinks">${g.partnerWebsite ? `<a class="linkbtn" href="${esc(g.partnerWebsite)}" target="_blank" rel="noopener">${ICONS.web}Conoce más de mí</a>` : ''}${blog ? `<a class="linkbtn" href="${esc(blog)}" target="_blank" rel="noopener">${ICONS.blog}Guías de viaje</a>` : ''}</div>
          </div></div>
      </section>
      ${documents.tagline ? `<div class="tagline">"${esc(documents.tagline)}"</div>` : ''}
    </div>
    <footer class="footer">
      <div><h2>¡Gracias por permitirnos ser parte de tu próximo viaje!</h2><small>Estamos contigo antes, durante y después de tu viaje.</small></div>
      <div><div class="socialIcons">${socials.map(([k, u, label]) => `<a href="${esc(u)}" target="_blank" rel="noopener" aria-label="${label}">${ICONS[k]}</a>`).join('')}</div>
        ${safeUrl(documents.website) ? `<small style="letter-spacing:0">${esc(hostOf(safeUrl(documents.website)))}</small>` : ''}</div>
      ${reviews ? `<div class="reviews"><a href="${esc(reviews)}" target="_blank" rel="noopener">Conoce nuestras reseñas<br><span class="gold">★★★★★</span></a></div>` : '<div></div>'}
    </footer>`;
  }

  function renderCircuitSheet(model) {
    const { g, details, documents } = model;
    const c = details.circuit;
    const wa = waLink(g.partnerTel);
    const style = (name, url) => (url ? ` style="--${name}:url('${url}')"` : '');
    const ruta = c.ruta.filter(Boolean);
    const desde = circuitDesde(c);
    const active = CIRCUIT_SERVICES.filter((s) => c.services[s.key]);
    const stars = (n) => '★'.repeat(Math.min(Math.max(parseInt(n, 10) || 3, 1), 5));
    const days = c.days.map((d, i) => {
      const meals = [d.desayuno && 'Desayuno incluido', d.comida && 'Comida incluida', d.cena && 'Cena incluida'].filter(Boolean);
      return `<div class="dayItem"><div class="dayNum">${i + 1}</div><h4>${esc(d.titulo || `Día ${i + 1}`)}</h4>${d.descripcion ? `<p>${esc(d.descripcion)}</p>` : ''}<div class="mealTags">${(meals.length ? meals : ['Sin alimentos incluidos']).map((m) => `<span class="mealTag">${m}</span>`).join('')}</div></div>`;
    }).join('');
    const cats = c.categories.map((cat) => `<div class="hotelCat"><div class="stars">${stars(cat.estrellas)}</div><h4>${esc(cat.nombre || 'Categoría')}</h4><ul>${cat.hoteles.filter((h) => h.ciudad || h.hotel).map((h) => `<li><span>${esc(h.ciudad)}</span><span>${esc(h.hotel)}</span></li>`).join('')}</ul></div>`).join('');
    const hi = c.occupancies.findIndex((o) => o.toLowerCase() === 'doble');
    const cell = (v) => (hasNum(v) && num(v) > 0 ? money(v) : (str(v) || '—'));
    const table = c.categories.length && c.occupancies.length ? `<table class="priceTable"><thead><tr><th>Categoría</th>${c.occupancies.map((o, i) => `<th${i === hi ? ' class="highlight"' : ''}>${esc(o || 'Ocupación')}</th>`).join('')}</tr></thead>
      <tbody>${c.categories.map((cat) => `<tr><td>${esc(cat.nombre || 'Categoría')} ${stars(cat.estrellas)}</td>${c.occupancies.map((o, i) => `<td${i === hi ? ' class="highlight"' : ''}>${esc(cell(cat.precios[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
    const inc = c.incluye.filter(Boolean), exc = c.excluye.filter(Boolean);
    const reserve = `Hola ${g.partner}, quiero reservar el circuito ${g.circuito} — Cotización ${g.folio}. ¡Me interesa!`;
    return `<div class="sheet" data-sheet="0">
    <section class="hero"${style('heroimg', g.heroImg)}>
      <div class="heroTop"><div class="brandmark"><span class="logoBadge"><img src="${LOGO}" alt=""></span>${esc(g.brand)} <span class="wave">≋</span></div></div>
      <div>
        <div class="greeting">Hola, ${esc(firstName(g.cliente) || g.cliente)} — preparamos este circuito pensando en ti</div>
        <h1>${esc(g.circuito)}</h1>
        <p class="partnerMsg">Tu Travel Partner, <b>${esc(g.partner)}</b>, armó este circuito a tu medida — con cada traslado, hotel y visita ya coordinados para que solo te enfoques en disfrutarlo.</p>
        ${ruta.length ? `<div class="routeStrip">${ruta.map((n, i) => `<span>${esc(n)}</span>${i < ruta.length - 1 ? '<span class="dot">→</span>' : ''}`).join('')}</div>` : ''}
      </div>
      <div class="heroBottom"><div class="quotebox"><small>COTIZACIÓN DE CIRCUITO</small><strong>${esc(g.folio)}</strong><span>Vigencia: ${esc(g.vigencia ? formatSingleDate(g.vigencia) : '—')}</span></div></div>
    </section>
    <div class="content">
      <section class="card trip"><div class="cardtitle">INFORMACIÓN DEL VIAJERO</div>
        <div class="tripgrid">
          <div><div class="lbl">Viajero</div><div class="val">${esc(g.cliente)}</div></div>
          <div><div class="lbl">Pasajeros</div><div class="val">${esc(g.pax || '—')}</div></div>
          <div><div class="lbl">Salida</div><div class="val">${esc(g.fechaSalida ? formatSingleDate(g.fechaSalida) : '—')}</div></div>
          <div><div class="lbl">Circuito</div><div class="val">${esc(dn(c))}</div></div>
          <div class="support"><b>TU TRAVEL PARTNER</b><div class="val">${esc(g.partner)}</div>
            ${wa ? `<a class="wabtn" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp ↗</a>` : ''}
            ${g.linkOnline ? `<a class="linkbtn" href="${esc(g.linkOnline)}" target="_blank" rel="noopener">${ICONS.link}Ver en línea</a>` : ''}</div>
        </div>
      </section>
      <section class="card"><div class="cardtitle">TU CIRCUITO EN UN VISTAZO</div>
        <div class="factsRow">
          <div class="factBox"><span class="ico">${ICONS.calendar}</span><b>${esc(dn(c))}</b><span>Duración total</span></div>
          <div class="factBox"><span class="ico">${ICONS.pin}</span><b>${ruta.length} ciudad${ruta.length !== 1 ? 'es' : ''}</b><span>${esc(ruta.join(' · ') || '—')}</span></div>
          <div class="factBox"><span class="ico">${ICONS.traslados}</span><b>${esc(c.tipoTraslado || '—')}</b><span>Traslados entre ciudades</span></div>
          <div class="factBox"><span class="ico">${ICONS.guia}</span><b>Guía en ${esc(c.idiomaGuia || 'español')}</b><span>Acompañante todo el circuito</span></div>
        </div>
      </section>
      ${active.length ? `<section class="card"><div class="cardtitle">TU CIRCUITO INCLUYE</div><div class="services" style="grid-template-columns:repeat(${active.length},1fr)">${active.map((s) => `<div><span class="ico">${ICONS[s.key]}</span><b>${s.label}</b></div>`).join('')}</div>
        ${c.services.alimentos ? '<div class="priceNote" style="text-align:center;margin-top:14px">* El detalle de alimentos incluidos (desayuno, comida y/o cena) se especifica día por día en el itinerario.</div>' : ''}</section>` : ''}
      ${c.days.length ? `<section class="card"><div class="cardtitle">ITINERARIO DÍA POR DÍA</div><div class="timeline">${days}</div></section>` : ''}
      ${c.categories.length ? `<section class="card"><div class="cardtitle">HOSPEDAJE POR CATEGORÍA</div><div class="hotelCats" style="grid-template-columns:repeat(${Math.min(Math.max(c.categories.length, 1), 3)},1fr)">${cats}</div></section>` : ''}
      ${table ? `<section class="card"><div class="cardtitle">TARIFAS POR PERSONA (MXN)</div>${table}<div class="priceNote">Tarifas por persona, según ocupación seleccionada. Precios sujetos a disponibilidad al momento de confirmar.</div></section>` : ''}
      ${inc.length || exc.length ? `<section class="card"><div class="cardtitle">¿QUÉ INCLUYE Y QUÉ NO?</div><div class="incGrid">
        <div class="incCol"><h4>Incluye</h4><ul>${inc.map((t) => `<li class="incYes">${ICONS.check}${esc(t)}</li>`).join('')}</ul></div>
        <div class="incCol"><h4>No incluye</h4><ul>${exc.map((t) => `<li class="incNo">${ICONS.cross}${esc(t)}</li>`).join('')}</ul></div></div></section>` : ''}
      <section class="price">
        <div><h2>${desde ? `DESDE (${esc(desde.cat)}, OCUPACIÓN ${esc(desde.occ.toUpperCase())})` : 'INVERSIÓN POR PERSONA'}</h2>
          <div class="total">${desde ? `${esc(money(desde.min))} <span style="font-size:15px;font-weight:600;color:#6b5a3f">por persona</span>` : 'Por confirmar'}</div>
          <div class="per">${desde ? 'Consulta la tabla completa de tarifas arriba según categoría y ocupación' : ''}</div></div>
        ${wa ? `<a class="cta" href="${esc(waLink(g.partnerTel, reserve))}" target="_blank" rel="noopener">RESERVAR MI CIRCUITO →</a>` : '<span class="cta">RESERVAR MI CIRCUITO →</span>'}
      </section>
      ${closingBlocks(g, documents, [documents.circImportant || documents.quoteImportant, documents.circPolicies || documents.quotePolicies, documents.quoteNote])}
  </div>`;
  }

  function buildCircuitMessage(model) {
    const { g, details } = model;
    const c = details.circuit;
    const desde = circuitDesde(c);
    const ruta = c.ruta.filter(Boolean);
    let msg = `¡Hola${g.cliente !== 'Nombre del cliente' ? ` ${g.cliente}` : ''}! 👋 Soy ${g.partner}, tu Travel Partner en ${g.brandName}.\n\n`;
    msg += `Aquí tienes tu circuito *${g.circuito}* (${dn(c)})`;
    if (ruta.length) msg += `: ${ruta.join(' → ')}`;
    msg += '\n\n';
    if (desde) msg += `💰 Desde ${money(desde.min)} por persona (${desde.cat}, ocupación ${desde.occ.toLowerCase()})\nConsulta el PDF para ver todas las categorías y ocupaciones disponibles.\n\n`;
    const included = CIRCUIT_SERVICES.filter((s) => c.services[s.key]).map((s) => s.label.toLowerCase());
    msg += `El circuito incluye ${included.length ? `${included.join(', ')}, ` : ''}con mi acompañamiento antes, durante y después de tu viaje.\n\n`;
    msg += 'Te comparto también el PDF con el itinerario completo día por día 📄\n';
    if (g.linkOnline) msg += `También puedes verlo en línea aquí: ${g.linkOnline}\n`;
    msg += `\nCualquier duda aquí estoy. ${model.documents.tagline || 'Viajar tranquilo también se planea.'} ✈️🌊\n— ${g.partner} · ${g.brandName}`;
    return msg;
  }

  /* =========================================================
     CONFIRMACIÓN DE SERVICIOS (reserva)
     ========================================================= */
  const QROO = /canc[uú]n|riviera maya|tulum|playa del carmen|cozumel|isla mujeres|holbox|bacalar|quintana roo|mahahual|puerto morelos|costa mujeres|akumal|chetumal|puerto aventuras|xcalak/i;
  const RES_SERVICES = [
    ['flight', 'Vuelo', 'icon-flight.png'], ['hotel', 'Hotel', 'icon-hotel.png'], ['transfer', 'Traslados', 'icon-transfer.png'],
    ['activities', 'Actividades y Tours', 'icon-activities.png'], ['insurance', 'Seguro de Viaje', 'icon-insurance.png'], ['partner', 'Travel Partner<br>24/7', 'icon-partner.png']
  ];

  // Valores iniciales tomados del viaje, la cotización aceptada y el vendedor.
  function confirmationDefaults(payload) {
    const { trip, quote, client = {}, lead, seller = {}, documents = {}, agency = {} } = payload;
    const raw = quote ? normalizeDetails(quote, null) : null;
    const circ = raw?.kind === 'circuito' ? raw.circuit : null;
    // Un circuito se traduce a la estructura de servicios de la confirmación.
    const det = circ ? {
      heroMediaId: raw.heroMediaId, varying: 'hotel', principal: 0,
      services: { vuelo: circ.services.vuelo, hotel: circ.services.hotel, traslados: circ.services.traslados, tours: circ.services.tours, seguro: circ.services.seguro },
      fixed: { tours: { items: circ.days.map((d, i) => ({ nombre: `Día ${i + 1}: ${d.titulo}` })).filter((t) => t.nombre.length > 8) } },
      proposals: [{ hotel: { hotel: circ.categories[0]?.hoteles.filter((h) => h.hotel).map((h) => `${h.ciudad ? `${h.ciudad}: ` : ''}${h.hotel}`).join(' · ') || '', stars: circ.categories[0]?.estrellas || '3' } }]
    } : raw;
    const p = det ? det.proposals[det.principal] || det.proposals[0] : null;
    const d = det ? { ...det.fixed, [det.varying]: p?.[det.varying] || {} } : {};
    const s = det?.services || {};
    const start = trip.start_date, end = trip.end_date;
    const year = (start || '').slice(0, 4) || String(new Date().getFullYear());
    const hotelName = d.hotel?.hotel || (s.hotel || !det ? quote?.hotel || '' : '');
    const v = d.vuelo || {};
    const withTime = (date, time) => [shortDate(date), time].filter(Boolean).join(' | ');
    const travelers = Number(lead?.travelers) || 0;
    return {
      reservation: `VC-${year}-${String(trip.id).padStart(5, '0')}`,
      holder: client?.name || '',
      passengers: client?.name || '',
      travelers: travelers || '',
      destination: trip.destination || '',
      coverMediaId: det?.heroMediaId || null,
      services: det
        ? { flight: !!s.vuelo, hotel: !!s.hotel, transfer: !!s.traslados, activities: !!s.tours, insurance: !!s.seguro, partner: true }
        : { flight: true, hotel: true, transfer: true, activities: false, insurance: false, partner: true },
      airline: v.aerolinea || '', flightBooking: '',
      outboundFlight: v.origen ? `${v.origen} → ${trip.destination}` : '', returnFlight: v.origen ? `${trip.destination} → ${v.origen}` : '',
      outboundDeparture: withTime(start, v.hsIda), outboundArrival: withTime(start, v.hlIda),
      returnDeparture: withTime(end, v.hsReg), returnArrival: withTime(end, v.hlReg),
      baggage: v.equipaje || '1 artículo personal\n1 maleta de mano 10 kg',
      flightTips: documents.resFlightTips || '',
      hotelName, hotelStars: d.hotel?.stars || '5', room: d.hotel?.room || '', mealPlan: d.hotel?.plan || '',
      checkin: withTime(start, '15:00 hrs'), checkout: withTime(end, '12:00 hrs'),
      hotelHighlights: d.hotel?.desc || '', hotelMediaId: d.hotel?.mediaId || null, hotelPhone: '',
      operator: '', transferContact: '',
      transferOutOrigin: 'Aeropuerto', transferOutDestination: hotelName, transferOutDate: shortDate(start), transferOutTime: '',
      transferBackOrigin: hotelName, transferBackDestination: 'Aeropuerto', transferBackDate: shortDate(end), transferBackTime: '',
      activitiesDetail: (d.tours?.items || []).filter((t) => t && str(t.nombre)).map((t) => t.nombre).join('\n'),
      insuranceProvider: '', insurancePolicy: '', insuranceDetail: d.seguro?.cobertura || '',
      partnerName: seller?.name || '', partnerPhone: seller?.phone || documents.supportWhatsapp || agency.whatsapp || '',
      partnerDetail: documents.resPartnerDetail || '',
      emergencyPhone: documents.emergencyPhone || '', airlinePhone: '',
      showSanitation: QROO.test(trip.destination || ''),
      paymentStatus: 'Pendiente de pago', paymentTotal: quote?.price ? String(quote.price) : '', paymentPaid: '', paymentSchedule: ''
    };
  }

  function mergeConfirmation(saved, defaults) {
    const c = { ...defaults, ...(saved || {}) };
    c.services = { ...defaults.services, ...(saved?.services || {}) };
    return c;
  }

  function renderReservation(c, payload) {
    const { documents = {} } = payload;
    const brand = documents.brandName || 'VIAJES CASAL';
    const on = (k) => !!c.services?.[k];
    const pax = lines(c.passengers);
    const paxCount = Number(c.travelers) || pax.length;
    const n = nightsBetween(c.startDate || payload.trip.start_date, c.endDate || payload.trip.end_date);
    const start = c.startDate || payload.trip.start_date, end = c.endDate || payload.trip.end_date;
    const duration = n != null && n >= 0 ? `${n + 1} días / ${n} noches` : '';
    const dl = (rows) => `<dl class="detail">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    const list = (v) => lines(v).map((x) => `<li>${esc(x)}</li>`).join('');
    const icon = (file) => `/doc-assets/${file}`;
    const wa = waLink(c.partnerPhone);
    const cover = media(c.coverMediaId), hotelImg = media(c.hotelMediaId);
    const stars = '★'.repeat(Math.min(Math.max(parseInt(c.hotelStars, 10) || 5, 1), 5));
    const visibleServices = RES_SERVICES.filter(([k]) => on(k));
    const grid = (cards) => { const v = cards.filter(Boolean); return v.length ? `<section class="main3" style="grid-template-columns:repeat(${Math.min(v.length, 3)},1fr)">${v.join('')}</section>` : ''; };
    const head = (file, title, value) => `<div class="card-head"><div class="card-head-left"><img src="${icon(file)}" alt=""><span>${title}</span></div>${value !== undefined ? `<div class="card-head-value">${esc(value)}</div>` : ''}</div>`;

    const flight = on('flight') ? `<div class="card primary-detail">${head('icon-flight.png', 'Vuelo', c.airline)}${dl([
      ['Vuelo de ida:', c.outboundFlight], ['Vuelo de regreso:', c.returnFlight], ['Reserva:', c.flightBooking],
      ['Salida ida:', c.outboundDeparture], ['Llegada ida:', c.outboundArrival], ['Salida regreso:', c.returnDeparture], ['Llegada regreso:', c.returnArrival],
      ['Pasajeros:', paxCount ? `${paxCount} ${paxCount === 1 ? 'pasajero' : 'pasajeros'}` : ''], ['Equipaje permitido:', c.baggage]
    ])}${lines(c.flightTips).length ? `<div class="tip"><h4>Tips útiles para tu vuelo</h4><ul>${list(c.flightTips)}</ul></div>` : ''}</div>` : '';
    const hotel = on('hotel') ? `<div class="card primary-detail">${head('icon-hotel.png', 'Hotel', c.hotelName)}${dl([
      ['Clasificación:', stars], ['Habitación:', c.room], ['Check-in:', c.checkin], ['Check-out:', c.checkout], ['Plan alimenticio:', c.mealPlan]
    ])}<div class="hotel-img">${hotelImg ? `<img src="${hotelImg}" alt="Imagen del hotel">` : ''}</div>${lines(c.hotelHighlights).length ? `<div class="tip"><h4>Datos destacables del hotel</h4><ul>${list(c.hotelHighlights)}</ul></div>` : ''}</div>` : '';
    const transferRows = (dir) => dl([['Origen:', c[`transfer${dir}Origin`]], ['Destino:', c[`transfer${dir}Destination`]], ['Fecha:', c[`transfer${dir}Date`]], ['Horario:', c[`transfer${dir}Time`]], ['Operador:', c.operator], ['Contacto:', c.transferContact]]);
    const transfer = on('transfer') ? `<div class="card primary-detail">${head('icon-transfer.png', 'Traslados')}<div class="label" style="margin-bottom:2mm">TRASLADO DE IDA</div>${transferRows('Out')}<hr style="border:0;border-top:1px dashed #c8d6dc;margin:6mm 0"><div class="label" style="margin-bottom:2mm">TRASLADO DE REGRESO</div>${transferRows('Back')}</div>` : '';
    const activities = on('activities') ? `<div class="card">${head('icon-activities.png', 'Actividades y Tours')}<div class="value">${esc(c.activitiesDetail)}</div></div>` : '';
    const insurance = on('insurance') ? `<div class="card">${head('icon-insurance.png', 'Seguro de Viaje', c.insuranceProvider)}${dl([['Póliza:', c.insurancePolicy], ['Cobertura:', c.insuranceDetail]])}</div>` : '';
    const blog = safeUrl(documents.blogUrl);
    const partner = on('partner') ? `<div class="card">${head('icon-partner.png', 'Travel Partner 24/7', c.partnerName)}${dl([['WhatsApp:', c.partnerPhone], ['Atención:', c.partnerDetail]])}${blog ? `<a class="blogBtn" href="${esc(blog)}" target="_blank" rel="noopener">Prepara tu viaje: guías y tips →</a>` : ''}</div>` : '';

    const paid = c.paymentStatus === 'Pagado por completo';
    const balance = String(c.paymentTotal || '').trim() ? money(num(c.paymentTotal) - num(c.paymentPaid)) : '';
    const fmtMoney = (v) => (hasNum(v) ? money(v) : str(v));
    const paymentRows = [['Estado:', c.paymentStatus], ['Total de la reserva:', fmtMoney(c.paymentTotal)], ...(paid ? [] : [['Monto pagado:', fmtMoney(c.paymentPaid)], ['Saldo pendiente:', balance], ['Pagos programados:', c.paymentSchedule]])];

    const termsUrl = safeUrl(documents.resTermsUrl);
    const social = (id, url, file, label) => { const u = safeUrl(url); return `<a href="${u ? esc(u) : '#'}"${u ? ' target="_blank" rel="noopener"' : ' aria-disabled="true"'} aria-label="${label}"><img src="${icon(file)}" alt="${label}"></a>`; };
    const website = safeUrl(documents.website);
    const reviews = safeUrl(documents.reviewsUrl);

    return `<section class="pdf-page pdf-page-one"><div class="pdf-page-one-inner">
  <header class="hero">${cover ? `<img class="hero-bg" src="${cover}" alt="Imagen del destino">` : ''}<div class="hero-overlay"></div>
    <div class="hero-inner"><div><div class="partner-name">Hola, ${esc(firstName(c.holder) || 'viajero')}</div><div class="hero-welcome">¡Qué emoción acompañarte en esta nueva aventura!</div><div class="title">Confirmación<br>de Servicios</div><div class="subtitle">Tu viaje está confirmado. Aquí encontrarás toda la información importante.</div></div>
      <div class="codebox"><div class="brand brand-logo"><img src="${LOGO}" alt="">${esc(brand)}<span class="brand-wave">≋</span></div><small>RESERVA</small><strong>${esc(c.reservation)}</strong><span class="travel-partner">Travel Partner: ${esc(c.partnerName)}</span></div></div>
  </header>
  <div class="pdf-page-content">
    <section class="box reservation-grid">
      <div><div class="section-title"><span class="wave">≋</span> Información de la reserva</div><div class="info-list">
        <div class="info-row"><div class="ico"><img src="${icon('icon-holder.png')}" alt=""></div><div><div class="label">Titular de la reserva</div><div class="value">${esc(c.holder)}</div></div></div>
        <div class="info-row"><div class="ico"><img src="${icon('icon-passengers.png')}" alt=""></div><div><div class="label">Pasajeros</div><div class="value">${paxCount ? `${paxCount} ${paxCount === 1 ? 'pasajero' : 'pasajeros'}` : ''}</div><div class="passengers">${esc(pax.join('\n'))}</div></div></div>
        <div class="info-row"><div class="ico"><img src="${icon('icon-destination.png')}" alt=""></div><div><div class="label">Destino</div><div class="value">${esc(c.destination)}</div></div></div>
      </div></div>
      <div><div class="section-title">&nbsp;</div><div class="info-list">
        <div class="info-row"><div class="ico"><img src="${icon('icon-calendar.png')}" alt=""></div><div><div class="label">Fecha de salida</div><div class="value">${esc(longDate(start))}</div></div></div>
        <div class="info-row"><div class="ico"><img src="${icon('icon-calendar.png')}" alt=""></div><div><div class="label">Fecha de retorno</div><div class="value">${esc(longDate(end))}</div></div></div>
        <div class="info-row"><div class="ico"><img src="${icon('icon-duration.png')}" alt=""></div><div><div class="label">Duración</div><div class="value">${esc(duration)}</div></div></div>
      </div></div>
      <div class="support"><div class="section-title" style="justify-content:center">Soporte 24/7</div><div class="value">Escanea el código para contactar<br>a tu Travel Partner por WhatsApp.</div>
        <div class="qr">${wa ? `<img src="/api/qr?data=${encodeURIComponent(wa)}" alt="Código QR de WhatsApp">` : ''}</div><div class="phone">☎ ${esc(c.partnerPhone)}</div></div>
    </section>
    <section class="box"><div class="section-title"><span class="wave">≋</span> Servicios incluidos</div>
      <div class="services" style="grid-template-columns:repeat(${Math.max(visibleServices.length, 1)},1fr)">${visibleServices.map(([, label, file]) => `<div class="service"><div class="circle"><img src="${icon(file)}" alt=""></div><b>${label}</b></div>`).join('')}</div>
    </section>
    ${grid([flight, hotel, transfer])}
  </div></div></section>
<section class="pdf-page pdf-page-two">
  <div class="pdf-page-content">
    ${grid([activities, insurance, partner])}
    <section class="legal4" style="margin-top:3mm">
      <div class="legal"><h3>ⓘ Consideraciones importantes</h3>${c.showSanitation ? `<p><b>CUOTA DE SANEAMIENTO AMBIENTAL DE QUINTANA ROO</b></p><p>${esc(documents.resSanitation)}</p>` : `<p>${esc(documents.resConsiderations)}</p>`}</div>
      <div class="legal"><h3>⚙ Políticas principales</h3><ul>${list(documents.resPolicies)}</ul></div>
      <div class="legal"><h3>⚖ Términos y condiciones</h3><p>${esc(documents.resTerms)}</p>${termsUrl ? `<p><a class="terms-link" href="${esc(termsUrl)}" target="_blank" rel="noopener">Consulta aquí los términos completos →</a></p>` : ''}</div>
      <div class="legal"><h3>♢ Documentos recomendados</h3><ul>${list(documents.resDocuments)}</ul></div>
    </section>
    <section class="box" style="margin-top:3mm;margin-bottom:0"><div class="section-title"><span class="wave">≋</span> Contactos importantes</div>
      <div class="contacts"><div class="contact"><b>Travel Partner</b>WhatsApp 24/7<br>${esc(c.partnerPhone)}</div><div class="contact"><b>Emergencias</b>${esc(c.emergencyPhone)}</div><div class="contact"><b>Aerolínea</b>${esc(c.airline)}<br>${esc(c.airlinePhone)}</div><div class="contact"><b>Hotel</b>${esc(c.hotelName)}<br>${esc(c.hotelPhone)}</div></div>
    </section>
    <section class="box payment-box" style="margin-top:3mm;margin-bottom:0"><div class="section-title"><span class="wave">≋</span> Información de pagos</div>
      <dl class="detail payment-detail">${paymentRows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
    </section>
  </div>
  <footer class="footer"><div><div class="thanks">¡Gracias por viajar con nosotros!</div><small>Estamos contigo antes, durante y después de tu viaje.</small></div>
    <div class="social"><div class="social-links">${social('fb', documents.facebook, 'icon-facebook.png', 'Facebook')}${social('ig', documents.instagram, 'icon-instagram.png', 'Instagram')}${social('tt', documents.tiktok, 'icon-tiktok.png', 'TikTok')}${social('yt', documents.youtube, 'icon-youtube.png', 'YouTube')}</div>
      <small>${website ? `<a class="website-link" href="${esc(website)}" target="_blank" rel="noopener">${esc(hostOf(website))}</a>` : ''}</small></div>
    <div class="review">${reviews ? `<a class="review-link" href="${esc(reviews)}" target="_blank" rel="noopener"><img class="review-icon" src="${icon('icon-review.png')}" alt="Reseñas"><span>Déjanos tu reseña</span><div class="stars">★★★★★</div></a>` : ''}</div>
  </footer>
</section>`;
  }

  function buildReservationMessage(c, payload) {
    const brand = titleCase(payload.documents?.brandName || 'Viajes Casal');
    const range = formatDateRange(payload.trip.start_date, payload.trip.end_date);
    return `¡Hola ${firstName(c.holder)}! 🎉 Tu viaje a ${c.destination}${range ? ` (${range})` : ''} está confirmado.\n\n`
      + `Te comparto tu Confirmación de Servicios (reserva ${c.reservation}) en PDF con vuelos, hotel, traslados y contactos importantes 📄\n\n`
      + `Guárdala en tu celular y cualquier duda escríbeme por aquí, estoy contigo antes, durante y después de tu viaje.\n— ${c.partnerName} · ${brand}`;
  }

  global.TPDocs = {
    esc, safeUrl, media, waLink, waNumber, money, num, formatDateRange, formatSingleDate, shortDate, firstName, titleCase,
    SERVICES, normalizeDetails, optionLabel, quoteModel, renderQuoteSheets, buildQuoteMessage,
    CIRCUIT_SERVICES, DEFAULT_OCCUPANCIES, newCircuitDetails, circuitDesde, circuitEndDate, circuitModel, renderCircuitSheet, buildCircuitMessage,
    QROO, confirmationDefaults, mergeConfirmation, renderReservation, buildReservationMessage
  };
}(typeof window !== 'undefined' ? window : globalThis));
