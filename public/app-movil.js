'use strict';

/* =========================================================
   TP-312 · App instalable para vendedores
   - Registra el service worker (abre sin internet y recibe notificaciones push).
   - Modo consulta sin conexión: aviso "Sin conexión" y mensajes claros al intentar guardar.
   - Botón 📱: instalar la app, activar notificaciones en este equipo y probarlas.
   - Atajos del ícono (?go=nuevo-lead | hoy | cotizaciones), avisos push (?n=…&lead=…) y "Compartir a Travel Partner".
   Usa las utilidades de app.js.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let installEvent = null;
  let swReg = null;

  /* ---------- Service worker ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => { swReg = reg; paintDot(); }).catch((e) => console.warn('Service worker:', e.message));
    });
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open' && e.data.url) handleDeepLink(new URL(e.data.url).searchParams); });
  }

  /* ---------- Sin conexión ---------- */
  const nativeFetch = window.fetch.bind(window);
  let offline = false;
  function setOffline(v) {
    if (v === offline) return;
    offline = v;
    document.body.classList.toggle('is-offline', v);
    let bar = document.getElementById('offlineBar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'offlineBar'; bar.className = 'offline-bar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
    bar.innerHTML = v ? '📴 <b>Sin conexión</b> · estás viendo lo último guardado (solo consulta). Los cambios se guardan cuando vuelva la señal.' : '';
    bar.classList.toggle('show', v);
  }
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isApi = url.includes('/api/');
    if (/\/api\/auth\/logout/.test(url)) { try { navigator.serviceWorker?.controller?.postMessage({ type: 'logout' }); await caches.delete('data-v1'); } catch { /* sin caché */ } }
    try {
      const res = await nativeFetch(input, init);
      if (isApi) setOffline(res.headers.get('X-TP-Offline') === '1');
      return res;
    } catch (error) {
      if (isApi) { setOffline(true); throw new Error('Sin conexión a internet: revisa tu señal e intenta de nuevo.'); }
      throw error;
    }
  };
  window.addEventListener('online', () => { if (offline && typeof loadAll === 'function' && currentUser) loadAll(); });
  window.addEventListener('offline', () => setOffline(true));

  /* ---------- Instalar ---------- */
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; paintDot(); });
  window.addEventListener('appinstalled', () => { installEvent = null; toast('¡Listo! Travel Partner quedó instalada en tu equipo'); paintDot(); });
  function paintDot() {
    const dot = document.getElementById('appDot');
    if (!dot) return;
    const needsPush = pushSupported && Notification.permission === 'default';
    dot.classList.toggle('hidden', !(installEvent || (standalone() && needsPush)));
  }

  async function currentSub() {
    if (!pushSupported) return null;
    const reg = swReg || await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }
  const b64 = (s) => { const pad = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
  async function enablePush() {
    if (!pushSupported) throw new Error(isIOS && !standalone() ? 'En iPhone primero instala la app (Compartir → Agregar a inicio) y ábrela desde el ícono.' : 'Este navegador no permite notificaciones.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('No diste permiso de notificaciones. Puedes activarlo en los ajustes del navegador para este sitio.');
    const reg = swReg || await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
    await send('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  }
  async function disablePush() {
    const sub = await currentSub();
    if (!sub) return;
    await send('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }

  async function appModal() {
    const sub = await currentSub().catch(() => null);
    const perm = pushSupported ? Notification.permission : 'unsupported';
    const installed = standalone();
    const installHtml = installed
      ? '<p class="full app-ok">✅ Estás usando la app instalada.</p>'
      : installEvent
        ? '<div class="full"><button type="button" class="btn primary" id="appInstall">📲 Instalar Travel Partner</button><p class="muted-note">Queda como app con el ícono de Viajes Casal, abre a pantalla completa y funciona sin internet para consultar.</p></div>'
        : isIOS
          ? '<ol class="full app-steps"><li>Abre este sitio en <b>Safari</b>.</li><li>Toca <b>Compartir</b> <span aria-hidden="true">⬆️</span> (abajo al centro).</li><li>Elige <b>“Agregar a inicio”</b> y luego <b>Agregar</b>.</li><li>Abre Travel Partner desde el ícono nuevo y activa aquí las notificaciones.</li></ol>'
          : '<ol class="full app-steps"><li>En <b>Chrome</b> (Android o computadora) abre el menú <b>⋮</b>.</li><li>Elige <b>“Instalar app”</b> o <b>“Agregar a pantalla principal”</b>.</li><li>Abre Travel Partner desde el ícono nuevo.</li></ol>';
    const pushHtml = perm === 'unsupported'
      ? `<p class="full muted-note">${isIOS && !installed ? 'En iPhone las notificaciones funcionan con la app instalada (iOS 16.4 o más reciente).' : 'Este navegador no permite notificaciones push.'}</p>`
      : perm === 'denied'
        ? '<p class="full note-warn">Las notificaciones están bloqueadas para este sitio. Actívalas en los ajustes del navegador (candado junto a la dirección) y vuelve a intentarlo.</p>'
        : sub
          ? '<div class="full quick-actions"><span class="app-ok">🔔 Activas en este equipo</span><button type="button" class="btn secondary small" id="pushTest">Enviar prueba</button><button type="button" class="btn ghost-danger small" id="pushOff">Desactivar aquí</button></div>'
          : '<div class="full"><button type="button" class="btn primary" id="pushOn">🔔 Activar notificaciones en este equipo</button></div>';
    openModal('APP TRAVEL PARTNER', 'Tu CRM en el celular', `<div class="modal-form">
      <p class="full section-label">1 · Instalar la app</p>${installHtml}
      <p class="full section-label">2 · Notificaciones</p>
      <p class="full muted-note">Te avisa al momento de leads nuevos, seguimientos vencidos, pagos, cotizaciones vistas y respuestas del proveedor, aunque la app esté cerrada.</p>${pushHtml}
      <p class="full section-label">3 · Atajos</p>
      <p class="full muted-note">Mantén presionado el ícono para <b>Nuevo lead</b>, <b>Seguimientos de hoy</b> o <b>Cotizaciones</b>. En Android, desde WhatsApp u otra app usa <b>Compartir → Travel Partner</b> para crear un lead con ese texto.</p>
      <p class="full muted-note">Sin internet puedes consultar lo último que cargaste; para guardar necesitas señal.</p>
      <div class="modal-actions"><button type="button" class="btn secondary close">Cerrar</button></div></div>`);
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (e) { toast(e.message, 7000); } el.disabled = false; }; };
    on('appInstall', async () => { installEvent.prompt(); const r = await installEvent.userChoice; installEvent = null; paintDot(); if (r.outcome === 'accepted') toast('Instalando Travel Partner…'); appModal(); });
    on('pushOn', async () => { await enablePush(); toast('Notificaciones activadas'); await send('POST', '/api/push/test'); paintDot(); appModal(); });
    on('pushTest', async () => { const r = await send('POST', '/api/push/test'); toast(r.sent ? 'Prueba enviada: revisa tu equipo' : 'No se pudo enviar; desactiva y vuelve a activar'); });
    on('pushOff', async () => { await disablePush(); toast('Notificaciones desactivadas en este equipo'); paintDot(); appModal(); });
  }
  window.appModal = appModal;
  document.addEventListener('click', (e) => { if (e.target.closest('#appBtn')) appModal(); });

  /* ---------- Atajos, avisos push y "Compartir" ---------- */
  const phoneIn = (text) => { const m = String(text || '').match(/(?:\+?\d[\d\s().-]{8,}\d)/); return m ? m[0].replace(/[^\d+]/g, '') : ''; };
  function openShared(p) {
    const text = [p.get('share_title'), p.get('share_text'), p.get('share_url')].filter(Boolean).join('\n').trim();
    if (!canWrite('leads')) return;
    leadModal(null);
    const form = $('#modalBody form');
    if (!form) return;
    const notes = form.querySelector('[name=notes]');
    if (notes) notes.value = `📲 Compartido a la app:\n${text}`.slice(0, 4000);
    const phone = phoneIn(text);
    const ph = form.querySelector('[name=phone]');
    if (ph && phone) { ph.value = phone; ph.dispatchEvent(new Event('input', { bubbles: true })); }
    form.querySelector('[name=name]')?.focus();
    toast('Completa nombre y destino para guardar el lead', 5000);
  }
  function openLink(link, leadId) {
    const [type, raw] = String(link || '').split(':');
    const id = Number(raw);
    if (type === 'campaigns') { navigate('campaigns'); return; }
    if (type === 'quote' && quoteById(id)) { navigate('quotes'); quoteModal(id); return; }
    if (type === 'payplan' && quoteById(id)) { navigate('quotes'); payPlanModal(id); return; }
    if (type === 'paychange' && typeof paymentChangesModal === 'function') { paymentChangesModal(id); return; }
    if (type === 'client' && clientById(id)) { navigate('clients'); clientFile(id); return; }
    if (type === 'followup' && followupById(id)) { navigate('followups'); followupModal(id); return; }
    if (type === 'trip' && tripById(id)) { navigate('trips'); tripModal(id); return; }
    if (leadId && leadById(leadId)) { navigate('leads'); leadModal(leadId); return; }
    if (bell && typeof toggleBell === 'function') toggleBell(true);
  }
  function handleDeepLink(p) {
    const go = p.get('go');
    const hasShare = p.has('share_text') || p.has('share_url') || p.has('share_title');
    if (!go && !p.has('n') && !p.has('lead') && !hasShare) return;
    const run = () => {
      if (hasShare) openShared(p);
      else if (go === 'nuevo-lead') { navigate('leads'); if (canWrite('leads')) leadModal(null); }
      else if (go === 'hoy') { ui.calDay = todayStr(); ui.calView = 'day'; navigate('followups'); if (typeof renderCalendar === 'function') renderCalendar(); }
      else if (go === 'cotizaciones') navigate('quotes');
      else openLink(p.get('n'), Number(p.get('lead')) || null);
    };
    const wait = (n = 0) => { if (loaded && currentUser) run(); else if (n < 80) setTimeout(() => wait(n + 1), 150); };
    wait();
    try { history.replaceState(null, '', location.pathname); } catch { /* sin historial */ }
  }
  handleDeepLink(new URLSearchParams(location.search));
}());
