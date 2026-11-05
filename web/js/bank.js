// bank.js — "image bank" generator for the static (server-less) demo.
// A few hundred SDXL-Turbo renders were generated offline from genomes spread across the design space.
// Evolution runs exactly as usual in genome space; each new genome is then snapped to the closest
// rendered lamp, so every option on screen is a real generated image and its genome stays consistent.
import { randomGenome, genomeDistance } from './genome.js';

let BANK = null;

export async function loadBank() {
  if (BANK) return BANK;
  const r = await fetch('bank/manifest.json');
  if (!r.ok) throw new Error(`no image bank (HTTP ${r.status})`);
  const m = await r.json();
  BANK = { brief: m.brief, entries: m.entries };
  return BANK;
}

export async function hasBank() {
  try { await loadBank(); return true; } catch { return false; }
}

function fromEntry(e, extra = {}) {
  const g = randomGenome();              // fresh unique id
  g.genes = { ...e.genes }; g.seed = e.seed; g.bank = e.idx; g.file = e.file;
  return Object.assign(g, extra);
}

/** Farthest-point sample of n bank entries for round 1. */
export function bankStart(n) {
  const E = BANK.entries;
  const chosen = [E[Math.floor(Math.random() * E.length)]];
  while (chosen.length < n) {
    let best = null, bestD = -1;
    for (const e of E) {
      if (chosen.includes(e)) continue;
      const d = Math.min(...chosen.map((c) => genomeDistance(e, c)));
      if (d > bestD) { bestD = d; best = e; }
    }
    chosen.push(best);
  }
  return chosen.map((e) => fromEntry(e));
}

/** Snap evolved genomes to their nearest unused bank entries (the elite keeps its own image). */
export function snapToBank(next, current) {
  const used = new Set(current.map((g) => g.bank)); // don't re-show this round's lamps as "new" options
  return next.map((g) => {
    if (g.elite) return g;
    let best = null, bestD = Infinity;
    for (const e of BANK.entries) {
      if (used.has(e.idx)) continue;
      const d = genomeDistance(g, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    used.add(best.idx);
    return fromEntry(best, { elite: false, parents: g.parents });
  });
}
