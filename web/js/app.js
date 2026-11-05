// app.js — GazeForge session controller.
import { randomGenome, evolve, renderSVG, toPrompt, diversity, genomeDistance } from './genome.js';
import { MouseGaze, WebcamGaze } from './gaze.js';
import { newSession, toCSV, download, upload } from './logger.js';
import { renderQuestionnaires, scoreQuestionnaires } from './questionnaires.js';

const $ = (s) => document.querySelector(s);
const N_OPTIONS = 4;
const FIXATION_MS = 100;      // gaze must stay on a card this long before it counts (filters saccade fly-overs)
const REVISIT_BONUS_MS = 250; // each return to a card counts like 250 ms of extra dwell
const STEER_SHOW_MS = 1200;
const GAZE_LOG_HZ = 30;

const INSTRUCTIONS = {
  explicit: 'Click the design closest to what you want — new variations grow from it.',
  gaze: 'Just look at the designs. GazeForge notices what holds your attention and evolves from it.',
  hybrid: 'Look freely — your gaze steers. Click a design to strongly favour it, or press Space to move on.',
};
const COND_LABEL = { explicit: 'A · Explicit', gaze: 'B · Gaze', hybrid: 'C · Hybrid' };

const S = {
  cfg: null, gaze: null, calib: null, session: null,
  phase: 'idle',               // idle | loading | round | steer | pick | done
  round: 0, options: [], seen: [],
  stats: [], rects: [],
  cand: null, candSince: 0, committed: null,
  roundStart: 0, sessionT0: 0, lastLog: 0, lastFrame: 0,
  timerId: null, cards: [],
};

// ---------------------------------------------------------------------------
// Utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.classList.toggle('hidden', !msg); }
const now = () => performance.now();
const tRel = () => Math.round(now() - S.sessionT0);
function logEvent(type, payload = {}) { S.session?.events.push([tRel(), type, payload]); }

// ---------------------------------------------------------------------------
// Setup screen
const form = $('#setup-form');
if (location.protocol.startsWith('http') && location.port) form.backend.value = location.origin;
form.backend.addEventListener('change', checkBackend);
checkBackend();

async function checkBackend() {
  const pill = $('#backend-status');
  const url = form.backend.value.trim().replace(/\/$/, '');
  if (!url) { pill.textContent = 'none'; pill.className = 'pill'; return null; }
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    pill.textContent = `ok · ${j.mode}${j.mode === 'comfy' ? (j.comfy_reachable ? ' ✓' : ' (ComfyUI unreachable)') : ''}`;
    pill.className = 'pill ok';
    return j;
  } catch { pill.textContent = 'unreachable'; pill.className = 'pill'; return null; }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  S.cfg = {
    pid: fd.get('pid').trim() || 'P00',
    condition: fd.get('condition'),
    gazeSource: fd.get('gazeSource'),
    generator: fd.get('generator'),
    roundSec: Number(fd.get('roundSec')),
    maxRounds: Number(fd.get('maxRounds')),
    brief: fd.get('brief').trim(),
    backend: fd.get('backend').trim().replace(/\/$/, ''),
    showGaze: fd.get('showGaze') === 'on',
    showHeat: fd.get('showHeat') === 'on',
    showSteer: fd.get('showSteer') === 'on',
    questionnaires: fd.get('questionnaires') === 'on',
  };
  if (S.cfg.generator === 'comfy' && !S.cfg.backend) { toast('ComfyUI mode needs a backend URL'); return; }

  if (S.cfg.gazeSource === 'mouse') {
    if (S.gaze?.kind !== 'mouse') { S.gaze?.stop(); S.gaze = new MouseGaze(); await S.gaze.init(); }
    S.calib = { method: 'none (mouse)' };
    startTrial();
  } else {
    const mode = S.cfg.gazeSource === 'headpose' ? 'head' : 'eyes';
    if (S.gaze?.kind !== 'webcam') { S.gaze?.stop(); S.gaze = new WebcamGaze($('#cam'), mode); S.gaze._needsInit = true; }
    S.gaze.mode = mode;
    runCalibration();
  }
});

// ---------------------------------------------------------------------------
// Calibration (9 points) + validation (4 points)
const CAL_POINTS = [[.5, .5], [.1, .1], [.5, .1], [.9, .1], [.9, .5], [.9, .9], [.5, .9], [.1, .9], [.1, .5],
  [.3, .3], [.7, .3], [.7, .7], [.3, .7]];
