'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sanitizeDocuments, DEFAULT_DOCUMENTS } = require('../src/documents');

test('TP-315: Prepara tu maleta se configura en Documentos (enlace https y productos)', () => {
  assert.match(DEFAULT_DOCUMENTS.storeUrl, /^https:\/\/go\.viajescasal\.com/);
  assert.equal(DEFAULT_DOCUMENTS.storeItems.split('\n').length, 5);
  const ok = sanitizeDocuments({ ...DEFAULT_DOCUMENTS, storeUrl: 'https://go.viajescasal.com/collections/todo', storeItems: '🎒 | Mochila | $915' });
  assert.equal(ok.storeUrl, 'https://go.viajescasal.com/collections/todo');
  assert.equal(ok.storeItems, '🎒 | Mochila | $915');
  assert.equal(sanitizeDocuments({ ...DEFAULT_DOCUMENTS, storeItems: '' }).storeItems, '', 'vacío oculta la sección');
  assert.throws(() => sanitizeDocuments({ ...DEFAULT_DOCUMENTS, storeUrl: 'javascript:alert(1)' }), /https/);
});
