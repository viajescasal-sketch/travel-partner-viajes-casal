'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sanitizeDocuments, DEFAULT_DOCUMENTS } = require('../src/documents');

test('TP-316b: catálogo inicial de tours (12) y se puede editar', () => {
  const rows = DEFAULT_DOCUMENTS.tours.split('\n').map((l) => l.split('|').map((x) => x.trim()));
  assert.equal(rows.length, 12);
  for (const r of rows) {
    assert.equal(r.length, 8, `8 columnas: ${r[1]}`);
    assert.ok(Number(r[4]) > 0, `precio: ${r[1]}`);
    assert.match(r[6], /^https:\/\//, `foto https: ${r[1]}`);
  }
  assert.deepEqual([...new Set(rows.map((r) => r[0]))].sort(), ['Cancún', 'Los Cabos', 'Puerto Vallarta', 'Riviera Maya']);
  assert.equal(sanitizeDocuments({ ...DEFAULT_DOCUMENTS, tours: '' }).tours, '', 'vacío oculta la sección');
});

test('TP-316b: tours filtrados por destino (Quintana Roo agrupado) y sin precios internos', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const ctx = { window: {}, document: { head: { append() {} }, createElement: () => ({}) } };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/extras.js'), 'utf8'), ctx);
  const wa = (t) => `https://wa.me/1?text=${encodeURIComponent(t)}`;
  const names = (dest) => [...ctx.TPExtras.tours({ documents: DEFAULT_DOCUMENTS, destination: dest, waLink: wa }).matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.equal(names('Cancún').length, 6, 'Cancún + Riviera Maya');
  assert.equal(names('Tulum').length, 6);
  assert.deepEqual(names('Los Cabos').sort(), ['ATV en el Desierto', 'Avistamiento de Ballenas', 'El Arco + Playa del Amor']);
  assert.equal(names('Puerto Vallarta').length, 3);
  assert.equal(ctx.TPExtras.tours({ documents: DEFAULT_DOCUMENTS, destination: 'París', waLink: wa }), '');
  const off = { tours: 'Cancún | Tour | Aventura | 3 horas | 900 | desc | https://x.com/a.jpg | No' };
  assert.equal(ctx.TPExtras.tours({ documents: off, destination: 'Cancún', waLink: wa }), '');
  assert.match(ctx.TPExtras.tours({ documents: DEFAULT_DOCUMENTS, destination: 'Cancún', waLink: wa }), /Quiero este tour/);
});
