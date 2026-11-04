/* Pixel de Meta (Facebook/Instagram) para el formulario público.
   Mide visitas (PageView) y solicitudes enviadas (Lead) de las campañas de anuncios.
   No se envían datos personales del cliente: solo los eventos. Archivo propio por la política de seguridad (CSP). */
(function () {
  var PIXEL_ID = '2219013442169852';
  if (window.fbq) return;
  var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
  if (!window._fbq) window._fbq = n;
  n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
  var t = document.createElement('script');
  t.async = true;
  t.src = 'https://connect.facebook.net/en_US/fbevents.js';
  var s = document.getElementsByTagName('script')[0];
  s.parentNode.insertBefore(t, s);
  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
