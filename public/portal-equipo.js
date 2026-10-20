'use strict';

/* =========================================================
   TP-313 · Portal del cliente (lado del equipo)
   Botón 🌐 en la Ficha 360 y en la ficha del lead: activar la liga, copiarla o mandarla por WhatsApp,
   generar una nueva (cierra los equipos recordados) o desactivarla.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const waNum = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return d.length === 10 ? `52${d}` : d; };
  async function portalModal(clientId) {
    const c = clientById(clientId);
    if (!c) return;
    openModal('PORTAL DEL CLIENTE', c.name, '<p class="muted">Cargando…</p>');
    let st;
    try { st = await api(`/api/clients/${c.id}/portal`); } catch (e) { toast(e.message); return; }
    const write = canWrite('clients');
    const first = String(c.name || '').split(/\s+/)[0];
    const msg = st.url ? `Hola ${first} 👋 Te comparto tu portal de Viajes Casal: ahí ves tus cotizaciones, pagos, contrato e itinerario, y puedes pedirnos nuevas cotizaciones.\n${st.url}\n${st.email && st.mail ? `La primera vez te pedirá un código que llega a tu correo (${st.emailMasked}).` : 'La primera vez te pedirá un código; yo te lo envío por aquí.'}` : '';
    const html = `<div class="modal-form">
      <p class="full muted-note">Una sola liga privada con sus cotizaciones (enviadas o aceptadas), plan de pagos y contrato, sus viajes con itinerario, encuesta y referidos, contacto contigo y un botón para pedir otra cotización. La primera vez en cada equipo pide un código de 6 dígitos ${st.email && st.mail ? `que llega a su correo <b>${H(st.emailMasked)}</b>` : '<b>que te llega a ti en la campanita</b> (no tiene correo) para que se lo mandes por WhatsApp'}.</p>
      ${st.enabled ? `<label class="full">Liga del portal<input id="cpUrl" readonly value="${H(st.url)}"></label>
        <p class="full muted-note">Activo desde ${H(fmtDate(String(st.created_at).slice(0, 10)))} · último acceso: ${st.last_access ? H(fmtStamp(st.last_access)) : 'aún no entra'} · equipos recordados: ${st.devices}</p>
        <label class="full">Mensaje para WhatsApp<textarea id="cpMsg" rows="5">${H(msg)}</textarea></label>
        <div class="full quick-actions">${c.phone ? `<a class="btn primary small" target="_blank" rel="noopener" id="cpWa" href="https://wa.me/${waNum(c.phone)}?text=${encodeURIComponent(msg)}">💬 Enviar por WhatsApp</a>` : ''}<button type="button" class="btn secondary small" id="cpCopy">Copiar liga</button><a class="btn secondary small" href="${H(st.url)}" target="_blank" rel="noopener">Abrir portal</a></div>
        ${write ? '<div class="full quick-actions"><button type="button" class="btn secondary small" id="cpRegen">Generar liga nueva</button><button type="button" class="btn ghost-danger small" id="cpOff">Desactivar portal</button><small>La liga nueva invalida la anterior y cierra los equipos recordados.</small></div>' : ''}`
        : `<p class="full">El portal de ${H(first)} aún no está activo.</p>${write ? '<div class="modal-actions"><button type="button" class="btn primary" id="cpOn">Activar portal</button></div>' : ''}`}
      <div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div></div>`;
    openModal('PORTAL DEL CLIENTE', c.name, html);
    const act = async (fn, okMsg) => { try { await fn(); toast(okMsg); portalModal(c.id); } catch (e) { toast(e.message); } };
    if ($('#cpOn')) $('#cpOn').onclick = () => act(() => send('POST', `/api/clients/${c.id}/portal`, {}), 'Portal activado');
    if ($('#cpRegen')) $('#cpRegen').onclick = () => { if (confirm(`¿Generar una liga nueva para ${c.name}? La anterior dejará de funcionar.`)) act(() => send('POST', `/api/clients/${c.id}/portal`, { regenerate: true }), 'Liga nueva generada'); };
    if ($('#cpOff')) $('#cpOff').onclick = () => { if (confirm(`¿Desactivar el portal de ${c.name}?`)) act(() => send('DELETE', `/api/clients/${c.id}/portal`), 'Portal desactivado'); };
    if ($('#cpCopy')) $('#cpCopy').onclick = async () => { try { await navigator.clipboard.writeText(st.url); toast('Liga copiada'); } catch { $('#cpUrl').select(); toast('Selecciona y copia con Ctrl+C'); } };
    if ($('#cpMsg') && $('#cpWa')) $('#cpMsg').oninput = (e) => { $('#cpWa').href = `https://wa.me/${waNum(c.phone)}?text=${encodeURIComponent(e.target.value)}`; };
  }
  window.portalModal = portalModal;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-portal-client]');
    if (el) portalModal(Number(el.dataset.portalClient));
  });
}());
