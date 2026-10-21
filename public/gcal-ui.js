'use strict';

/* =========================================================
   TP-112 · Google Calendar en dos vías (pantalla)
   - Seguimientos › Google Calendar: conectar mi cuenta, ver estado, sincronizar ahora, desconectar.
   - Configuración › Integraciones (administrador): guía paso a paso y credenciales OAuth.
   Usa las utilidades de app.js.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const WHAT = '<ul class="gcal-what"><li>📞 <b>Seguimientos</b> con hora y aviso 10 min antes</li><li>✈️ <b>Viajes</b> de tus clientes (día completo)</li><li>💳 <b>Pagos por cobrar</b> del plan de pagos</li><li>🏦 <b>Pagos a proveedores</b> por vencer</li></ul>';

  async function gcalModal() {
    let st;
    try { st = await api('/api/gcal/status'); } catch (e) { toast(e.message); return; }
    const body = !st.configured
      ? `<p>La conexión en dos vías aún no está activada para la agencia.</p>${isAdmin() ? '<p class="muted-note">Actívala una sola vez en <b>Configuración › Integraciones › Google Calendar</b> (te guiamos paso a paso).</p><div class="modal-actions"><button type="button" class="btn primary" data-settings-tab="integrationsPanel" data-gcal-goto>Ir a Integraciones</button></div>' : '<p class="muted-note">Pide al administrador que la active en Configuración › Integraciones.</p>'}`
      : st.connected
        ? `<p class="gcal-ok">✅ Conectado con <b>${H(st.email || 'tu cuenta de Google')}</b> · calendario <b>“Travel Partner”</b></p>
           <p class="muted-note">Última sincronización: ${st.last_sync ? H(fmtStamp(st.last_sync)) : 'en curso…'} · ${st.events} eventos.${st.last_error ? `<br><span class="danger-text">⚠ ${H(st.last_error)}</span>` : ''}</p>
           ${WHAT}
           <p class="muted-note"><b>En Google puedes:</b> mover un seguimiento (cambia la fecha en el CRM), cambiarle el título, borrarlo (queda como <b>hecho</b>) o crear un evento nuevo en el calendario “Travel Partner” (se vuelve seguimiento). Viajes y pagos se cambian en el CRM. Tus eventos personales nunca entran al CRM.</p>
           <div class="modal-actions"><button type="button" class="btn ghost-danger small" id="gcalOff">Desconectar</button><button type="button" class="btn secondary" id="gcalSync">Sincronizar ahora</button><button type="button" class="btn primary close">Listo</button></div>`
        : `<p>Conecta tu cuenta de Google y el CRM creará un calendario <b>“Travel Partner”</b> que se mantiene al día en los dos sentidos (cada cambio del CRM al momento; lo que hagas en Google regresa en unos minutos):</p>${WHAT}
           <p class="muted-note">Google te pedirá permiso para “ver y editar los calendarios que crea esta app”: el CRM no puede ver tus otros calendarios. Si aparece “Google no verificó esta app”, elige <b>Configuración avanzada → Ir a Travel Partner</b> (es la app de tu agencia).</p>
           <div class="modal-actions"><a class="btn primary" href="/api/gcal/connect">Conectar con Google</a></div>`;
    openModal('PRODUCTIVIDAD', 'Google Calendar', `<div class="gcal">${body}
      <details class="gcal-ics"><summary>Opción simple: liga de solo lectura (.ics)</summary><p class="muted-note">Para quien no quiera conectar su cuenta: Google lee la liga cada pocas horas y no regresa cambios.</p><button type="button" class="btn secondary small" id="gcalIcs">Ver mi liga .ics</button></details></div>`);
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('gcalIcs', () => googleCalendarFeedModal());
    on('gcalSync', async (e) => { e.target.disabled = true; try { const r = await send('POST', '/api/gcal/sync'); toast(`Sincronizado: ${r.created} nuevos · ${r.updated} actualizados · ${r.removed} quitados`); await loadAll(); gcalModal(); } catch (err) { toast(err.message, 6000); e.target.disabled = false; } });
    on('gcalOff', async () => { if (!confirm('¿Desconectar tu Google Calendar? El calendario “Travel Partner” se queda en tu Google (puedes borrarlo allá) pero ya no se actualizará.')) return; try { await send('POST', '/api/gcal/disconnect'); toast('Google Calendar desconectado'); gcalModal(); } catch (err) { toast(err.message); } });
    const goto = document.querySelector('[data-gcal-goto]');
    if (goto) goto.addEventListener('click', () => { close(); navigate('settings'); });
  }
  window.gcalModal = gcalModal;

  // Configuración › Integraciones (administrador).
  window.renderGcalCard = async () => {
    const box = document.getElementById('gcalCard');
    if (!box) return;
    if (!isAdmin()) { box.innerHTML = '<div class="int-main"><b>Google Calendar (dos vías)</b><small>Cada vendedor lo conecta desde Seguimientos › Google Calendar.</small></div>'; return; }
    let c;
    try { c = await api('/api/gcal/config'); } catch (e) { box.innerHTML = `<div class="int-main"><b>Google Calendar</b><small>${H(e.message)}</small></div>`; return; }
    box.innerHTML = `<div class="int-main"><b>Google Calendar (dos vías) ${c.hasSecret ? '<span class="tag-ok">Activo</span>' : '<span class="tag-soon">Por configurar</span>'}</b>
      <small>Cada vendedor conecta su cuenta y el CRM mantiene un calendario “Travel Partner” con seguimientos, viajes y pagos, en los dos sentidos.</small>
      <details class="gcal-guide"${c.hasSecret ? '' : ' open'}><summary>Guía para activarlo (una sola vez, ~10 minutos)</summary><ol>
        <li>Entra a <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud › Nuevo proyecto</a> con tu cuenta de Google. Nombre: <b>Travel Partner CRM</b> → <b>Crear</b>.</li>
        <li>Activa la API: <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a> → <b>Habilitar</b> (revisa que arriba diga tu proyecto nuevo).</li>
        <li>Pantalla de consentimiento: <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">Google Auth Platform › Branding</a> → <b>Comenzar</b>. Nombre de la app: <b>Travel Partner</b>, correo de asistencia: el tuyo · Público: <b>Externo</b> · Contacto: tu correo → <b>Crear</b>.</li>
        <li>En <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Público</a> haz clic en <b>Publicar app</b> → <b>Confirmar</b> (si se queda “en prueba”, Google desconecta a los vendedores cada 7 días).</li>
        <li>Credenciales: <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Clientes › Crear cliente</a> → Tipo <b>Aplicación web</b>, nombre <b>Travel Partner CRM</b>.
          <br>Orígenes de JavaScript autorizados: <code>${H(c.origin)}</code> <button type="button" class="link" data-copy="${H(c.origin)}">Copiar</button>
          <br>URI de redireccionamiento autorizados: <code>${H(c.redirectUri)}</code> <button type="button" class="link" data-copy="${H(c.redirectUri)}">Copiar</button> → <b>Crear</b>.</li>
        <li>Copia el <b>ID de cliente</b> y el <b>Secreto del cliente</b> (empieza con GOCSPX-) y pégalos aquí abajo.</li>
        <li>Cada vendedor entra a <b>Seguimientos › Google Calendar › Conectar con Google</b>. Si Google avisa “no verificó esta app”, es normal: <b>Configuración avanzada → Ir a Travel Partner</b>.</li>
      </ol></details>
      ${c.fromEnv ? '<p class="muted-note">Las credenciales vienen de las variables del servidor (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>' : `<form id="gcalCfg" class="gcal-cfg"><label>ID de cliente<input name="client_id" required value="${H(c.client_id)}" placeholder="123456-abc.apps.googleusercontent.com" autocomplete="off"></label><label>Secreto del cliente<input name="client_secret" type="password" autocomplete="off" placeholder="${c.hasSecret ? '•••••••• (guardado; escribe uno nuevo solo para cambiarlo)' : 'GOCSPX-…'}"></label><button class="btn primary small">Guardar</button></form>`}
    </div>`;
    const form = document.getElementById('gcalCfg');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const v = formValues(form);
      try { await send('PUT', '/api/gcal/config', { client_id: v.client_id, client_secret: v.client_secret }); toast('Google Calendar listo: cada vendedor ya puede conectarse'); renderGcalCard(); } catch (err) { toast(err.message, 6000); }
    };
  };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#gcalCard [data-copy]');
    if (!b) return;
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado'); } catch { toast(b.dataset.copy, 8000); }
  }, true);

  // Regreso de Google (?gcal=…)
  const r = new URLSearchParams(location.search).get('gcal');
  if (r) {
    const msg = { ok: '✅ Google Calendar conectado: revisa el calendario “Travel Partner”', cancelado: 'Cancelaste la conexión con Google', 'sin-permiso': 'Google no dio permiso para el calendario: vuelve a intentar y marca la casilla del calendario', 'sin-configurar': 'Falta activar Google Calendar en Configuración › Integraciones', error: 'No se pudo conectar con Google. Intenta de nuevo.' }[r] || '';
    const wait = (n = 0) => { if (typeof loaded !== 'undefined' && loaded) { if (msg) toast(msg, 7000); if (r === 'ok') { navigate('followups'); gcalModal(); } } else if (n < 80) setTimeout(() => wait(n + 1), 150); };
    wait();
    try { history.replaceState(null, '', location.pathname); } catch { /* sin historial */ }
  }
}());
