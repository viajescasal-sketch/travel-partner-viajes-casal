'use strict';

/* Avatares ilustrados de animales (con parpadeo y movimiento suave) para el perfil de cada agente.
   Si el agente no sube foto, elige uno; si no elige, se le asigna uno según su usuario. */
(function (global) {
  // Ojos con brillo (parpadean con la clase av-eyes)
  const eyes = (lx, rx, y, r = 3.4, c = '#1d2433') => `<g class="av-eyes"><circle cx="${lx}" cy="${y}" r="${r}" fill="${c}"/><circle cx="${rx}" cy="${y}" r="${r}" fill="${c}"/><circle cx="${lx + 1.1}" cy="${y - 1.2}" r="${r * 0.33}" fill="#fff"/><circle cx="${rx + 1.1}" cy="${y - 1.2}" r="${r * 0.33}" fill="#fff"/></g>`;
  const cheeks = (lx, rx, y, c = '#ff8fa3') => `<ellipse cx="${lx}" cy="${y}" rx="3.6" ry="2.2" fill="${c}" opacity=".55"/><ellipse cx="${rx}" cy="${y}" rx="3.6" ry="2.2" fill="${c}" opacity=".55"/>`;
  const smile = (x, y, w = 4, c = '#1d2433') => `<path d="M${x - w} ${y} q${w} ${w * 0.9} ${w * 2} 0" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`;

  const ANIMALS = [
    { key: 'tortuga', name: 'Tortuga marina', bg: '#c9f0e4', art: `
      <path d="M14 30c0-11 8-18 18-18s18 7 18 18v6H14z" fill="#3aa57a"/>
      <path d="M22 18l5 6h10l5-6M18 28h8m12 0h8M27 24l-3 8m13-8 3 8" stroke="#2b7f5d" stroke-width="2" fill="none" stroke-linecap="round"/>
      <ellipse cx="32" cy="42" rx="16" ry="13" fill="#7fd3a4"/>
      ${eyes(25, 39, 41)}${cheeks(20, 44, 47)}${smile(32, 48, 3.5)}` },
    { key: 'delfin', name: 'Delfín', bg: '#cfe8ff', art: `
      <path d="M30 10c6 2 9 6 9 10l-6-2z" fill="#4c86c6"/>
      <ellipse cx="32" cy="36" rx="18" ry="17" fill="#6aa5e6"/>
      <ellipse cx="32" cy="46" rx="12" ry="6.5" fill="#dbeeff"/>
      <ellipse cx="32" cy="49" rx="8" ry="4.5" fill="#8ec0f2"/>
      ${eyes(25, 39, 34)}${cheeks(19, 45, 41)}${smile(32, 49.5, 3)}` },
    { key: 'flamenco', name: 'Flamenco', bg: '#ffe0ea', art: `
      <path d="M33 9c4-1 7 2 6 5" fill="none" stroke="#e45d8a" stroke-width="3" stroke-linecap="round"/>
      <circle cx="32" cy="34" r="17" fill="#ff9fbe"/>
      ${eyes(25, 39, 31)}${cheeks(20, 44, 38)}
      <path d="M27 40h10l-2 7c-1 3-5 3-6 0z" fill="#fff4f7"/>
      <path d="M29 45h6l-1.2 3.4c-.8 1.6-2.8 1.6-3.6 0z" fill="#2c2c3a"/>` },
    { key: 'tucan', name: 'Tucán', bg: '#fff1c7', art: `
      <circle cx="30" cy="33" r="17" fill="#26313f"/>
      <ellipse cx="25" cy="33" rx="9" ry="10" fill="#fff8e6"/>
      ${eyes(25, 25, 31, 3.4)}
      <path d="M31 30c10-4 20-2 23 4-5 4-14 6-23 2z" fill="#ffb11f"/>
      <path d="M46 31c4 0 7 1 8 3-2 2-5 3-8 3z" fill="#ff6a3d"/>
      <path d="M31 33c8 1 16 1 22 1" stroke="#e08d00" stroke-width="1.2" fill="none"/>` },
    { key: 'jaguar', name: 'Jaguar', bg: '#ffe5c2', art: `
      <circle cx="18" cy="18" r="6" fill="#e8a33d"/><circle cx="46" cy="18" r="6" fill="#e8a33d"/>
      <circle cx="18" cy="18" r="3" fill="#ffd28a"/><circle cx="46" cy="18" r="3" fill="#ffd28a"/>
      <circle cx="32" cy="35" r="18" fill="#f2b44f"/>
      <g fill="#8a5a1f" opacity=".75"><circle cx="20" cy="27" r="2"/><circle cx="44" cy="27" r="2"/><circle cx="32" cy="21" r="2.2"/><circle cx="16" cy="38" r="1.8"/><circle cx="48" cy="38" r="1.8"/></g>
      <ellipse cx="32" cy="43" rx="9" ry="7" fill="#fff3dd"/>
      ${eyes(25, 39, 33)}
      <path d="M29.5 39.5h5l-2.5 3z" fill="#4a2f17"/>${smile(32, 44, 2.6)}` },
    { key: 'ajolote', name: 'Ajolote', bg: '#ffe0ef', art: `
      <g fill="#ff7eb0"><rect x="5" y="22" width="12" height="4.5" rx="2.2" transform="rotate(-25 11 24)"/><rect x="3" y="30" width="12" height="4.5" rx="2.2"/><rect x="5" y="38" width="12" height="4.5" rx="2.2" transform="rotate(25 11 40)"/>
      <rect x="47" y="22" width="12" height="4.5" rx="2.2" transform="rotate(25 53 24)"/><rect x="49" y="30" width="12" height="4.5" rx="2.2"/><rect x="47" y="38" width="12" height="4.5" rx="2.2" transform="rotate(-25 53 40)"/></g>
      <ellipse cx="32" cy="35" rx="18" ry="16" fill="#ffc2da"/>
      ${eyes(24, 40, 32, 3)}${cheeks(20, 44, 38)}
      <path d="M24 40q8 7 16 0" fill="none" stroke="#1d2433" stroke-width="1.8" stroke-linecap="round"/>` },
    { key: 'ballena', name: 'Ballena', bg: '#d6ecff', art: `
      <g class="av-spout" fill="#7cc4f2"><path d="M32 14c0-3 0-5-1-7M32 14c1-3 3-5 5-6M32 14c-1-3-3-5-5-6" stroke="#7cc4f2" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>
      <path d="M12 36c0-11 9-19 20-19s20 8 20 19-9 16-20 16-20-5-20-16z" fill="#3f6fb5"/>
      <path d="M16 42c4 6 10 9 16 9s12-3 16-9c-6 2-11 3-16 3s-10-1-16-3z" fill="#e8f2ff"/>
      ${eyes(24, 40, 34)}${cheeks(19, 45, 40)}${smile(32, 41, 3, '#fff')}` },
    { key: 'pulpo', name: 'Pulpo', bg: '#ece0ff', art: `
      <path d="M14 34c0-12 8-21 18-21s18 9 18 21v6H14z" fill="#9a6ae0"/>
      <g fill="#9a6ae0"><circle cx="17" cy="44" r="5"/><circle cx="27" cy="46" r="5"/><circle cx="37" cy="46" r="5"/><circle cx="47" cy="44" r="5"/></g>
      <g fill="#c7a8f5"><circle cx="17" cy="46" r="1.4"/><circle cx="27" cy="48" r="1.4"/><circle cx="37" cy="48" r="1.4"/><circle cx="47" cy="46" r="1.4"/><circle cx="24" cy="20" r="2"/><circle cx="40" cy="22" r="1.5"/></g>
      ${eyes(25, 39, 31)}${cheeks(20, 44, 37)}${smile(32, 37, 3)}` },
    { key: 'colibri', name: 'Colibrí', bg: '#d9f5e6', art: `
      <circle cx="28" cy="33" r="16" fill="#2fb88a"/>
      <path d="M14 36c3 8 11 12 18 10-8-1-13-5-18-10z" fill="#1d8f69"/>
      <ellipse cx="27" cy="40" rx="9" ry="6" fill="#e64980" opacity=".85"/>
      ${eyes(23, 33, 30, 3)}
      <path d="M40 31l20-3-20 6z" fill="#2c2c3a"/>` },
    { key: 'mono', name: 'Mono araña', bg: '#f3e3d3', art: `
      <circle cx="13" cy="33" r="6" fill="#8a5a3c"/><circle cx="51" cy="33" r="6" fill="#8a5a3c"/>
      <circle cx="13" cy="33" r="3" fill="#f1c9a5"/><circle cx="51" cy="33" r="3" fill="#f1c9a5"/>
      <circle cx="32" cy="32" r="18" fill="#8a5a3c"/>
      <path d="M17 33c0-7 6-11 15-11s15 4 15 11c0 9-7 15-15 15s-15-6-15-15z" fill="#f1c9a5"/>
      ${eyes(26, 38, 31)}
      <ellipse cx="32" cy="38" rx="2.5" ry="1.6" fill="#5c3b25"/>${smile(32, 42, 3.2)}` },
    { key: 'buho', name: 'Búho', bg: '#efe2cf', art: `
      <path d="M16 16l7 6-8 2zM48 16l-7 6 8 2z" fill="#a0683c"/>
      <ellipse cx="32" cy="36" rx="18" ry="17" fill="#b9814f"/>
      <ellipse cx="32" cy="44" rx="10" ry="8" fill="#e7cfae"/>
      <circle cx="24" cy="31" r="8" fill="#fff6e8"/><circle cx="40" cy="31" r="8" fill="#fff6e8"/>
      ${eyes(24, 40, 31, 4)}
      <path d="M30 37h4l-2 4z" fill="#f2a33a"/>` },
    { key: 'manati', name: 'Manatí', bg: '#e1e7ee', art: `
      <ellipse cx="32" cy="34" rx="19" ry="17" fill="#8d9aab"/>
      <ellipse cx="32" cy="42" rx="11" ry="8" fill="#b9c3cf"/>
      <g fill="#6c7889"><circle cx="27" cy="41" r=".9"/><circle cx="30" cy="43" r=".9"/><circle cx="34" cy="43" r=".9"/><circle cx="37" cy="41" r=".9"/></g>
      <ellipse cx="29" cy="38.5" rx="1.4" ry="1" fill="#4b5563"/><ellipse cx="35" cy="38.5" rx="1.4" ry="1" fill="#4b5563"/>
      ${eyes(24, 40, 30, 3)}${cheeks(19, 45, 36)}` }
  ];
  const KEYS = ANIMALS.map((a) => a.key);
  const byKey = (k) => ANIMALS.find((a) => a.key === k) || null;
  // Animal por omisión según el usuario (siempre el mismo para la misma persona).
  const defaultFor = (id) => ANIMALS[Math.abs(Number(id) || 0) % ANIMALS.length].key;

  /** SVG del animal. opts: { size, still } */
  function svg(key, { size = 40, still = false, title = '' } = {}) {
    const a = byKey(key) || ANIMALS[0];
    const id = `avc${Math.random().toString(36).slice(2, 8)}`;
    return `<svg class="av-svg${still ? '' : ' av-live'}" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${title || a.name}"><defs><clipPath id="${id}"><circle cx="32" cy="32" r="32"/></clipPath></defs><g clip-path="url(#${id})"><circle cx="32" cy="32" r="32" fill="${a.bg}"/><g class="av-body">${a.art}</g></g></svg>`;
  }
  /** Avatar de un usuario: su foto, su animal elegido o el de omisión. u: { id, name, photoUrl, avatar } */
  function html(u, { size = 40, still = false } = {}) {
    if (u?.photoUrl) return `<img class="av-img" src="${String(u.photoUrl).replace(/"/g, '')}" width="${size}" height="${size}" alt="${String(u.name || '').replace(/[<>"&]/g, '')}">`;
    return svg(u?.avatar && byKey(u.avatar) ? u.avatar : defaultFor(u?.id), { size, still, title: u?.name || '' });
  }

  global.TPAvatars = { ANIMALS, KEYS, byKey, defaultFor, svg, html };
  if (typeof module !== 'undefined' && module.exports) module.exports = { KEYS, defaultFor };
}(typeof window !== 'undefined' ? window : globalThis));
