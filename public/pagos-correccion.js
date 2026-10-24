'use strict';

/* Corrección de pagos con autorización del administrador.
   - El asesor toca ✏️ en un pago (ficha 360 o plan de pagos), cambia lo que se capturó mal o pide eliminarlo, y escribe el motivo.
   - El cambio queda "pendiente": no toca la ficha, el plan ni el portal del cliente hasta que el administrador lo autoriza.
   - El administrador recibe el aviso en la campanita y lo autoriza o rechaza desde "Correcciones de pago".
   - Si quien corrige es el administrador, el cambio se aplica directo. */

const pcMoney = (n) => money(n);
const pcCur = (e) => ({ amount: Number(e.amount), method: e.meta?.method || 'Otro', date: String(e.event_at || '').slice(0, 10), title: e.title || '', note: e.body || '' });

function payFixModal(ev, { back = null } = {}) {
  const cur = pcCur(ev);
  const admin = isAdmin();
  const pending = ev.meta?.change?.status === 'pending' ? ev.meta.change : null;
  const online = Boolean(ev.meta?.provider);
  if (online && !admin) { toast('Los pagos en línea (Mercado Pago) solo los corrige el administrador'); return; }
  const v = pending && pending.action === 'edit' ? pending : cur;
  openModal('CORREGIR PAGO', `${ev.title || 'Pago'} · ${pcMoney(ev.amount)}`, `<form class="modal-form pc-form">
    ${pending ? `<div class="full pc-note warn">⏳ Ya hay una corrección pendiente de autorización (${escapeHtml(pending.action === 'delete' ? 'eliminar el pago' : 'editar')}). Si guardas, la reemplazas.${pending.by === currentUser?.id || admin ? ' <button type="button" class="link" id="pcCancel">Cancelar esa solicitud</button>' : ''}</div>` : ''}
    <div class="full pc-seg" role="radiogroup" aria-label="Qué quieres hacer">
      <label><input type="radio" name="action" value="edit" ${pending?.action !== 'delete' ? 'checked' : ''}><span>✏️ Corregir datos</span></label>
      <label><input type="radio" name="action" value="delete" ${pending?.action === 'delete' ? 'checked' : ''}><span>🗑 Eliminar este pago</span></label>
    </div>
    <div class="full pc-now"><b>Así está registrado</b><span>${pcMoney(cur.amount)} · ${escapeHtml(cur.method)} · ${escapeHtml(fmtDate(cur.date))}${cur.note ? ` · ${escapeHtml(cur.note)}` : ''}</span></div>
    <div class="full pc-edit grid2">
      ${field('Monto correcto (MXN)*', `<input name="amount" type="number" min="1" step="0.01" inputmode="decimal" value="${escapeHtml(v.amount)}">`)}
      ${field('Forma de pago', `<select name="method">${options(PAY_METHODS, v.method)}</select>`)}
      ${field('Fecha del pago', `<input name="date" type="date" max="${todayStr()}" value="${escapeHtml(v.date)}">`)}
      ${field('Concepto', `<input name="title" maxlength="120" value="${escapeHtml(v.title)}">`)}
      ${field('Referencia o nota', `<input name="note" maxlength="1000" value="${escapeHtml(v.note)}" placeholder="Folio de transferencia, banco…">`, true)}
    </div>
    <p class="full pc-del-msg hidden">El pago se quitará de la ficha del cliente, del plan de pagos de la cotización y del portal del cliente.</p>
    ${field(admin ? 'Motivo (opcional)' : 'Motivo para el administrador*', `<textarea name="reason" rows="2" maxlength="500" ${admin ? '' : 'required'} placeholder="Ej. Capturé $5,000 y el comprobante dice $4,500">${escapeHtml(pending?.reason || '')}</textarea>`, true)}
    <p class="full muted-note">${admin ? 'Como administrador, el cambio se aplica de inmediato en la ficha, el plan de pagos, la liga de pago y el portal del cliente.' : '🔒 El cambio se envía al administrador para que lo autorice. Mientras tanto, el pago sigue como está.'}</p>
    <div class="modal-actions">${back ? '<button type="button" class="btn secondary" id="pcBack">Volver</button>' : '<button type="button" class="btn secondary close">Cancelar</button>'}<button type="submit" class="btn primary" id="pcSave">${admin ? 'Guardar corrección' : 'Enviar para autorización'}</button></div>
  </form>`);
  const form = $('#modalBody form');
  const paint = () => {
    const del = form.action.value === 'delete';
    form.querySelector('.pc-edit').classList.toggle('hidden', del);
    form.querySelector('.pc-del-msg').classList.toggle('hidden', !del);
    $('#pcSave').classList.toggle('danger', del);
    $('#pcSave').textContent = del ? (admin ? 'Eliminar pago' : 'Pedir eliminarlo') : (admin ? 'Guardar corrección' : 'Enviar para autorización');
  };
  form.querySelectorAll('[name=action]').forEach((r) => { r.onchange = paint; });
  paint();
  if ($('#pcBack')) $('#pcBack').onclick = back;
  if ($('#pcCancel')) $('#pcCancel').onclick = async () => {
    try { await send('DELETE', `/api/payment-changes/${ev.id}`); toast('Solicitud cancelada'); await loadAll(); back ? back() : close(); } catch (error) { toast(error.message); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = f.action === 'delete' ? { action: 'delete', reason: f.reason } : { action: 'edit', amount: f.amount, method: f.method, date: f.date, title: f.title, note: f.note, reason: f.reason };
    if (f.action === 'delete' && admin && !confirm('¿Eliminar este pago? Se quita de la ficha, del plan y del portal del cliente.')) return;
    $('#pcSave').disabled = true;
    try {
      const r = await send('POST', `/api/client-events/${ev.id}/change`, body);
      toast(r.applied ? (f.action === 'delete' ? 'Pago eliminado' : 'Pago corregido') : 'Enviado al administrador para su autorización', 5000);
      await loadAll();
      back ? back() : close();
    } catch (error) { toast(error.message, 6000); $('#pcSave').disabled = false; }
  };
}

// Lista de correcciones pendientes. El administrador autoriza o rechaza; el asesor ve las suyas.
async function paymentChangesModal(focusId = null) {
  let list = [];
  try { list = (await api('/api/payment-changes')).changes; db.paymentChanges = list; } catch (error) { toast(error.message); return; }
  const admin = isAdmin();
  const row = (k, a, b) => (a === b ? '' : `<div class="pc-diff"><span>${k}</span><s>${escapeHtml(a)}</s><b>${escapeHtml(b)}</b></div>`);
  const card = (x) => {
    const c = x.change, cur = x.current;
    const diff = c.action === 'delete'
      ? '<div class="pc-diff del"><span>Acción</span><b>🗑 Eliminar este pago</b></div>'
      : [row('Monto', pcMoney(cur.amount), pcMoney(c.amount)), row('Forma', cur.method, c.method), row('Fecha', fmtDate(cur.date), fmtDate(c.date)), row('Concepto', cur.title, c.title), row('Referencia', cur.note || '—', c.note || '—')].join('');
    return `<article class="pc-card${Number(focusId) === x.event_id ? ' focus' : ''}" data-pc="${x.event_id}">
      <header><div><b>${escapeHtml(x.client_name)}</b><small>${x.folio ? `${escapeHtml(x.folio)} · ` : ''}${escapeHtml(String(cur.title || 'Pago').replace(` · ${x.folio}`, ''))} · ${pcMoney(cur.amount)}</small></div><span class="pc-who">${escapeHtml(x.by_name)}<small>${escapeHtml(fmtDue(c.at))}</small></span></header>
      <div class="pc-diffs">${diff}</div>
      ${c.reason ? `<p class="pc-reason">💬 ${escapeHtml(c.reason)}</p>` : ''}
      <div class="pc-acts">${admin
        ? `<button type="button" class="link" data-pc-client="${x.client_id}">Ver ficha</button><input class="pc-comment" maxlength="500" placeholder="Comentario (opcional)"><button type="button" class="btn secondary small" data-pc-reject="${x.event_id}">Rechazar</button><button type="button" class="btn primary small" data-pc-approve="${x.event_id}">✓ Autorizar</button>`
        : `<span class="muted">Esperando autorización</span><button type="button" class="btn secondary small" data-pc-cancel="${x.event_id}">Cancelar solicitud</button>`}</div>
    </article>`;
  };
  openModal('PAGOS', admin ? 'Correcciones de pago por autorizar' : 'Mis correcciones de pago', `<div class="pc-list">${list.length ? list.map(card).join('') : `<p class="empty-note">${admin ? '✅ No hay correcciones pendientes.' : 'No tienes correcciones pendientes.'}</p>`}</div>
    <p class="muted-note">Al autorizar, el cambio se aplica en la ficha del cliente, el plan de pagos de la cotización, la liga de pago y el portal del cliente, y se avisa a quien lo pidió.</p>
    <div class="modal-actions"><button type="button" class="btn primary close">Listo</button></div>`, { wide: true });
  $('#modalBody .pc-card.focus')?.scrollIntoView({ block: 'center' });
  $('#modalBody').onclick = async (e) => {
    const t = e.target;
    const cl = t.closest('[data-pc-client]');
    if (cl) { navigate('clients'); clientFile(Number(cl.dataset.pcClient)); return; }
    const ap = t.closest('[data-pc-approve]'), rj = t.closest('[data-pc-reject]'), cc = t.closest('[data-pc-cancel]');
    if (!ap && !rj && !cc) return;
    const id = Number((ap || rj || cc).dataset.pcApprove || (ap || rj || cc).dataset.pcReject || (ap || rj || cc).dataset.pcCancel);
    const comment = t.closest('.pc-card')?.querySelector('.pc-comment')?.value || '';
    (ap || rj || cc).disabled = true;
    try {
      if (ap) await send('POST', `/api/payment-changes/${id}/approve`, { comment });
      else if (rj) await send('POST', `/api/payment-changes/${id}/reject`, { comment });
      else await send('DELETE', `/api/payment-changes/${id}`);
      toast(ap ? 'Corrección autorizada: ficha, plan y portal actualizados' : rj ? 'Corrección rechazada' : 'Solicitud cancelada', 5000);
      await loadAll();
      paymentChangesModal();
    } catch (error) { toast(error.message, 6000); (ap || rj || cc).disabled = false; }
  };
}

// Aviso en Cotizaciones: correcciones por autorizar (admin) o esperando (asesor).
function renderPayChangesBanner() {
  const box = $('#payChanges');
  if (!box) return;
  const n = (db.paymentChanges || []).length;
  box.classList.toggle('hidden', !n);
  if (!n) { box.innerHTML = ''; return; }
  box.innerHTML = isAdmin()
    ? `<span>✏️ <b>${n} ${n === 1 ? 'corrección de pago' : 'correcciones de pago'}</b> por autorizar</span><button type="button" class="btn primary small" data-pay-changes>Revisar</button>`
    : `<span>⏳ ${n === 1 ? 'Tienes 1 corrección de pago' : `Tienes ${n} correcciones de pago`} esperando autorización del administrador</span><button type="button" class="btn secondary small" data-pay-changes>Ver</button>`;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-pay-changes]');
  if (!el) return;
  e.stopPropagation();
  paymentChangesModal(Number(el.dataset.payChanges) || null);
});
