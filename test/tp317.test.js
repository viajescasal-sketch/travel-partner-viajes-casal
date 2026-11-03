'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('TP-317: las páginas del cliente cargan accesible.css y los botones cumplen contraste AA', () => {
  for (const f of ['portal', 'itinerario', 'documento', 'pagar', 'contrato', 'encuesta', 'referido', 'formulario']) {
    assert.match(pub(`${f}.html`), /\/accesible\.css\?v=tp31[78]/, `${f}.html`);
  }
  const css = pub('accesible.css');
  const hex = (name) => css.match(new RegExp(`--${name}:(#[0-9a-f]{6})`, 'i'))[1];
  for (const n of ['coral-ink', 'coral-ink-2', 'teal-ink', 'teal-ink-2', 'wa-ink']) assert.ok(ratio('#ffffff', hex(n)) >= 4.5, `blanco sobre ${n}`);
  assert.ok(ratio('#5b6b77', '#f4f7f9') >= 4.5, 'texto secundario sobre fondo');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('TP-317: el menú del itinerario marca la pestaña activa con aria-current', () => {
  assert.match(pub('itinerario.js'), /aria-current/);
});
