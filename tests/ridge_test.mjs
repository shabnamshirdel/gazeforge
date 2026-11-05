// Calibration-model tests on synthetic data (eye-gaze mode and head-pointing mode).
import { WebcamGaze } from '../web/js/gaze.js';
const W = 1400, H = 860, rnd = () => Math.random() - 0.5;
const pts = [[.5,.5],[.1,.1],[.5,.1],[.9,.1],[.9,.5],[.9,.9],[.5,.9],[.1,.9],[.1,.5],[.3,.3],[.7,.3],[.7,.7],[.3,.7]];
const VAL = [[.2,.25],[.8,.25],[.8,.75],[.2,.75],[.5,.3]];

// Eye mode: weak noisy iris features, cleaner blendshape features
const eyeFeat = (x, y) => {
  const u = x / W - 0.5, v = y / H - 0.5;
  return { raw: [0.25*u + rnd()*0.04, 0.12*v + rnd()*0.04, rnd()*0.004, rnd()*0.004, 0.5+rnd()*0.002, 0.45+rnd()*0.002, 0.12,
                 0.8*u + rnd()*0.05, 0.6*v + rnd()*0.05, 0.3 - 0.08*v + rnd()*0.01], open: 0.3 - 0.08*v + rnd()*0.01 };
};
// Head mode: head forward vector follows the target
const headFeat = (x, y) => {
  const u = x / W - 0.5, v = y / H - 0.5;
  return { raw: [rnd()*0.02, rnd()*0.02, 0.35*u + rnd()*0.006, 0.25*v + rnd()*0.006, 0.5+0.05*u, 0.45+0.04*v, 0.12, rnd()*0.1, rnd()*0.1, 0.3],
           open: 0.3 + rnd()*0.02 };
};
for (const [mode, f] of [['eyes', eyeFeat], ['head', headFeat]]) {
  const samples = [];
  for (const [fx, fy] of pts) for (let k = 0; k < 25; k++) samples.push({ feat: f(fx*W, fy*H), x: fx*W, y: fy*H });
  samples.push({ feat: { ...f(700, 430), open: 0.05 }, x: 700, y: 430 });
  const g = new WebcamGaze(null, mode);
  const fit = g.train(samples);
  let err = 0;
  for (const [fx, fy] of VAL) {
    const ps = Array.from({ length: 25 }, () => g.predictRaw(f(fx*W, fy*H)));
    err += Math.hypot(ps.reduce((s,p)=>s+p.x,0)/25 - fx*W, ps.reduce((s,p)=>s+p.y,0)/25 - fy*H);
  }
  console.log(`${mode}: chose '${fit.chosen}' λ=${fit.lambda}, cv ${fit.cvErrorPx}px, blinks dropped ${fit.dropped}, held-out error ${(err/VAL.length).toFixed(0)}px`);
}
