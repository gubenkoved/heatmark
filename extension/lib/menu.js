// Context menus: one open at a time, keyboard navigable, kept inside the viewport.
//
//   openMenu(items, { x, y, onClose? })
//   items: { label, key?, danger?, disabled?, run } | { header } | '-' (separator) | falsy (skipped)

import { h } from './ui.js';

let current = null;

export function closeMenu() {
  current?.close();
}

export function openMenu(items, { x, y, onClose }) {
  closeMenu();
  const restore = document.activeElement;
  const el = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  const buttons = [];

  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      if (el.lastChild && !el.lastChild.classList.contains('menu-sep')) el.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.header) { el.append(h('div', { class: 'menu-h' }, it.header)); continue; }
    const b = h('button', {
      type: 'button', role: 'menuitem', class: 'menu-i' + (it.danger ? ' danger' : ''), disabled: !!it.disabled,
      onclick: () => { close(); it.run?.(); },
    }, h('span', { class: 'menu-l' }, it.label), it.key ? h('kbd', {}, it.key) : null);
    buttons.push(b);
    el.append(b);
  }
  while (el.lastChild?.classList.contains('menu-sep')) el.lastChild.remove();
  if (!buttons.length) { onClose?.(); return null; }

  document.body.append(el);
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = `${Math.max(6, Math.min(x, vw - w - 6))}px`;
  el.style.top = `${y + ht > vh - 6 ? Math.max(6, y - ht) : y}px`;

  let sel = -1;
  const enabled = () => buttons.filter((b) => !b.disabled);
  const focus = (b) => { sel = enabled().indexOf(b); b?.focus({ preventScroll: true }); };
  const step = (d) => {
    const list = enabled();
    if (!list.length) return;
    sel = (sel + d + list.length) % list.length;
    list[sel].focus({ preventScroll: true });
  };

  el.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'ArrowDown') { ev.preventDefault(); step(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); step(-1); }
    else if (ev.key === 'Home') { ev.preventDefault(); sel = -1; step(1); }
    else if (ev.key === 'End') { ev.preventDefault(); sel = 0; step(-1); }
    else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); close(); }
  });
  el.addEventListener('mousemove', (ev) => {
    const b = ev.target.closest('.menu-i');
    if (b && !b.disabled && document.activeElement !== b) focus(b);
  });
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());

  const outside = (ev) => { if (!el.contains(ev.target)) close(false); };
  const scrolled = (ev) => { if (!el.contains(ev.target)) close(false); };
  const lost = () => close(false);
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('scroll', scrolled, true);
  window.addEventListener('resize', lost);
  window.addEventListener('blur', lost);

  function close(refocus = true) {
    if (current?.el !== el) return;
    current = null;
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('scroll', scrolled, true);
    window.removeEventListener('resize', lost);
    window.removeEventListener('blur', lost);
    el.remove();
    onClose?.();
    if (refocus && restore?.isConnected) restore.focus({ preventScroll: true });
  }

  current = { el, close };
  el.focus({ preventScroll: true });
  return current;
}

// Position helpers for callers
export const atPointer = (ev) => ({ x: ev.clientX, y: ev.clientY });
export const below = (target) => {
  const r = target.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};
