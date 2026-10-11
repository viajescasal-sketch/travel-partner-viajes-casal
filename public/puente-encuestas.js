/* Puente de encuestas → CRM de Viajes Casal.
   Las encuestas propias del sitio (paquetes, tours…) siguen igual: mismo diseño, mismas preguntas y el mismo
   mensaje de WhatsApp. Este archivo solo copia sus respuestas al CRM cuando el cliente las envía.
   Se carga solo desde formulario-embed.js, o a mano:
   <script src="https://travelpartner.viajescasal.com/puente-encuestas.js" async></script>
   Para conectar una encuesta nueva: ponle al <form> el atributo data-crm-encuesta="Nombre de la encuesta"
   y a sus campos name="nombre", "whatsapp", "correo", "destino"… (los mismos del formulario del CRM). */
(function () {
  if (window.__tpPuenteEncuestas) return;
  window.__tpPuenteEncuestas = true;

  var script = document.currentScript;
  var CRM = script && script.src ? new URL(script.src).origin : 'https://travelpartner.viajescasal.com';
  var ENDPOINT = CRM + '/api/public/lead';
  var seen = new WeakMap(); // cuándo apareció cada encuesta (antispam del CRM: mínimo 4 s)

  // ---------- utilidades ----------
  function byId(form, id) { return form.querySelector('#' + id); }
  function val(form, id) { var el = byId(form, id); return el ? String(el.value || '').trim() : ''; }
  function idx(form, id) { var el = byId(form, id); return el && el.tagName === 'SELECT' ? el.selectedIndex : -1; } // 0 = "Seleccionar…"
  function num(form, id) { var n = parseInt(val(form, id), 10); return isNaN(n) || n < 0 ? 0 : n; }
  function cancunToday() { return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10); }
  function clean(s) { return String(s || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim(); }

  // Texto de la pregunta de un campo (la etiqueta que ve el cliente).
  function labelOf(el) {
    var lab = el.id && document.querySelector('label[for="' + el.id + '"]');
    if (lab) return clean(lab.innerText);
    var own = el.closest('label');
    if (own && el.type !== 'checkbox' && el.type !== 'radio') return clean(own.innerText);
    var box = el.parentElement;
    for (var i = 0; box && i < 5; i++, box = box.parentElement) {
      var cands = box.querySelectorAll(':scope > label, :scope > .vc-label, :scope > p, :scope > span.vc-label');
      for (var j = 0; j < cands.length; j++) {
        // Se salta las etiquetas de cada opción (las que tienen su propia casilla adentro).
        if (cands[j] !== own && !cands[j].querySelector('input, select, textarea')) return clean(cands[j].innerText);
      }
    }
    return clean(el.name || el.id || 'Respuesta');
  }

  // Pregunta de un grupo de casillas u opciones ("Servicios adicionales"); null si la casilla va sola.
  function groupLabel(el, own) {
    var box = (own || el).parentElement;
    for (var i = 0; box && i < 3 && box.querySelectorAll('input[type="' + el.type + '"]').length < 2; i++) box = box.parentElement;
    if (!box || box.querySelectorAll('input[type="' + el.type + '"]').length < 2) return null;
    for (var k = 0; box && k < 2; k++, box = box.parentElement) {
      var cands = box.querySelectorAll(':scope > label, :scope > .vc-label, :scope > legend');
      for (var j = 0; j < cands.length; j++) if (!cands[j].querySelector('input, select, textarea')) return clean(cands[j].innerText);
    }
    return null;
  }

  // Todas las respuestas tal cual, en el orden de la encuesta.
  function allAnswers(form) {
    var rows = [];
    var groups = {};
    Array.prototype.forEach.call(form.querySelectorAll('input, select, textarea'), function (el) {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.disabled) return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!el.checked) return;
        var own = el.closest('label');
        var option = clean(own ? own.innerText : el.value);
        var q = groupLabel(el, own);
        if (!q || q === option) { rows.push([option, 'Sí']); return; } // casilla suelta, p. ej. "Mis fechas son flexibles"
        if (groups[q]) { groups[q][1] += ', ' + option; return; }
        groups[q] = [q, option];
        rows.push(groups[q]);
        return;
      }
      var opt = el.tagName === 'SELECT' ? el.options[el.selectedIndex] : null;
      var v = el.tagName === 'SELECT' ? (opt && opt.value !== '' ? clean(opt.text) : '') : String(el.value || '').trim();
      if (v) rows.push([labelOf(el), v]);
    });
    return rows;
  }

  // ---------- Encuesta de paquetes ("Solicitar cotización") ----------
  function fromPackages(form) {
    // Por posición de la opción, para que funcione igual en español y en inglés.
    var servicio = ['', 'paquete', 'hotel', 'vuelo', 'tours', 'asesoria', 'asesoria', 'asesoria'][idx(form, 'q-cotizacion')] || 'asesoria';
    var etapa = ['', 'Solo estoy explorando ideas', 'Ya quiero ver opciones y precios', 'Ya quiero ver opciones y precios',
      'Quiero reservar pronto (esta semana o las próximas 2)', 'Quiero reservar pronto (esta semana o las próximas 2)'][idx(form, 'q-etapa')] || '';
    var motivo = ['', 'Vacaciones', 'Viaje familiar', 'Viaje con amigos', 'Luna de miel', 'Cumpleaños', 'Otro', 'Otro'][idx(form, 'q-tipoViaje')] || '';
    var presupuesto = idx(form, 'q-presupuesto') === 6 ? 'Prefiero que me orienten según lo que incluye' : '';
    var flexible = Array.prototype.some.call(form.querySelectorAll('input[type=checkbox]'), function (c) {
      return c.checked && /flexib/i.test((c.closest('label') || {}).innerText || '');
    });
    var bebes = num(form, 'q-bebes');
    var edades = val(form, 'q-edadesNinos') || val(form, 'q-edades');
    var destinoEl = byId(form, 'q-destino');
    var destino = val(form, 'q-destino');
    if (destinoEl && destinoEl.selectedIndex === destinoEl.options.length - 1) destino = 'Otro (por definir)';
    return {
      encuesta: 'Encuesta de paquetes (Solicitar cotización)', origen: 'encuesta-paquetes',
      nombre: val(form, 'q-nombre'), whatsapp: val(form, 'q-whatsapp'), correo: val(form, 'q-email'),
      servicio: servicio, destino: destino, ciudadSalida: val(form, 'q-ciudadSalida'),
      llegada: val(form, 'q-fechaSalida'), regreso: val(form, 'q-fechaRegreso'),
      fechas: val(form, 'q-fechaSalida') ? (flexible ? 'Mis fechas son flexibles' : 'Tengo fechas fijas') : (flexible ? 'Mis fechas son flexibles' : 'Aún no tengo fechas'),
      adultos: num(form, 'q-adultos'), ninos: num(form, 'q-ninos') + bebes,
      edades: [edades, bebes ? bebes + (bebes === 1 ? ' bebé' : ' bebés') + ' (0-1 años)' : ''].filter(Boolean).join(' · '),
      etapa: etapa, motivo: motivo, presupuesto: presupuesto, comentarios: val(form, 'q-comentarios')
    };
  }

  // ---------- Encuesta de tours ("Cotizar" / "Solicitar información") ----------
  function fromTours(form) {
    var tourEl = byId(form, 't-tour');
    var tour = val(form, 't-tour');
    var etapa = ['', 'Solo estoy explorando ideas', 'Ya quiero ver opciones y precios',
      'Quiero reservar pronto (esta semana o las próximas 2)', 'Quiero reservar pronto (esta semana o las próximas 2)'][idx(form, 't-etapa')] || '';
    var otro = tourEl && tourEl.selectedIndex === tourEl.options.length - 1;
    return {
      encuesta: 'Encuesta de tours (Solicitar información)', origen: 'encuesta-tours',
      nombre: val(form, 't-nombre'), whatsapp: val(form, 't-whatsapp'), correo: val(form, 't-email'),
      servicio: 'tours', destino: tour && !otro ? 'Tour ' + tour : 'Tour (por definir)',
      llegada: val(form, 't-fecha'), fechas: val(form, 't-fecha') ? 'Tengo fechas fijas' : 'Aún no tengo fechas',
      adultos: num(form, 't-adultos'), ninos: num(form, 't-ninos'), edades: val(form, 't-edadesNinos') || val(form, 't-edades'),
      etapa: etapa, comentarios: val(form, 't-comentarios')
    };
  }

  // ---------- Encuesta genérica (atributo data-crm-encuesta) ----------
  function fromGeneric(form) {
    var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? String(el.value || '').trim() : ''; };
    return {
      encuesta: form.getAttribute('data-crm-encuesta') || 'Encuesta del sitio', origen: form.getAttribute('data-origen') || 'encuesta-sitio',
      nombre: get('nombre'), whatsapp: get('whatsapp') || get('telefono'), correo: get('correo') || get('email'),
      servicio: get('servicio') || 'asesoria', destino: get('destino') || 'Por definir',
      llegada: get('llegada'), regreso: get('regreso'), fechas: get('llegada') ? 'Tengo fechas fijas' : 'Aún no tengo fechas',
      adultos: parseInt(get('adultos'), 10) || 1, ninos: parseInt(get('ninos'), 10) || 0, comentarios: get('comentarios')
    };
  }

  function kindOf(form) {
    if (!form || form.tagName !== 'FORM') return null;
    if (form.hasAttribute('data-crm-encuesta')) return fromGeneric;
    if (byId(form, 'q-nombre') && byId(form, 'q-whatsapp')) return fromPackages;
    if (byId(form, 't-nombre') && byId(form, 't-whatsapp')) return fromTours;
    return null;
  }

  function build(form, reader) {
    var p = reader(form);
    var today = cancunToday();
    var respuestas = allAnswers(form);
    if (p.llegada && p.llegada < today) { p.llegada = ''; p.regreso = ''; } // el CRM rechaza fechas pasadas; quedan en las respuestas
    if (!p.llegada) { p.regreso = ''; if (p.fechas === 'Tengo fechas fijas') p.fechas = 'Aún no tengo fechas'; }
    if (p.regreso && p.regreso < p.llegada) p.regreso = '';
    if (!p.adultos) p.adultos = 1;
    if (!p.ninos) p.edades = '';
    var digits = String(p.whatsapp || '').replace(/\D/g, '');
    if (!String(p.whatsapp).trim().startsWith('+') && digits.length === 10) p.whatsapp = '+52' + digits;
    var page = new URLSearchParams(window.location.search);
    p.respuestas = respuestas;
    p.pagina = window.location.hostname + window.location.pathname;
    p.origen = (p.origen + '-' + window.location.hostname.replace(/^www\./, '').split('.')[0]).slice(0, 80);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (page.get(k)) p[k] = page.get(k); });
    p.hp_check = '';
    // La encuesta ya pasó sus propias validaciones y abrió WhatsApp (no es un robot): el antispam de tiempo del CRM
    // es para su propio formulario, así que aquí nunca se descarta a un cliente que llenó rápido.
    p.elapsed = Math.max(Date.now() - (seen.get(form) || Date.now()), 4500);
    Object.keys(p).forEach(function (k) { if (p[k] === '' || p[k] === undefined) delete p[k]; });
    return p;
  }

  function send(payload) {
    try {
      // Texto plano: el navegador lo manda directo (sin verificación previa) y "keepalive" lo termina aunque se abra WhatsApp.
      fetch(ENDPOINT, { method: 'POST', mode: 'cors', keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || !d.ok) console.warn('[CRM] La encuesta no se registró:', d.error || r.status); }); })
        .catch(function () { /* sin conexión: el cliente igual llega por WhatsApp */ });
    } catch (e) { /* nunca romper la encuesta */ }
  }

  // ---------- Detectar encuestas y su envío ----------
  function mark(root) {
    var forms = root.tagName === 'FORM' ? [root] : root.querySelectorAll ? root.querySelectorAll('form') : [];
    Array.prototype.forEach.call(forms, function (f) { if (!seen.has(f) && kindOf(f)) seen.set(f, Date.now()); });
  }
  new MutationObserver(function (list) {
    list.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) mark(n); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  mark(document);
  document.addEventListener('focusin', function (e) { var f = e.target.form; if (f && !seen.has(f) && kindOf(f)) seen.set(f, Date.now() - 4000); }, true);

  // Se registra solo cuando la encuesta de verdad se envió (pasó sus validaciones y abrió WhatsApp o se cerró).
  var pending = null;
  function flush() {
    if (!pending) return;
    var p = pending.payload;
    pending = null;
    send(p);
  }
  var nativeOpen = window.open;
  window.open = function (url) {
    if (pending && /wa\.me|whatsapp\.com/i.test(String(url || ''))) flush();
    return nativeOpen.apply(window, arguments);
  };

  window.addEventListener('submit', function (e) {
    var form = e.target;
    var reader = kindOf(form);
    if (!reader) return;
    var payload;
    try { payload = build(form, reader); } catch (err) { return; }
    if (!payload.nombre || String(payload.whatsapp || '').replace(/\D/g, '').length < 10) return; // la encuesta mostrará sus propios errores
    pending = { payload: payload, form: form };
    // Si la encuesta no abre WhatsApp, se registra cuando se cierra tras enviarse.
    setTimeout(function () {
      if (pending && pending.form === form && !document.documentElement.contains(form)) flush();
      else if (pending && pending.form === form) pending = null; // no pasó las validaciones de la encuesta
    }, 1500);
  }, true);
}());
