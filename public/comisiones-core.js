'use strict';

/* TP-206: metas mensuales y comisiones por vendedor (cálculo compartido entre la plataforma, el servidor y las pruebas).
   - Cada venta (cotización Aceptada) cuenta para la meta del mes en que se aceptó.
   - La comisión del vendedor = % de la utilidad de la venta (reservas: tarifa neta o comisión del proveedor, TP-205).
   - Queda "Por liberar" hasta que el cliente liquida su plan de pagos; luego "Por pagar"; el administrador la marca "Pagada". */
(function (global) {
  const R = typeof module !== 'undefined' && module.exports ? require('./reportes-core') : global.TPReports;
  const GOAL_BASES = ['venta', 'utilidad'];
  const GOAL_BASE_LABELS = { venta: 'Ventas', utilidad: 'Utilidad' };
  const STATUSES = ['Por liberar', 'Por pagar', 'Pagada'];
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const amount = (v, max = 100000000) => {
    if (v === '' || v == null) return '';
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n >= 0 ? Math.min(round2(n), max) : '';
  };

  /** Configuración: { base, sellers: { [userId]: { goal, pct, months: { 'AAAA-MM': meta } } } } */
  function cleanGoals(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const sellers = {};
    for (const [id, v] of Object.entries(r.sellers && typeof r.sellers === 'object' ? r.sellers : {}).slice(0, 200)) {
      if (!/^\d{1,10}$/.test(id) || !v || typeof v !== 'object') continue;
      const months = {};
      for (const [m, g] of Object.entries(v.months && typeof v.months === 'object' ? v.months : {}).slice(-36)) {
        const val = amount(g);
        if (MONTH_RE.test(m) && val !== '') months[m] = val;
      }
      sellers[id] = { goal: amount(v.goal), pct: amount(v.pct, 100), months };
    }
    return { base: GOAL_BASES.includes(r.base) ? r.base : 'venta', sellers };
  }
  const sellerCfg = (goals, sellerId) => goals?.sellers?.[String(sellerId)] || { goal: '', pct: '', months: {} };
  function goalFor(goals, sellerId, month) {
    const c = sellerCfg(goals, sellerId);
    const m = c.months?.[month];
    return m !== undefined && m !== '' ? m : c.goal === '' || c.goal == null ? null : Number(c.goal);
  }
  const pctFor = (goals, sellerId) => { const p = sellerCfg(goals, sellerId).pct; return p === '' || p == null ? null : Number(p); };

  const sellerOf = (q, leads) => { const lead = q.lead_id ? (leads || []).find((l) => l.id === q.lead_id) : null; return lead?.owner_id ?? q.owner_id ?? null; };
  const saleTotal = (q) => round2(q.payment_plan?.total || Number(q.price) || 0);
  function statusOf(q) {
    if (q.seller_commission?.status === 'Pagada') return 'Pagada';
    return q.payment_plan?.status === 'pagado' ? 'Por pagar' : 'Por liberar';
  }

  /**
   * Ventas con su comisión. data: { quotes, leads, trips }. opts: { month: 'AAAA-MM' | from/to, sellerId, goals }.
   * → [{ quote, seller, month, total, profit, pct, commission, status, paid }]
   */
  function sales(data, { month = '', from = '', to = '', sellerId = null, goals = null } = {}) {
    const leads = data.leads || [], trips = data.trips || [];
    return (data.quotes || []).filter((q) => q.status === 'Aceptada' && q.accepted_at).map((q) => {
      const day = String(q.accepted_at).slice(0, 10);
      return { q, day, seller: sellerOf(q, leads) };
    }).filter(({ day, seller }) => (!month || day.slice(0, 7) === month) && (!from || day >= from) && (!to || day <= to) && (sellerId == null || String(seller) === String(sellerId)))
      .map(({ q, day, seller }) => {
        const status = statusOf(q);
        const paid = status === 'Pagada' ? q.seller_commission : null;
        const profit = R.saleProfit(q, trips);
        const pct = paid ? Number(paid.pct) : pctFor(goals, seller);
        const commission = paid ? Number(paid.amount) : profit == null || pct == null ? null : round2((profit * pct) / 100);
        return { quote: q, seller, month: day.slice(0, 7), day, total: saleTotal(q), profit, pct, commission, status, paid, balance: q.payment_plan ? round2(q.payment_plan.balance) : null };
      })
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** Resumen del mes por vendedor: meta, avance y comisiones por estado. */
  function monthSummary(data, goals, month, sellerId) {
    const list = sales(data, { month, sellerId, goals });
    const base = goals?.base === 'utilidad' ? 'utilidad' : 'venta';
    const sold = round2(list.reduce((s, x) => s + x.total, 0));
    const profit = round2(list.reduce((s, x) => s + (x.profit || 0), 0));
    const goal = goalFor(goals, sellerId, month);
    const value = base === 'utilidad' ? profit : sold;
    const by = (st) => round2(list.filter((x) => x.status === st).reduce((s, x) => s + (x.commission || 0), 0));
    return {
      sellerId, month, base, goal, sold, profit, value, sales: list.length,
      progress: goal ? Math.round((value / goal) * 100) : null,
      remaining: goal ? Math.max(0, round2(goal - value)) : null,
      pct: pctFor(goals, sellerId),
      commission: { porLiberar: by('Por liberar'), porPagar: by('Por pagar'), pagada: by('Pagada'), total: round2(list.reduce((s, x) => s + (x.commission || 0), 0)) },
      missingProfit: list.filter((x) => x.profit == null).length,
      list
    };
  }

  /** Comisión de cada vendedor para el reporte de desempeño (ventas aceptadas en el periodo). */
  function commissionBySeller(data, goals, { from = '', to = '' } = {}) {
    const out = new Map();
    for (const x of sales(data, { from, to, goals })) {
      const k = x.seller ?? 'none';
      const cur = out.get(k) || { total: 0, missing: 0, porPagar: 0, pagada: 0 };
      if (x.commission == null) cur.missing += 1; else cur.total = round2(cur.total + x.commission);
      if (x.status === 'Por pagar') cur.porPagar = round2(cur.porPagar + (x.commission || 0));
      if (x.status === 'Pagada') cur.pagada = round2(cur.pagada + (x.commission || 0));
      out.set(k, cur);
    }
    return out;
  }

  const monthOf = (today) => String(today).slice(0, 7);
  const prevMonth = (m) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

  global.TPComm = { GOAL_BASES, GOAL_BASE_LABELS, STATUSES, cleanGoals, goalFor, pctFor, sellerOf, statusOf, sales, monthSummary, commissionBySeller, monthOf, prevMonth };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.TPComm;
}(typeof window !== 'undefined' ? window : globalThis));
