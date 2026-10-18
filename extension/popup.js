'use strict';

const MODES = ['original', 'sidebar', 'hidden'];
const DEFAULT_MODE = 'original';

const radios = [...document.querySelectorAll('input[name="mode"]')];
const reset = document.getElementById('reset');
const status = document.getElementById('status');

function show(mode) {
  for (const radio of radios) radio.checked = radio.value === mode;
  reset.disabled = mode === DEFAULT_MODE;
}

function save(mode) {
  if (!MODES.includes(mode)) return;
  chrome.storage.sync.set({ mode }, () => {
    const failed = Boolean(chrome.runtime.lastError);
    if (!failed) show(mode);
    status.textContent = failed ? "Couldn't save" : 'Saved';
    status.classList.toggle('is-error', failed);
    status.classList.add('is-visible');
  });
}

chrome.storage.sync.get({ mode: DEFAULT_MODE }, ({ mode }) => {
  show(MODES.includes(mode) ? mode : DEFAULT_MODE);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.mode) show(MODES.includes(changes.mode.newValue) ? changes.mode.newValue : DEFAULT_MODE);
});

for (const radio of radios) {
  radio.addEventListener('change', () => {
    if (radio.checked) save(radio.value);
  });
}

reset.addEventListener('click', () => {
  save(DEFAULT_MODE);
  radios.find((r) => r.value === DEFAULT_MODE)?.focus();
});