const VAL_POINTS = [[.2, .25], [.8, .25], [.8, .75], [.2, .75], [.5, .3]];

async function runCalibration() {
  show('screen-calib');
  $('#calib-msg').classList.remove('hidden');
  $('#calib-result').classList.add('hidden');
  const status = $('#calib-status'), startBtn = $('#calib-start');
  startBtn.disabled = true;
  if (S.gaze._needsInit) {
    try {
      await S.gaze.init((m) => (status.textContent = m));
      S.gaze._needsInit = false;
    } catch (err) {
      console.error(err);
      status.textContent = `Could not start webcam gaze: ${err.message}. Go back and choose "Mouse as gaze".`;
      return;
    }
  }
  $('#cam').classList.remove('hidden');
  status.textContent = S.gaze.mode === 'head'
    ? 'Camera ready. HEAD POINTING: imagine a laser pointer on your nose — turn your head gently to point it at each dot.'
    : 'Camera ready. Centre your face in the preview, keep your head still and follow each dot with your EYES.';
  startBtn.disabled = false;
  startBtn.onclick = doCalibration;
}

async function showDotAndCollect(px, py, settleMs, collectMs) {
  const dot = $('#calib-dot');
  dot.style.left = `${px}px`; dot.style.top = `${py}px`;
  dot.classList.remove('hidden', 'shrink'); void dot.offsetWidth;
  dot.style.setProperty('--dur', `${settleMs + collectMs}ms`);
  dot.classList.add('shrink');
  await sleep(settleMs);
  const feats = await S.gaze.collect(collectMs);
  return feats;
}

async function doCalibration() {
  $('#calib-msg').classList.add('hidden');
  $('#cam').classList.add('hidden');
  const W = window.innerWidth, H = window.innerHeight;
  const samples = [];
  for (const [fx, fy] of CAL_POINTS) {
    const x = fx * W, y = fy * H;
    const feats = await showDotAndCollect(x, y, 700, 1000);
    feats.forEach((feat) => samples.push({ feat, x, y }));
    await sleep(150);
  }
  if (samples.length < 40) {
    $('#calib-dot').classList.add('hidden');
    $('#calib-msg').classList.remove('hidden');
    $('#calib-status').textContent = 'Not enough face data — check lighting and that your face is visible, then retry.';
    return;
  }
  const fit = S.gaze.train(samples);

  // Validation on points not used for training
  const errs = [], errX = [], errY = [], valSamples = [];
  for (const [fx, fy] of VAL_POINTS) {
    const x = fx * W, y = fy * H;
    const feats = (await showDotAndCollect(x, y, 700, 900)).filter((f) => f.open > 0.55 * S.gaze.model.openness);
    feats.forEach((f) => valSamples.push({ feat: f, x, y }));
    if (!feats.length) continue;
    const preds = feats.map((f) => S.gaze.predictRaw(f));
    const mx = preds.reduce((s, p) => s + p.x, 0) / preds.length;
    const my = preds.reduce((s, p) => s + p.y, 0) / preds.length;
    errs.push(Math.hypot(mx - x, my - y)); errX.push(Math.abs(mx - x)); errY.push(Math.abs(my - y));
  }
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  // Raw samples are kept so the gaze model can be re-fit / debugged offline
  const pack = (arr) => arr.map((s) => [Math.round(s.x), Math.round(s.y), Math.round(s.feat.open * 1e4) / 1e4,
    ...s.feat.raw.map((v) => Math.round(v * 1e5) / 1e5)]);
  $('#calib-dot').classList.add('hidden');
  // Choose the model that best predicts the validation dots, then refit on all data
  const sel = S.gaze.selectWithValidation(valSamples);
  if (sel) {
    errs.length = 0; errX.length = 0; errY.length = 0;
    errs.push(sel.err); errX.push(sel.errX); errY.push(sel.errY);
    fit.chosen = sel.chosen; fit.lambda = sel.lambda; fit.validationCandidates = sel.candidates;
  }
  const meanErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  const pctW = (meanErr / W) * 100;
  S.calib = {
    method: 'webcam-ridge-9pt', samplesUsed: fit.used, samplesDropped: fit.dropped,
    model: { features: fit.chosen, lambda: fit.lambda, cvErrorPx: fit.cvErrorPx, candidates: fit.candidates, validationCandidates: fit.validationCandidates },
    validationErrorPx: Math.round(meanErr), validationErrorPctWidth: Math.round(pctW * 10) / 10,
    validationErrorXpx: Math.round(avg(errX)), validationErrorYpx: Math.round(avg(errY)),
    screen: { w: W, h: H },
    rawColumns: ['x', 'y', 'open', 'iris_h', 'iris_v', 'head_fwd_x', 'head_fwd_y', 'nose_x', 'nose_y', 'iod', 'blend_h', 'blend_v', 'lid'],
    mode: S.gaze.mode,
    rawCalibration: pack(samples), rawValidation: pack(valSamples),
  };
  const quality = pctW < 8 ? 'good' : pctW < 14 ? 'usable' : 'poor — consider recalibrating';
  $('#calib-acc').textContent = `Mean validation error ≈ ${Math.round(meanErr)} px (${pctW.toFixed(1)}% of screen width; ` +
    `horizontal ${Math.round(avg(errX))} px, vertical ${Math.round(avg(errY))} px) — ${quality}. ` +
    `Model: ${fit.chosen} features (λ=${fit.lambda}). The dot shows your live gaze — look around to check it before continuing.`;
  $('#calib-result').classList.remove('hidden');
  $('#gaze-dot').classList.remove('hidden');
}
$('#calib-redo').onclick = () => { $('#calib-result').classList.add('hidden'); $('#gaze-dot').classList.add('hidden'); doCalibration(); };
$('#calib-continue').onclick = () => startTrial();

