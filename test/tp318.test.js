'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('TP-318: sensación de app en celular (tap, press, hover solo con mouse)', () => {
  const css = pub('accesible.css');
  assert.match(css, /-webkit-tap-highlight-color:transparent/);
  assert.match(css, /touch-action:manipulation/);
  assert.match(css, /\.tabs a:active[^{]*\{transform:scale\(\.97\)/);
  assert.match(css, /scroll-snap-type:x proximity/);
  assert.match(pub('ui.css'), /-webkit-tap-highlight-color:transparent/);
  assert.doesNotMatch(pub('ui.css'), /transition: all/);
  for (const f of ['tp006.css', 'cotizaciones.css', 'ui.css']) assert.match(pub(f), /@media \(hover:hover\) and \(pointer:fine\)\{/, f);
});

test('TP-318: pagar y contrato usan viewport-fit y theme-color; días pasados sin bajar el contraste', () => {
  for (const f of ['pagar.html', 'contrato.html']) { assert.match(pub(f), /viewport-fit=cover/); assert.match(pub(f), /theme-color/); }
  assert.match(pub('accesible.css'), /\.day\.past,\.pills a\.past\{opacity:1\}/);
  assert.match(pub('itinerario.js'), /<span title="\$\{esc\(v\.name\)\}">/);
  for (const f of ['portal', 'itinerario', 'documento', 'pagar', 'contrato', 'encuesta', 'referido', 'formulario']) assert.match(pub(`${f}.html`), /accesible.css\?v=tp31[89]/);
});

test('TP-318: iniciales = primer nombre + primer apellido', () => {
  const src = pub('app.js');
  const start = src.indexOf('const initials = ');
  const end = src.indexOf('\n};', start) + 3;
  const initials = new Function(`${src.slice(start, end)}; return initials;`)();
  assert.equal(initials('Ana Pérez López'), 'AP');
  assert.equal(initials('Juan Carlos Pérez López'), 'JP');
  assert.equal(initials('María de la Cruz'), 'MC');
  assert.equal(initials('Jo'), 'J');
  assert.equal(initials('aleksandra wiśniewska-kowalczyk'), 'AW');
  assert.equal(initials('  '), '?');
  assert.equal(initials(null), '?');
});

test('TP-318: los CSS cambiados llevan versión nueva para que el navegador no use la copia vieja', () => {
  const idx = pub('index.html');
  for (const f of ['ui', 'tp006', 'cotizaciones', 'ficha-lead', 'app-movil', 'viaje']) assert.match(idx, new RegExp(`/${f}\\.css\\?v=tp31[89]`), f);
});

test('TP-318: formulario y proveedor también', () => {
  assert.match(pub('formulario.html'), /formulario.css\?v=tp31[89]/);
  assert.match(pub('proveedor.html'), /proveedor.css\?v=tp31[89]/);
});
