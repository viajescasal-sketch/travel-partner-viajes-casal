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
const F = require('../public/campos-core');
const A = require('../public/automatizaciones-core');
const { nowCancun } = require('../src/crm-schema');

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function signIn(baseUrl, email, temporal) {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: temporal }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  await call('POST', '/api/auth/change-password', { currentPassword: temporal, newPassword: 'NuevaClave2026Segura' });
  return call;
}
async function setup(context, extra = {}) {
  const sent = [];
  const mailer = { configured: false, from: 'x@example.test', send: async (m) => { sent.push(m); return { delivered: true }; } };
  const app = await createApp({ skipPurgeTimer: true, mailer, ...extra });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const partner = await signIn(baseUrl, process.env.PARTNER_EMAIL, process.env.PARTNER_INITIAL_PASSWORD);
  const admin = await signIn(baseUrl, process.env.ADMIN_EMAIL, process.env.ADMIN_INITIAL_PASSWORD);
  mailer.configured = true;
  const users = (await admin('GET', '/api/crm')).body.users;
  return { baseUrl, store: app.locals.dataStore, automations: app.locals.automations, partner, admin, sent, adminId: users.find((u) => u.role === 'admin').id, paulinaId: users.find((u) => u.role === 'travel_partner').id };
}
const FIELDS = {
  leads: [{ label: 'Motivo del viaje', type: 'select', options: 'Luna de miel, Vacaciones familiares, Negocios', required: true, card: true }, { label: 'Aerolínea preferida', type: 'text' }],
  clients: [{ label: 'Aniversario de bodas', type: 'date' }, { label: 'Viajero frecuente', type: 'bool' }, { label: 'Intereses', type: 'multi', options: ['Playa', 'Cultura', 'Aventura'] }],
  trips: [{ label: 'Número de habitaciones', type: 'number' }]
};

test('TP-306: definiciones y valores de campos personalizables', () => {
  assert.equal(F.slug('Aerolínea preferida'), 'aerolinea_preferida');
  const defs = F.cleanDefs({ leads: [{ label: 'Motivo' , type: 'select', options: 'A, B,A' }, { label: 'Motivo', type: 'text' }, { label: '' }], clients: [], trips: [], otra: [{ label: 'x' }] });
  assert.deepEqual(defs.leads.map((d) => d.key), ['motivo', 'motivo_2'], 'claves únicas');
  assert.deepEqual(defs.leads[0].options, ['A', 'B']);
  assert.equal(defs.otra, undefined);
  assert.throws(() => F.cleanDefs({ leads: [{ label: 'Sin opciones', type: 'select' }] }), /opciones/);
  const d = F.cleanDefs(FIELDS);
  const { values, missing } = F.cleanValues(d.clients, { aniversario_de_bodas: '2015-06-20', viajero_frecuente: 'on', intereses: ['Playa', 'Cultura'], otro: 'x' }, { campo_borrado: 1 });
  assert.deepEqual(values, { aniversario_de_bodas: '2015-06-20', viajero_frecuente: true, intereses: ['Playa', 'Cultura'] }, 'sin claves desconocidas');
  assert.deepEqual(missing, []);
  assert.throws(() => F.cleanValues(d.clients, { intereses: ['Golf'] }), /no es una opción/);
  assert.throws(() => F.cleanValues(d.trips, { numero_de_habitaciones: 'muchas' }), /número/);
  assert.deepEqual(F.cleanValues(d.leads, {}).missing, ['Motivo del viaje']);
  // Un campo desactivado conserva su valor y ya no se puede cambiar.
  const off = d.leads.map((x) => (x.key === 'aerolinea_preferida' ? { ...x, active: false } : x));
  assert.deepEqual(F.cleanValues(off, { aerolinea_preferida: 'Volaris', motivo_del_viaje: 'Negocios' }, { aerolinea_preferida: 'Aeroméxico' }).values, { aerolinea_preferida: 'Aeroméxico', motivo_del_viaje: 'Negocios' });
  assert.equal(F.display(d.clients[0], '2015-06-20'), '20 jun 2015');
  assert.equal(F.display(d.clients[1], false), 'No');
});

