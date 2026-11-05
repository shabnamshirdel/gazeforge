// questionnaires.js — Raw NASA-TLX (Hart, 2006) and SUS (Brooke, 1996).

export const TLX = [
  ['mental', 'Mental demand — how mentally demanding was the task?', 'Very low', 'Very high'],
  ['physical', 'Physical demand — how physically demanding was the task?', 'Very low', 'Very high'],
  ['temporal', 'Temporal demand — how hurried or rushed was the pace?', 'Very low', 'Very high'],
  ['performance', 'Performance — how successful were you in getting a design you liked?', 'Perfect', 'Failure'],
  ['effort', 'Effort — how hard did you have to work to get there?', 'Very low', 'Very high'],
  ['frustration', 'Frustration — how insecure, irritated or stressed were you?', 'Very low', 'Very high'],
];

export const SUS = [
  'I think that I would like to use this system frequently.',
  'I found the system unnecessarily complex.',
  'I thought the system was easy to use.',
  'I think that I would need the support of a technical person to be able to use this system.',
  'I found the various functions in this system were well integrated.',
  'I thought there was too much inconsistency in this system.',
  'I would imagine that most people would learn to use this system very quickly.',
  'I found the system very cumbersome to use.',
  'I felt very confident using the system.',
  'I needed to learn a lot of things before I could get going with this system.',
];

export function renderQuestionnaires(tlxEl, susEl) {
  tlxEl.innerHTML = TLX.map(([k, q, lo, hi]) => `
    <div class="tlx-item">
      <div class="q">${q}</div>
      <input type="range" name="tlx_${k}" min="0" max="100" step="5" value="50" />
      <div class="ends"><span>${lo}</span><span>${hi}</span></div>
    </div>`).join('');
  susEl.innerHTML = SUS.map((q, i) => `
    <div class="sus-item">
      <span>${i + 1}. ${q}</span>
      <span class="opts">${[1, 2, 3, 4, 5].map((v) =>
        `<label><input type="radio" name="sus_${i}" value="${v}" required />${v}</label>`).join('')}</span>
    </div>`).join('');
}

export function scoreQuestionnaires(form) {
  const fd = new FormData(form);
  const tlx = Object.fromEntries(TLX.map(([k]) => [k, Number(fd.get(`tlx_${k}`))]));
  const tlxRaw = Object.values(tlx).reduce((a, b) => a + b, 0) / TLX.length;
  const susItems = SUS.map((_, i) => Number(fd.get(`sus_${i}`)));
  // SUS: odd items (1,3,5…) score−1, even items 5−score; sum × 2.5 → 0–100
  const sus = susItems.reduce((s, v, i) => s + (i % 2 === 0 ? v - 1 : 5 - v), 0) * 2.5;
  return { tlx, tlxRaw: Math.round(tlxRaw * 10) / 10, susItems, sus };
}
