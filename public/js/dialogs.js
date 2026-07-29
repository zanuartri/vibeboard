'use strict';

// ── Styled dialogs ───────────────────────────────────────────────────────────
// Promise-based, self-contained replacements for window.confirm / window.prompt
// so we never fall back to the browser's native (and off-theme) dialogs. Each
// dialog builds its own overlay, focuses sensibly, traps Tab, and supports
// Esc (cancel) / Enter (confirm). It manages its own focus so it doesn't depend
// on the modal-a11y observer wired up in app.js for the static modals.
//
//   vbConfirm(message, opts?) → Promise<boolean>
//   vbPrompt(message, opts?)  → Promise<string|null>   (null = cancelled)

function vbDialog({
  title = '',
  message = '',
  messageHtml = '',
  input = false,
  value = '',
  placeholder = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  danger = false,
} = {}) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'vb-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'vb-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (title) {
      const head = document.createElement('div');
      head.className = 'vb-dialog-head';
      const h = document.createElement('div');
      h.className = 'vb-dialog-title';
      h.textContent = title;
      head.appendChild(h);
      box.setAttribute('aria-label', title);
      box.appendChild(head);
    }

    const body = document.createElement('div');
    body.className = 'vb-dialog-body';

    if (message || messageHtml) {
      const m = document.createElement('div');
      m.className = 'vb-dialog-message';
      if (messageHtml) {
        const allowedTags = ['b', 'i', 'em', 'strong', 'code', 'br'];
        const sanitized = messageHtml.replace(/<(\/?)([\w-]+)([^>]*)>/g, (match, slash, tag, attrs) => {
          const lower = tag.toLowerCase();
          if (allowedTags.includes(lower)) return `<${slash}${lower}>`;
          return '';
        });
        m.innerHTML = sanitized;
      } else {
        m.textContent = message;
      }
      body.appendChild(m);
    }

    let field = null;
    if (input) {
      field = document.createElement('input');
      field.type = 'text';
      field.className = 'vb-dialog-input';
      field.value = value;
      field.placeholder = placeholder;
      field.spellcheck = false;
      field.autocomplete = 'off';
      body.appendChild(field);
    }

    box.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'vb-dialog-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = cancelText;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger ? 'btn-danger vb-dialog-confirm-danger' : 'btn-save';
    confirmBtn.textContent = confirmText;
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    box.appendChild(footer);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    // Trigger the open transition on the next frame.
    requestAnimationFrame(() => overlay.classList.add('open'));

    let done = false;
    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 150);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
      resolve(result);
    }

    const onConfirm = () => close(input ? field.value : true);
    const onCancel = () => close(input ? null : false);

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) onCancel(); });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key === 'Enter') {
        // Enter confirms from the input or either button; let Shift+Enter pass.
        if (!e.shiftKey) { e.preventDefault(); onConfirm(); }
        return;
      }
      if (e.key === 'Tab') {
        const focusables = [...box.querySelectorAll('button, input')].filter(el => !el.disabled);
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);

    setTimeout(() => { (field || confirmBtn).focus(); if (field) field.select(); }, 40);
  });
}

function vbConfirm(message, opts = {}) {
  return vbDialog({ message, messageHtml: opts.messageHtml || '', input: false, confirmText: 'Confirm', ...opts });
}

function vbPrompt(message, opts = {}) {
  return vbDialog({ message, input: true, confirmText: 'Save', ...opts });
}

// ── Run-agent confirm ────────────────────────────────────────────────────────
// Asked every time a card is manually moved to In Progress/Review (or Run is
// clicked) instead of silently applying a fixed workspace setting, so the
// unattended/skip-permissions choice is made per task, not once globally.
// Returns { confirmed, skipPermissions } or null if cancelled.
function vbConfirmRunAgent(cardTitle, defaultSkipPermissions = true) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;

    const overlay = document.createElement('div');
    overlay.className = 'vb-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'vb-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Start agent');

    const head = document.createElement('div');
    head.className = 'vb-dialog-head';
    const h = document.createElement('div');
    h.className = 'vb-dialog-title';
    h.textContent = 'Start agent';
    head.appendChild(h);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'vb-dialog-body';

    const m = document.createElement('div');
    m.className = 'vb-dialog-message';
    m.textContent = `Run the agent on "${cardTitle}"?`;
    body.appendChild(m);

    const row = document.createElement('div');
    row.className = 'toggle-row';
    const rowText = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'toggle-row-label';
    label.textContent = 'Skip permission prompts';
    const hint = document.createElement('div');
    hint.className = 'toggle-row-hint';
    hint.textContent = 'Run unattended, without asking before each tool use.';
    rowText.appendChild(label);
    rowText.appendChild(hint);
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!defaultSkipPermissions;
    const track = document.createElement('span');
    track.className = 'toggle-track';
    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(track);
    row.appendChild(rowText);
    row.appendChild(toggleLabel);
    body.appendChild(row);

    box.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'vb-dialog-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-save';
    confirmBtn.textContent = 'Start';
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    box.appendChild(footer);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    let done = false;
    function close(result) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 150);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
      resolve(result);
    }

    const onConfirm = () => close({ confirmed: true, skipPermissions: checkbox.checked });
    const onCancel = () => close(null);

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) onCancel(); });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key === 'Enter' && e.target !== checkbox) { e.preventDefault(); onConfirm(); return; }
      if (e.key === 'Tab') {
        const focusables = [...box.querySelectorAll('button, input')].filter(el => !el.disabled);
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);

    setTimeout(() => confirmBtn.focus(), 40);
  });
}