test('TP-306: campos en leads, clientes y viajes (formularios, bitácora y exportación)', async (context) => {
  const ctx = await setup(context);
  assert.equal((await ctx.partner('PUT', '/api/custom-fields', { fields: FIELDS })).status, 403);
  const saved = await ctx.admin('PUT', '/api/custom-fields', { fields: FIELDS });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.fields.leads.map((x) => x.key), ['motivo_del_viaje', 'aerolinea_preferida']);
  assert.equal((await ctx.partner('GET', '/api/crm')).body.settings.customFields.clients.length, 3, 'todo el equipo ve las definiciones');

  const base = { client: { name: 'Ana López', phone: '998 123 4567', custom: { viajero_frecuente: true } }, destination: 'Cancún', budget: 60000 };
  const missing = await ctx.partner('POST', '/api/leads', { ...base, custom: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Motivo del viaje/);
  assert.equal((await ctx.partner('POST', '/api/leads', { ...base, custom: { motivo_del_viaje: 'Safari' } })).status, 400, 'opción inválida');
  const created = await ctx.partner('POST', '/api/leads', { ...base, custom: { motivo_del_viaje: 'Luna de miel', aerolinea_preferida: 'Volaris' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.record.custom, { motivo_del_viaje: 'Luna de miel', aerolinea_preferida: 'Volaris' });
  assert.deepEqual(created.body.client.custom, { viajero_frecuente: true }, 'campos del cliente nuevo desde el lead');
  const leadId = created.body.record.id, clientId = created.body.client.id;

  // Mover de etapa (tablero) no exige los campos; editar sí los valida.
  assert.equal((await ctx.partner('PATCH', `/api/leads/${leadId}`, { stage: 'Calificado' })).status, 200);
  const edit = await ctx.partner('PATCH', `/api/leads/${leadId}`, { custom: { motivo_del_viaje: 'Negocios', aerolinea_preferida: '' } });
  assert.deepEqual(edit.body.record.custom, { motivo_del_viaje: 'Negocios' });
  const hist = await ctx.partner('GET', `/api/history/leads/${leadId}`);
  assert.ok(JSON.stringify(hist.body).includes('Motivo del viaje') || JSON.stringify(hist.body).includes('Luna de miel'), 'la bitácora registra el cambio del campo');

  const c = await ctx.partner('PATCH', `/api/clients/${clientId}`, { custom: { aniversario_de_bodas: '2015-06-20', intereses: ['Playa'] } });
  assert.deepEqual(c.body.record.custom, { viajero_frecuente: true, aniversario_de_bodas: '2015-06-20', intereses: ['Playa'] });
  assert.equal((await ctx.partner('PATCH', `/api/clients/${clientId}`, { custom: { aniversario_de_bodas: '20/06/2015' } })).status, 400);
  const trip = await ctx.partner('POST', '/api/trips', { client_id: clientId, destination: 'Cancún', start_date: '2027-01-10', end_date: '2027-01-15', custom: { numero_de_habitaciones: '2' } });
  assert.equal(trip.body.record.custom.numero_de_habitaciones, 2);

  const csv = await fetch(`${ctx.baseUrl}/api/export?sections=leads&format=csv`, { headers: { cookie: '' } });
  assert.equal(csv.status, 401);
  const exp = await ctx.partner('GET', '/api/export?sections=clients&format=csv');
  assert.match(exp.body, /Aniversario de bodas/);
  assert.match(exp.body, /2015-06-20/);
  assert.match(exp.body, /Playa/);
});

test('TP-307: reglas, condiciones y textos', () => {
  assert.throws(() => A.cleanRule({ name: '', actions: [] }), /nombre/);
  assert.throws(() => A.cleanRule({ name: 'x', actions: [] }), /acción/);
  assert.throws(() => A.cleanRule({ name: 'x', trigger: { type: 'date_field', entity: 'clients', field: 'aniv' }, actions: [{ type: 'set_stage', stage: 'Cotizado' }] }), /lead/, 'cambiar etapa necesita un lead');
  assert.throws(() => A.cleanRule({ name: 'x', trigger: { type: 'lead_created' }, conditions: [{ path: 'trip.status', op: 'eq', value: 'x' }], actions: [{ type: 'notify', title: 'a' }] }), /no aplica/);
  assert.throws(() => A.cleanRule({ name: 'x', actions: [{ type: 'set_stage', stage: 'Vendido' }] }), /etapa/);
  const rule = A.cleanRule({ name: 'Alto', trigger: { type: 'lead_created' }, conditions: [{ path: 'lead.budget', op: 'gte', value: '80000' }, { path: 'lead.source', op: 'eq', value: 'instagram' }], actions: [{ type: 'notify', to: 'admins', title: 'Lead de {cliente}' }] });
  assert.equal(rule.active, false, 'nuevas reglas apagadas hasta activarlas');
  assert.match(rule.id, /^a[a-z0-9]+$/);
  const ctx = { lead: { budget: 90000, source: 'Instagram', destination: 'Cancún', custom: { motivo: 'Luna de miel' } }, client: { name: 'Ana López', tags: 'Pareja, Playa' } };
  assert.equal(A.matches(rule, ctx), true, 'sin distinguir mayúsculas');
  assert.equal(A.matches(rule, { ...ctx, lead: { ...ctx.lead, budget: 1000 } }), false);
  assert.equal(A.matches({ ...rule, match: 'any' }, { ...ctx, lead: { ...ctx.lead, budget: 1000 } }), true);
  assert.equal(A.testCondition({ path: 'lead.custom.motivo', op: 'eq', value: 'luna de miel' }, ctx), true);
  assert.equal(A.testCondition({ path: 'client.tags', op: 'contains', value: 'playa' }, ctx), true);
  assert.equal(A.testCondition({ path: 'client.email', op: 'empty', value: '' }, ctx), true);
  assert.equal(A.fill('Hola {nombre}, tu viaje a {destino} {x}', ctx), 'Hola Ana, tu viaje a Cancún {x}');
  assert.equal(A.triggerMatches({ type: 'lead_stage', stage: 'Cotizado' }, { type: 'lead_stage', stage: 'Cotizado' }), true);
  assert.equal(A.triggerMatches({ type: 'lead_stage', stage: 'Cotizado' }, { type: 'lead_stage', stage: 'Vendido' }), false);
  assert.equal(A.triggerMatches({ type: 'payment_received', full: true }, { type: 'payment_received', full: false }), false);
  assert.ok(A.fieldsFor({ type: 'date_field', entity: 'clients', field: 'x' }, { clients: [{ key: 'aniv', label: 'Aniversario', type: 'date' }] }).some((f) => f.path === 'client.custom.aniv'));
  assert.equal(A.EXAMPLES.length, 5);
  A.EXAMPLES.forEach((r) => A.cleanRule(r));
});

test('TP-307: automatizaciones al momento (lead nuevo, etapa, cotización y pago)', async (context) => {
  const ctx = await setup(context);
  assert.equal((await ctx.partner('GET', '/api/automations')).status, 403, 'solo el administrador');
  const first = await ctx.admin('GET', '/api/automations');
  assert.equal(first.body.rules.length, 5, 'reglas de ejemplo');
  assert.ok(first.body.rules.every((r) => !r.active), 'apagadas');
  assert.ok(first.body.templates.some((t) => t.id === 'ci5'));
  await ctx.admin('PUT', '/api/custom-fields', { fields: { leads: [], clients: [{ label: 'Segmento', type: 'select', options: 'VIP, Normal' }], trips: [] } });

  const add = (rule) => ctx.admin('POST', '/api/automations', { active: true, ...rule });
  const vip = await add({ name: 'Presupuesto alto', trigger: { type: 'lead_created' }, conditions: [{ path: 'lead.budget', op: 'gte', value: '80000' }], actions: [{ type: 'notify', to: 'admins', title: '💎 {cliente} · {destino}' }, { type: 'set_stage', stage: 'Calificado' }, { type: 'set_field', target: 'client', key: 'segmento', value: 'VIP' }, { type: 'add_tag', tag: 'Lujo' }] });
  assert.equal(vip.status, 201, JSON.stringify(vip.body));
  await add({ name: 'Calificado → llamar', trigger: { type: 'lead_stage', stage: 'Calificado' }, actions: [{ type: 'followup', ftype: 'Llamada', title: 'Llamar a {nombre} por {destino}', days: 1, time: '11:00' }] });
  await add({ name: 'Rechazada → correo', trigger: { type: 'quote_status', status: 'Rechazada' }, actions: [{ type: 'email_client', subject: 'Tu viaje a {destino}', body: 'Hola {nombre},\n\n¿Ajustamos tu cotización {folio}?' }, { type: 'whatsapp_task', template: 'se1', to: 'owner' }] });
  await add({ name: 'Liquidado', trigger: { type: 'payment_received', full: true }, actions: [{ type: 'notify', to: 'owner', title: 'Liquidó {cliente}: {monto}' }] });

  const lead = (await ctx.partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567', email: 'ana@cliente.test' }, destination: 'Cancún', budget: 120000, travelers: 2 })).body;
  assert.equal(lead.record.stage, 'Calificado', 'la regla cambió la etapa');
  const client = await ctx.store.getRecord('clients', lead.client.id);
  assert.deepEqual(client.custom, { segmento: 'VIP' });
  assert.equal(client.tags, 'Lujo');
  assert.ok(ctx.store.notifications.some((n) => n.kind === 'automation' && n.user_id === ctx.adminId && n.title === '💎 Ana López · Cancún'));
  const fups = (await ctx.store.listRecords('followups')).filter((f) => f.lead_id === lead.record.id);
  assert.equal(fups.length, 1, 'la regla de etapa corrió en cadena');
  assert.equal(fups[0].title, 'Llamar a Ana por Cancún');
  assert.equal(fups[0].due_at, `${addDays(nowCancun().slice(0, 10), 1)} 11:00:00`);
  assert.equal(fups[0].owner_id, ctx.paulinaId);
  assert.equal(fups[0].auto.rule, 'Calificado → llamar');

  const small = (await ctx.partner('POST', '/api/leads', { client: { name: 'Luis Pérez', phone: '998 765 4321' }, destination: 'Tulum', budget: 20000 })).body;
  assert.equal(small.record.stage, 'Nuevo', 'no cumple la condición');

  // Cotización rechazada → correo + tarea de WhatsApp con plantilla
  const q = (await ctx.partner('POST', '/api/quotes', { client_id: lead.client.id, lead_id: lead.record.id, destination: 'Cancún', hotel: 'Riu', price: 30000, status: 'Enviada' })).body.record;
  ctx.sent.length = 0;
  await ctx.partner('PATCH', `/api/quotes/${q.id}`, { status: 'Rechazada' });
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, 'ana@cliente.test');
  assert.match(ctx.sent[0].text, new RegExp(`Hola Ana,\\n\\n¿Ajustamos tu cotización ${q.folio}\\?`));
  const wa = (await ctx.store.listRecords('followups')).find((f) => f.auto?.template === 'se1');
  assert.equal(wa.type, 'WhatsApp');
  assert.equal(wa.auto.quote_id, q.id);
  // Cliente "No contactar": no se le manda correo
  await ctx.partner('PATCH', `/api/clients/${lead.client.id}`, { no_marketing: true });
  await ctx.partner('PATCH', `/api/quotes/${q.id}`, { status: 'Enviada' });
  ctx.sent.length = 0;
  await ctx.partner('PATCH', `/api/quotes/${q.id}`, { status: 'Rechazada' });
  assert.equal(ctx.sent.length, 0);

  // Pago que liquida el viaje
  const q2 = (await ctx.partner('POST', '/api/quotes', { client_id: lead.client.id, lead_id: lead.record.id, destination: 'Cancún', hotel: 'Riu', price: 10000, status: 'Enviada' })).body.record;
  const acc = (await ctx.partner('PATCH', `/api/quotes/${q2.id}`, { status: 'Aceptada' })).body.record;
  await ctx.admin('POST', `/api/quotes/${q2.id}/contract`, { action: 'waive' }).catch(() => {});
  const before = ctx.store.notifications.filter((n) => n.title.startsWith('Liquidó')).length;
  await ctx.partner('POST', `/api/quotes/${q2.id}/payment-plan/${acc.payment_plan.installments[0].id}/pay`, { method: 'Transferencia' });
  assert.equal(ctx.store.notifications.filter((n) => n.title.startsWith('Liquidó')).length, before, 'aún no liquida');
  await ctx.partner('POST', `/api/quotes/${q2.id}/payment-plan/${acc.payment_plan.installments[1].id}/pay`, { method: 'Transferencia' });
  assert.ok(ctx.store.notifications.some((n) => n.title === 'Liquidó Ana López: $7,000' && n.user_id === ctx.paulinaId));

  // Historial, estadísticas y bitácora
  const list = (await ctx.admin('GET', '/api/automations')).body;
  assert.equal(list.stats[vip.body.rule.id].runs, 1);
  assert.ok(list.history.some((h) => h.rule === 'Presupuesto alto' && h.results.some((r) => /Etapa Nuevo → Calificado/.test(r))));
  assert.ok(list.history.some((h) => h.rule === 'Rechazada → correo' && h.results.some((r) => /Omitido: cliente marcado/.test(r))));

  // Apagar y borrar
  const off = await ctx.admin('PUT', `/api/automations/${vip.body.rule.id}`, { ...vip.body.rule, active: false });
  assert.equal(off.body.rule.active, false);
  assert.equal((await ctx.partner('POST', '/api/leads', { client: { name: 'Eva Ruiz', phone: '998 111 2222' }, destination: 'Cabo', budget: 200000 })).body.record.stage, 'Nuevo');
  assert.equal((await ctx.admin('DELETE', `/api/automations/${vip.body.rule.id}`)).status, 200);
});

test('TP-307: automatizaciones por fecha y prueba sin efectos', async (context) => {
  let clock = nowCancun();
  const ctx = await setup(context, { automationsNow: () => clock });
  const today = clock.slice(0, 10);
  await ctx.admin('PUT', '/api/custom-fields', { fields: { leads: [], clients: [{ label: 'Aniversario', type: 'date' }], trips: [] } });
  const add = (rule) => ctx.admin('POST', '/api/automations', { active: true, ...rule });
  await add({ name: 'Viaje en 7 días', trigger: { type: 'trip_before', days: 7 }, actions: [{ type: 'whatsapp_task', template: 'ci5', title: 'Itinerario a {cliente}' }] });
  await add({ name: 'Lead dormido', trigger: { type: 'lead_idle', days: 5 }, conditions: [{ path: 'lead.destination', op: 'contains', value: 'cun' }], actions: [{ type: 'notify', to: 'owner', title: '{cliente} lleva {dias} días sin movimiento' }] });
  await add({ name: 'Aniversario', trigger: { type: 'date_field', entity: 'clients', field: 'aniversario', days: 3, when: 'before', yearly: true }, actions: [{ type: 'followup', ftype: 'WhatsApp', title: 'Felicitar a {nombre} por su aniversario' }] });

  const lead = (await ctx.partner('POST', '/api/leads', { client: { name: 'Ana López', phone: '998 123 4567' }, destination: 'Cancún' })).body;
  await ctx.partner('PATCH', `/api/clients/${lead.client.id}`, { custom: { aniversario: `2010-${addDays(today, 3).slice(5)}` } });
  await ctx.partner('POST', '/api/trips', { client_id: lead.client.id, destination: 'Cancún', start_date: addDays(today, 7), end_date: addDays(today, 12) });
  await ctx.partner('POST', '/api/trips', { client_id: lead.client.id, destination: 'Tulum', start_date: addDays(today, 20), end_date: addDays(today, 22) });

  // Dry-run: no crea nada
  const rules = (await ctx.admin('GET', '/api/automations')).body.rules;
  const dormido = rules.find((r) => r.name === 'Lead dormido');
  const t = await ctx.admin('POST', '/api/automations/test', { rule: dormido, entity: 'leads', id: lead.record.id });
  assert.equal(t.body.matches, true);
  assert.equal(t.body.conditions[0].ok, true);
  assert.match(t.body.actions[0], /Aviso a Paulina/);
  const nFups = (await ctx.store.listRecords('followups')).length;

  const r1 = await ctx.automations.runScheduled({ force: true });
  assert.equal(r1.fired, 2, 'viaje en 7 días y aniversario en 3 días (el lead aún no está dormido)');
  const fups = await ctx.store.listRecords('followups');
  assert.equal(fups.length, nFups + 2);
  assert.ok(fups.some((f) => f.title === 'Itinerario a Ana López' && f.auto.template === 'ci5'));
  assert.ok(fups.some((f) => f.title === 'Felicitar a Ana por su aniversario'));
  assert.equal((await ctx.automations.runScheduled({ force: true })).fired, 0, 'no se repite');

  // 6 días después: el lead ya está dormido (lo último fue hoy)
  clock = `${addDays(today, 6)} 10:00:00`;
  const r2 = await ctx.automations.runScheduled({ force: true });
  assert.equal(r2.fired, 1);
  assert.ok(ctx.store.notifications.some((n) => n.kind === 'automation' && n.title === 'Ana López lleva 6 días sin movimiento'));
  // Fuera de horario no corre (sin force)
  clock = `${addDays(today, 30)} 22:00:00`;
  assert.equal((await ctx.automations.runScheduled({})).fired, 0);
});
