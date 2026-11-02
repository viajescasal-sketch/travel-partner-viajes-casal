'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const TPContract = require('../public/contrato-core.js');

const clauseOf = (plan) => {
  const doc = TPContract.build({ cfg: {}, documents: {}, agency: { name: 'Viajes Casal' }, quote: { folio: 'COT-1', destination: 'Cancún', price: 30000 }, client: { name: 'Ana' }, lead: null, plan });
  return doc.blocks.flatMap((b) => b.items || []).find((t) => /PRECIO Y FORMA DE PAGO/.test(t));
};

test('TP-317b: el contrato dice "pago total" cuando no hay anticipo y "anticipo" cuando sí', () => {
  const total = clauseOf({ total: 30000, installments: [{ label: 'Pago total', amount: 30000 }] });
  assert.match(total, /recibir el pago total de \$30,000/);
  assert.doesNotMatch(total, /anticipo/i);
  const conAnticipo = clauseOf({ total: 30000, installments: [{ label: 'Anticipo', amount: 6000 }, { label: 'Liquidación', amount: 24000 }] });
  assert.match(conAnticipo, /recibir el anticipo de \$6,000/);
});
