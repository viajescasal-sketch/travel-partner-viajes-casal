'use strict';

// Alta automática de leads (bot de WhatsApp y formulario web):
// busca o crea al cliente, actualiza su lead abierto o crea uno nuevo y deja un seguimiento a 15 minutos.

const { nowCancun, sanitize } = require('./crm-schema');
const { SELLER_ROLES } = require('./access');
const { summaryFor, diffChanges } = require('./audit');
const { DEFAULT_LEAD_QUESTIONS, normalizeQuestions, scoreQualification } = require('./documents');

const CLOSED = ['Vendido', 'Perdido'];
const FOLLOWUP_MINUTES = 15;

const addMinutes = (stamp, minutes) => {
  const d = new Date(`${stamp.replace(' ', 'T')}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

function createLeadIntake(dataStore) {
  async function questions() {
    const saved = await dataStore.getSetting('lead_questions');
    return normalizeQuestions(Array.isArray(saved) ? saved : DEFAULT_LEAD_QUESTIONS);
  }

  // Vendedor que recibe los leads: el configurado o el primer vendedor activo.
  async function defaultOwner(ownerId) {
    const users = await dataStore.listUsers();
    const chosen = users.find((u) => u.id === Number(ownerId) && u.active && SELLER_ROLES.includes(u.role));
    return chosen || users.find((u) => u.active && u.role === 'travel_partner') || users.find((u) => u.active && u.role === 'admin');
  }

  const log = (action, metadata) => dataStore.logActivity(null, action, null, metadata);

  /**
   * channel: { label: 'bot de WhatsApp', source: 'WhatsApp', ownerId }
   * person:  { name, phone, email }
   * lead:    { destination, start, end, travelers, budget }
   * answers: { q_presupuesto: 'Más de $25 mil', ... } (etiquetas de las preguntas de calificación)
   */
  async function intake({ channel, person, lead: data, answers = {}, notes, followupDetails = '' }) {
    const now = nowCancun();
    const qs = await questions();
    const owner = await defaultOwner(channel.ownerId);
    const label = channel.label;

    // Cliente: por WhatsApp y, si no, por correo.
    let client = person.phone ? await dataStore.findClientByPhone(person.phone) : null;
    if (!client && person.email) {
      const email = person.email.toLowerCase();
      client = (await dataStore.listRecords('clients')).find((c) => String(c.email || '').toLowerCase() === email) || null;
    }
    let createdClient = false;
    if (!client) {
      client = await dataStore.insertRecord('clients', sanitize('clients', { name: person.name, phone: person.phone || null, email: person.email || null }), owner?.id ?? null);
      createdClient = true;
      await log('crm_clients_create', { entity: 'clients', entityId: client.id, summary: client.name, note: capital(label) });
    } else {
      const fill = {};
      if (!client.phone && person.phone) fill.phone = person.phone;
      if (!client.email && person.email) fill.email = person.email;
      if (Object.keys(fill).length) client = await dataStore.updateRecord('clients', client.id, fill);
    }

    const open = (await dataStore.listRecords('leads'))
      .filter((l) => l.client_id === client.id && !CLOSED.includes(l.stage))
      .sort((a, b) => b.id - a.id)[0] || null;
    const all = { clients: [client], leads: open ? [open] : [] };
    const find = (entity, id) => (all[entity] || []).find((r) => r.id === Number(id)) || null;
    const validAnswers = Object.fromEntries(Object.entries(answers).filter(([id, value]) => value && qs.some((q) => q.id === id)));
    const hasAnswers = Object.keys(validAnswers).length > 0;

    let lead;
    let action;
    if (open) {
      // Lead abierto: se completa con lo nuevo y se agregan las respuestas a las notas.
      const changes = { notes: `${open.notes ? `${open.notes}\n\n` : ''}${notes}`.slice(-4000) };
      if (data.destination) changes.destination = data.destination;
      if (data.start) { changes.start_date = data.start; changes.end_date = data.end && data.end >= data.start ? data.end : null; }
      if (data.travelers) changes.travelers = data.travelers;
      if (data.budget) changes.budget = data.budget;
      if (hasAnswers) changes.qualification = scoreQualification({ answers: { ...(open.qualification?.answers || {}), ...validAnswers } }, qs);
      lead = await dataStore.updateRecord('leads', open.id, changes);
      action = 'updated';
      const diff = diffChanges('leads', open, lead, find).filter((c) => c.field !== 'notes');
      await log('crm_leads_update', { entity: 'leads', entityId: lead.id, summary: summaryFor('leads', lead, find), ...(diff.length ? { changes: diff } : {}), note: `Actualizado por el ${label}` });
    } else {
      const fields = sanitize('leads', {
        client_id: client.id, destination: data.destination || 'Por definir', start_date: data.start || null,
        end_date: data.start && data.end && data.end >= data.start ? data.end : null,
        travelers: data.travelers || null, budget: data.budget || null, source: channel.source, stage: 'Nuevo', priority: 'Media', notes,
        ...(hasAnswers ? { qualification: scoreQualification({ answers: validAnswers }, qs) } : {})
      });
      fields.stage_changed_at = now;
      lead = await dataStore.insertRecord('leads', fields, client.owner_id && !createdClient ? client.owner_id : owner?.id ?? null);
      action = 'created';
      all.leads = [lead];
      await log('crm_leads_create', { entity: 'leads', entityId: lead.id, summary: summaryFor('leads', lead, find), note: `Creado por el ${label}${owner ? ` · asignado a ${owner.name}` : ''}` });
    }

    // Aviso al vendedor: seguimiento para contactar en 15 minutos (si no tiene uno pendiente).
    const pending = (await dataStore.listRecords('followups')).some((f) => f.lead_id === lead.id && !f.done);
    let followup = null;
    if (!pending) {
      followup = await dataStore.insertRecord('followups', sanitize('followups', {
        client_id: client.id, lead_id: lead.id, type: 'WhatsApp', title: `Contactar a ${client.name} (${label})`.slice(0, 160),
        details: String(followupDetails || '').slice(0, 2000) || null,
        due_at: addMinutes(now, FOLLOWUP_MINUTES)
      }), lead.owner_id);
      await log('crm_followups_create', { entity: 'followups', entityId: followup.id, summary: followup.title, note: capital(label) });
    }
    const seller = lead.owner_id ? await dataStore.findUserById(lead.owner_id) : null;
    return { action, lead, client, followup, seller };
  }

  return { intake, questions, defaultOwner };
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

module.exports = { createLeadIntake, addMinutes, CLOSED };
