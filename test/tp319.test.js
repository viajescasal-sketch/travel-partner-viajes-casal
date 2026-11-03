'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('TP-319: navegar no hace scroll animado y el panel respeta movimiento reducido', () => {
  assert.doesNotMatch(pub('app.js'), /scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/);
  assert.match(pub('ui.css'), /prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto !important/);
  for (const f of ['formulario.js', 'encuesta.js', 'contrato.js', 'formulario-embed.js']) assert.match(pub(f), /prefers-reduced-motion: reduce/, f);
});

test('TP-319: sin animaciones de layout en el menú ni en el modal; cajones con curva fuerte', () => {
  const t = pub('tp006.css');
  assert.doesNotMatch(t, /grid-template-columns \.2s ease/);
  assert.doesNotMatch(t, /modal-bg \.modal \{ transition: width/);
  assert.match(pub('styles.css'), /aside\{transform:translateX\(-100%\);transition:transform \.25s cubic-bezier\(\.32,\.72,0,1\)\}/);
  const c = pub('cotizaciones.css');
  assert.match(c, /transform \.22s cubic-bezier\(\.32,\.72,0,1\)/);
  assert.match(c, /@starting-style \{ \.qv-drawer-bg \{ opacity: 0; \} \}/);
  assert.match(c, /@media \(hover:hover\) and \(pointer:fine\)\{\.qv-card:hover/);
});

test('TP-319: avatares animados solo en el perfil y en el selector', () => {
  const u = pub('ui.css');
  assert.match(u, /\.profile-avatar \.av-live \.av-body, \.av-opt \.av-live \.av-body/);
  assert.doesNotMatch(u, /^\s*\.av-live \.av-body/m);
});

test('TP-319: versión nueva en los archivos cambiados', () => {
  const idx = pub('index.html');
  for (const f of ['ui', 'tp006', 'cotizaciones', 'viaje', 'app-movil', 'styles']) assert.match(idx, new RegExp(`/${f}\\.css\\?v=tp319`), f);
  assert.match(idx, /app\.js\?v=tp319/);
  assert.match(pub('formulario.html'), /formulario\.css\?v=tp319/);
});
