// Overlay scrollbars: native bars are hidden (CSS on [data-scroll]); a thin thumb is drawn
// over the scroll area's edge. It appears while scrolling or hovering, widens under the
// pointer, can be dragged, and clicking the track pages. The host (parent) also gets
// sc-shadow-top / sc-shadow-left while content is scrolled away from the start.

const attached = new WeakMap();
const INSET = 3;   // px between thumb and track ends
const MIN = 28;    // px minimum thumb length
const HIT = 12;    // px track thickness (hit area; the visible thumb is thinner)

export function attachScrollbar(el, axis = 'y') {
  if (attached.has(el)) return attached.get(el);
  const host = el.parentElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.classList.add('sc-host');
  const y = axis === 'y';
  const track = document.createElement('div');
  track.className = `sc-track sc-${axis} none`;
  const thumb = document.createElement('div');
  thumb.className = 'sc-thumb';
  track.append(thumb);
  host.append(track);

  let raf = 0, hideTimer = 0, drag = null;
  let geo = { pos: 0, size: 0, total: 0, len: 0, tl: 0 };

  function update() {
    raf = 0;
    const pos = y ? el.scrollTop : el.scrollLeft;
    const size = y ? el.clientHeight : el.clientWidth;
    const total = y ? el.scrollHeight : el.scrollWidth;
    const can = size > 0 && total > size + 1 && el.offsetParent !== null;
    track.classList.toggle('none', !can);
    host.classList.toggle(y ? 'sc-shadow-top' : 'sc-shadow-left', can && pos > 1);
    if (!can) return;
    if (y) {
      track.style.top = `${el.offsetTop}px`;
      track.style.height = `${size}px`;
      track.style.left = `${el.offsetLeft + el.offsetWidth - HIT}px`;
    } else {
      track.style.left = `${el.offsetLeft}px`;
      track.style.width = `${size}px`;
      track.style.top = `${el.offsetTop + el.offsetHeight - HIT}px`;
    }
    const len = size - INSET * 2;
    const tl = Math.max(MIN, (len * size) / total);
    const off = INSET + ((len - tl) * pos) / (total - size);
    thumb.style[y ? 'height' : 'width'] = `${tl}px`;
    thumb.style.transform = y ? `translateY(${off}px)` : `translateX(${off}px)`;
    geo = { pos, size, total, len, tl };
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  function flash() {
    track.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!drag) track.classList.remove('on'); }, 900);
  }

  el.addEventListener('scroll', () => { schedule(); flash(); }, { passive: true });

  // The whole track width is the hit area: pressing level with the thumb drags it,
  // pressing above/below it pages towards the pointer.
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const r = thumb.getBoundingClientRect();
    const p = y ? ev.clientY : ev.clientX;
    const [a, b] = y ? [r.top, r.bottom] : [r.left, r.right];
    if (p >= a - 2 && p <= b + 2) {
      track.setPointerCapture(ev.pointerId);
      drag = { start: p, pos: geo.pos, ratio: (geo.total - geo.size) / Math.max(1, geo.len - geo.tl) };
      track.classList.add('drag', 'on');
    } else {
      el.scrollBy({ [y ? 'top' : 'left']: (p < a ? -1 : 1) * geo.size * 0.9, behavior: 'smooth' });
    }
  });
  track.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const d = (y ? ev.clientY : ev.clientX) - drag.start;
    el[y ? 'scrollTop' : 'scrollLeft'] = drag.pos + d * drag.ratio;
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    track.classList.remove('drag');
    flash();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  new ResizeObserver(schedule).observe(el);
  new ResizeObserver(schedule).observe(host);
  new MutationObserver(schedule).observe(el, { childList: true, subtree: true });
  schedule();

  const api = { update: schedule };
  attached.set(el, api);
  return api;
}

export function autoScrollbars(root = document) {
  for (const el of root.querySelectorAll('[data-scroll]')) attachScrollbar(el, el.dataset.scroll === 'x' ? 'x' : 'y');
}
