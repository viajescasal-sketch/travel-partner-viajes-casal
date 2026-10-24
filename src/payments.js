'use strict';

// TP-201 / TP-202: plan de pagos de la cotización aceptada, liga de pago para el cliente y recordatorios de saldo.
//  - Al aceptar una cotización se arma el plan (anticipo + parcialidades) con lo que trae la cotización.
//  - El cliente tiene una liga privada /pagar/<token> con su plan, lo que lleva pagado y cómo pagar lo siguiente.
//  - Con Mercado Pago configurado (MP_ACCESS_TOKEN en Hostinger) paga con tarjeta, OXXO o SPEI y el pago se registra solo.
//    Sin Mercado Pago, la liga muestra los datos de transferencia y la liga manual (Clip u otra) que pegue el vendedor.
//  - Recordatorios: N días antes y el día del vencimiento (vendedor + correo al cliente) y aviso si se vence.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ENTITY_ORDER, ValidationError, nowCancun, sanitize } = require('./crm-schema');
const { buildScope, isVisible, canWrite } = require('./access');
const TPContract = require('../public/contrato-core');
const hooks = require('./hooks');

const SETTING = 'payments';
const TOKEN_RE = /^[a-f0-9]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAY_METHODS = ['Transferencia', 'Depósito', 'Tarjeta', 'Efectivo', 'Liga de pago', 'Otro'];
const DEFAULTS = {
  anticipoPct: 30, // anticipo cuando la cotización no lo trae
  anticipoDays: 3, // días para pagar el anticipo
  saldoDaysBefore: 30, // la liquidación vence N días antes de la salida
  reminderDays: 3, // recordatorio N días antes de cada vencimiento
  emailClient: true, // correo al cliente (recordatorio y recibo)
  bank: { banco: '', titular: '', clabe: '', cuenta: '', notas: '' }
};
const BANK_FIELDS = { banco: 60, titular: 120, clabe: 30, cuenta: 30, notas: 400 };

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
// "$8,213.50 MXN" → 8213.5
const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : 0; const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
const money = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const longDate = (iso) => (ISO_DATE.test(String(iso)) ? `${Number(iso.slice(8, 10))} de ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : String(iso || ''));
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const newPayToken = () => crypto.randomBytes(20).toString('hex');

function cleanSettings(saved) {
  const s = { ...DEFAULTS, ...(saved || {}), bank: { ...DEFAULTS.bank, ...(saved?.bank || {}) } };
  const int = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def; };
  s.anticipoPct = int(s.anticipoPct, 1, 100, DEFAULTS.anticipoPct);
  s.anticipoDays = int(s.anticipoDays, 0, 30, DEFAULTS.anticipoDays);
  s.saldoDaysBefore = int(s.saldoDaysBefore, 0, 120, DEFAULTS.saldoDaysBefore);
  s.reminderDays = int(s.reminderDays, 0, 15, DEFAULTS.reminderDays);
  s.emailClient = s.emailClient !== false;
  for (const [k, max] of Object.entries(BANK_FIELDS)) s.bank[k] = plain(s.bank[k], max);
  return { anticipoPct: s.anticipoPct, anticipoDays: s.anticipoDays, saldoDaysBefore: s.saldoDaysBefore, reminderDays: s.reminderDays, emailClient: s.emailClient, bank: s.bank };
}

// ---- Plan ----
function statusOf(inst) {
  const paid = round2(inst.paid || 0);
  if (paid >= round2(inst.amount) - 0.5) return 'pagado';
  return paid > 0 ? 'parcial' : 'pendiente';
}
function recalc(plan) {
  plan.installments.forEach((i) => { i.paid = round2((i.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0)); i.status = statusOf(i); });
  plan.paid = round2(plan.installments.reduce((s, i) => s + i.paid, 0));
  plan.balance = round2(Math.max(0, plan.total - plan.paid));
  plan.status = plan.balance <= 0.5 ? 'pagado' : plan.paid > 0 ? 'parcial' : 'pendiente';
  return plan;
}
const nextPending = (plan) => (plan?.installments || []).find((i) => i.status !== 'pagado') || null;
const newInst = (label, due, amount) => ({ label, due, amount: round2(amount), paid: 0, status: 'pendiente', payments: [], reminders: {}, link_url: '' });

/** Arma el plan con lo que trae la cotización (esquema de pago de la propuesta principal). */
function buildPlan(quote, lead, settings, today) {
  const cfg = cleanSettings(settings);
  let total = round2(num(quote.price));
  if (quote.mode === 'Por persona' && Number(lead?.travelers) > 1) total = round2(total * Number(lead.travelers));
  const proposals = Array.isArray(quote.details?.proposals) ? quote.details.proposals : [];
  const prop = proposals.find((p) => Math.abs(num(p?.price?.total) - num(quote.price)) < 1) || proposals[0] || {};
  const pay = prop.pay || {};
  const start = (ISO_DATE.test(String(lead?.start_date || '')) && lead.start_date) || (ISO_DATE.test(String(quote.details?.startDate || '')) && quote.details.startDate) || null;
  const earliest = addDays(today, 1);
  let saldoDue = start ? addDays(start, -cfg.saldoDaysBefore) : addDays(today, 30);
  if (saldoDue < earliest) saldoDue = start && start > today ? addDays(today, Math.max(1, Math.min(7, daysBetween(today, start) - 1))) : addDays(today, 7);
  const list = [];
  const pagos = (Array.isArray(pay.pagos) ? pay.pagos : []).map((p) => ({ due: ISO_DATE.test(String(p?.fecha || '')) ? p.fecha : null, amount: round2(num(p?.monto)) })).filter((p) => p.amount > 0);
  if (pay.esquema === 'plan' && pagos.length) {
    pagos.forEach((p, i) => list.push(newInst(i === 0 ? 'Anticipo' : i === pagos.length - 1 && pagos.length > 2 ? 'Liquidación' : `Pago ${i + 1}`, p.due || (i === 0 ? addDays(today, cfg.anticipoDays) : saldoDue), p.amount)));
    const sum = round2(list.reduce((s, i) => s + i.amount, 0));
    if (total - sum >= 1) list.push(newInst('Liquidación', saldoDue, total - sum));
    else if (sum > total) total = sum;
  } else {
    let anticipo = round2(num(pay.anticipo)) || Math.round((total * cfg.anticipoPct) / 100);
    anticipo = Math.min(anticipo, total);
    const due = ISO_DATE.test(String(pay.anticipoFecha || '')) ? pay.anticipoFecha : addDays(today, cfg.anticipoDays);
    list.push(newInst('Anticipo', due, anticipo));
    if (total - anticipo >= 1) list.push(newInst('Liquidación', saldoDue > due ? saldoDue : addDays(due, 1), total - anticipo));
  }
  list.sort((a, b) => a.due.localeCompare(b.due));
  list.forEach((inst, i) => { inst.id = `p${i + 1}`; });
  return recalc({ total, currency: 'MXN', created_at: nowCancun(), seq: list.length, installments: list });
}

/** Cambios del vendedor al plan: fechas, montos, conceptos, liga manual. Lo pagado se conserva. */
function editPlan(current, body) {
  const input = Array.isArray(body?.installments) ? body.installments : null;
  if (!input || !input.length) throw new ValidationError('El plan necesita al menos un pago');
  if (input.length > 12) throw new ValidationError('Máximo 12 pagos');
  const total = round2(num(body.total) || current.total);
  if (!(total > 0) || total > 50000000) throw new ValidationError('Escribe el total de la venta');
  let seq = Number(current.seq) || current.installments.length;
  const byId = new Map(current.installments.map((i) => [i.id, i]));
  const kept = new Set();
  const list = input.map((row, idx) => {
    const amount = round2(num(row?.amount));
    const due = String(row?.due || '');
    const label = plain(row?.label, 40) || (idx === 0 ? 'Anticipo' : `Pago ${idx + 1}`);
    if (!ISO_DATE.test(due) || Number.isNaN(Date.parse(due))) throw new ValidationError(`Revisa la fecha de “${label}”`);
    if (!(amount > 0)) throw new ValidationError(`Escribe el monto de “${label}”`);
    const link = plain(row?.link_url, 500);
    if (link && !/^https:\/\/\S+$/i.test(link)) throw new ValidationError('La liga de pago debe empezar con https://');
    const old = row?.id ? byId.get(String(row.id)) : null;
    if (old) {
      kept.add(old.id);
      if (amount < round2(old.paid || 0) - 0.5) throw new ValidationError(`“${label}” ya tiene ${money(old.paid)} pagados; el monto no puede ser menor`);
      const changed = old.due !== due || round2(old.amount) !== amount;
      return { ...old, label, due, amount, link_url: link, reminders: changed ? {} : (old.reminders || {}) };
    }
    seq += 1;
    return { ...newInst(label, due, amount), id: `p${seq}`, link_url: link };
  });
  for (const old of current.installments) {
    if (!kept.has(old.id) && (old.payments || []).length) throw new ValidationError(`“${old.label}” ya tiene pagos registrados y no se puede quitar`);
  }
  const sum = round2(list.reduce((s, i) => s + i.amount, 0));
  if (Math.abs(sum - total) > 1) throw new ValidationError(`Los pagos suman ${money(sum)} y el total es ${money(total)}. Ajusta los montos.`);
  list.sort((a, b) => a.due.localeCompare(b.due));
  return recalc({ ...current, total, seq, installments: list, updated_at: nowCancun() });
}

// Estado del pago para la confirmación del viaje (TP-201: se mantiene al día solo).
function tripPaymentFields(plan) {
  const schedule = plan.installments.filter((i) => i.status !== 'pagado').map((i) => `${i.label}: ${money(i.amount - i.paid)} antes del ${longDate(i.due)}`).join(' · ');
  return {
    paymentStatus: plan.status === 'pagado' ? 'Pagado por completo' : plan.paid > 0 ? 'Pago parcial' : 'Pendiente de pago',
    paymentTotal: String(plan.total),
    paymentPaid: String(plan.paid),
    paymentSchedule: schedule
  };
}

// ---- Mercado Pago (Checkout Pro) ----
function createMercadoPago(env = {}, fetchImpl = globalThis.fetch) {
  const token = String(env.MP_ACCESS_TOKEN || '').trim();
  const secret = String(env.MP_WEBHOOK_SECRET || '').trim();
  const call = async (method, path, body, idem) => {
    const res = await fetchImpl(`https://api.mercadopago.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(idem ? { 'X-Idempotency-Key': idem } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`Mercado Pago respondió ${res.status}: ${data.message || data.error || 'error'}`); e.status = 502; throw e; }
    return data;
  };
  return {
    configured: Boolean(token),
    sandbox: /^TEST-/.test(token),
    createPreference: (body, idem) => call('POST', '/checkout/preferences', body, idem),
    getPayment: (id) => call('GET', `/v1/payments/${encodeURIComponent(id)}`),
    // Firma x-signature (opcional): solo si se configuró MP_WEBHOOK_SECRET.
    verifySignature(req, dataId) {
      if (!secret) return true;
      const header = String(req.get('x-signature') || '');
      const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
      if (!parts.ts || !parts.v1) return false;
      const manifest = `id:${String(dataId).toLowerCase()};request-id:${req.get('x-request-id') || ''};ts:${parts.ts};`;
      const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
    }
  };
}

