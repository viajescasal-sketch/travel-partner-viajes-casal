'use strict';

// Ganchos internos por plataforma (cada dataStore tiene los suyos): permiten que un módulo
// reaccione a lo que pasa en otro sin acoplarlos. Ej.: 'leadSold' (TP-309), 'leadIntake' (TP-309).
const hooksOf = (store) => { if (!store.__tpHooks) Object.defineProperty(store, '__tpHooks', { value: {}, enumerable: false }); return store.__tpHooks; };
function on(store, name, fn) { const h = hooksOf(store); (h[name] = h[name] || []).push(fn); }
async function emit(store, name, ...args) {
  for (const fn of hooksOf(store)[name] || []) {
    try { await fn(...args); } catch (error) { console.error(`Gancho ${name} falló:`, error.message); }
  }
}
module.exports = { on, emit };
