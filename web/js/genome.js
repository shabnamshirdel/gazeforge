// genome.js — parametric design space + gaze-weighted interactive evolution.
// Every design is a "genome": a vector of genes in [0,1]. The same genome drives
// (a) the offline mock renderer (SVG floor lamp) and (b) the text prompt sent to ComfyUI.

export const GENES = [
  { key: 'shade',    type: 'cat', options: ['cone', 'drum', 'dome', 'globe', 'pleated'] },
  { key: 'hue',      type: 'num' },
  { key: 'material', type: 'cat', options: ['matte ceramic', 'brushed brass', 'frosted glass', 'oak wood', 'white paper'] },
  { key: 'height',   type: 'num' },
  { key: 'arm',      type: 'num' },   // 0 = straight stem, 1 = strongly arched
  { key: 'base',     type: 'cat', options: ['round', 'square', 'tripod', 'disc'] },
  { key: 'glow',     type: 'num' },
  { key: 'pattern',  type: 'cat', options: ['plain', 'stripes', 'dots', 'ribs'] },
];

let nextId = 1;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const randn = () => { // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const randSeed = () => Math.floor(Math.random() * 2 ** 31);

export function randomGenome() {
  const g = { id: nextId++, seed: randSeed(), parents: [], genes: {} };
  for (const gene of GENES) g.genes[gene.key] = Math.random();
  return g;
}

export function decode(genome) {
  const out = {};
  for (const gene of GENES) {
    const v = genome.genes[gene.key];
    out[gene.key] = gene.type === 'cat'
      ? gene.options[Math.min(gene.options.length - 1, Math.floor(v * gene.options.length))]
      : v;
  }
  return out;
}

// ---- Evolution -------------------------------------------------------------

function weightedPick(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

function crossover(a, b, wa, wb) {
  // Per-gene: numeric genes blend by parent weight; categorical genes are inherited.
  const pa = wa / (wa + wb || 1);
  const genes = {};
  for (const gene of GENES) {
    genes[gene.key] = gene.type === 'num'
      ? pa * a.genes[gene.key] + (1 - pa) * b.genes[gene.key]
      : (Math.random() < pa ? a : b).genes[gene.key];
  }
  return genes;
}

function mutate(genes, sigma) {
  const out = {};
  for (const gene of GENES) {
    let v = genes[gene.key];
    if (gene.type === 'num') v = clamp01(v + sigma * randn());
    else if (Math.random() < sigma * 1.2) v = Math.random(); // categorical jump
    out[gene.key] = v;
  }
  return out;
}

/**
 * Produce the next generation.
 * @param {Array} options  current genomes
 * @param {Array<number>} weights  preference weights (sum to 1)
 * @param {number} round  0-based index of the round that just finished
 * @param {number} n  number of options to produce
 * @returns {Array} new genomes; the first one is the "elite" (best of last round, carried over)
 */
export function evolve(options, weights, round, n = 4) {
  const sigma = 0.05 + 0.25 * Math.exp(-round / 4); // explore early, refine later
  const best = weights.indexOf(Math.max(...weights));
  const elite = { ...options[best], id: nextId++, elite: true, parents: [options[best].id] };
  const next = [elite];
  while (next.length < n) {
    const i = weightedPick(weights);
    let j = weightedPick(weights);
    if (options.length > 1) for (let k = 0; k < 5 && j === i; k++) j = weightedPick(weights);
    const genes = mutate(crossover(options[i], options[j], weights[i], weights[j]), sigma);
    const parentForSeed = weights[i] >= weights[j] ? options[i] : options[j];
    next.push({
      id: nextId++,
      elite: false,
      seed: Math.random() < 0.7 ? parentForSeed.seed : randSeed(), // keep composition, sometimes jump
      parents: [options[i].id, options[j].id],
      genes,
    });
  }
  return { next, sigma };
}

export function genomeDistance(a, b) {
  let s = 0;
  for (const gene of GENES) {
    const d = a.genes[gene.key] - b.genes[gene.key];
    s += gene.type === 'num' ? d * d : (decode(a)[gene.key] === decode(b)[gene.key] ? 0 : 1);
  }
  return Math.sqrt(s / GENES.length);
}

/** Mean pairwise distance — a cheap stand-in for CLIP-embedding diversity. */
export function diversity(genomes) {
  let s = 0, c = 0;
  for (let i = 0; i < genomes.length; i++)
    for (let j = i + 1; j < genomes.length; j++) { s += genomeDistance(genomes[i], genomes[j]); c++; }
  return c ? s / c : 0;
}

// ---- Prompt (for ComfyUI) --------------------------------------------------

const HUE_NAMES = ['red', 'orange', 'amber', 'yellow', 'olive', 'green', 'teal', 'cyan', 'sky blue', 'blue', 'indigo', 'violet', 'magenta', 'rose'];

export function toPrompt(genome, brief) {
  const d = decode(genome);
  const color = HUE_NAMES[Math.floor(d.hue * HUE_NAMES.length) % HUE_NAMES.length];
  const height = d.height < 0.33 ? 'compact' : d.height < 0.66 ? 'medium-height' : 'tall';
  const arm = d.arm < 0.3 ? 'straight vertical stem' : d.arm < 0.7 ? 'gently curved stem' : 'dramatic arched arm';
  const pattern = d.pattern === 'plain' ? 'smooth surface' : `${d.pattern} pattern on the shade`;
  const glow = d.glow < 0.33 ? 'lamp switched off' : d.glow < 0.66 ? 'soft warm glow' : 'bright warm light';
  return {
    prompt: `${brief}. A ${height} floor lamp with a ${d.shade} shade, ${color} ${d.material}, ${d.base} base, ${arm}, ${pattern}, ${glow}. ` +
      `product design render, centered, full object visible, studio lighting, plain light background, high detail`,
    negative: 'text, watermark, logo, cropped, multiple objects, people, blurry, lowres, deformed',
    seed: genome.seed,
  };
}

// ---- Mock renderer (no GPU needed) -----------------------------------------

const MAT = {
  'matte ceramic': { sat: 45, light: 62, stem: '#d8d4cc', alpha: 1 },
  'brushed brass': { sat: 55, light: 55, stem: '#c9a24a', alpha: 1 },
  'frosted glass': { sat: 35, light: 78, stem: '#9aa3ad', alpha: 0.72 },
  'oak wood':      { sat: 40, light: 50, stem: '#9a6b3f', alpha: 1 },
  'white paper':   { sat: 18, light: 88, stem: '#2b2b2b', alpha: 0.9 },
};

export function renderSVG(genome) {
  const d = decode(genome);
  const m = MAT[d.material];
  const uid = `g${genome.id}`;
  const fill = `hsla(${Math.round(d.hue * 360)}, ${m.sat}%, ${m.light}%, ${m.alpha})`;
  const dark = `hsl(${Math.round(d.hue * 360)}, ${m.sat}%, ${Math.max(15, m.light - 30)}%)`;
  const floorY = 240, cx = 100;
  const topY = floorY - (95 + d.height * 95);          // where the stem meets the shade
  const bend = (d.arm - 0.5) * 2 * 45;                 // horizontal offset of the shade
  const sx = cx + bend;

  // Base
  let base = '';
  if (d.base === 'round') base = `<ellipse cx="${cx}" cy="${floorY - 4}" rx="30" ry="7" fill="${m.stem}"/>`;
  if (d.base === 'disc') base = `<ellipse cx="${cx}" cy="${floorY - 3}" rx="40" ry="5" fill="${dark}"/>`;
  if (d.base === 'square') base = `<rect x="${cx - 24}" y="${floorY - 12}" width="48" height="12" rx="2" fill="${m.stem}"/>`;
  if (d.base === 'tripod') base = [-28, 0, 28].map((dx) =>
    `<line x1="${cx}" y1="${floorY - 40}" x2="${cx + dx}" y2="${floorY}" stroke="${m.stem}" stroke-width="4" stroke-linecap="round"/>`).join('');

  // Stem (quadratic curve to the shade)
  const stem = `<path d="M ${cx} ${floorY - 8} Q ${cx - bend * 0.6} ${(floorY + topY) / 2 - 30} ${sx} ${topY}"
    fill="none" stroke="${m.stem}" stroke-width="5" stroke-linecap="round"/>`;

  // Shade
  const w = 70, h = 46, y0 = topY - 6;
  let shapePath;
  switch (d.shade) {
    case 'cone':    shapePath = `M ${sx - w * 0.22} ${y0 - h} L ${sx + w * 0.22} ${y0 - h} L ${sx + w / 2} ${y0} L ${sx - w / 2} ${y0} Z`; break;
    case 'drum':    shapePath = `M ${sx - w * 0.42} ${y0 - h} L ${sx + w * 0.42} ${y0 - h} L ${sx + w * 0.42} ${y0} L ${sx - w * 0.42} ${y0} Z`; break;
    case 'dome':    shapePath = `M ${sx - w / 2} ${y0} A ${w / 2} ${h} 0 0 1 ${sx + w / 2} ${y0} Z`; break;
    case 'globe':   shapePath = `M ${sx - 30} ${y0 - 26} A 30 30 0 1 1 ${sx - 30} ${y0 - 25.9} Z`; break;
    case 'pleated': shapePath = `M ${sx - w * 0.3} ${y0 - h} L ${sx + w * 0.3} ${y0 - h} L ${sx + w * 0.48} ${y0} L ${sx - w * 0.48} ${y0} Z`; break;
  }

  let pattern = '';
  if (d.pattern === 'stripes') pattern = `<pattern id="p${uid}" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="10" fill="${dark}" opacity="0.35"/></pattern>`;
  if (d.pattern === 'dots') pattern = `<pattern id="p${uid}" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="2" fill="${dark}" opacity="0.45"/></pattern>`;
  if (d.pattern === 'ribs') pattern = `<pattern id="p${uid}" width="12" height="6" patternUnits="userSpaceOnUse"><rect width="12" height="2" fill="${dark}" opacity="0.35"/></pattern>`;
  const pleats = d.shade === 'pleated'
    ? Array.from({ length: 7 }, (_, i) => {
        const t = (i + 1) / 8;
        return `<line x1="${sx - w * 0.3 + t * w * 0.6}" y1="${y0 - h}" x2="${sx - w * 0.48 + t * w * 0.96}" y2="${y0}" stroke="${dark}" stroke-opacity="0.4"/>`;
      }).join('') : '';

  const glowOpacity = (d.glow * 0.85).toFixed(2);
  return `<svg viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${d.shade} lamp">
    <defs>
      <radialGradient id="glow${uid}" cx="50%" cy="30%" r="60%">
        <stop offset="0%" stop-color="#ffd98a" stop-opacity="${glowOpacity}"/>
        <stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/>
      </radialGradient>
      ${pattern}
    </defs>
    <ellipse cx="${sx}" cy="${y0 + 60}" rx="90" ry="110" fill="url(#glow${uid})"/>
    <line x1="10" y1="${floorY}" x2="190" y2="${floorY}" stroke="currentColor" stroke-opacity="0.15"/>
    ${base}${stem}
    <path d="${shapePath}" fill="${fill}" stroke="${dark}" stroke-width="1.5"/>
    ${pattern ? `<path d="${shapePath}" fill="url(#p${uid})"/>` : ''}
    ${pleats}
  </svg>`;
}