const DEFAULT_AGENCY = { name: 'Viajes Bumeran Casal', whatsapp: '+52 998 763 6565', email: 'casal@viajesbumeran.com', website: 'https://viajescasal.com/' };

function createPayments(dataStore, { assignment = null, mailer = null, env = {}, mercadoPago = null, publicDirectory = null, contracts = null, now = () => nowCancun() } = {}) {
  const mp = mercadoPago || createMercadoPago(env);
  const appUrl = (req) => String(env.APP_URL || '').trim().replace(/\/+$/, '') || (req ? `${req.protocol}://${req.get('host')}` : 'https://travelpartner.viajescasal.com');
  const settings = async () => cleanSettings(await dataStore.getSetting(SETTING));
  const payUrl = (quote, req) => (quote.pay_token ? `${appUrl(req)}/pagar/${quote.pay_token}` : null);

  // Un cambio a la vez por cotización (el webhook y el vendedor pueden llegar juntos).
  const queues = new Map();
  function serial(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function syncTrips(quote, plan) {
    const trips = (await dataStore.listRecords('trips')).filter((t) => t.quote_id === quote.id);
    for (const t of trips) {
      if (!t.confirmation) continue; // sin confirmación guardada, el documento toma el plan al armarse
      const confirmation = { ...(t.confirmation || {}), ...tripPaymentFields(plan) };
      await dataStore.updateRecord('trips', t.id, { confirmation });
    }
  }

  /** Crea el plan si la cotización está aceptada y aún no tiene uno. */
  async function ensurePlan(quote, { force = false } = {}) {
    if (!quote || quote.status !== 'Aceptada') return quote;
    if (quote.payment_plan && !force) return quote;
    if (quote.payment_plan && force && quote.payment_plan.paid > 0) throw new ValidationError('El plan ya tiene pagos; edítalo en lugar de volver a armarlo');
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const plan = buildPlan(quote, lead, await settings(), now().slice(0, 10));
    let updated = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan, pay_token: quote.pay_token || newPayToken() });
    await syncTrips(updated, plan);
    // TP-204: contrato pendiente de firma antes del anticipo.
    if (contracts) updated = await contracts.requireFor(updated);
    return updated;
  }

  async function teamFor(quote, client) {
    const users = await dataStore.listUsers();
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const seller = users.find((u) => u.id === (lead?.owner_id ?? quote.owner_id) && u.active) || null;
    const admins = users.filter((u) => u.active && u.role === 'admin');
    return { lead, seller, admins, users, ownerIds: new Set([lead?.owner_id, quote.owner_id, client?.owner_id].filter(Boolean)) };
  }

  function clientEmail({ client, quote, seller, agency, subject, intro, rows, button, outro }) {
    const first = String(client.name || '').trim().split(/\s+/)[0] || '';
    const sign = [seller?.name, agency.name].filter(Boolean).join(' · ');
    const text = `Hola ${first},\n\n${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${button ? `${button.label}: ${button.url}\n\n` : ''}${outro ? `${outro}\n\n` : ''}${sign}\n${agency.whatsapp ? `WhatsApp ${agency.whatsapp}` : ''}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px">
<p style="font-size:15px">Hola ${escapeHtml(first)},</p><p style="font-size:15px">${escapeHtml(intro)}</p>
<table style="font-size:14px;border-collapse:collapse;margin:8px 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5b6b78">${escapeHtml(k)}</td><td style="padding:4px 0"><b>${escapeHtml(v)}</b></td></tr>`).join('')}</table>
${button ? `<p><a href="${escapeHtml(button.url)}" style="background:#00b8c8;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">${escapeHtml(button.label)}</a></p>` : ''}
${outro ? `<p style="font-size:14px">${escapeHtml(outro)}</p>` : ''}
<p style="font-size:13px;color:#5b6b78;margin-top:22px">${escapeHtml(sign)}${agency.whatsapp ? `<br>WhatsApp ${escapeHtml(agency.whatsapp)}` : ''}</p></div>`;
    return { to: client.email, subject: subject.slice(0, 180), text, html, _ref: quote.folio };
  }
  async function sendClientMail(mail) {
    if (!mailer?.configured || !mail.to) return false;
    const { _ref, ...rest } = mail;
    try { await mailer.send(rest); return true; } catch (error) { console.error(`Correo al cliente (${_ref}) no enviado:`, error.message); return false; }
  }
  const agencyInfo = async () => ({ ...DEFAULT_AGENCY, ...((await dataStore.getSetting('agency')) || {}) });

  /**
   * Registra un pago en una parcialidad: ficha 360, plan, confirmación del viaje, avisos y recibo al cliente.
   * opts: { amount, method, userId, providerId, provider, date, note, req }
   */
  function recordPayment(quoteId, instId, opts) {
    return serial(`q${quoteId}`, async () => {
      const quote = await dataStore.getRecord('quotes', quoteId);
      if (!quote?.payment_plan) throw new ValidationError('La cotización no tiene plan de pagos');
      const plan = recalc(JSON.parse(JSON.stringify(quote.payment_plan)));
      const inst = plan.installments.find((i) => i.id === instId);
      if (!inst) throw new ValidationError('Ese pago no existe en el plan');
      if (opts.providerId && plan.installments.some((i) => (i.payments || []).some((p) => p.provider_id === String(opts.providerId)))) return { quote, plan, duplicate: true };
      const amount = round2(opts.amount ?? inst.amount - inst.paid);
      if (!(amount > 0) || amount > 50000000) throw new ValidationError('Escribe el monto del pago');
      const client = await dataStore.getRecord('clients', quote.client_id);
      const team = await teamFor(quote, client);
      const at = opts.date ? `${opts.date} ${now().slice(11, 19)}` : now();
      const method = PAY_METHODS.includes(opts.method) ? opts.method : 'Otro';
      const event = await dataStore.insertClientEvent({
        client_id: quote.client_id, lead_id: quote.lead_id || null, quote_id: quote.id, type: 'payment', amount,
        title: (plain(opts.title, 80) ? `${plain(opts.title, 80)} · ${quote.folio}` : `${inst.label} · ${quote.folio}`).slice(0, 120), body: plain(opts.note, 1000) || null,
        meta: { method, installment: inst.id, ...(opts.provider ? { provider: opts.provider, providerId: String(opts.providerId) } : {}) },
        event_at: at, created_by: opts.userId ?? null
      });
      inst.payments = [...(inst.payments || []), { amount, at, method, event_id: event?.id ?? null, by: opts.userId ?? null, ...(opts.provider ? { provider: opts.provider, provider_id: String(opts.providerId) } : {}) }];
      delete inst.pending;
      recalc(plan);
      const updated = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
      await syncTrips(updated, plan);
      const auto = Boolean(opts.provider);
      await dataStore.logActivity(opts.userId ?? null, 'crm_quotes_update', opts.req || null, { entity: 'quotes', entityId: quote.id, summary: `${quote.folio} · ${client?.name || ''}`, note: `${auto ? 'Pago recibido por Mercado Pago' : 'Pago registrado'}: ${inst.label} ${money(amount)} (${method}) · saldo ${money(plan.balance)}` });
      // Avisos: vendedor del cliente y administradores (menos quien lo registró).
      if (assignment) {
        const ids = new Set([...team.ownerIds, ...team.admins.map((u) => u.id)]);
        if (opts.userId) ids.delete(opts.userId);
        for (const id of ids) {
          const u = team.users.find((x) => x.id === id && x.active);
          if (u) await assignment.notify(u, { kind: 'payment', leadId: quote.lead_id || null, link: `payplan:${quote.id}`, title: `💰 ${auto ? 'Pago en línea' : 'Pago recibido'}: ${money(amount)} de ${client?.name || 'cliente'}`, body: `${inst.label} · ${quote.folio} · ${plan.balance > 0.5 ? `saldo ${money(plan.balance)}` : 'viaje liquidado ✅'}` });
        }
      }
      // Recibo al cliente
      const cfg = await settings();
      if (cfg.emailClient && client?.email) {
        const agency = await agencyInfo();
        const next = nextPending(plan);
        await sendClientMail(clientEmail({
          client, quote, seller: team.seller, agency,
          subject: `Recibimos tu pago · ${quote.destination}`,
          intro: `¡Gracias! Recibimos tu pago para tu viaje a ${quote.destination}.`,
          rows: [['Concepto', `${inst.label} · ${quote.folio}`], ['Monto', `${money(amount)} MXN`], ['Pagado a la fecha', `${money(plan.paid)} de ${money(plan.total)}`], ['Saldo', plan.balance > 0.5 ? `${money(plan.balance)} MXN` : 'Liquidado ✅'], ...(next ? [['Siguiente pago', `${next.label}: ${money(next.amount - next.paid)} antes del ${longDate(next.due)}`]] : [])],
          button: plan.balance > 0.5 && updated.pay_token ? { label: 'Ver mi plan de pagos', url: payUrl(updated) } : null
        }));
      }
      await hooks.emit(dataStore, 'paymentReceived', { quote: updated, plan, amount, installment: inst, auto }); // TP-307
      return { quote: updated, plan, event };
    });
  }

  /** Quita el último pago de una parcialidad (solo administrador). */
  function undoPayment(quoteId, instId, { userId, req }) {
    return serial(`q${quoteId}`, async () => {
      const quote = await dataStore.getRecord('quotes', quoteId);
      const plan = quote?.payment_plan ? recalc(JSON.parse(JSON.stringify(quote.payment_plan))) : null;
      const inst = plan?.installments.find((i) => i.id === instId);
      if (!inst || !(inst.payments || []).length) throw new ValidationError('Ese pago no tiene registros');
      const last = inst.payments.pop();
      if (last.event_id) await dataStore.deleteClientEvent(last.event_id).catch(() => {});
      recalc(plan);
      const updated = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
      await syncTrips(updated, plan);
      await dataStore.logActivity(userId, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: `Pago deshecho: ${inst.label} ${money(last.amount)}` });
      return { quote: updated, plan };
    });
  }

  /**
   * Mantiene el plan de pagos igual que la ficha 360 cuando un pago se corrige o se elimina.
   * Busca el pago por event_id en la cotización del registro; si no está en ningún plan no hace nada.
   */
  function syncEventToPlan(event, { remove = false, userId = null, req = null } = {}) {
    if (!event?.quote_id) return Promise.resolve(null);
    return serial(`q${event.quote_id}`, async () => {
      const quote = await dataStore.getRecord('quotes', event.quote_id);
      if (!quote?.payment_plan) return null;
      const plan = recalc(JSON.parse(JSON.stringify(quote.payment_plan)));
      let hit = null;
      for (const inst of plan.installments) {
        const idx = (inst.payments || []).findIndex((p) => p.event_id != null && Number(p.event_id) === Number(event.id));
        if (idx < 0) continue;
        hit = { inst, before: inst.payments[idx] };
        if (remove) inst.payments.splice(idx, 1);
        else inst.payments[idx] = { ...inst.payments[idx], amount: round2(event.amount), method: event.meta?.method || inst.payments[idx].method, at: event.event_at || inst.payments[idx].at, edited_at: now() };
      }
      if (!hit) return null;
      recalc(plan);
      const updated = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
      await syncTrips(updated, plan);
      await dataStore.logActivity(userId, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: remove ? `Pago quitado del plan: ${hit.inst.label} ${money(hit.before.amount)} · saldo ${money(plan.balance)}` : `Pago corregido en el plan: ${hit.inst.label} ${money(hit.before.amount)} → ${money(event.amount)} · saldo ${money(plan.balance)}` });
      return updated;
    });
  }

  /** Limpieza: quita del plan los pagos cuyo registro ya se borró de la ficha 360 (antes no se sincronizaba). */
  async function reconcileDeletedPayments() {
    if (!dataStore.listAllClientEvents) return 0;
    const ids = new Set((await dataStore.listAllClientEvents()).filter((e) => e.type === 'payment').map((e) => Number(e.id)));
    let fixed = 0;
    for (const q of (await dataStore.listRecords('quotes')).filter((x) => x.payment_plan)) {
      await serial(`q${q.id}`, async () => {
        const quote = await dataStore.getRecord('quotes', q.id);
        if (!quote?.payment_plan) return;
        const plan = recalc(JSON.parse(JSON.stringify(quote.payment_plan)));
        const gone = [];
        plan.installments.forEach((inst) => { inst.payments = (inst.payments || []).filter((p) => { const keep = p.event_id == null || ids.has(Number(p.event_id)); if (!keep) gone.push(`${inst.label} ${money(p.amount)}`); return keep; }); });
        if (!gone.length) return;
        recalc(plan);
        const updated = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
        await syncTrips(updated, plan);
        await dataStore.logActivity(null, 'crm_quotes_update', null, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: `Plan sincronizado con la ficha: se quitaron pagos eliminados (${gone.join(', ')}) · saldo ${money(plan.balance)}` });
        fixed += gone.length;
      });
    }
    return fixed;
  }

  // ---- Mercado Pago: confirmar un pago (webhook o regreso del cliente) ----
  async function processMpPayment(paymentId) {
    if (!mp.configured || !paymentId) return { ok: false };
    const payment = await mp.getPayment(paymentId);
    const m = /^tp-q(\d+)-(p\d+)$/.exec(String(payment.external_reference || ''));
    if (!m) return { ok: false, reason: 'ajeno' };
    const quoteId = Number(m[1]), instId = m[2];
    if (payment.status === 'approved') {
      if (payment.currency_id && payment.currency_id !== 'MXN') return { ok: false, reason: 'moneda' };
      const date = String(payment.date_approved || '');
      const cancun = date ? new Date(Date.parse(date) - 5 * 3600000).toISOString().slice(0, 10) : null;
      const r = await recordPayment(quoteId, instId, { amount: Number(payment.transaction_amount), method: 'Liga de pago', provider: 'mercadopago', providerId: payment.id, date: cancun && cancun <= now().slice(0, 10) ? cancun : null, note: `Mercado Pago #${payment.id}${payment.payment_method_id ? ` · ${payment.payment_method_id}` : ''}` });
      return { ok: true, status: 'approved', duplicate: Boolean(r.duplicate), quoteId };
    }
    if (['pending', 'in_process', 'authorized'].includes(payment.status)) {
      await serial(`q${quoteId}`, async () => {
        const quote = await dataStore.getRecord('quotes', quoteId);
        const inst = quote?.payment_plan?.installments?.find((i) => i.id === instId);
        if (!inst || inst.pending?.id === String(payment.id)) return;
        inst.pending = { id: String(payment.id), status: payment.status, method: payment.payment_method_id || null, at: now() };
        await dataStore.updateRecord('quotes', quoteId, { payment_plan: quote.payment_plan });
      });
    }
    return { ok: true, status: payment.status, quoteId };
  }

  async function findByToken(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const quote = (await dataStore.listRecords('quotes')).find((q) => q.pay_token && q.pay_token.length === token.length && crypto.timingSafeEqual(Buffer.from(q.pay_token), Buffer.from(token)));
    if (!quote || quote.status !== 'Aceptada' || !quote.payment_plan) return null;
    return quote;
  }

  async function publicPayload(quote) {
    const client = await dataStore.getRecord('clients', quote.client_id);
    const lead = quote.lead_id ? await dataStore.getRecord('leads', quote.lead_id) : null;
    const seller = await dataStore.findUserById(lead?.owner_id ?? quote.owner_id);
    const cfg = await settings();
    const plan = recalc(JSON.parse(JSON.stringify(quote.payment_plan)));
    const bank = Object.fromEntries(Object.entries(cfg.bank).filter(([, v]) => v));
    return {
      ok: true,
      agency: await agencyInfo(),
      seller: seller ? { name: seller.name, whatsapp: seller.phone || null } : null,
      client: { firstName: String(client?.name || '').trim().split(/\s+/)[0] || '' },
      quote: { folio: quote.folio, destination: quote.destination, hotel: quote.hotel, start_date: lead?.start_date || quote.details?.startDate || null, end_date: lead?.end_date || quote.details?.endDate || null },
      plan: {
        total: plan.total, paid: plan.paid, balance: plan.balance, status: plan.status,
        installments: plan.installments.map((i) => ({ id: i.id, label: i.label, due: i.due, amount: i.amount, paid: i.paid, status: i.status, link_url: i.link_url || null, pending: i.pending ? i.pending.status : null }))
      },
      methods: { mercadoPago: mp.configured, bank: Object.keys(bank).length ? bank : null },
      // TP-204: si falta firmar el contrato, la liga pide firmarlo antes de pagar.
      contract: { state: TPContract.state(quote), url: TPContract.state(quote) === 'none' ? null : `/contrato/${quote.pay_token}` },
      today: now().slice(0, 10)
    };
  }

  // ---- Rutas públicas (sin sesión) ----
  const publicRouter = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const hookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });

  publicRouter.get('/pagar/:token', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      if (!quote) { res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Liga no disponible</title><body style="font-family:Arial;padding:40px;text-align:center;color:#203342"><h2>Esta liga de pago ya no está disponible</h2><p>Pide a tu Travel Partner una liga nueva.</p></body>'); return; }
      res.sendFile('pagar.html', { root: publicDirectory });
    } catch (error) { next(error); }
  });

  publicRouter.get('/api/public/pay/:token', limiter, async (req, res, next) => {
    try {
      let quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Esta liga de pago ya no está disponible' }); return; }
      // Regreso desde Mercado Pago: confirmar el pago de inmediato (por si el aviso de Mercado Pago tarda).
      let returned = null;
      const paymentId = String(req.query.payment_id || req.query.collection_id || '');
      if (/^\d{1,20}$/.test(paymentId) && mp.configured) {
        try { returned = await processMpPayment(paymentId); quote = await dataStore.getRecord('quotes', quote.id); } catch (error) { console.error('Mercado Pago (regreso):', error.message); }
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ...(await publicPayload(quote)), returned: returned && returned.quoteId === quote.id ? returned.status : null });
    } catch (error) { next(error); }
  });

  publicRouter.post('/api/public/pay/:token/checkout', limiter, async (req, res, next) => {
    try {
      const quote = await findByToken(req.params.token);
      if (!quote) { res.status(404).json({ ok: false, error: 'Esta liga de pago ya no está disponible' }); return; }
      if (!mp.configured) { res.status(400).json({ ok: false, error: 'El pago en línea no está disponible. Usa los datos de transferencia.' }); return; }
      const result = await serial(`q${quote.id}`, async () => {
        const fresh = await dataStore.getRecord('quotes', quote.id);
        if (TPContract.pending(fresh)) throw new ValidationError('Primero firma tu contrato para poder pagar');
        const plan = recalc(fresh.payment_plan);
        const inst = plan.installments.find((i) => i.id === String(req.body?.installment || '')) || nextPending(plan);
        if (!inst || inst.status === 'pagado') throw new ValidationError('Ese pago ya está cubierto');
        const amount = round2(inst.amount - inst.paid);
        if (inst.mp?.url && round2(inst.mp.amount) === amount) return inst.mp.url;
        const client = await dataStore.getRecord('clients', fresh.client_id);
        const agency = await agencyInfo();
        const back = `${appUrl(req)}/pagar/${fresh.pay_token}`;
        const pref = await mp.createPreference({
          items: [{ id: `${fresh.folio}-${inst.id}`, title: `${inst.label} · Viaje a ${fresh.destination} (${fresh.folio})`.slice(0, 250), quantity: 1, unit_price: amount, currency_id: 'MXN' }],
          external_reference: `tp-q${fresh.id}-${inst.id}`,
          notification_url: `${appUrl(req)}/api/public/payments/mercadopago`,
          back_urls: { success: back, pending: back, failure: back },
          auto_return: 'approved',
          statement_descriptor: String(agency.name || 'VIAJES CASAL').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 22),
          ...(client?.email ? { payer: { email: client.email } } : {}),
          metadata: { quote_id: fresh.id, installment: inst.id }
        }, `tp-q${fresh.id}-${inst.id}-${Math.round(amount * 100)}`);
        const url = mp.sandbox ? pref.sandbox_init_point || pref.init_point : pref.init_point;
        if (!url) throw Object.assign(new Error('Mercado Pago no devolvió la liga'), { status: 502 });
        inst.mp = { id: pref.id, url, amount, created_at: now() };
        await dataStore.updateRecord('quotes', fresh.id, { payment_plan: plan });
        return url;
      });
      res.json({ ok: true, url: result });
    } catch (error) {
      if (error.status === 502) { console.error(error.message); res.status(502).json({ ok: false, error: 'No pudimos abrir Mercado Pago. Intenta de nuevo en un momento o usa transferencia.' }); return; }
      next(error);
    }
  });

  // Aviso de Mercado Pago (webhook). Siempre se consulta el pago a Mercado Pago con nuestra clave.
  publicRouter.post('/api/public/payments/mercadopago', hookLimiter, async (req, res) => {
    const type = String(req.query.type || req.query.topic || req.body?.type || req.body?.topic || '');
    const id = String(req.query['data.id'] || req.body?.data?.id || (type === 'payment' ? req.query.id || '' : ''));
    if (!mp.configured) { res.status(200).json({ ok: true, ignored: 'no configurado' }); return; }
    if (type !== 'payment' || !/^\d{1,20}$/.test(id)) { res.status(200).json({ ok: true, ignored: true }); return; }
    if (!mp.verifySignature(req, id)) { res.status(401).json({ ok: false }); return; }
    try {
      const r = await processMpPayment(id);
      res.status(200).json({ ok: true, status: r.status || null });
    } catch (error) {
      console.error('Mercado Pago (aviso):', error.message);
      res.status(500).json({ ok: false }); // Mercado Pago lo reintenta
    }
  });

  // ---- Rutas con sesión ----
  const apiRouter = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const parseId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new ValidationError('Identificador inválido'); return n; };
  async function visibleQuote(req, { write = true } = {}) {
    const user = req.session.user;
    if (write && !canWrite(user, 'quotes')) throw Object.assign(new Error('Tu rol no permite esta acción'), { status: 403, expose: true });
    const data = {};
    for (const name of ENTITY_ORDER) data[name] = await dataStore.listRecords(name);
    const id = parseId(req.params.id);
    const quote = data.quotes.find((q) => q.id === id);
    if (!quote || !isVisible(buildScope(user, data), 'quotes', id)) throw Object.assign(new Error('No se encontró la cotización'), { status: 404, expose: true });
    return quote;
  }
  const out = (quote, req) => ({ ok: true, record: quote, plan: quote.payment_plan ? recalc(quote.payment_plan) : null, url: payUrl(quote, req) });

  apiRouter.get('/payments/settings', wrap(async (req, res) => {
    res.json({ ok: true, ...(await settings()), mercadoPago: { configured: mp.configured, sandbox: mp.sandbox, webhook: `${appUrl(req)}/api/public/payments/mercadopago` } });
  }));
  apiRouter.put('/payments/settings', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw Object.assign(new Error('Acceso no autorizado'), { status: 403, expose: true });
    const b = req.body || {};
    const clabe = plain(b.bank?.clabe, 30).replace(/\s/g, '');
    if (clabe && !/^\d{18}$/.test(clabe)) throw new ValidationError('La CLABE debe tener 18 dígitos');
    const saved = cleanSettings({ ...b, bank: { ...(b.bank || {}), clabe } });
    await dataStore.setSetting(SETTING, saved);
    await dataStore.logActivity(req.session.user.id, 'crm_settings_update', req, { note: `Cobros: anticipo ${saved.anticipoPct}% · recordatorio ${saved.reminderDays} días antes · correo al cliente ${saved.emailClient ? 'sí' : 'no'}` });
    res.json({ ok: true, ...saved });
  }));

  apiRouter.post('/quotes/:id/payment-plan', wrap(async (req, res) => {
    const quote = await visibleQuote(req);
    if (quote.status !== 'Aceptada') throw new ValidationError('El plan de pagos se arma cuando la cotización está Aceptada');
    const updated = await serial(`q${quote.id}`, () => ensurePlan(quote, { force: Boolean(req.body?.rebuild) }));
    await dataStore.logActivity(req.session.user.id, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: req.body?.rebuild ? 'Plan de pagos rearmado desde la cotización' : 'Plan de pagos creado' });
    res.json(out(updated, req));
  }));

  apiRouter.put('/quotes/:id/payment-plan', wrap(async (req, res) => {
    const quote = await visibleQuote(req);
    if (!quote.payment_plan) throw new ValidationError('Primero arma el plan de pagos');
    const updated = await serial(`q${quote.id}`, async () => {
      const fresh = await dataStore.getRecord('quotes', quote.id);
      const plan = editPlan(recalc(fresh.payment_plan), req.body || {});
      const saved = await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
      await syncTrips(saved, plan);
      return saved;
    });
    await dataStore.logActivity(req.session.user.id, 'crm_quotes_update', req, { entity: 'quotes', entityId: quote.id, summary: quote.folio, note: `Plan de pagos actualizado: ${updated.payment_plan.installments.map((i) => `${i.label} ${money(i.amount)} (${i.due})`).join(', ')}` });
    res.json(out(updated, req));
  }));

  apiRouter.post('/quotes/:id/payment-plan/:inst/pay', wrap(async (req, res) => {
    const quote = await visibleQuote(req);
    const b = req.body || {};
    if (b.date !== undefined && b.date !== null && b.date !== '') {
      if (!ISO_DATE.test(String(b.date))) throw new ValidationError('Fecha inválida');
      if (String(b.date) > now().slice(0, 10)) throw new ValidationError('La fecha no puede ser futura');
    }
    const r = await recordPayment(quote.id, String(req.params.inst), { amount: b.amount === undefined || b.amount === '' ? undefined : num(b.amount), method: b.method, date: b.date || null, note: b.note, userId: req.session.user.id, req });
    res.status(201).json(out(r.quote, req));
  }));

  apiRouter.post('/quotes/:id/payment-plan/:inst/undo', wrap(async (req, res) => {
    if (req.session.user.role !== 'admin') throw Object.assign(new Error('Solo el administrador puede deshacer pagos'), { status: 403, expose: true });
    const quote = await visibleQuote(req);
    const r = await undoPayment(quote.id, String(req.params.inst), { userId: req.session.user.id, req });
    res.json(out(r.quote, req));
  }));

  // ---- TP-202: recordatorios de saldo (los llama el motor de recordatorios cada 5 minutos) ----
  async function runReminders({ workStart = '09:00', workEnd = '20:00', email = true } = {}) {
    const current = now();
    const today = current.slice(0, 10);
    const hhmm = current.slice(11, 16);
    const result = { before: 0, due: 0, overdue: 0, emails: 0 };
    if (hhmm < workStart || hhmm >= workEnd) return result; // solo en horario laboral
    const cfg = await settings();
    const quotes = (await dataStore.listRecords('quotes')).filter((q) => q.status === 'Aceptada' && q.payment_plan);
    if (!quotes.length) return result;
    const followups = await dataStore.listRecords('followups');
    const agency = await agencyInfo();
    for (const q of quotes) {
      await serial(`q${q.id}`, async () => {
        const quote = await dataStore.getRecord('quotes', q.id);
        if (!quote?.payment_plan || quote.status !== 'Aceptada') return;
        const plan = recalc(quote.payment_plan);
        const client = await dataStore.getRecord('clients', quote.client_id);
        let team = null;
        let changed = false;
        for (const inst of plan.installments) {
          if (inst.status === 'pagado') continue;
          const left = daysBetween(today, inst.due);
          const stage = left < 0 ? 'overdue' : left === 0 ? 'due' : left <= cfg.reminderDays ? 'before' : null;
          inst.reminders = inst.reminders || {};
          if (!stage || inst.reminders[stage]) continue;
          // Un plan recién armado no recuerda el mismo día (el cliente acaba de aceptar).
          if (stage === 'before' && String(plan.created_at).slice(0, 10) === today) continue;
          if (stage === 'before' && (inst.reminders.due || inst.reminders.overdue)) continue;
          team = team || await teamFor(quote, client);
          const amountLeft = round2(inst.amount - inst.paid);
          const when = stage === 'overdue' ? `venció el ${longDate(inst.due)}` : stage === 'due' ? 'vence hoy' : `vence en ${left} ${left === 1 ? 'día' : 'días'} (${longDate(inst.due)})`;
          const seller = team.seller || team.admins[0] || null;
          const lines = [`Cliente: ${client?.name || '—'}${client?.phone ? ` · WhatsApp ${client.phone}` : ''}`, `${inst.label} de ${quote.folio}: ${money(amountLeft)} · ${when}`, `Pagado: ${money(plan.paid)} de ${money(plan.total)}`, 'Abre el plan de pagos y toca “Recordar por WhatsApp”: el mensaje ya lleva la liga de pago.'];
          const mail = (to, title) => (email && to?.email ? { subject: title.slice(0, 180), text: `Hola ${to.name},\n\n${title}\n\n${lines.map((l) => `• ${l}`).join('\n')}\n\nAbrir la plataforma: ${appUrl()}\n\n— Travel Partner Viajes Casal`, html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#203342;max-width:560px"><p>Hola ${escapeHtml(to.name)},</p><p><b>${escapeHtml(title)}</b></p><ul style="line-height:1.6">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul><p><a href="${escapeHtml(appUrl())}" style="background:#00b8c8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir la plataforma</a></p></div>` } : null);
          if (assignment) {
            const title = stage === 'overdue' ? `⚠ Pago vencido: ${client?.name || 'cliente'} · ${money(amountLeft)}` : `💳 Cobrar ${inst.label.toLowerCase()}: ${client?.name || 'cliente'} · ${money(amountLeft)}`;
            const body = `${quote.folio} · ${quote.destination} · ${when}`;
            const recipients = stage === 'overdue' ? [seller, ...team.admins.filter((a) => a.id !== seller?.id)] : [seller];
            for (const u of recipients.filter(Boolean)) await assignment.notify(u, { kind: stage === 'overdue' ? 'payment_overdue' : 'payment_due', leadId: quote.lead_id || null, link: `payplan:${quote.id}`, title: title.slice(0, 200), body, email: mail(u, title) });
          }
          // Seguimiento "Pago" en el calendario del vendedor (una vez por parcialidad).
          if (stage !== 'overdue') {
            const title = `Cobrar ${inst.label.toLowerCase()} · ${client?.name || 'cliente'} · ${money(amountLeft)}`.slice(0, 160);
            const exists = followups.some((f) => !f.done && f.type === 'Pago' && f.client_id === quote.client_id && f.title === title);
            if (!exists) {
              const f = await dataStore.insertRecord('followups', sanitize('followups', { client_id: quote.client_id, lead_id: quote.lead_id || null, type: 'Pago', title, details: `${inst.label} de ${quote.folio} (${quote.destination}) vence el ${longDate(inst.due)}. Envía el recordatorio por WhatsApp con la liga de pago.`.slice(0, 2000), due_at: `${inst.due} ${workStart}` }), seller?.id ?? null);
              followups.push(f);
            }
          }
          // Correo al cliente (antes y el día del vencimiento).
          if (stage !== 'overdue' && cfg.emailClient && client?.email) {
            const sent = await sendClientMail(clientEmail({
              client, quote, seller: team.seller, agency,
              subject: stage === 'due' ? `Hoy vence tu pago · viaje a ${quote.destination}` : `Recordatorio de pago · viaje a ${quote.destination}`,
              intro: stage === 'due' ? `Te recordamos que hoy vence tu pago para tu viaje a ${quote.destination}.` : `Te recordamos que tu próximo pago para tu viaje a ${quote.destination} ${when}.`,
              rows: [['Concepto', `${inst.label} · ${quote.folio}`], ['Monto', `${money(amountLeft)} MXN`], ['Fecha límite', longDate(inst.due)], ['Pagado a la fecha', `${money(plan.paid)} de ${money(plan.total)}`]],
              button: quote.pay_token ? { label: 'Pagar ahora', url: payUrl(quote) } : null,
              outro: 'Si ya realizaste tu pago, ignora este mensaje o envíanos tu comprobante por WhatsApp. ¡Gracias!'
            }));
            if (sent) result.emails += 1;
          }
          inst.reminders[stage] = current;
          result[stage] += 1;
          changed = true;
        }
        if (changed) await dataStore.updateRecord('quotes', quote.id, { payment_plan: plan });
      });
    }
    return result;
  }

  return { publicRouter, apiRouter, ensurePlan, recordPayment, syncEventToPlan, reconcileDeletedPayments, processMpPayment, runReminders, settings, mercadoPago: mp };
}

module.exports = { createPayments, createMercadoPago, buildPlan, editPlan, recalc, cleanSettings, tripPaymentFields, num, PAY_METHODS, DEFAULTS };
