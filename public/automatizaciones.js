'use strict';

/* =========================================================
   TP-307 Constructor de automatizaciones (Configuración › Automatizaciones, solo administrador)
   ========================================================= */
(function () {
  const H = escapeHtml;
  const A = window.TPAuto;
  const st = { data: null };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const whoOptions = (sel, { auto = false } = {}) => options([...(auto ? [['auto', 'Automático (según la asignación)']] : [['owner', 'El vendedor del cliente'], ['admins', 'Los administradores']]), ...(db.users || []).filter((u) => u.active !== false && u.role !== 'operaciones').map((u) => [String(u.id), u.name])], String(sel));
  const ctxDefs = () => db.customFields || { leads: [], clients: [], trips: [] };

  async function load() { st.data = await api('/api/automations'); }

  window.renderAutomations = async (reload = true) => {
    const box = $('#automationsBody');
    if (!box || !A) return;
    if (reload || !st.data) { try { await load(); } catch (error) { box.innerHTML = `<p class="muted">${H(error.message)}</p>`; return; } }
    const { rules, stats, history, templates } = st.data;
    const desc = (r) => A.describe(r, { users: db.users || [], templates, customDefs: ctxDefs() });
    box.innerHTML = `<p class="muted-note">Reglas “si pasa X, haz Y” para todo el equipo. Las de evento corren al momento; las de fecha se revisan cada hora en horario laboral. Los recordatorios que ya existen (lead sin contacto, cotización sin respuesta, cobros, postviaje y campañas) siguen funcionando aparte.</p>
      <div class="toolbar"><button type="button" class="btn primary" id="auNew">+ Nueva automatización</button><button type="button" class="btn secondary" id="auRun">Revisar reglas por fecha ahora</button></div>
      <div class="au-list">${rules.map((r) => { const d = desc(r); const s = stats[r.id]; return `<article class="au-rule${r.active ? ' on' : ''}" data-au="${H(r.id)}">
        <label class="au-switch" title="${r.active ? 'Activa' : 'Apagada'}"><input type="checkbox" data-au-toggle ${r.active ? 'checked' : ''}><span></span></label>
        <div class="au-main"><b>${A.TRIGGERS[r.trigger.type].icon} ${H(r.name)}</b>${r.example ? ' <span class="cf-chip">Ejemplo</span>' : ''}
          <small><b>Cuando:</b> ${H(d.when)}${d.conditions ? ` · ${d.conditions} condición${d.conditions > 1 ? 'es' : ''}` : ''}</small>
          <small><b>Hace:</b> ${H(d.actions.join(' · '))}</small>
          <small class="muted">${s ? `Corrió ${s.runs} ${s.runs === 1 ? 'vez' : 'veces'} · última ${H(fmtDate(String(s.last_at).slice(0, 10)))} ${H(String(s.last_at).slice(11, 16))}` : 'Aún no corre'}</small></div>
        <div class="au-acts"><button type="button" class="btn secondary small" data-au-edit>Editar</button><button type="button" class="link" data-au-copy>Duplicar</button><button type="button" class="link danger-link" data-au-del>Eliminar</button></div></article>`; }).join('') || '<p class="empty-note">Sin automatizaciones.</p>'}</div>
      <h4 class="au-h">Últimas ejecuciones</h4>
      <div class="au-history">${history.length ? history.slice(0, 25).map((h) => `<div><small>${H(fmtDate(h.at.slice(0, 10)))} ${H(h.at.slice(11, 16))}</small><b>${H(h.rule)}</b>${h.target ? `<span>${H(h.target)}</span>` : ''}<em>${H(h.results.join(' · '))}</em></div>`).join('') : '<p class="empty-note">Todavía no se ejecuta ninguna automatización.</p>'}</div>`;
    $('#auNew').onclick = () => editor(null);
    $('#auRun').onclick = async (e) => { e.target.disabled = true; try { const r = await send('POST', '/api/automations/run'); toast(r.fired ? `${r.fired} automatizaciones ejecutadas` : 'Nada pendiente por fecha'); await renderAutomations(); } catch (error) { toast(error.message); } e.target.disabled = false; };
    box.querySelectorAll('[data-au]').forEach((card) => {
      const rule = rules.find((r) => r.id === card.dataset.au);
      card.querySelector('[data-au-toggle]').onchange = async (e) => {
        try { await send('PUT', `/api/automations/${rule.id}`, { ...rule, active: e.target.checked }); toast(e.target.checked ? `“${rule.name}” activada` : `“${rule.name}” apagada`); await renderAutomations(); } catch (error) { toast(error.message, 6000); e.target.checked = !e.target.checked; }
      };
      card.querySelector('[data-au-edit]').onclick = () => editor(rule);
      card.querySelector('[data-au-copy]').onclick = () => editor({ ...clone(rule), id: null, name: `${rule.name} (copia)`, active: false, example: false });
      card.querySelector('[data-au-del]').onclick = async () => { if (!confirm(`¿Eliminar “${rule.name}”?`)) return; try { await send('DELETE', `/api/automations/${rule.id}`); toast('Automatización eliminada'); await renderAutomations(); } catch (error) { toast(error.message); } };
    });
  };

  /* ---------------- Editor ---------------- */
  const OPS_BY_TYPE = { number: ['gte', 'lte', 'eq', 'neq', 'empty', 'not_empty'], text: ['contains', 'eq', 'neq', 'empty', 'not_empty'], select: ['eq', 'neq', 'empty', 'not_empty'], multi: ['eq', 'neq', 'empty', 'not_empty'], bool: ['eq'], user: ['eq', 'neq'] };
  const blankAction = (type) => ({ followup: { type, ftype: 'Llamada', title: 'Llamar a {cliente}', details: '', days: 1, time: '10:00', to: 'owner' }, whatsapp_task: { type, template: 'se1', title: '', days: 0, time: '', to: 'owner' }, email_client: { type, subject: '', body: 'Hola {nombre},\n\n' }, notify: { type, to: 'owner', title: '', body: '', email: false }, set_stage: { type, stage: 'Calificado' }, assign: { type, to: 'auto' }, set_field: { type, target: 'client', key: '', value: '' }, add_tag: { type, tag: '' } }[type]);

  function editor(rule) {
    const r = rule ? clone(rule) : { id: null, name: '', active: true, trigger: { type: 'lead_created' }, match: 'all', conditions: [], actions: [blankAction('followup')] };
    const templates = st.data?.templates || [];
    const test = { entity: '', id: '', result: null };
    function fields() { return A.fieldsFor(r.trigger, ctxDefs()); }
    function triggerParams() {
      const t = r.trigger;
      if (t.type === 'lead_stage') return field('Etapa', `<select data-t="stage"><option value="">Cualquier etapa</option>${options(A.LEAD_STAGES, t.stage || '')}</select>`);
      if (t.type === 'quote_status') return field('Estado', `<select data-t="status"><option value="">Cualquier estado</option>${options(A.QUOTE_STATUSES, t.status || '')}</select>`);
      if (t.type === 'payment_received') return `<label class="kb-check"><input type="checkbox" data-t="full" ${t.full ? 'checked' : ''}> Solo cuando el cliente liquida su viaje</label>`;
      if (['lead_idle', 'trip_before', 'trip_after'].includes(t.type)) return field('Días', `<input data-t="days" type="number" min="${t.type === 'lead_idle' ? 1 : 0}" max="365" value="${H(t.days ?? (t.type === 'lead_idle' ? 5 : 7))}">`);
      if (t.type === 'date_field') {
        const dates = (ctxDefs()[t.entity || 'clients'] || []).filter((d) => d.type === 'date' && d.active !== false);
        return `${field('Registro', `<select data-t="entity">${options([['clients', 'Cliente'], ['leads', 'Lead'], ['trips', 'Viaje']], t.entity || 'clients')}</select>`)}
          ${field('Campo de fecha', dates.length ? `<select data-t="field"><option value="">Elige…</option>${options(dates.map((d) => [d.key, d.label]), t.field || '')}</select>` : '<span class="muted">Primero crea un campo de tipo Fecha en Campos personalizables.</span>')}
          ${field('Días', `<input data-t="days" type="number" min="0" max="365" value="${H(t.days ?? 0)}">`)}
          ${field('Cuándo', `<select data-t="when">${options([['before', 'Antes de la fecha'], ['after', 'Después de la fecha']], t.when || 'before')}</select>`)}
          <label class="kb-check"><input type="checkbox" data-t="yearly" ${t.yearly !== false ? 'checked' : ''}> Cada año (aniversarios, cumpleaños)</label>`;
      }
      return '';
    }
    function condRow(c, i) {
      const fl = fields();
      const f = fl.find((x) => x.path === c.path) || fl[0];
      if (!f) return '';
      if (c.path !== f.path) { c.path = f.path; }
      const ops = OPS_BY_TYPE[f.type] || OPS_BY_TYPE.text;
      if (!ops.includes(c.op)) c.op = ops[0];
      const noValue = ['empty', 'not_empty'].includes(c.op);
      let value = '';
      if (!noValue) {
        if (f.type === 'select' || f.type === 'multi') value = `<select data-c="value">${options(f.options, c.value || f.options[0])}</select>`;
        else if (f.type === 'bool') value = `<select data-c="value">${options([['true', 'Sí'], ['false', 'No']], c.value || 'true')}</select>`;
        else if (f.type === 'user') value = `<select data-c="value">${options((db.users || []).map((u) => [String(u.id), u.name]), c.value)}</select>`;
        else value = `<input data-c="value" maxlength="120" value="${H(c.value || '')}"${f.type === 'number' ? ' inputmode="decimal"' : ''}>`;
        if (!c.value && (f.type === 'select' || f.type === 'multi')) c.value = f.options[0] || '';
        if (!c.value && f.type === 'bool') c.value = 'true';
      }
      return `<div class="au-row" data-ci="${i}"><select data-c="path">${options(fl.map((x) => [x.path, x.label]), f.path)}</select><select data-c="op">${options(ops.map((o) => [o, A.OPS[o]]), c.op)}</select>${value}<button type="button" class="link danger-link" data-c-del="${i}">✕</button></div>`;
    }
    function actionRow(a, i) {
      const when = `${field('En días', `<input data-a="days" type="number" min="0" max="365" value="${H(a.days ?? 0)}">`)}${field('Hora', `<input data-a="time" type="time" value="${H(a.time || '')}">`)}${field('Para', `<select data-a="to">${whoOptions(a.to)}</select>`)}`;
      let body = '';
      if (a.type === 'followup') body = `${field('Tipo', `<select data-a="ftype">${options(A.FOLLOWUP_TYPES, a.ftype)}</select>`)}${field('Título', `<input data-a="title" maxlength="160" value="${H(a.title)}">`, true)}${field('Detalles', `<input data-a="details" maxlength="1000" value="${H(a.details || '')}">`, true)}${when}`;
      if (a.type === 'whatsapp_task') body = `${field('Plantilla', `<select data-a="template">${options(templates.map((t) => [t.id, t.name]), a.template)}</select>`)}${field('Título de la tarea (opcional)', `<input data-a="title" maxlength="160" value="${H(a.title || '')}" placeholder="Enviar WhatsApp a {cliente}">`, true)}${when}`;
      if (a.type === 'email_client') body = `${field('Asunto', `<input data-a="subject" maxlength="160" value="${H(a.subject)}">`, true)}${field('Mensaje', `<textarea data-a="body" rows="4" maxlength="4000">${H(a.body)}</textarea>`, true)}`;
      if (a.type === 'notify') body = `${field('Para', `<select data-a="to">${whoOptions(a.to)}</select>`)}${field('Aviso', `<input data-a="title" maxlength="160" value="${H(a.title)}">`, true)}${field('Detalle', `<input data-a="body" maxlength="300" value="${H(a.body || '')}">`, true)}<label class="kb-check"><input type="checkbox" data-a="email" ${a.email ? 'checked' : ''}> También por correo</label>`;
      if (a.type === 'set_stage') body = field('Nueva etapa', `<select data-a="stage">${options(['Nuevo', 'Calificado', 'Cotizado', 'Negociación'], a.stage)}</select>`);
      if (a.type === 'assign') body = field('Asignar a', `<select data-a="to">${whoOptions(a.to, { auto: true })}</select>`);
      if (a.type === 'set_field') {
        const subjects = A.subjectsOf(r.trigger).filter((s) => ['lead', 'client', 'trip'].includes(s));
        if (!subjects.includes(a.target)) a.target = subjects[0] || 'client';
        const ent = { lead: 'leads', client: 'clients', trip: 'trips' }[a.target];
        const defs = (ctxDefs()[ent] || []).filter((d) => d.active !== false);
        if (!defs.some((d) => d.key === a.key)) a.key = defs[0]?.key || '';
        const def = defs.find((d) => d.key === a.key);
        const valueInput = def && ['select', 'multi'].includes(def.type) ? `<select data-a="value">${options(def.options, a.value)}</select>` : def?.type === 'bool' ? `<select data-a="value">${options([['true', 'Sí'], ['false', 'No']], a.value || 'true')}</select>` : `<input data-a="value" maxlength="300" value="${H(a.value || '')}"${def?.type === 'date' ? ' type="date"' : ''}>`;
        body = `${field('En', `<select data-a="target">${options(subjects.map((s) => [s, { lead: 'Lead', client: 'Cliente', trip: 'Viaje' }[s]]), a.target)}</select>`)}${field('Campo', defs.length ? `<select data-a="key">${options(defs.map((d) => [d.key, d.label]), a.key)}</select>` : '<span class="muted">Sin campos personalizables</span>')}${field('Valor', valueInput)}`;
      }
      if (a.type === 'add_tag') body = field('Preferencia', `<input data-a="tag" maxlength="40" value="${H(a.tag)}" placeholder="VIP">`);
      return `<div class="au-action" data-ai="${i}"><div class="au-action-head"><b>${A.ACTIONS[a.type].icon} ${H(A.ACTIONS[a.type].label)}</b>${A.ACTIONS[a.type].help ? `<small class="muted">${H(A.ACTIONS[a.type].help)}</small>` : ''}<button type="button" class="link danger-link" data-a-del="${i}">Quitar</button></div><div class="modal-form">${body}</div></div>`;
    }
    function testOptions() {
      const subjects = A.subjectsOf(r.trigger);
      const list = [];
      if (subjects.includes('lead')) list.push(...db.leads.slice().sort((a, b) => b.id - a.id).slice(0, 40).map((l) => [`leads:${l.id}`, `Lead · ${clientName(l.client_id)} · ${l.destination}`]));
      if (subjects.includes('trip')) list.push(...db.trips.slice().sort((a, b) => b.id - a.id).slice(0, 30).map((t) => [`trips:${t.id}`, `Viaje · ${clientName(t.client_id)} · ${t.destination}`]));
      if (subjects.includes('quote')) list.push(...db.quotes.slice().sort((a, b) => b.id - a.id).slice(0, 30).map((q) => [`quotes:${q.id}`, `Cotización · ${q.folio} · ${clientName(q.client_id)}`]));
      if (!list.length && subjects.includes('client')) list.push(...db.clients.slice(0, 40).map((c) => [`clients:${c.id}`, `Cliente · ${c.name}`]));
      return list;
    }
    function paint() {
      const T = A.TRIGGERS[r.trigger.type];
      openModal('AUTOMATIZACIÓN', r.id ? r.name : 'Nueva automatización', `<div class="au-editor">
        <div class="modal-form">${field('Nombre*', `<input id="auName" maxlength="100" value="${H(r.name)}" placeholder="Ej. Cotización rechazada → llamar en 2 días">`, true)}
          <label class="full kb-check"><input type="checkbox" id="auActive" ${r.active ? 'checked' : ''}> Activa</label></div>
        <h4 class="au-h">1 · Cuando…</h4>
        <div class="modal-form">${field('Disparador', `<select id="auTrigger">${options(Object.entries(A.TRIGGERS).map(([k, v]) => [k, `${v.icon} ${v.label}`]), r.trigger.type)}</select>`, true)}${T.help ? `<p class="full muted-note">${H(T.help)}</p>` : ''}${triggerParams()}</div>
        <h4 class="au-h">2 · Si… <small class="muted">(opcional)</small></h4>
        ${r.conditions.length > 1 ? `<div class="au-match">${field('', `<select id="auMatch">${options([['all', 'Se cumplen todas'], ['any', 'Se cumple alguna']], r.match)}</select>`)}</div>` : ''}
        <div id="auConds">${r.conditions.map(condRow).join('') || '<p class="muted-note">Sin condiciones: aplica siempre.</p>'}</div>
        <button type="button" class="btn secondary small" id="auAddCond">+ Condición</button>
        <h4 class="au-h">3 · Entonces…</h4>
        <div id="auActs">${r.actions.map(actionRow).join('')}</div>
        <div class="au-add"><select id="auActType">${options(Object.entries(A.ACTIONS).filter(([, v]) => !v.needs || A.subjectsOf(r.trigger).includes(v.needs)).map(([k, v]) => [k, `${v.icon} ${v.label}`]), 'followup')}</select><button type="button" class="btn secondary small" id="auAddAct">+ Acción</button></div>
        <p class="muted-note">Variables para los textos: ${A.VARIABLES.map((v) => `<code>${v}</code>`).join(' ')}</p>
        <h4 class="au-h">Probar sin hacer cambios</h4>
        <div class="au-test"><select id="auTestRec"><option value="">Elige un registro…</option>${options(testOptions(), test.entity ? `${test.entity}:${test.id}` : '')}</select><button type="button" class="btn secondary small" id="auTest">Probar</button></div>
        <div id="auTestOut">${test.result ? testHtml(test.result) : ''}</div>
        <div class="modal-actions"><button type="button" class="btn secondary" id="auBack">Volver</button><button type="button" class="btn primary" id="auSave">${r.id ? 'Guardar cambios' : 'Crear automatización'}</button></div></div>`, { wide: true });
      bind();
    }
    const testHtml = (t) => `<div class="au-test-out ${t.matches ? 'ok' : 'no'}"><b>${t.matches ? '✅ Se ejecutaría' : '⛔ No se ejecutaría'}</b> con ${H(t.target || 'este registro')}${t.conditions.length ? `<ul>${t.conditions.map((c) => `<li>${c.ok ? '✓' : '✗'} ${H(c.label)} <small class="muted">(valor: ${H(c.value == null || c.value === '' ? 'vacío' : Array.isArray(c.value) ? c.value.join(', ') : String(c.value))})</small></li>`).join('')}</ul>` : ''}<ul>${t.actions.map((a) => `<li>${H(a)}</li>`).join('')}</ul></div>`;
    function bind() {
      const body = $('#modalBody');
      $('#auName').oninput = (e) => { r.name = e.target.value; };
      $('#auActive').onchange = (e) => { r.active = e.target.checked; };
      $('#auTrigger').onchange = (e) => { r.trigger = { type: e.target.value }; const subj = A.subjectsOf(r.trigger); r.conditions = r.conditions.filter((c) => subj.includes(c.path.split('.')[0])); r.actions = r.actions.filter((a) => !A.ACTIONS[a.type].needs || subj.includes(A.ACTIONS[a.type].needs)); if (!r.actions.length) r.actions.push(blankAction('followup')); test.result = null; paint(); };
      body.querySelectorAll('[data-t]').forEach((el) => { el.onchange = () => { const k = el.dataset.t; r.trigger[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; if (k === 'entity') { r.trigger.field = ''; r.conditions = []; } paint(); }; });
      if ($('#auMatch')) $('#auMatch').onchange = (e) => { r.match = e.target.value; };
      body.querySelectorAll('[data-ci]').forEach((row) => {
        const c = r.conditions[Number(row.dataset.ci)];
        row.querySelectorAll('[data-c]').forEach((el) => {
          el.oninput = () => { c[el.dataset.c] = el.value; if (el.dataset.c !== 'value') { if (el.dataset.c === 'path') c.value = ''; paint(); } };
          el.onchange = el.oninput;
        });
      });
      body.querySelectorAll('[data-c-del]').forEach((b) => { b.onclick = () => { r.conditions.splice(Number(b.dataset.cDel), 1); paint(); }; });
      $('#auAddCond').onclick = () => { const f = fields()[0]; if (!f) { toast('Este disparador no tiene datos para condiciones'); return; } r.conditions.push({ path: f.path, op: '', value: '' }); paint(); };
      body.querySelectorAll('[data-ai]').forEach((row) => {
        const a = r.actions[Number(row.dataset.ai)];
        row.querySelectorAll('[data-a]').forEach((el) => {
          const k = el.dataset.a;
          el.oninput = () => { a[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; if (k === 'target' || k === 'key') paint(); };
          el.onchange = el.oninput;
        });
      });
      body.querySelectorAll('[data-a-del]').forEach((b) => { b.onclick = () => { r.actions.splice(Number(b.dataset.aDel), 1); paint(); }; });
      $('#auAddAct').onclick = () => { if (r.actions.length >= 6) { toast('Máximo 6 acciones'); return; } r.actions.push(blankAction($('#auActType').value)); paint(); };
      $('#auTestRec').onchange = (e) => { const [en, id] = e.target.value.split(':'); test.entity = en || ''; test.id = id || ''; };
      $('#auTest').onclick = async () => {
        if (!test.entity) { toast('Elige un registro para probar'); return; }
        try { test.result = await send('POST', '/api/automations/test', { rule: { ...r, name: r.name || 'Prueba' }, entity: test.entity, id: Number(test.id) }); $('#auTestOut').innerHTML = testHtml(test.result); } catch (error) { toast(error.message, 6000); }
      };
      $('#auBack').onclick = () => { close(); };
      $('#auSave').onclick = async (e) => {
        e.target.disabled = true;
        try {
          const payload = { ...r }; delete payload.id;
          if (r.id) await send('PUT', `/api/automations/${r.id}`, payload); else await send('POST', '/api/automations', payload);
          toast(r.id ? 'Automatización guardada' : 'Automatización creada');
          close();
          await renderAutomations();
        } catch (error) { toast(error.message, 6000); e.target.disabled = false; }
      };
    }
    paint();
  }
}());
