import { changeShelfMode, copyShelvesToShared, retrySharedShelves } from '../lib/store.js';
import { plural } from '../lib/ui.js';
import { S, withBusy } from './state.js';

const dialog = document.getElementById('settings');
const radio = [...dialog.querySelectorAll('input')];
const copy = document.getElementById('copy-shelves');
const retry = document.getElementById('retry-shelves');
const info = document.getElementById('shelf-sync-info');
let busy = false;
let feedback = '';

function render() {
  if (!S.m) return;
  const { shelfMode, sharedPending, sharedError, unavailablePins } = S.m;
  const shared = shelfMode === 'shared';
  for (const input of radio) {
    input.checked = input.value === shelfMode;
    input.disabled = busy;
  }
  copy.hidden = !shared;
  retry.hidden = !shared || !sharedPending;
  copy.disabled = retry.disabled = busy;
  const messages = [];
  if (shared && sharedPending) messages.push(sharedError, 'Shared changes are saved on this device and awaiting Chrome Sync.');
  if (shared && unavailablePins) messages.push(`${plural(unavailablePins, 'shared pin')} waiting for a matching Chrome bookmark on this device.`);
  if (feedback) messages.push(feedback);
  info.textContent = messages.filter(Boolean).join(' ');
  info.hidden = !info.textContent;
}

async function run(action) {
  busy = true;
  feedback = '';
  render();
  try { await withBusy(action); } finally { busy = false; render(); }
}

export function openSettings() {
  if (dialog.open || !S.m) return;
  feedback = '';
  render();
  dialog.showModal();
  radio.find((input) => input.checked)?.focus();
}

dialog.addEventListener('keydown', (event) => event.stopPropagation());
dialog.addEventListener('change', (event) => {
  if (event.target.name !== 'shelfMode') return;
  run(() => changeShelfMode(event.target.value)).then(() => {
    if (dialog.open) radio.find((input) => input.checked)?.focus();
  });
});
copy.addEventListener('click', () => run(async () => {
  const result = await copyShelvesToShared();
  feedback = `Added ${plural(result.pins, 'pin')} and ${plural(result.shelves, 'shelf', 'shelves')} to Shared.`;
}));
retry.addEventListener('click', () => run(retrySharedShelves));
document.getElementById('close-settings').addEventListener('click', () => dialog.close());

// The manager reloads its model after storage events. Refresh an open dialog with it.
export function renderSettings() {
  if (dialog.open) render();
}
