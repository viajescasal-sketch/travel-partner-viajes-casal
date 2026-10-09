'use strict';
// Formulario web de Viajes Casal: pasos con botones y preguntas según el servicio. Envía el lead directo al CRM.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const params = new URLSearchParams(location.search);
  const embed = params.get('embed') === '1';
  if (embed) document.body.classList.add('embed');
  const startedAt = Date.now();

  let F = null; // definición que manda el servidor
  let today = new Date().toISOString().slice(0, 10);
  let whatsapp = '';
  const s = { adultos: 2, ninos: 0, experiencias: [] }; // respuestas
  let index = 0;

  // ---------- Altura para el iframe ----------
  function postHeight(scroll) {
    if (!embed || window.parent === window) return;
    const box = document.querySelector('.wf');
    window.parent.postMessage({ tpForm: 1, height: Math.ceil((box ? box.getBoundingClientRect().height : document.body.scrollHeight) + 4), scroll: Boolean(scroll) }, '*');
  }
  if (embed && 'ResizeObserver' in window) new ResizeObserver(() => postHeight(false)).observe(document.body);

  // ---------- Piezas ----------
  const option = (name, value, label, extra = {}) => `<button type="button" class="wf-opt" data-name="${esc(name)}" data-value="${esc(value)}" aria-pressed="${extra.multi ? s[name].includes(value) : s[name] === value}"${extra.multi ? ' data-multi="1"' : ''}>${extra.icon ? `<span class="ico" aria-hidden="true">${esc(extra.icon)}</span>` : ''}<span><b>${esc(label)}</b>${extra.hint ? `<small>${esc(extra.hint)}</small>` : ''}</span>${extra.multi ? '<span class="check" aria-hidden="true">✓</span>' : ''}</button>`;
  const choices = (name, legend, list, opts = {}) => `<fieldset class="wf-q" data-q="${esc(name)}"><legend>${esc(legend)}</legend>${opts.help ? `<small class="help">${esc(opts.help)}</small>` : ''}<div class="${opts.chips ? 'wf-chips' : `wf-opts${opts.cols ? ' cols' : ''}`}">${list.map((v) => option(name, v, v, { multi: opts.multi })).join('')}</div></fieldset>`;
  const input = (name, label, attrs = '', help = '') => `<div class="wf-q"><label><span>${esc(label)}</span>${help ? `<small class="help">${esc(help)}</small>` : ''}<input class="wf-input" name="${esc(name)}" value="${esc(s[name] || '')}" ${attrs} /></label></div>`;
  const counter = (name, label, min) => `<div class="wf-q"><span class="wf-label">${esc(label)}</span><div class="wf-counter"><button type="button" data-count="${name}" data-delta="-1" aria-label="Menos">−</button><output id="out_${name}">${s[name]}</output><button type="button" data-count="${name}" data-delta="1" aria-label="Más">+</button></div></div>`;

  const svc = () => s.servicio;
  const STEPS = [
    {
      id: 'basico',
      render: () => `<h2>Empecemos por lo básico 👋</h2><p class="sub">Por aquí te compartiremos tu cotización personalizada.</p>
        ${input('nombre', 'Nombre completo', 'autocomplete="name" maxlength="120" required')}
        ${input('whatsapp', 'WhatsApp', 'type="tel" inputmode="tel" autocomplete="tel" maxlength="25" placeholder="998 123 4567" required', 'Si no es de México, escríbelo con lada, por ejemplo +1 305 123 4567')}
        ${input('correo', 'Correo (opcional)', 'type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="tu@correo.com"')}`,
      check: () => {
        if (String(s.nombre || '').trim().length < 2) return 'Escribe tu nombre';
        const digits = String(s.whatsapp || '').replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return 'Escribe tu WhatsApp a 10 dígitos (o con lada)';
        if (s.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.correo)) return 'Revisa tu correo';
        return '';
      }
    },
    {
      id: 'servicio',
      auto: true,
      render: () => `<h2>¿Qué te gustaría que te ayudemos a organizar?</h2><p class="sub">Elige una opción.</p>
        <div class="wf-opts">${F.services.map((o) => option('servicio', o.id, o.label, { icon: o.icon, hint: o.hint })).join('')}</div>`,
      check: () => (svc() ? '' : 'Elige una opción')
    },
    {
      id: 'rama',
      auto: () => ['hotel', 'asesoria'].includes(svc()),
      render: () => {
        if (svc() === 'paquete') return `<h2>Detalles del vuelo</h2>${input('ciudadSalida', 'Ciudad desde donde saldrían', 'maxlength="120" placeholder="Ej. Monterrey" required')}`;
        if (svc() === 'vuelo') return `<h2>Detalles del vuelo</h2>${input('ciudadSalida', 'Ciudad desde donde saldrían', 'maxlength="120" placeholder="Ej. Monterrey" required')}${choices('tipoVuelo', '¿Viaje redondo o solo ida?', F.tipoVuelo, { chips: true })}`;
        if (svc() === 'hotel') return `<h2>Preferencias de hospedaje</h2>${choices('hospedaje', '¿Qué tipo de hospedaje prefieren?', F.hospedaje)}`;
        if (svc() === 'tours') return `<h2>Experiencias</h2>${choices('experiencias', '¿Qué tipo de experiencia buscan?', F.experiencias, { multi: true, cols: true, help: 'Puedes elegir varias.' })}`;
        return `<h2>Te asesoramos</h2>${choices('preocupacion', '¿Qué es lo que más te frena o te preocupa de organizar este viaje?', F.preocupacion)}`;
      },
      check: () => {
        if (['paquete', 'vuelo'].includes(svc()) && !String(s.ciudadSalida || '').trim()) return 'Escribe la ciudad de salida';
        if (svc() === 'vuelo' && !s.tipoVuelo) return 'Elige si es redondo o solo ida';
        if (svc() === 'hotel' && !s.hospedaje) return 'Elige el tipo de hospedaje';
        if (svc() === 'tours' && !s.experiencias.length) return 'Elige al menos una experiencia';
        if (svc() === 'asesoria' && !s.preocupacion) return 'Elige una opción';
        return '';
      }
    },
    {
      id: 'detalles',
      render: () => {
        const noDates = s.fechas === F.fechas[2];
        const oneWay = s.tipoVuelo === 'Solo ida';
        return `<h2>Cuéntanos los detalles de tu viaje</h2>
        ${input('destino', '¿A qué destino te gustaría viajar?', 'maxlength="120" placeholder="Ej. Cancún, Riviera Maya, Los Cabos… o “no sé, quiero recomendaciones”" required')}
        ${choices('fechas', '¿Tienes fechas?', F.fechas, { chips: true })}
        <div class="wf-row${noDates || !s.fechas ? ' hidden' : ''}" id="wfDates">
          ${input('llegada', 'Fecha de llegada', `type="date" min="${today}"`)}
          ${oneWay ? '' : input('regreso', 'Fecha de regreso', `type="date" min="${esc(s.llegada || today)}"`)}
        </div>
        <div class="${noDates ? '' : 'hidden'}" id="wfWhen">${choices('cuando', '¿Para cuándo lo tienes pensado?', F.cuando, { chips: true })}</div>
        <div class="wf-row">${counter('adultos', '¿Cuántos adultos viajan?')}${counter('ninos', '¿Cuántos niños viajan?')}</div>
        <div class="${s.ninos ? '' : 'hidden'}" id="wfAges">${input('edades', 'Edades de los niños', 'maxlength="80" placeholder="Ej. 4, 8, 12"', 'Escribe las edades separadas por comas.')}</div>
        ${svc() === 'vuelo' ? '' : choices('noches', 'Número de noches o días de viaje', F.noches, { chips: true })}`;
      },
      check: () => {
        if (!String(s.destino || '').trim()) return 'Escribe a qué destino te gustaría viajar';
        if (!s.fechas) return 'Dinos si ya tienes fechas';
        if (s.fechas !== F.fechas[2]) {
          if (!s.llegada) return 'Elige la fecha de llegada';
          if (s.llegada < today) return 'La fecha de llegada ya pasó';
          if (s.tipoVuelo !== 'Solo ida' && !s.regreso) return 'Elige la fecha de regreso';
          if (s.regreso && s.regreso < s.llegada) return 'El regreso no puede ser antes de la llegada';
        } else if (!s.cuando) return 'Dinos para cuándo lo tienes pensado';
        if (s.adultos < 1) return 'Debe viajar al menos un adulto';
        if (s.ninos && !String(s.edades || '').trim()) return 'Escribe las edades de los niños';
        if (svc() !== 'vuelo' && !s.noches) return 'Elige el número de noches';
        return '';
      }
    },
    {
      id: 'calificacion',
      render: () => `<h2>Ya casi terminamos 🙌</h2><p class="sub">Esto nos ayuda a armar la propuesta correcta.</p>
        ${choices('presupuesto', '¿Cuál es tu presupuesto aproximado por persona?', F.presupuesto)}
        ${choices('etapa', '¿En qué etapa estás ahora mismo?', F.etapa)}
        ${choices('motivo', 'Motivo del viaje', F.motivo, { chips: true })}
        ${choices('quien', '¿Quién toma la decisión del viaje?', F.quien)}`,
      check: () => (!s.presupuesto ? 'Elige tu presupuesto por persona' : !s.etapa ? 'Dinos en qué etapa estás' : !s.motivo ? 'Elige el motivo del viaje' : !s.quien ? 'Dinos quién toma la decisión' : '')
    },
    {
      id: 'final',
      last: true,
      render: () => `<h2>¡Listo! Un asesor humano (no un bot) va a escribirte 😊</h2>
        <div class="wf-q"><label><span>¿Hay algo más que debamos saber para diseñar tu viaje ideal?</span><textarea class="wf-input" name="comentarios" maxlength="1500" placeholder="Cuéntanos detalles adicionales (opcional)">${esc(s.comentarios || '')}</textarea></label></div>`,
      check: () => ''
    }
  ];

  // ---------- Pintar ----------
  function show(i, scroll) {
    index = i;
    const step = STEPS[index];
    $('#wfStep').innerHTML = step.render();
    $('#wfError').textContent = '';
    $('#wfBack').classList.toggle('hidden', index === 0);
    $('#wfNext').textContent = step.last ? 'Enviar mi solicitud' : 'Siguiente';
    const autoStep = typeof step.auto === 'function' ? step.auto() : step.auto;
    $('#wfNext').classList.toggle('hidden', Boolean(autoStep));
    $('#wfBar').style.width = `${Math.round((index / STEPS.length) * 100)}%`;
    const first = $('#wfStep input:not([type=hidden]), #wfStep textarea');
    if (first && index === 0 && !embed) first.focus();
    if (scroll) { if (embed) { window.scrollTo(0, 0); postHeight(true); } else window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }

  function readInputs() {
    document.querySelectorAll('#wfStep [name]').forEach((el) => { s[el.name] = el.value.trim(); });
  }

  function next() {
    readInputs();
    const error = STEPS[index].check();
    if (error) { $('#wfError').textContent = error; return; }
    if (STEPS[index].last) { send(); return; }
    show(index + 1, true);
  }

  $('#wfStep').addEventListener('input', (e) => {
    if (!e.target.name) return;
    s[e.target.name] = e.target.value;
    if (e.target.name === 'llegada' && $('[name=regreso]')) $('[name=regreso]').min = e.target.value || today;
  });

  $('#wfStep').addEventListener('click', (e) => {
    const counterBtn = e.target.closest('[data-count]');
    if (counterBtn) {
      const name = counterBtn.dataset.count;
      const min = name === 'adultos' ? 1 : 0;
      s[name] = Math.min(Math.max((s[name] || 0) + Number(counterBtn.dataset.delta), min), name === 'adultos' ? 60 : 30);
      $(`#out_${name}`).textContent = s[name];
      if (name === 'ninos') $('#wfAges').classList.toggle('hidden', !s.ninos);
      return;
    }
    const btn = e.target.closest('.wf-opt');
    if (!btn) return;
    readInputs();
    const { name, value } = btn.dataset;
    if (btn.dataset.multi) {
      s[name] = s[name].includes(value) ? s[name].filter((v) => v !== value) : [...s[name], value];
      btn.setAttribute('aria-pressed', String(s[name].includes(value)));
      return;
    }
    if (name === 'servicio' && s.servicio !== value) { s.servicio = value; delete s.tipoVuelo; }
    s[name] = value;
    btn.closest('.wf-opts, .wf-chips').querySelectorAll('.wf-opt').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    $('#wfError').textContent = '';
    if (name === 'fechas') {
      const noDates = value === F.fechas[2];
      $('#wfDates').classList.toggle('hidden', noDates);
      $('#wfWhen').classList.toggle('hidden', !noDates);
    }
    const step = STEPS[index];
    const autoStep = typeof step.auto === 'function' ? step.auto() : step.auto;
    if (autoStep) setTimeout(next, 180);
  });

  $('#wfBack').addEventListener('click', () => { readInputs(); if (index > 0) show(index - 1, true); });
  $('#wfForm').addEventListener('submit', (e) => { e.preventDefault(); next(); });

  // ---------- Enviar ----------
  async function send() {
    const btn = $('#wfNext');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const digits = String(s.whatsapp || '').replace(/\D/g, '');
    const payload = {
      ...s,
      whatsapp: String(s.whatsapp || '').trim().startsWith('+') || digits.length !== 10 ? s.whatsapp : `+52${digits}`,
      website: $('#wfWebsite').value,
      elapsed: Date.now() - startedAt,
      origen: params.get('origen') || '',
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      pagina: params.get('pagina') || (embed ? '' : 'Enlace directo')
    };
    // Solo se envían las respuestas del servicio elegido.
    const keep = { paquete: ['ciudadSalida'], vuelo: ['ciudadSalida', 'tipoVuelo'], hotel: ['hospedaje'], tours: ['experiencias'], asesoria: ['preocupacion'] }[svc()] || [];
    ['ciudadSalida', 'tipoVuelo', 'hospedaje', 'experiencias', 'preocupacion'].forEach((k) => { if (!keep.includes(k)) delete payload[k]; });
    if (svc() === 'vuelo') delete payload.noches;
    if (payload.fechas === F.fechas[2]) { delete payload.llegada; delete payload.regreso; } else delete payload.cuando;
    if (!payload.ninos) delete payload.edades;
    try {
      const res = await fetch('/api/public/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'No pudimos enviar tu solicitud. Intenta de nuevo.');
      done(data.whatsapp || whatsapp);
    } catch (error) {
      $('#wfError').textContent = error.message === 'Failed to fetch' ? 'Sin conexión. Revisa tu internet e intenta de nuevo.' : error.message;
      btn.disabled = false;
      btn.textContent = 'Enviar mi solicitud';
    }
  }

  function done(number) {
    const first = String(s.nombre || '').trim().split(/\s+/)[0];
    const dmy = (iso) => iso.split('-').reverse().join('/');
    const fechas = s.llegada ? ` del ${dmy(s.llegada)}${s.regreso ? ` al ${dmy(s.regreso)}` : ''}` : '';
    const msg = `Hola, soy ${String(s.nombre || '').trim()}. Acabo de llenar el formulario para mi viaje a ${s.destino}${fechas}. Quedo atento(a) a mi cotización.`;
    $('#wfBar').style.width = '100%';
    $('#wfNav').classList.add('hidden');
    $('#wfError').textContent = '';
    $('#wfStep').innerHTML = `<div class="wf-done"><div class="big" aria-hidden="true">🎉</div><h2>¡Gracias, ${esc(first)}!</h2>
      <p>Ya recibimos tu información. En menos de 15 minutos alguien de nuestro equipo te escribe por WhatsApp con tu propuesta.</p>
      <p><b>Viajar tranquilo también se planea.</b></p>
      ${number ? `<a class="wf-btn wa" href="https://wa.me/${esc(number)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">💬 Escríbenos por WhatsApp</a>` : ''}</div>`;
    if (embed) { window.scrollTo(0, 0); postHeight(true); } else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- Inicio ----------
  fetch('/api/public/form', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) throw new Error();
      F = data.form;
      today = data.today || today;
      whatsapp = data.whatsapp || '';
      $('#wfAgency').textContent = data.agency || 'Viajes Bumeran Casal';
      if (!data.enabled) {
        $('#wfNav').classList.add('hidden');
        $('#wfStep').innerHTML = `<div class="wf-done"><h2>Escríbenos por WhatsApp</h2><p>Por ahora atendemos tus solicitudes directo por WhatsApp.</p>${whatsapp ? `<a class="wf-btn wa" href="https://wa.me/${esc(whatsapp)}" target="_blank" rel="noopener">💬 Abrir WhatsApp</a>` : ''}</div>`;
        return;
      }
      show(0);
    })
    .catch(() => { $('#wfStep').innerHTML = '<p class="wf-error">No pudimos cargar el formulario. Recarga la página o escríbenos por WhatsApp.</p>'; $('#wfNav').classList.add('hidden'); });
}());
