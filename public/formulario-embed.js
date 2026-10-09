/* Formulario de Viajes Casal para pegar en cualquier sitio o landing.
   Uso: <script src="https://travelpartner.viajescasal.com/formulario-embed.js" data-origen="landing-cancun" async></script> */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  var query = new URLSearchParams();
  query.set('embed', '1');
  if (script.getAttribute('data-origen')) query.set('origen', script.getAttribute('data-origen'));
  var page = new URLSearchParams(window.location.search);
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (key) { if (page.get(key)) query.set(key, page.get(key)); });
  query.set('pagina', window.location.hostname + window.location.pathname);
  var frame = document.createElement('iframe');
  frame.src = origin + '/formulario?' + query.toString();
  frame.title = 'Formulario para cotizar tu viaje';
  frame.setAttribute('loading', 'lazy');
  frame.style.cssText = 'width:100%;max-width:680px;height:720px;border:0;display:block;margin:0 auto;background:transparent;';
  script.parentNode.insertBefore(frame, script);
  window.addEventListener('message', function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    var data = event.data || {};
    if (!data.tpForm) return;
    if (data.height) frame.style.height = Math.max(400, Math.min(4000, Number(data.height) || 0)) + 'px';
    if (data.scroll) {
      var top = frame.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.6) frame.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}());
