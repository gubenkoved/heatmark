// In-app dialogs replacing window.confirm / window.prompt.
//
//   await confirmDialog({ title, message, ok: 'Delete', danger: true })  → true | false
//   await promptDialog({ title, value, placeholder, ok, validate })      → string | null
// validate(value) may return an error message to keep the dialog open.

import { h } from './ui.js';

function dialog({ title, message = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false, validate = null }) {
  return new Promise((resolve) => {
    const restore = document.activeElement;
    const field = input
      ? h('input', { class: 'dlg-in', type: 'text', spellcheck: 'false', value: input.value || '', placeholder: input.placeholder || '' })
      : null;
    const error = h('div', { class: 'dlg-err', role: 'alert' });
    const okBtn = h('button', { type: 'button', class: `btn ${danger ? 'danger-solid' : 'primary'}` }, ok);
    const cancelBtn = h('button', { type: 'button', class: 'btn' }, cancel);
    const box = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h3', { class: 'dlg-t' }, title),
      message ? h('p', { class: 'dlg-m' }, message) : null,
      field, error,
      h('div', { class: 'dlg-acts' }, cancelBtn, okBtn));
    const back = h('div', { class: 'dlg-back' }, box);

    const finish = (value) => {
      back.remove();
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      resolve(value);
    };
    const submit = () => {
      if (!field) return finish(true);
      const v = field.value.trim();
      if (!v) { field.focus(); return; }
      const problem = validate?.(v);
      if (problem) { error.textContent = problem; field.focus(); return; }
      finish(v);
    };

    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => finish(field ? null : false));
    back.addEventListener('mousedown', (ev) => { if (ev.target === back) finish(field ? null : false); });
    box.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); finish(field ? null : false); }
      else if (ev.key === 'Enter' && document.activeElement !== cancelBtn) { ev.preventDefault(); submit(); }
      else if (ev.key === 'Tab') { // keep focus inside the dialog
        const items = [field, cancelBtn, okBtn].filter(Boolean);
        const i = items.indexOf(document.activeElement);
        ev.preventDefault();
        items[(i + (ev.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    });
    field?.addEventListener('input', () => { error.textContent = ''; });

    document.body.append(back);
    if (field) { field.focus(); field.select(); } else okBtn.focus();
  });
}

export const confirmDialog = (opts) => dialog(opts).then((v) => v === true);
export const promptDialog = ({ value = '', placeholder = '', ...opts }) => dialog({ ...opts, input: { value, placeholder } });
