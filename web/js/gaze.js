// gaze.js — gaze sources.
//   MouseGaze  : the cursor stands in for gaze (development, demos, pilots without a camera)
//   WebcamGaze : MediaPipe FaceLandmarker iris + head-pose features -> ridge regression to screen
// Both expose: .point  {x, y, valid}  in viewport (CSS px) coordinates.

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ---------------------------------------------------------------------------
// One Euro filter (Casiez et al., CHI 2012): smooth when still, responsive when moving.
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; }
}
export class OneEuro {
  constructor({ minCutoff = 0.8, beta = 0.004, dCutoff = 1.0 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = new LowPass(); this.dx = new LowPass(); this.t = null; this.prev = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(value, tSec) {
    const dt = this.t === null ? 1 / 30 : Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const d = this.prev === null ? 0 : (value - this.prev) / dt;
    this.prev = value;
    const ed = this.dx.filter(d, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    return this.x.filter(value, OneEuro.alpha(cutoff, dt));
  }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.t = null; this.prev = null; }
}

// ---------------------------------------------------------------------------
export class MouseGaze {
  constructor() {
    this.kind = 'mouse';
    this.point = { x: 0, y: 0, valid: false };
    this._onMove = (e) => { this.point = { x: e.clientX, y: e.clientY, valid: true }; };
  }
  async init() { window.addEventListener('pointermove', this._onMove); return true; }
  get calibrated() { return true; }
  stop() { window.removeEventListener('pointermove', this._onMove); }
}

// ---------------------------------------------------------------------------
// Small linear algebra helpers for ridge regression.
function solve(A, b) { // Gaussian elimination with partial pivoting; A is n×n (array of arrays)
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

function ridge(X, y, lambda) {
  const p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 1; a < p; a++) XtX[a][a] += lambda; // don't penalise the intercept
  return solve(XtX, Xty);
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Landmark indices (MediaPipe Face Mesh with iris refinement, 478 points)
const EYE_R = { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 };
const EYE_L = { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 };
const NOSE = 1;

export class WebcamGaze {
  /** mode: 'eyes' (eye gaze) or 'head' (head pointing — far more robust with a webcam) */
  constructor(videoEl, mode = 'eyes') {
    this.kind = 'webcam';
    this.mode = mode;
    this.video = videoEl;
    this.point = { x: 0, y: 0, valid: false };
    this.faceFound = false;
    this.landmarker = null;
    this.model = null;           // { wx, wy, mean, std, openness }
    this.collecting = null;      // array receiving raw feature samples during calibration
    this.lastFeat = null;
    this.fx = new OneEuro({ minCutoff: 0.4, beta: 0.003 }); this.fy = new OneEuro({ minCutoff: 0.4, beta: 0.003 });
    this._running = false;
  }

  async init(onStatus = () => {}) {
    onStatus('Loading face model…');
    const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MP_MODEL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: true, // includes MediaPipe's own eyeLook{In,Out,Up,Down} estimates
    });
    try { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); }

    onStatus('Starting camera…');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    this.video.srcObject = stream;
    await this.video.play();
    this._running = true;
    this._loop();
    onStatus('Camera ready');
    return true;
  }

  get calibrated() { return !!this.model; }

  stop() {
    this._running = false;
    this.video.srcObject?.getTracks().forEach((t) => t.stop());
  }

  _loop() {
    if (!this._running) return;
    const now = performance.now();
    if (this.video.readyState >= 2 && now !== this._lastTs) {
      this._lastTs = now;
      const res = this.landmarker.detectForVideo(this.video, now);
      const lm = res.faceLandmarks?.[0];
      this.faceFound = !!lm;
      if (lm) {
        const feat = this._features(lm, res.facialTransformationMatrixes?.[0]?.data, res.faceBlendshapes?.[0]?.categories);
        this.lastFeat = feat;
        if (this.collecting) this.collecting.push(feat);
        if (this.model) this._predict(feat, now / 1000);
      } else {
        this.point = { ...this.point, valid: false };
      }
    }
    requestAnimationFrame(() => this._loop());
  }

  _eye(lm, e) {
    const A = lm[e.inner], B = lm[e.outer], T = lm[e.top], D = lm[e.bottom], I = lm[e.iris];
    const w = Math.hypot(B.x - A.x, B.y - A.y) || 1e-6;
    const cx = (A.x + B.x) / 2, cy = (T.y + D.y) / 2;
    // Signed horizontal offset along the eye axis, so both eyes agree in direction
    const ux = (B.x - A.x) / w, uy = (B.y - A.y) / w;
    const dx = I.x - cx, dy = I.y - cy;
    return { h: (dx * ux + dy * uy) / w * Math.sign(B.x - A.x || 1), v: dy / w, open: (D.y - T.y) / w, w };
  }

