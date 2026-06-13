// lib/artwork.js
//
// Ten distinct "Noder" NFT illustrations — abstract node-graph / circuit-board
// characters, each with its own colour palette and node arrangement. They are
// plain SVG strings (viewBox "0 0 200 200"), embedded so the app needs no file
// I/O and no external image hosting. `image_index` (0–9) on an `nfts` row maps
// directly into this array.
//
// Kept deliberately small and self-contained: a rounded gradient backdrop, a
// scatter of "nodes" (circles) wired together by "edges" (lines), and one
// emphasised core node. Distinct enough that a gallery of them reads as a real
// collection rather than ten recolours of one shape.

const ARTWORK = [
  // 0 — Cobalt mesh
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder cobalt mesh">
    <defs><linearGradient id="n0" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b2a6b"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n0)"/>
    <g stroke="#60a5fa" stroke-width="2.5" opacity="0.8"><line x1="60" y1="60" x2="100" y2="100"/><line x1="140" y1="55" x2="100" y2="100"/><line x1="55" y1="140" x2="100" y2="100"/><line x1="150" y1="145" x2="100" y2="100"/><line x1="60" y1="60" x2="140" y2="55"/></g>
    <g fill="#93c5fd"><circle cx="60" cy="60" r="9"/><circle cx="140" cy="55" r="9"/><circle cx="55" cy="140" r="9"/><circle cx="150" cy="145" r="9"/></g>
    <circle cx="100" cy="100" r="16" fill="#bfdbfe" stroke="#3b82f6" stroke-width="4"/>
  </svg>`,

  // 1 — Emerald lattice
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder emerald lattice">
    <defs><linearGradient id="n1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#052e1a"/><stop offset="1" stop-color="#065f46"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n1)"/>
    <g stroke="#34d399" stroke-width="2.5" opacity="0.8"><line x1="50" y1="100" x2="100" y2="60"/><line x1="100" y1="60" x2="150" y2="100"/><line x1="150" y1="100" x2="100" y2="140"/><line x1="100" y1="140" x2="50" y2="100"/><line x1="100" y1="60" x2="100" y2="140"/></g>
    <g fill="#6ee7b7"><circle cx="50" cy="100" r="9"/><circle cx="150" cy="100" r="9"/><circle cx="100" cy="60" r="9"/><circle cx="100" cy="140" r="9"/></g>
    <circle cx="100" cy="100" r="15" fill="#d1fae5" stroke="#10b981" stroke-width="4"/>
  </svg>`,

  // 2 — Amber circuit
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder amber circuit">
    <defs><linearGradient id="n2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#451a03"/><stop offset="1" stop-color="#92400e"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n2)"/>
    <g stroke="#fbbf24" stroke-width="3" fill="none" opacity="0.85"><path d="M40 70 H90 V40"/><path d="M160 90 H120 V130 H80"/><path d="M40 140 H70 V100"/></g>
    <g fill="#fcd34d"><circle cx="90" cy="40" r="8"/><circle cx="160" cy="90" r="8"/><circle cx="40" cy="140" r="8"/><circle cx="70" cy="100" r="8"/></g>
    <rect x="86" y="86" width="28" height="28" rx="6" fill="#fde68a" stroke="#f59e0b" stroke-width="4"/>
  </svg>`,

  // 3 — Violet constellation
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder violet constellation">
    <defs><linearGradient id="n3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2e1065"/><stop offset="1" stop-color="#5b21b6"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n3)"/>
    <g stroke="#c4b5fd" stroke-width="2" opacity="0.7"><line x1="45" y1="50" x2="95" y2="95"/><line x1="160" y1="60" x2="95" y2="95"/><line x1="70" y1="160" x2="95" y2="95"/><line x1="155" y1="150" x2="95" y2="95"/></g>
    <g fill="#ddd6fe"><circle cx="45" cy="50" r="6"/><circle cx="160" cy="60" r="7"/><circle cx="70" cy="160" r="6"/><circle cx="155" cy="150" r="8"/><circle cx="120" cy="35" r="4"/></g>
    <circle cx="95" cy="95" r="18" fill="#ede9fe" stroke="#8b5cf6" stroke-width="4"/>
  </svg>`,

  // 4 — Rose pulse
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder rose pulse">
    <defs><linearGradient id="n4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c0519"/><stop offset="1" stop-color="#9f1239"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n4)"/>
    <polyline points="30,100 70,100 85,60 100,140 115,80 130,100 170,100" fill="none" stroke="#fb7185" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="#fecdd3"><circle cx="30" cy="100" r="7"/><circle cx="170" cy="100" r="7"/></g>
    <circle cx="100" cy="140" r="9" fill="#fda4af"/><circle cx="85" cy="60" r="7" fill="#fda4af"/>
  </svg>`,

  // 5 — Cyan grid
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder cyan grid">
    <defs><linearGradient id="n5" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#083344"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n5)"/>
    <g stroke="#22d3ee" stroke-width="2" opacity="0.55"><line x1="70" y1="40" x2="70" y2="160"/><line x1="130" y1="40" x2="130" y2="160"/><line x1="40" y1="70" x2="160" y2="70"/><line x1="40" y1="130" x2="160" y2="130"/></g>
    <g fill="#67e8f9"><circle cx="70" cy="70" r="8"/><circle cx="130" cy="70" r="8"/><circle cx="70" cy="130" r="8"/><circle cx="130" cy="130" r="8"/></g>
    <circle cx="100" cy="100" r="14" fill="#cffafe" stroke="#06b6d4" stroke-width="4"/>
  </svg>`,

  // 6 — Slate orbit
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder slate orbit">
    <defs><linearGradient id="n6" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#334155"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n6)"/>
    <ellipse cx="100" cy="100" rx="62" ry="30" fill="none" stroke="#94a3b8" stroke-width="2.5" opacity="0.8"/>
    <ellipse cx="100" cy="100" rx="30" ry="62" fill="none" stroke="#64748b" stroke-width="2.5" opacity="0.8"/>
    <g fill="#cbd5e1"><circle cx="162" cy="100" r="7"/><circle cx="38" cy="100" r="7"/><circle cx="100" cy="38" r="7"/><circle cx="100" cy="162" r="7"/></g>
    <circle cx="100" cy="100" r="16" fill="#e2e8f0" stroke="#94a3b8" stroke-width="4"/>
  </svg>`,

  // 7 — Lime sprout
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder lime sprout">
    <defs><linearGradient id="n7" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a2e05"/><stop offset="1" stop-color="#3f6212"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n7)"/>
    <g stroke="#a3e635" stroke-width="3" fill="none" opacity="0.85"><path d="M100 160 V90"/><path d="M100 110 C70 100 60 70 70 55"/><path d="M100 100 C130 92 142 64 134 50"/></g>
    <g fill="#bef264"><circle cx="70" cy="55" r="9"/><circle cx="134" cy="50" r="9"/></g>
    <circle cx="100" cy="160" r="10" fill="#84cc16"/>
    <circle cx="100" cy="86" r="13" fill="#ecfccb" stroke="#84cc16" stroke-width="4"/>
  </svg>`,

  // 8 — Fuchsia burst
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder fuchsia burst">
    <defs><radialGradient id="n8" cx="0.5" cy="0.5" r="0.7"><stop offset="0" stop-color="#701a75"/><stop offset="1" stop-color="#2d0a2e"/></radialGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n8)"/>
    <g stroke="#f0abfc" stroke-width="2.5" opacity="0.8"><line x1="100" y1="100" x2="100" y2="35"/><line x1="100" y1="100" x2="158" y2="70"/><line x1="100" y1="100" x2="150" y2="155"/><line x1="100" y1="100" x2="55" y2="150"/><line x1="100" y1="100" x2="40" y2="80"/></g>
    <g fill="#f5d0fe"><circle cx="100" cy="35" r="8"/><circle cx="158" cy="70" r="8"/><circle cx="150" cy="155" r="8"/><circle cx="55" cy="150" r="8"/><circle cx="40" cy="80" r="8"/></g>
    <circle cx="100" cy="100" r="15" fill="#fae8ff" stroke="#d946ef" stroke-width="4"/>
  </svg>`,

  // 9 — Orange relay
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Noder orange relay">
    <defs><linearGradient id="n9" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#431407"/><stop offset="1" stop-color="#9a3412"/></linearGradient></defs>
    <rect width="200" height="200" rx="24" fill="url(#n9)"/>
    <g stroke="#fb923c" stroke-width="3" opacity="0.85"><line x1="45" y1="65" x2="100" y2="100"/><line x1="100" y1="100" x2="155" y2="65"/><line x1="100" y1="100" x2="100" y2="160"/></g>
    <g fill="#fdba74"><circle cx="45" cy="65" r="10"/><circle cx="155" cy="65" r="10"/><circle cx="100" cy="160" r="10"/></g>
    <rect x="84" y="84" width="32" height="32" rx="8" fill="#ffedd5" stroke="#f97316" stroke-width="4"/>
  </svg>`,
];

const ARTWORK_COUNT = ARTWORK.length;

// Safe accessor: clamps/normalises an index into range so a bad row can never
// throw while rendering the gallery.
function svgForIndex(i) {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n >= ARTWORK_COUNT) return ARTWORK[0];
  return ARTWORK[n];
}

module.exports = { ARTWORK, ARTWORK_COUNT, svgForIndex };
