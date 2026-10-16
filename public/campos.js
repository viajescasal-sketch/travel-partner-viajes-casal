'use strict';

/* =========================================================
   TP-306 Campos personalizables
   Campos en los formularios de lead, cliente y viaje; chips en tarjetas; Configuración › Campos personalizables.
   ========================================================= */
(function () {
  const H = escapeHtml;
  const F = window.TPFields;
  const defsOf = (entity) => (db.customFields?.[entity] || []).filter((d) => d.active !== false);

  // Campos dentro de un formulario (data-cf = clave).
  window.customFieldsHtml = (entity, values = {}) => {
    const defs = defsOf(entity);
    if (!defs.length) return '';
    const v = values || {};
    const input = (d) => {
      const val = v[d.key];
      const req = d.required ? ' required' : '';
      switch (d.type) {
        case 'longtext': return `<textarea data-cf="${d.key}" rows="2" maxlength="3000"${req}>${H(val ?? '')}</textarea>`;
        case 'number': return `<input data-cf="${d.key}" inputmode="decimal" maxlength="20" value="${H(val ?? '')}"${req}>`;
        case 'date': return `<input data-cf="${d.key}" type="date" value="${H(val ?? '')}"${req}>`;
        case 'select': return `<select data-cf="${d.key}"${req}><option value="">—</option>${d.options.map((o) => `<option${o === val ? ' selected' : ''}>${H(o)}</option>`).join('')}</select>`;
        case 'multi': return `<span class="cf-multi" data-cf="${d.key}" data-cf-multi>${d.options.map((o) => `<label class="kb-check"><input type="checkbox" value="${H(o)}"${(Array.isArray(val) ? val : []).includes(o) ? ' checked' : ''}> ${H(o)}</label>`).join('')}</span>`;
        case 'bool': return `<select data-cf="${d.key}"${req}><option value="">—</option><option value="true"${val === true ? ' selected' : ''}>Sí</option><option value="false"${val === false ? ' selected' : ''}>No</option></select>`;
        default: return `<input data-cf="${d.key}" maxlength="300" value="${H(val ?? '')}"${req}>`;
      }
    };
    return `<p class="full section-label cf-head">Campos personalizados</p>${defs.map((d) => `<label class="${['longtext', 'multi'].includes(d.type) ? 'full' : ''}">${H(d.label)}${d.required ? '*' : ''}${input(d)}${d.help ? `<small class="muted">${H(d.help)}</small>` : ''}</label>`).join('')}`;
  };
  // Valores del formulario → { clave: valor } (null si la entidad no tiene campos).
  window.readCustomFields = (entity, form) => {
    const defs = defsOf(entity);
    if (!defs.length || !form) return null;
    const out = {};
    for (const d of defs) {
      const el = form.querySelector(`[data-cf="${d.key}"]`);
      if (!el) continue;
      if (d.type === 'multi') out[d.key] = [...el.querySelectorAll('input:checked')].map((i) => i.value);
      else if (d.type === 'bool') out[d.key] = el.value === '' ? '' : el.value === 'true';
      else out[d.key] = el.value.trim();
    }
    return out;
  };
  // Chips en tarjetas y listas (campos marcados “Mostrar en tarjeta”).
  window.customChipsHtml = (entity, record) => {
    const defs = defsOf(entity).filter((d) => d.card);
    const chips = defs.map((d) => { const t = F.display(d, record?.custom?.[d.key]); return t ? `<span class="cf-chip" title="${H(d.label)}">${d.type === 'bool' ? `${H(d.label)}: ` : ''}${H(t)}</span>` : ''; }).join('');
    return chips;
  };
  // Resumen en la ficha 360.
  window.customSummaryHtml = (entity, record) => {
    const rows = defsOf(entity).map((d) => [d.label, F.display(d, record?.custom?.[d.key])]).filter(([, t]) => t);
    return rows.length ? `<div class="cf-summary">${rows.map(([l, t]) => `<span><small>${H(l)}</small><b>${H(t)}</b></span>`).join('')}</div>` : '';
  };

  /* ---------------- Configuración › Campos personalizables ---------------- */
  const st = { entity: 'leads', fields: null, dirty: false };
  window.renderCustomFieldsSettings = async (reload = true) => {
    const box = $('#fieldsSettingsBody');
    if (!box || !F) return;
    if (reload || !st.fields) {
      try { st.fields = (await api('/api/custom-fields')).fields; st.dirty = false; } catch (error) { box.innerHTML = `<p class="muted">${H(error.message)}</p>`; return; }
    }
    const list = st.fields[st.entity];
    const row = (d, i) => `<div class="cf-row${d.active === false ? ' off' : ''}" data-cfi="${i}">
      <div class="cf-main"><input data-cff="label" maxlength="60" value="${H(d.label)}" placeholder="Nombre del campo" aria-label="Nombre del campo">
        <select data-cff="type" aria-label="Tipo">${options(Object.entries(F.TYPES), d.type)}</select>
        <span class="cf-move"><button type="button" class="icon" data-cf-up="${i}" title="Subir"${i ? '' : ' disabled'}>↑</button><button type="button" class="icon" data-cf-down="${i}" title="Bajar"${i < list.length - 1 ? '' : ' disabled'}>↓</button></span></div>
      ${['select', 'multi'].includes(d.type) ? `<label class="cf-opts">Opciones (una por renglón)<textarea data-cff="options" rows="3" maxlength="2400">${H((d.options || []).join('\n'))}</textarea></label>` : ''}
      <div class="cf-flags"><label class="kb-check"><input type="checkbox" data-cff="required" ${d.required ? 'checked' : ''}> Obligatorio</label><label class="kb-check"><input type="checkbox" data-cff="card" ${d.card ? 'checked' : ''}> Mostrar en tarjetas</label><label class="kb-check"><input type="checkbox" data-cff="active" ${d.active !== false ? 'checked' : ''}> Activo</label><input data-cff="help" maxlength="160" value="${H(d.help || '')}" placeholder="Ayuda (opcional)"><button type="button" class="link danger-link" data-cf-del="${i}">Quitar</button></div>
      ${d.key ? `<small class="muted">Clave: ${H(d.key)}</small>` : ''}</div>`;
    box.innerHTML = `<div class="seg cf-tabs">${Object.entries(F.ENTITIES).map(([k, l]) => `<button type="button" data-cf-entity="${k}" class="${st.entity === k ? 'on' : ''}">${l} (${st.fields[k].filter((d) => d.active !== false).length})</button>`).join('')}</div>
      <p class="muted-note">Los campos aparecen en el formulario de ${H(F.ENTITIES[st.entity].toLowerCase())}, en la ficha y en la exportación a Excel; se pueden buscar y usar en las automatizaciones. “Mostrar en tarjetas” los pone como etiqueta en el tablero y las listas. Desactivar un campo lo oculta sin borrar lo ya capturado.</p>
      <div id="cfList">${list.map(row).join('') || '<p class="empty-note">Aún no hay campos. Ej.: aerolínea preferida, motivo del viaje, aniversario.</p>'}</div>
      <div class="modal-actions"><button type="button" class="btn secondary" id="cfAdd">+ Agregar campo</button><button type="button" class="btn primary" id="cfSave">Guardar campos</button></div>`;
    const body = box;
    body.oninput = (e) => {
      const r = e.target.closest('[data-cfi]'); const f = e.target.dataset.cff;
      if (!r || !f) return;
      const d = list[Number(r.dataset.cfi)];
      if (['required', 'card', 'active'].includes(f)) d[f] = e.target.checked;
      else if (f === 'options') d.options = e.target.value.split('\n');
      else d[f] = e.target.value;
      st.dirty = true;
      if (f === 'type' || f === 'active') renderCustomFieldsSettings(false);
    };
    body.onchange = body.oninput;
    body.onclick = async (e) => {
      const ent = e.target.closest('[data-cf-entity]');
      if (ent) { st.entity = ent.dataset.cfEntity; renderCustomFieldsSettings(false); return; }
      const up = e.target.closest('[data-cf-up]'), down = e.target.closest('[data-cf-down]'), del = e.target.closest('[data-cf-del]');
      if (up || down) { const i = Number((up || down).dataset[up ? 'cfUp' : 'cfDown']); const j = up ? i - 1 : i + 1; [list[i], list[j]] = [list[j], list[i]]; st.dirty = true; renderCustomFieldsSettings(false); return; }
      if (del) { const d = list[Number(del.dataset.cfDel)]; if (d.key && !confirm(`¿Quitar “${d.label}”? Lo ya capturado deja de mostrarse. Si solo quieres ocultarlo, desactívalo.`)) return; list.splice(Number(del.dataset.cfDel), 1); st.dirty = true; renderCustomFieldsSettings(false); return; }
      if (e.target.id === 'cfAdd') { list.push({ label: '', type: 'text', options: [], required: false, card: false, active: true, help: '' }); renderCustomFieldsSettings(false); $$('#cfList [data-cff="label"]').pop()?.focus(); return; }
      if (e.target.id === 'cfSave') {
        e.target.disabled = true;
        try {
          const out = await send('PUT', '/api/custom-fields', { fields: st.fields });
          st.fields = out.fields; st.dirty = false;
          db.customFields = out.fields;
          toast('Campos guardados');
          renderCustomFieldsSettings(false);
          renderAll();
        } catch (error) { toast(error.message, 6000); e.target.disabled = false; }
      }
    };
  };
}());
