// Re-fit the gaze model on a recorded session's raw calibration data.
// Usage: node real_data_test.mjs ../data/<session>.json
import { readFileSync } from 'node:fs';
import { WebcamGaze } from '../web/js/gaze.js';
const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const c = s.calibration, col = Object.fromEntries(c.rawColumns.map((n, i) => [n, i]));
const toSample = (r) => {
  const g = (n) => (n in col ? r[col[n]] : 0);
  return { x: g('x'), y: g('y'), feat: { open: g('open'),
    raw: [g('iris_h'), g('iris_v'), g('head_fwd_x'), g('head_fwd_y'), g('nose_x'), g('nose_y'), g('iod'), g('blend_h'), g('blend_v'), g('open')] } };
};
const cal = c.rawCalibration.map(toSample), val = c.rawValidation.map(toSample);
const gz = new WebcamGaze(null, c.mode === 'head' ? 'head' : 'eyes');
const fit = gz.train(cal);
const sel = gz.selectWithValidation(val);
console.log(`recorded: ${c.validationErrorPx}px (x ${c.validationErrorXpx}, y ${c.validationErrorYpx})`);
console.log(`new model: '${sel.chosen}' λ=${sel.lambda} → ${sel.err.toFixed(0)}px (x ${sel.errX.toFixed(0)}, y ${sel.errY.toFixed(0)})`);
console.log('top candidates:', sel.candidates.sort((a, b) => a.valErrorPx - b.valErrorPx).slice(0, 5).map(c => `${c.set}/${c.lambda}:${c.valErrorPx}`).join('  '));