  _features(lm, mat, blend) {
    const r = this._eye(lm, EYE_R), l = this._eye(lm, EYE_L);
    const n = lm[NOSE];
    const iod = Math.hypot(lm[EYE_R.outer].x - lm[EYE_L.outer].x, lm[EYE_R.outer].y - lm[EYE_L.outer].y);
    // Head orientation: the face's forward axis from the transformation matrix (column-major 4×4)
    const fwdX = mat ? mat[8] : 0, fwdY = mat ? mat[9] : 0;
    // MediaPipe blendshape gaze: when looking toward one side, one eye looks "out" and the other "in".
    const b = {};
    (blend || []).forEach((c) => (b[c.categoryName] = c.score));
    const g = (k) => b[k] ?? 0;
    const bh = (g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2;
    const bv = (g('eyeLookUpLeft') + g('eyeLookUpRight') - g('eyeLookDownLeft') - g('eyeLookDownRight')) / 2;
    return {
      raw: [(r.h + l.h) / 2, (r.v + l.v) / 2, fwdX, fwdY, n.x, n.y, iod, bh, bv, (r.open + l.open) / 2],
      open: (r.open + l.open) / 2,
    };
  }

  // Candidate feature sets. Calibration fits all of them; the validation dots (collected *after*
  // calibration, so they include natural head drift) decide which one is used.
  //   lid   = eyelid opening — the upper lid follows vertical gaze, and on real webcam data this was a far
  //           better vertical cue than iris height (validation error 388 px -> ~56 px on pilot data)
  //   blend = MediaPipe eyeLook* blendshapes;  pose = head orientation;  head = head-pointing mode
  static _expand(z, set) { // z = standardised raw features
    const [h, v, fx, fy, nx, ny, iod, bh, bv, lid] = z;
    const quad = (a, c) => [a, c, a * c, a * a, c * c];
    switch (set) {
      case 'iris+lid+pose':  return [1, h, v, lid, fx, fy];
      case 'iris+lid':       return [1, h, v, lid];
      case 'iris+lid+blend': return [1, h, v, lid, bh, bv, fx, fy];
      case 'blend':          return [1, bh, bv, lid, fx, fy];
      case 'eye':            return [1, ...quad(h, v)];
      case 'head':           return [1, ...quad(fx, fy), nx, ny];
      default:               return [1, h, v, fx, fy, nx, ny, iod, bh, bv, lid]; // 'full'
    }
  }

  static SETS = { eyes: ['iris+lid+pose', 'iris+lid', 'iris+lid+blend', 'blend', 'eye', 'full'], head: ['head'] };
  static LAMBDAS = [0.1, 1, 5, 20, 50, 100];

  _standardise(raw, model = this.model) { return raw.map((x, i) => (x - model.mean[i]) / model.std[i]); }

  // Minimum scales per raw feature, so a feature that barely varied during calibration
  // (e.g. head position) can't be amplified into huge errors when it moves slightly later.
  static STD_FLOOR = [0.02, 0.015, 0.03, 0.03, 0.03, 0.03, 0.01, 0.05, 0.05, 0.01];

  /** Collect feature samples for `ms` milliseconds (call while the user fixates a target). */
  async collect(ms) {
    this.collecting = [];
    await new Promise((r) => setTimeout(r, ms));
    const s = this.collecting; this.collecting = null;
    return s;
  }

  /** samples: [{ feat, x, y }] gathered at calibration targets. */
  static _fit(good, set, lambda) {
    const p = good[0].feat.raw.length;
    const mean = new Array(p).fill(0), std = new Array(p).fill(0);
    good.forEach((s) => s.feat.raw.forEach((v, i) => (mean[i] += v / good.length)));
    good.forEach((s) => s.feat.raw.forEach((v, i) => (std[i] += (v - mean[i]) ** 2 / good.length)));
    for (let i = 0; i < p; i++) std[i] = Math.max(Math.sqrt(std[i]), WebcamGaze.STD_FLOOR[i] ?? 1e-3);
    const model = { mean, std, set, lambda };
    const X = good.map((s) => WebcamGaze._expand(s.feat.raw.map((x, i) => (x - mean[i]) / std[i]), set));
    model.wx = ridge(X, good.map((s) => s.x), lambda);
    model.wy = ridge(X, good.map((s) => s.y), lambda);
    return model;
  }

  static _apply(model, feat) {
    const x = WebcamGaze._expand(feat.raw.map((v, i) => (v - model.mean[i]) / model.std[i]), model.set);
    const dot = (w) => w.reduce((s, wi, i) => s + wi * x[i], 0);
    return { x: dot(model.wx), y: dot(model.wy) };
  }

  /**
   * samples: [{ feat, x, y }] gathered at calibration targets.
   * Chooses the feature set and ridge strength by leave-one-point-out cross-validation,
   * then refits on all points.
   */
  train(samples) {
    const openMed = median(samples.map((s) => s.feat.open));
    const good = samples.filter((s) => s.feat.open > 0.6 * openMed); // drop blinks
    const keyOf = (s) => `${Math.round(s.x)},${Math.round(s.y)}`;
    const pointKeys = [...new Set(good.map(keyOf))];

    let best = null;
    const results = [];
    for (const set of WebcamGaze.SETS[this.mode] ?? WebcamGaze.SETS.eyes) {
      for (const lambda of WebcamGaze.LAMBDAS) {
        let err = 0, n = 0;
        for (const k of pointKeys) {
          const train = good.filter((s) => keyOf(s) !== k);
          const test = good.filter((s) => keyOf(s) === k);
          if (!test.length || train.length < 20) continue;
          const m = WebcamGaze._fit(train, set, lambda);
          const preds = test.map((s) => WebcamGaze._apply(m, s.feat));
          const mx = preds.reduce((a, p) => a + p.x, 0) / preds.length;
          const my = preds.reduce((a, p) => a + p.y, 0) / preds.length;
          err += Math.hypot(mx - test[0].x, my - test[0].y); n++;
        }
        const cv = err / Math.max(1, n);
        results.push({ set, lambda, cvErrorPx: Math.round(cv) });
        if (!best || cv < best.cv) best = { set, lambda, cv };
      }
    }
    this.model = WebcamGaze._fit(good, best.set, best.lambda);
    this.model.openness = openMed;
    this._calGood = good; this._openMed = openMed;
    this.fx.reset(); this.fy.reset();
    return { used: good.length, dropped: samples.length - good.length, chosen: best.set, lambda: best.lambda,
             cvErrorPx: Math.round(best.cv), candidates: results };
  }

  /** Mean error per validation target for a model: { err, errX, errY } in px. */
  static _valError(model, val) {
    const groups = new Map();
    val.forEach((s) => { const k = `${Math.round(s.x)},${Math.round(s.y)}`; (groups.get(k) || groups.set(k, []).get(k)).push(s); });
    let e = 0, ex = 0, ey = 0;
    for (const g of groups.values()) {
      const ps = g.map((s) => WebcamGaze._apply(model, s.feat));
      const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length, my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
      e += Math.hypot(mx - g[0].x, my - g[0].y); ex += Math.abs(mx - g[0].x); ey += Math.abs(my - g[0].y);
    }
    const n = Math.max(1, groups.size);
    return { err: e / n, errX: ex / n, errY: ey / n };
  }

  /**
   * Pick the model that generalises best to the validation dots (shown after calibration, so they
   * capture real head drift), report its held-out error, then refit it on calibration + validation data.
   */
  selectWithValidation(valSamples) {
    const val = valSamples.filter((s) => s.feat.open > 0.6 * this._openMed);
    if (!val.length || !this._calGood) return null;
    let best = null;
    const candidates = [];
    for (const set of WebcamGaze.SETS[this.mode] ?? WebcamGaze.SETS.eyes) {
      for (const lambda of WebcamGaze.LAMBDAS) {
        const r = WebcamGaze._valError(WebcamGaze._fit(this._calGood, set, lambda), val);
        candidates.push({ set, lambda, valErrorPx: Math.round(r.err) });
        if (!best || r.err < best.err) best = { set, lambda, ...r };
      }
    }
    this.model = WebcamGaze._fit([...this._calGood, ...val], best.set, best.lambda);
    this.model.openness = this._openMed;
    this.fx.reset(); this.fy.reset();
    return { chosen: best.set, lambda: best.lambda, err: best.err, errX: best.errX, errY: best.errY, candidates };
  }

  predictRaw(feat) { return WebcamGaze._apply(this.model, feat); }

  _predict(feat, tSec) {
    if (feat.open < 0.55 * this.model.openness) return; // blink: hold last point
    const p = this.predictRaw(feat);
    const W = window.innerWidth, H = window.innerHeight;
    this.point = {
      x: Math.min(W, Math.max(0, this.fx.filter(p.x, tSec))),
      y: Math.min(H, Math.max(0, this.fy.filter(p.y, tSec))),
      valid: true,
    };
  }
}
