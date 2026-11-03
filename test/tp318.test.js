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
  for (const f of ['portal', 'itinerario', 'documento', 'pagar', 'contrato', 'encuesta', 'referido', 'formulario']) assert.match(pub(`${f}.html`), /accesible\.css\?v=tp318/);
});
