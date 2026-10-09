'use strict';

// Arma las hojas de exportación (Excel/CSV) a partir de los datos visibles para el usuario.

const SECTIONS = {
  clients: 'Clientes',
  leads: 'Leads',
  quotes: 'Cotizaciones',
  sales: 'Ventas',
  trips: 'Viajes',
  followups: 'Seguimientos',
  users: 'Usuarios'
};
// Secciones que puede descargar cada rol (el servidor filtra además los registros).
const ROLE_SECTIONS = {
  admin: ['clients', 'leads', 'quotes', 'sales', 'trips', 'followups', 'users'],
  travel_partner: ['clients', 'leads', 'quotes', 'sales', 'trips', 'followups'],
  operaciones: ['trips', 'followups'],
  consulta: []
};

const yesNo = (v) => (v ? 'Sí' : 'No');
const col = (header, type = 'text', width = 16) => ({ header, type, width });

// data: { clients, leads, quotes, trips, followups }, users: lista, questions: preguntas de calificación
// range: { from, to } en formato YYYY-MM-DD; filtra por fecha de creación (ventas: fecha de venta; seguimientos: fecha programada).
function buildSheets(sectionList, data, { users = [], questions = [], range = null } = {}) {
  const inRange = (value) => {
    if (!range || (!range.from && !range.to)) return true;
    const day = String(value || '').slice(0, 10);
    if (!day) return false;
    return (!range.from || day >= range.from) && (!range.to || day <= range.to);
  };
  const userName = (id) => users.find((u) => Number(u.id) === Number(id))?.name || '';
  const client = (id) => data.clients.find((c) => c.id === Number(id)) || {};
  const quote = (id) => data.quotes.find((q) => q.id === Number(id)) || null;
  const lead = (id) => data.leads.find((l) => l.id === Number(id)) || null;
  const sheets = [];

  for (const section of sectionList) {
    if (section === 'clients') {
      sheets.push({
        name: SECTIONS.clients,
        columns: [col('ID', 'number', 7), col('Nombre', 'text', 28), col('WhatsApp', 'text', 18), col('Correo', 'text', 28), col('Preferencias', 'text', 26),
          col('Vendedor', 'text', 18), col('Leads', 'number', 8), col('Cotizaciones', 'number', 12), col('Viajes', 'number', 8), col('Total vendido', 'money', 15), col('Creado', 'datetime', 17), col('Notas', 'text', 40)],
        rows: data.clients.filter((c) => inRange(c.created_at)).map((c) => {
          const accepted = data.quotes.filter((q) => q.client_id === c.id && q.status === 'Aceptada');
          return [c.id, c.name, c.phone, c.email, c.tags, userName(c.owner_id),
            data.leads.filter((l) => l.client_id === c.id).length, data.quotes.filter((q) => q.client_id === c.id).length,
            data.trips.filter((t) => t.client_id === c.id).length, accepted.reduce((s, q) => s + Number(q.price || 0), 0), c.created_at, c.notes];
        })
      });
    }
    if (section === 'leads') {
      sheets.push({
        name: SECTIONS.leads,
        columns: [col('ID', 'number', 7), col('Cliente', 'text', 26), col('WhatsApp', 'text', 18), col('Correo', 'text', 26), col('Destino', 'text', 22),
          col('Salida', 'date', 12), col('Regreso', 'date', 12), col('Viajeros', 'number', 9), col('Presupuesto', 'money', 14), col('Etapa', 'text', 13),
          col('Prioridad', 'text', 10), col('Origen', 'text', 12), col('Calificación %', 'number', 13), col('Nivel', 'text', 10),
          ...questions.map((q) => col(q.label, 'text', 22)),
          col('Vendedor', 'text', 18), col('Creado', 'datetime', 17), col('Cerrado', 'datetime', 17), col('Motivo de pérdida', 'text', 22), col('Notas', 'text', 40)],
        rows: data.leads.filter((l) => inRange(l.created_at)).map((l) => {
          const c = client(l.client_id);
          const qa = l.qualification || {};
          return [l.id, c.name, c.phone, c.email, l.destination, l.start_date, l.end_date, l.travelers, l.budget, l.stage, l.priority, l.source,
            qa.score ?? '', qa.level || '', ...questions.map((q) => qa.answers?.[q.id] || ''),
            userName(l.owner_id), l.created_at, l.closed_at, l.lost_reason || '', l.notes];
        })
      });
    }
    if (section === 'quotes') {
      sheets.push({
        name: SECTIONS.quotes,
        columns: [col('Folio', 'text', 15), col('Tipo', 'text', 10), col('Cliente', 'text', 26), col('Destino', 'text', 22), col('Hotel / paquete', 'text', 32),
          col('Precio', 'money', 14), col('Modalidad', 'text', 12), col('Propuestas', 'number', 11), col('Estado', 'text', 13), col('Vigencia', 'date', 12),
          col('Vendedor', 'text', 18), col('Creada', 'datetime', 17), col('Aceptada', 'datetime', 17)],
        rows: data.quotes.filter((q) => inRange(q.created_at)).map((q) => {
          const circuit = q.details?.kind === 'circuito';
          return [q.folio, circuit ? 'Circuito' : 'Paquete', client(q.client_id).name, q.destination, q.hotel, q.price, q.mode,
            circuit ? 1 : (q.details?.proposals?.length || 1), q.status, q.valid_until, userName(q.owner_id), q.created_at, q.accepted_at];
        })
      });
    }
    if (section === 'sales') {
      const sales = data.quotes.filter((q) => q.status === 'Aceptada' && inRange(q.accepted_at)).sort((a, b) => String(b.accepted_at || '').localeCompare(String(a.accepted_at || '')));
      sheets.push({
        name: SECTIONS.sales,
        columns: [col('Folio', 'text', 15), col('Fecha de venta', 'datetime', 17), col('Mes', 'text', 9), col('Cliente', 'text', 26), col('Destino', 'text', 22),
          col('Hotel / paquete', 'text', 32), col('Monto', 'money', 14), col('Modalidad', 'text', 12), col('Origen del lead', 'text', 14), col('Vendedor', 'text', 18), col('Viaje registrado', 'text', 14)],
        rows: sales.map((q) => [q.folio, q.accepted_at, String(q.accepted_at || '').slice(0, 7), client(q.client_id).name, q.destination, q.hotel, q.price, q.mode,
          lead(q.lead_id)?.source || '', userName(q.owner_id), yesNo(data.trips.some((t) => t.quote_id === q.id))])
      });
    }
    if (section === 'trips') {
      sheets.push({
        name: SECTIONS.trips,
        columns: [col('ID', 'number', 7), col('Cliente', 'text', 26), col('WhatsApp', 'text', 18), col('Destino', 'text', 22), col('Salida', 'date', 12), col('Regreso', 'date', 12),
          col('Estado', 'text', 22), col('Cotización', 'text', 15), col('Confirmación lista', 'text', 16), col('Registró', 'text', 18), col('Creado', 'datetime', 17), col('Notas', 'text', 40)],
        rows: data.trips.filter((t) => inRange(t.created_at)).map((t) => [t.id, client(t.client_id).name, client(t.client_id).phone, t.destination, t.start_date, t.end_date, t.status,
          quote(t.quote_id)?.folio || '', yesNo(t.confirmation), userName(t.owner_id), t.created_at, t.notes])
      });
    }
    if (section === 'followups') {
      sheets.push({
        name: SECTIONS.followups,
        columns: [col('Fecha y hora', 'datetime', 17), col('Tipo', 'text', 12), col('Actividad', 'text', 32), col('Cliente', 'text', 26), col('Lead', 'text', 22),
          col('Hecho', 'text', 8), col('Responsable', 'text', 18), col('Detalles', 'text', 40)],
        rows: data.followups.filter((f) => inRange(f.due_at)).map((f) => [f.due_at, f.type, f.title, client(f.client_id).name || '', lead(f.lead_id)?.destination || '', yesNo(f.done), userName(f.owner_id), f.details])
      });
    }
    if (section === 'users') {
      sheets.push({
        name: SECTIONS.users,
        columns: [col('ID', 'number', 7), col('Nombre', 'text', 24), col('Correo', 'text', 30), col('Rol', 'text', 15), col('Activo', 'text', 8), col('Último acceso', 'datetime', 17)],
        rows: users.map((u) => [u.id, u.name, u.email, { admin: 'Administrador', travel_partner: 'Vendedor', operaciones: 'Operaciones', consulta: 'Consulta' }[u.role] || u.role, yesNo(u.active), u.last_login_at])
      });
    }
  }
  return sheets;
}

module.exports = { SECTIONS, ROLE_SECTIONS, buildSheets };
