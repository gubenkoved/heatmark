import { retrySharedShelves, setDefaultShelf, setQuickAccess } from '../lib/store.js';
import { h, plural } from '../lib/ui.js';
import { S, withBusy } from './state.js';

const dialog = document.getElementById('settings');
const defaultShelf = document.getElementById('default-shelf');
const all = document.getElementById('all-quick-shelves');
const list = document.getElementById('quick-shelves');
const retry = document.getElementById('retry-shelves');
const info = document.getElementById('shelf-sync-info');
let busy = false;

function label(shelf) {
  return `${shelf.name} · ${shelf.scope === 'shared' ? 'Shared' : 'Local'}`;
}

function render() {
  if (!S.m) return;
  const m = S.m;
  const shelves = new Map(m.shelves.map((shelf) => [shelf.id, shelf]));
  defaultShelf.replaceChildren(...m.shelves.map((shelf) => h('option', { value: shelf.id }, label(shelf))));
  if (!shelves.has(m.defaultShelf)) {
    defaultShelf.prepend(h('option', { value: m.defaultShelf }, 'Pinned · Local (created when you pin)'));
  }
  defaultShelf.value = m.defaultShelf;
  defaultShelf.disabled = busy;
  all.checked = m.quickAccess == null;
  all.disabled = busy;
  const selected = m.quickShelves;
  const ordered = [...new Set([...selected, ...shelves.keys()])];
  if (all.checked) list.replaceChildren();
  else list.replaceChildren(...ordered.map((id) => {
    const index = selected.indexOf(id);
    const shelf = shelves.get(id);
    const toggle = h('input', {
      type: 'checkbox', checked: index >= 0, disabled: busy, 'data-quick-focus': id,
      onchange: (event) => {
        const saved = m.quickAccess ?? selected;
        run(() => setQuickAccess(event.target.checked ? [...saved, id] : saved.filter((value) => value !== id)));
      },
    });
    const arrows = [-1, 1].map((delta) => {
      const next = index + delta;
      const direction = delta < 0 ? 'up' : 'down';
      const key = id + direction;
      const button = h('button', {
        class: 'ghost sm', type: 'button', 'aria-label': `Move ${label(shelf)} ${direction}`,
        'data-quick-focus': key, disabled: busy || index < 0 || next < 0 || next >= selected.length,
        onclick: () => {
          const order = [...(m.quickAccess ?? selected)];
          const i = order.indexOf(id), j = order.indexOf(selected[next]);
          [order[i], order[j]] = [order[j], order[i]];
          run(() => setQuickAccess(order));
        },
      }, delta < 0 ? '↑' : '↓');
      return button;
    });
    return h('div', { class: 'quick-shelf' }, h('label', {}, toggle, label(shelf)), ...arrows);
  }));

  retry.hidden = !m.sharedPending;
  retry.disabled = busy;
  const messages = [];
  if (m.sharedPending) messages.push(m.sharedError, m.sharedPaused
    ? 'Shared edits from 1.1.0 are paused. Retry to send them to Chrome Sync.'
    : 'Shared changes are saved on this device and awaiting Chrome Sync.');
  if (m.unavailablePins) messages.push(`${plural(m.unavailablePins, 'shared pin')} waiting for a matching Chrome bookmark on this device.`);
  info.textContent = messages.filter(Boolean).join(' ');
  info.hidden = !info.textContent;
}

async function run(action) {
  if (busy) return;
  const active = document.activeElement;
  const focus = active?.dataset.quickFocus;
  busy = true;
  try { await withBusy(action); } finally {
    busy = false;
    render();
    if (dialog.open && (active === defaultShelf || active === all)) active.focus();
    if (dialog.open && focus) {
      const controls = [...list.querySelectorAll('[data-quick-focus]')];
      const next = controls.find((control) => control.dataset.quickFocus === focus && !control.disabled)
        || controls.find((control) => control.dataset.quickFocus === focus.replace(/up$|down$/, ''));
      (next || all).focus();
    }
  }
}

export function openSettings() {
  if (dialog.open || !S.m) return;
  render();
  dialog.showModal();
  defaultShelf.focus();
}

dialog.addEventListener('keydown', (event) => event.stopPropagation());
defaultShelf.addEventListener('change', () => run(() => setDefaultShelf(defaultShelf.value)));
all.addEventListener('change', () => run(() => setQuickAccess(all.checked ? null : S.m.quickShelves)));
retry.addEventListener('click', () => run(retrySharedShelves));
document.getElementById('close-settings').addEventListener('click', () => dialog.close());

export function renderSettings() {
  if (dialog.open && !busy) render();
}