// ---------------------------------------------------------------------------
// Trial
function diverseStart(n) {
  // Farthest-point sampling from a random pool, so round 1 spans the design space.
  const pool = Array.from({ length: 24 }, randomGenome);
  const chosen = [pool.splice(Math.floor(Math.random() * pool.length), 1)[0]];
  while (chosen.length < n) {
    let best = 0, bestD = -1;
    pool.forEach((g, i) => {
      const d = Math.min(...chosen.map((c) => genomeDistance(g, c)));
      if (d > bestD) { bestD = d; best = i; }
    });
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen;
}

function startTrial() {
  S.session = newSession(S.cfg);
  S.session.calibration = S.calib;
  S.sessionT0 = now();
  S.round = 0;
  S.options = diverseStart(N_OPTIONS);
  S.seen = [...S.options];
  $('#trial-brief').textContent = S.cfg.brief;
  $('#trial-cond').textContent = COND_LABEL[S.cfg.condition];
  $('#trial-instr').textContent = INSTRUCTIONS[S.cfg.condition];
  $('#btn-next').classList.toggle('hidden', S.cfg.condition === 'explicit');
  $('#gaze-dot').classList.toggle('hidden', !S.cfg.showGaze);
  banner('');
  show('screen-trial');
  logEvent('trial_start', { condition: S.cfg.condition });
  beginRound();
}

function buildCards() {
  const grid = $('#grid');
  grid.className = 'grid';
  grid.innerHTML = '';
  S.cards = S.options.map((g, slot) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.slot = slot;
    el.innerHTML = `<span class="tag">${g.elite ? 'carried over' : `option ${slot + 1}`}</span>
      <div class="art"></div><div class="wbar"></div><span class="wlabel"></span>`;
    grid.appendChild(el);
    return el;
  });
}

