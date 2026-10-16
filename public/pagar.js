'use strict';

// Liga de pago para el cliente (TP-201): /pagar/<token>
(function () {
  const token = (location.pathname.match(/\/pagar\/([a-f0-9]{40})/) || [])[1];
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmt = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const waLink = (phone, text) => { let d = String(phone || '').replace(/\D/g, ''); if (d.length === 10) d = `52${d}`; return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null; };

  async function load() {
    if (!token) return fail('Liga incompleta. Pide a tu Travel Partner una liga nueva.');
    const qs = new URLSearchParams(location.search);
    const extra = qs.get('payment_id') || qs.get('collection_id');
    let data;
    try {
      const r = await fetch(`/api/public/pay/${token}${extra ? `?payment_id=${encodeURIComponent(extra)}` : ''}`, { cache: 'no-store' });
      data = await r.json();
      if (!r.ok || !data.ok) return fail(data.error || 'Esta liga de pago ya no está disponible.');
    } catch { return fail('No pudimos cargar tu plan. Revisa tu conexión e intenta de nuevo.'); }
    if (extra) history.replaceState(null, '', location.pathname);
    render(data, qs.get('status') || qs.get('collection_status'));
  }

  function fail(msg) {
    $('#subtitle').textContent = '';
    $('#app').innerHTML = `<div class="card"><p>${esc(msg)}</p></div>`;
  }

  function render(d, mpStatus) {
    const p = d.plan;
    const q = d.quote;
    $('#title').textContent = `Hola${d.client.firstName ? `, ${d.client.firstName}` : ''} 👋`;
    $('#subtitle').textContent = `Tu viaje a ${q.destination}${q.start_date ? ` · ${fmt(q.start_date)}${q.end_date ? ` al ${fmt(q.end_date)}` : ''}` : ''}`;
    document.title = `Plan de pagos · ${q.destination}`;
    const next = p.installments.find((i) => i.status !== 'pagado');
    const pct = p.total ? Math.min(100, Math.round((p.paid / p.total) * 100)) : 0;
    let note = '';
    if (d.returned === 'approved') note = '<div class="note ok">✅ ¡Gracias! Recibimos tu pago. Te enviamos el recibo por correo y tu Travel Partner ya fue avisado.</div>';
    else if (d.returned && ['pending', 'in_process', 'authorized'].includes(d.returned)) note = '<div class="note wait">⏳ Tu pago está en proceso. Si pagaste en OXXO o por transferencia, se refleja aquí en cuanto se acredite.</div>';
    else if (mpStatus === 'rejected' || mpStatus === 'failure' || d.returned === 'rejected') note = '<div class="note err">El pago no se completó. Puedes intentarlo de nuevo con otra tarjeta o método.</div>';

    const rows = p.installments.map((i) => {
      const left = days(d.today, i.due);
      let chip = '';
      if (i.status === 'pagado') chip = '<span class="chip ok">Pagado ✓</span>';
      else if (i.pending) chip = '<span class="chip next">En proceso</span>';
      else if (left < 0) chip = '<span class="chip late">Vencido</span>';
      else if (i === next) chip = `<span class="chip next">${left === 0 ? 'Vence hoy' : `Vence en ${left} ${left === 1 ? 'día' : 'días'}`}</span>`;
      if (i.status === 'parcial') chip += `<span class="chip part">Abonado ${money(i.paid)}</span>`;
      return `<div class="row${i.status === 'pagado' ? ' done' : ''}"><div><b>${esc(i.label)}</b>${chip}<br><small>Fecha límite: ${esc(fmt(i.due))}</small></div><div class="amt">${money(i.amount)}</div></div>`;
    }).join('');

    let payBox = '';
    const contract = d.contract || {};
    if (next && contract.state === 'pending') payBox = `<div class="card"><h2>Paso 1: firma tu contrato ✍️</h2><p class="muted" style="margin-top:-6px">Antes de pagar tu anticipo, lee y firma el contrato de tu viaje (precio, plan de pagos, políticas de cambios y cancelación). Toma un par de minutos y lo firmas desde tu celular.</p><a class="pay" href="${esc(contract.url)}">Leer y firmar mi contrato</a><p class="muted" style="text-align:center;margin:10px 0 0">Después podrás pagar ${money(Math.round((next.amount - next.paid) * 100) / 100)} de ${esc(next.label.toLowerCase())}.</p></div>`;
    else if (!next) payBox = '<div class="card"><p class="done-all">🎉 ¡Tu viaje está liquidado!</p><p class="muted" style="text-align:center">Gracias por viajar con nosotros. Tu Travel Partner te enviará tus documentos de viaje.</p></div>';
    else {
      const due = Math.round((next.amount - next.paid) * 100) / 100;
      const opts = [];
      if (d.methods.mercadoPago) opts.push(`<button class="pay" id="payMp" data-inst="${esc(next.id)}">Pagar ${money(due)} en línea</button><p class="muted" style="text-align:center;margin:8px 0 0">Tarjeta de crédito o débito, OXXO o transferencia SPEI · pago seguro con Mercado Pago</p>`);
      if (next.link_url) opts.push(`<a class="pay${opts.length ? ' alt' : ''}" href="${esc(next.link_url)}" target="_blank" rel="noopener">Pagar ${money(due)} con tarjeta</a>`);
      const b = d.methods.bank;
      if (b) {
        const line = (k, label, copy) => (b[k] ? `<div><span>${label}</span><b>${esc(b[k])}${copy ? ` <button class="copy" data-copy="${esc(b[k])}">Copiar</button>` : ''}</b></div>` : '');
        opts.push(`<div class="bank" style="margin-top:${opts.length ? 16 : 0}px"><h2 style="margin-bottom:6px">${opts.length ? 'O paga por transferencia' : 'Paga por transferencia o depósito'}</h2>${line('banco', 'Banco')}${line('titular', 'Titular')}${line('clabe', 'CLABE', true)}${line('cuenta', 'Cuenta', true)}<div><span>Monto</span><b>${money(due)}</b></div><div><span>Referencia</span><b>${esc(q.folio)} <button class="copy" data-copy="${esc(q.folio)}">Copiar</button></b></div>${b.notas ? `<p class="muted">${esc(b.notas)}</p>` : ''}</div>`);
      }
      const msg = `Hola${d.seller ? ` ${d.seller.name.split(' ')[0]}` : ''}, te comparto mi comprobante de pago de ${next.label.toLowerCase()} (${money(due)}) de mi viaje a ${q.destination} · ${q.folio}.`;
      const wa = waLink(d.seller?.whatsapp || d.agency.whatsapp, msg);
      if (wa) opts.push(`<a class="pay alt" href="${esc(wa)}" target="_blank" rel="noopener">📲 Enviar mi comprobante por WhatsApp</a>`);
      if (!opts.length) opts.push('<p class="muted">Tu Travel Partner te compartirá los datos para pagar.</p>');
      payBox = `<div class="card"><h2>Siguiente pago: ${esc(next.label)} · ${money(due)}</h2><p class="muted" style="margin-top:-6px">Fecha límite: ${esc(fmt(next.due))}</p>${opts.join('')}</div>`;
    }

    $('#app').innerHTML = `${note}
      <div class="card"><div class="sum"><div><span>Total del viaje</span><b>${money(p.total)}</b></div><div><span>Pagado</span><b>${money(p.paid)}</b></div><div class="bal"><span>Saldo</span><b>${money(p.balance)}</b></div></div>
        <div class="bar"><i style="width:${pct}%"></i></div><p class="muted" style="margin:0">${pct}% pagado · ${esc(q.folio)}${q.hotel ? ` · ${esc(q.hotel)}` : ''}</p></div>
      ${payBox}
      <div class="card"><h2>Tus pagos</h2>${rows}</div>
      ${contract.url && contract.state !== 'pending' ? `<p style="text-align:center"><a href="${esc(contract.url)}" style="color:#007985;font-size:14px">📄 Ver mi contrato${contract.state === 'signed' ? ' firmado' : ''}</a></p>` : ''}`;
    $('#foot').innerHTML = `${esc(d.agency.name || 'Viajes Casal')}${d.seller ? ` · Tu Travel Partner: ${esc(d.seller.name)}` : ''}${d.agency.whatsapp ? ` · WhatsApp ${esc(d.agency.whatsapp)}` : ''}`;

    document.querySelectorAll('[data-copy]').forEach((btn) => { btn.onclick = async () => { try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = '¡Copiado!'; } catch { btn.textContent = btn.dataset.copy; } }; });
    const mp = $('#payMp');
    if (mp) mp.onclick = async () => {
      mp.disabled = true; mp.textContent = 'Abriendo Mercado Pago…';
      try {
        const r = await fetch(`/api/public/pay/${token}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installment: mp.dataset.inst }) });
        const out = await r.json();
        if (!r.ok || !out.url) throw new Error(out.error || 'No pudimos abrir el pago');
        location.href = out.url;
      } catch (error) { mp.disabled = false; mp.textContent = 'Intentar de nuevo'; alert(error.message); }
    };
  }

  load();
})();
