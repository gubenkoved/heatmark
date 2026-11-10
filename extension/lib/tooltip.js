// App tooltips replacing the browser's native ones.
//
// Any element with data-tip (or a plain title, which is converted on first hover so the native
// tooltip never appears) gets a styled tooltip. It shows after a short delay; moving to another
// tooltip target soon after shows it immediately. Text may contain "\n" for extra lines; a
// line "a · b" keeps its look. Placement: above the target, flipping below, clamped to the viewport.

const DELAY = 450;   // ms before the first tooltip
const WARM = 400;    // ms after hiding during which the next one shows instantly
const GAP = 7;       // px between target and tooltip
const EDGE = 8;      // px viewport margin

let tip = null, target = null, showTimer = 0, lastHide = 0;

function el() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  return tip;
}

function textOf(t) {
  if (t.hasAttribute('title')) {
    const v = t.getAttribute('title');
    t.removeAttribute('title');
    if (v) {
      t.dataset.tip = v;
      if (!t.getAttribute('aria-label') && !t.textContent.trim()) t.setAttribute('aria-label', v);
    }
  }
  return t.dataset.tip || '';
}

function place(t) {
  const box = el();
  const r = t.getBoundingClientRect();
  box.style.left = '0px';
  box.style.top = '0px';
  const w = box.offsetWidth, h = box.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let below = r.top - GAP - h < EDGE;
  if (below && r.bottom + GAP + h > vh - EDGE) below = false;
  const top = below ? r.bottom + GAP : r.top - GAP - h;
  const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), vw - EDGE - w);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.dataset.side = below ? 'below' : 'above';
}

function show(t) {
  const text = textOf(t);
  if (!text) return;
  const box = el();
  box.textContent = text;
  box.classList.remove('on');
  place(t);
  // next frame so the transition runs from the placed position
  requestAnimationFrame(() => { if (target === t) box.classList.add('on'); });
}

function hide() {
  clearTimeout(showTimer);
  if (tip?.classList.contains('on')) lastHide = Date.now();
  tip?.classList.remove('on');
  target = null;
}

export function installTooltips(root = document) {
  root.addEventListener('pointerover', (ev) => {
    const t = ev.target.closest?.('[data-tip], [title]');
    if (t === target) return;
    if (!t) { if (target && !target.contains(ev.target)) hide(); return; }
    // convert now so the native tooltip can't start its own timer
    textOf(t);
    if (!t.dataset.tip) return;
    clearTimeout(showTimer);
    const warm = (tip?.classList.contains('on')) || Date.now() - lastHide < WARM;
    if (tip?.classList.contains('on')) lastHide = Date.now();
    tip?.classList.remove('on');
    target = t;
    showTimer = setTimeout(() => { if (target === t && t.isConnected) show(t); }, warm ? 0 : DELAY);
  });
  root.addEventListener('pointerout', (ev) => {
    if (!target) return;
    const to = ev.relatedTarget;
    if (to && target.contains(to)) return;
    if (to?.closest?.('[data-tip], [title]')) return; // pointerover will take over
    hide();
  });
  for (const type of ['pointerdown', 'keydown', 'wheel']) root.addEventListener(type, hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  // hide only when the target itself moves (its scroller scrolled), not on unrelated scrolls
  window.addEventListener('scroll', (ev) => {
    if (target && (ev.target === document || ev.target.contains?.(target))) hide();
  }, { capture: true, passive: true });
}
