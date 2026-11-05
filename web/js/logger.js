// logger.js — session record, CSV export, download & upload helpers.
import { GENES } from './genome.js';

export function newSession(cfg) {
  return {
    schema: 'gazeforge/1',
    sessionId: `${cfg.pid}_${cfg.condition}_${new Date().toISOString().replace(/[:.]/g, '-')}`,
    startedAt: new Date().toISOString(),
    config: cfg,
    screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    userAgent: navigator.userAgent,
    calibration: null,
    rounds: [],
    gaze: [],          // downsampled samples: [tMs, x, y, optionSlot|-1]
    events: [],        // [tMs, type, payload]
    final: null,
    questionnaires: null,
    summary: null,
  };
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per (round × option) — the tidy format analysis/analyze.R expects. */
export function toCSV(session) {
  const c = session.config;
  const header = ['participant', 'condition', 'gaze_source', 'generator', 'round', 'slot', 'option_id', 'is_elite',
    'dwell_ms', 'entries', 'revisits', 'ttff_ms', 'weight', 'clicked', 'max_dwell', 'final_pick', 'final_round',
    'round_ms', 'sigma', 'n_rounds', 'tlx_raw', 'sus', ...GENES.map((g) => `gene_${g.key}`)];
  const rows = [header.join(',')];
  const fin = session.final || {};
  for (const r of session.rounds) {
    const maxDwell = Math.max(...r.options.map((o) => o.dwellMs));
    r.options.forEach((o, slot) => {
      rows.push([
        c.pid, c.condition, c.gazeSource, c.generator, r.round, slot, o.id, o.elite ? 1 : 0,
        Math.round(o.dwellMs), o.entries, Math.max(0, o.entries - 1), o.ttffMs ?? '',
        r.weights ? r.weights[slot].toFixed(4) : '',
        r.clickedSlot === slot ? 1 : 0,
        maxDwell > 0 && o.dwellMs === maxDwell ? 1 : 0,
        fin.optionId === o.id ? 1 : 0, fin.round ?? '',
        Math.round(r.durationMs), r.sigma?.toFixed(3) ?? '', session.rounds.length,
        session.questionnaires?.tlxRaw ?? '', session.questionnaires?.sus ?? '',
        ...GENES.map((g) => o.genes[g.key].toFixed(4)),
      ].map(csvCell).join(','));
    });
  }
  return rows.join('\n');
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function upload(backend, session) {
  const res = await fetch(`${backend}/api/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
