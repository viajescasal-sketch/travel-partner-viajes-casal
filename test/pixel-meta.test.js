'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_INITIAL_PASSWORD = 'AdminTemporal123';
process.env.PARTNER_EMAIL = 'paulina@example.test';
process.env.PARTNER_INITIAL_PASSWORD = 'PartnerTemporal123';

const { createApp } = require('../server');

test('el Pixel de Meta solo se permite en la página del formulario', async (context) => {
  const app = await createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const form = await fetch(`${baseUrl}/formulario`);
  assert.equal(form.status, 200);
  const csp = form.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net/);
  assert.match(csp, /img-src 'self' https:\/\/www\.facebook\.com/);
  assert.match(await form.text(), /\/pixel-meta\.js/);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.doesNotMatch(health.headers.get('content-security-policy'), /facebook/);

  const pixel = await fetch(`${baseUrl}/pixel-meta.js`);
  assert.equal(pixel.status, 200);
  assert.match(await pixel.text(), /2219013442169852/);

  const img = await fetch(`${baseUrl}/campanas-meta/islandia-aurora-boreal.jpg`);
  assert.equal(img.status, 200);
});