async function renderOptions() {
  if (S.cfg.generator === 'mock') {
    S.options.forEach((g, i) => { S.cards[i].querySelector('.art').innerHTML = renderSVG(g); });
    return { generator: 'mock' };
  }
  // ComfyUI through the FastAPI bridge
  S.cards.forEach((c) => c.classList.add('loading'));
  const items = S.options.map((g) => { g.prompt = toPrompt(g, S.cfg.brief); return g.prompt; });
  const t0 = now();
  try {
    const res = await fetch(`${S.cfg.backend}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, width: 512, height: 512 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const { images } = await res.json();
    await Promise.all(images.map((src, i) => new Promise((resolve) => {
      const img = new Image(); img.onload = img.onerror = resolve; img.src = src; img.alt = `design option ${i + 1}`;
      S.cards[i].querySelector('.art').replaceChildren(img);
    })));
    return { generator: 'comfy', genMs: Math.round(now() - t0) };
  } catch (err) {
    console.error(err);
    toast(`Generation failed (${err.message}) — showing mock designs for this round`, 4000);
    S.options.forEach((g, i) => { S.cards[i].querySelector('.art').innerHTML = renderSVG(g); });
    return { generator: 'mock-fallback', error: String(err.message) };
  } finally {
    S.cards.forEach((c) => c.classList.remove('loading'));
  }
}

async function beginRound() {
  S.phase = 'loading';
  $('#trial-round').textContent = `Round ${S.round + 1} / ${S.cfg.maxRounds}`;
  $('#timer-bar').style.transition = 'none'; $('#timer-bar').style.width = '0';
  buildCards();
  S.renderInfo = await renderOptions();
  S.stats = S.options.map(() => ({ dwellMs: 0, entries: 0, ttffMs: null }));
  S.cand = null; S.committed = null;
  measureRects();
  S.roundStart = now();
  S.phase = 'round';
  logEvent('round_start', { round: S.round, ids: S.options.map((o) => o.id) });
  startTimer();
}

function startTimer() {
  clearTimeout(S.timerId);
  const sec = S.cfg.roundSec;
  if (S.cfg.condition === 'explicit' || !sec) return;
  const bar = $('#timer-bar');
  requestAnimationFrame(() => {
    bar.style.transition = `width ${sec}s linear`;
    bar.style.width = '100%';
  });
  S.timerId = setTimeout(() => { if (S.phase === 'round') endRound('timer'); }, sec * 1000);
}

function measureRects() { S.rects = S.cards.map((c) => c.getBoundingClientRect()); }
window.addEventListener('resize', () => { if (S.cards.length) measureRects(); });

const HIT_MARGIN = 40; // gaze landing in the gap between cards counts for the nearest card
function hitTest(x, y) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < S.rects.length; i++) {
    const r = S.rects[i];
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= HIT_MARGIN ? best : null;
}

function gazeWeights() {
  const scores = S.stats.map((s) => s.dwellMs + REVISIT_BONUS_MS * Math.max(0, s.entries - 1));
  const n = scores.length;
  const sharp = scores.map((s) => Math.pow(s, 1.5));
  const total = sharp.reduce((a, b) => a + b, 0);
  const w = total > 0 ? sharp.map((s) => s / total) : new Array(n).fill(1 / n);
  return w.map((wi) => 0.9 * wi + 0.1 / n); // keep a little exploration for every option
}

function oneHot(slot, n) { return Array.from({ length: n }, (_, i) => (i === slot ? 1 : 0)); }
const mix = (a, b, t) => a.map((ai, i) => t * ai + (1 - t) * b[i]);

function recordRound(endedBy, clickedSlot = null, weights = null, sigma = null) {
  const gw = gazeWeights();
  const rec = {
    round: S.round,
    endedBy,
    clickedSlot,
    durationMs: now() - S.roundStart,
    render: S.renderInfo,
    gazeWeights: gw,
    weights,
    sigma,
    options: S.options.map((g, i) => ({
      id: g.id, elite: !!g.elite, seed: g.seed, parents: g.parents, genes: { ...g.genes },
      prompt: g.prompt?.prompt ?? null,
      dwellMs: S.stats[i].dwellMs, entries: S.stats[i].entries, ttffMs: S.stats[i].ttffMs,
    })),
  };
  S.session.rounds.push(rec);
  return rec;
}

async function endRound(endedBy, clickedSlot = null) {
  if (S.phase !== 'round') return;
  S.phase = 'steer';
  clearTimeout(S.timerId);
  const n = S.options.length;
  const gw = gazeWeights();
  let weights;
  if (S.cfg.condition === 'explicit') weights = mix(oneHot(clickedSlot, n), new Array(n).fill(1 / n), 0.9);
  else if (S.cfg.condition === 'hybrid' && clickedSlot !== null) weights = mix(oneHot(clickedSlot, n), gw, 0.6);
  else weights = gw;

  const isLast = S.round + 1 >= S.cfg.maxRounds;
  const { next, sigma } = evolve(S.options, weights, S.round, N_OPTIONS);
  recordRound(endedBy, clickedSlot, weights, sigma);
  logEvent('round_end', { round: S.round, endedBy, clickedSlot });

  if (clickedSlot !== null) S.cards[clickedSlot].classList.add('picked');
  if (S.cfg.showSteer) {
    const grid = $('#grid');
    S.cards.forEach((c, i) => {
      c.style.setProperty('--w', (weights[i] / Math.max(...weights)).toFixed(3));
      c.querySelector('.wbar').style.width = `${Math.round(weights[i] * 100)}%`;
      c.querySelector('.wlabel').textContent = `${Math.round(weights[i] * 100)}% influence`;
    });
    grid.classList.add('steering');
    const why = S.cfg.condition === 'explicit' || clickedSlot !== null ? 'your choice' : 'what held your attention';
    banner(isLast ? 'Last round reached' : `Evolving from ${why}…`);
    await sleep(STEER_SHOW_MS);
    banner('');
  }

  if (isLast) { enterPick(true); return; }
  $('#grid').classList.add('fading');
  await sleep(300);
  S.options = next;
  S.seen.push(...next.filter((g) => !g.elite));
  S.round += 1;
  beginRound();
}

function enterPick(afterLastRound = false) {
  if (S.phase === 'round') { clearTimeout(S.timerId); recordRound('done'); }
  S.phase = 'pick';
  const grid = $('#grid');
  grid.classList.remove('steering', 'fading');
  S.cards.forEach((c) => { c.classList.remove('picked'); c.style.removeProperty('--w'); c.querySelector('.wbar').style.width = '0'; });
  grid.classList.add('picking');
  $('#timer-bar').style.transition = 'none'; $('#timer-bar').style.width = '0';
  banner(afterLastRound ? 'Last round — click your final design' : 'Click the design you are happiest with');
  logEvent('pick_start', { afterLastRound });
}

async function finalize(slot) {
  S.phase = 'done';
  banner('');
  S.cards[slot].classList.add('picked');
  const g = S.options[slot];
  S.session.final = { slot, optionId: g.id, round: S.round, genes: { ...g.genes }, prompt: g.prompt?.prompt ?? null, tMs: tRel() };
  S.finalArt = S.cards[slot].querySelector('.art').innerHTML;
  logEvent('final_pick', { slot, id: g.id });
  await sleep(600);
  if (S.cfg.questionnaires) {
    renderQuestionnaires($('#tlx'), $('#sus'));
    show('screen-quest');
  } else finishSession();
}

$('#quest-form').addEventListener('submit', (e) => {
  e.preventDefault();
  S.session.questionnaires = scoreQuestionnaires(e.target);
  finishSession();
});

function summarise() {
  const s = S.session;
  const rounds = s.rounds;
  const lastRec = rounds[rounds.length - 1];
  const finalSlot = s.final.slot;
  const maxDwellSlot = (rec) => {
    const d = rec.options.map((o) => o.dwellMs);
    const m = Math.max(...d);
    return m > 0 ? d.indexOf(m) : null;
  };
  const clickedRounds = rounds.filter((r) => r.clickedSlot !== null && r.clickedSlot !== undefined);
  const agree = clickedRounds.filter((r) => maxDwellSlot(r) === r.clickedSlot).length;
  return {
    nRounds: rounds.length,
    totalSec: Math.round((s.final.tMs) / 100) / 10,
    designsSeen: S.seen.length,
    diversity: Math.round(diversity(S.seen) * 1000) / 1000,
    finalRound: s.final.round + 1,
    gazePredictsFinal: maxDwellSlot(lastRec) === finalSlot,
    gazeClickAgreement: clickedRounds.length ? Math.round((agree / clickedRounds.length) * 100) : null,
    calibErrorPx: s.calibration?.validationErrorPx ?? null,
    tlxRaw: s.questionnaires?.tlxRaw ?? null,
    sus: s.questionnaires?.sus ?? null,
  };
}

async function finishSession() {
  S.session.summary = summarise();
  S.session.endedAt = new Date().toISOString();
  const sm = S.session.summary;
  $('#summary-final').innerHTML = `<div class="art" style="display:grid;place-items:center">${S.finalArt}</div>`;
  const stat = (k, v) => `<div><dt>${k}</dt><dd>${v ?? '—'}</dd></div>`;
  $('#summary-stats').innerHTML = [
    stat('Rounds', sm.nRounds), stat('Time to final (s)', sm.totalSec), stat('Designs explored', sm.designsSeen),
    stat('Exploration diversity', sm.diversity), stat('Gaze predicted final pick', sm.gazePredictsFinal ? 'yes' : 'no'),
    stat('Gaze ↔ click agreement', sm.gazeClickAgreement === null ? '—' : `${sm.gazeClickAgreement}%`),
    stat('Calibration error (px)', sm.calibErrorPx), stat('NASA-TLX (raw)', sm.tlxRaw), stat('SUS', sm.sus),
  ].join('');
  show('screen-summary');
  $('#gaze-dot').classList.add('hidden');
  $('#face-warn').classList.add('hidden');
  const up = $('#upload-status');
  up.textContent = '';
  if (S.cfg.backend) {
    try { const r = await upload(S.cfg.backend, S.session); up.textContent = `Saved on server: ${r.saved}`; }
    catch (err) { up.textContent = `Server upload failed (${err.message}) — use the download buttons.`; }
  }
}

$('#dl-json').onclick = () => download(`${S.session.sessionId}.json`, JSON.stringify(S.session, null, 1));
$('#dl-csv').onclick = () => download(`${S.session.sessionId}.csv`, toCSV(S.session), 'text/csv');
$('#btn-again').onclick = () => { S.phase = 'idle'; show('screen-setup'); };

// ---------------------------------------------------------------------------
// Input
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const slot = Number(card.dataset.slot);
  if (S.phase === 'pick') return finalize(slot);
  if (S.phase !== 'round') return;
  if (S.cfg.condition === 'gaze') { toast('In this condition, just look — no clicking needed. Press Enter when you are happy.'); return; }
  logEvent('click', { slot });
  endRound('click', slot);
});
$('#btn-next').onclick = () => { if (S.phase === 'round') endRound('space'); };
$('#btn-done').onclick = () => { if (S.phase === 'round') enterPick(); };

window.addEventListener('keydown', (e) => {
  if (!$('#screen-trial').classList.contains('active')) return;
  if (e.code === 'Space') { e.preventDefault(); if (S.phase === 'round' && S.cfg.condition !== 'explicit') endRound('space'); }
  if (e.code === 'Enter') { e.preventDefault(); if (S.phase === 'round') enterPick(); }
  if (e.key === 'g' || e.key === 'G') { S.cfg.showGaze = !S.cfg.showGaze; $('#gaze-dot').classList.toggle('hidden', !S.cfg.showGaze); }
  if (e.key === 'h' || e.key === 'H') { S.cfg.showHeat = !S.cfg.showHeat; if (!S.cfg.showHeat) S.cards.forEach((c) => c.style.setProperty('--heat', 0)); }
});

// ---------------------------------------------------------------------------
// Main gaze loop: fixation filtering, dwell/entry accounting, logging
function frame() {
  const t = now();
  const dt = S.lastFrame ? Math.min(100, t - S.lastFrame) : 16;
  S.lastFrame = t;
  const g = S.gaze;
  const trialActive = $('#screen-trial').classList.contains('active');
  const calibCheck = !$('#calib-result').classList.contains('hidden') && $('#screen-calib').classList.contains('active');

  if (g && calibCheck && g.point.valid) {
    const dot = $('#gaze-dot');
    dot.style.left = `${g.point.x}px`; dot.style.top = `${g.point.y}px`; dot.style.opacity = 1;
  }

  if (g && trialActive) {
    const p = g.point;
    const dot = $('#gaze-dot');
    if (p.valid) { dot.style.left = `${p.x}px`; dot.style.top = `${p.y}px`; }
    dot.style.opacity = p.valid ? 1 : 0.2;
    if (g.kind === 'webcam') $('#face-warn').classList.toggle('hidden', g.faceFound);

    const slot = p.valid ? hitTest(p.x, p.y) : null;

    if (S.phase === 'round') {
      if (slot !== S.cand) { S.cand = slot; S.candSince = t; }
      if (S.cand !== S.committed && t - S.candSince >= FIXATION_MS) {
        S.committed = S.cand;
        if (S.committed !== null) {
          const st = S.stats[S.committed];
          st.entries += 1;
          if (st.ttffMs === null) st.ttffMs = Math.round(S.candSince - S.roundStart);
          st.dwellMs += t - S.candSince; // credit the fixation-confirmation window
        }
      } else if (S.committed !== null && slot === S.committed) {
        S.stats[S.committed].dwellMs += dt;
      }
      if (S.cfg.showHeat) {
        const max = Math.max(1, ...S.stats.map((s) => s.dwellMs));
        S.cards.forEach((c, i) => c.style.setProperty('--heat', (S.stats[i].dwellMs / max).toFixed(3)));
      }
    }

    if (S.session && t - S.lastLog >= 1000 / GAZE_LOG_HZ) {
      S.lastLog = t;
      S.session.gaze.push([tRel(), p.valid ? Math.round(p.x) : null, p.valid ? Math.round(p.y) : null, slot ?? -1]);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for debugging / automated tests
window.__gazeforge = S;
