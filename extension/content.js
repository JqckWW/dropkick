/*
 * DropKick content script — runs on https://admin.shopify.com/* (top frame only).
 *
 * Modes:
 *   original  Nothing on the page is touched.
 *   hidden    content.css hides the floating Sidekick bar. Pure CSS, so it also covers the bar
 *             appearing late or being recreated; no observers run.
 *   sidebar   The bar is hidden the same way, and a "Sidekick" item is added to the left nav directly
 *             above Settings. The item is a clone of Shopify's own Settings item (so it matches its
 *             styling, including the collapsed nav), with Shopify's "sidekick" icon. Activating it
 *             clicks Sidekick's own "open panel" button, which still exists in the hidden bar.
 *
 * Shopify's nodes are never moved or modified; the only DOM change is the added <li>.
 */
(() => {
  'use strict';

  // After an extension update or reload, background.js injects a fresh copy into open tabs. The old
  // copy is disconnected from the extension, so the new one asks it to remove itself.
  const TAKEOVER = 'dropkick:takeover';

  const MODES = ['original', 'sidebar', 'hidden'];
  const DEFAULT_MODE = 'original';

  const FOOTER = '[data-frame-footer-outlet="center"]';
  const FIELD = '[data-sidekick-field]';
  // The open-panel button is identified by its icon, which is not localized; the label is a fallback.
  const OPEN_BUTTONS = [
    'button:has(s-internal-icon[type="layout-sidebar-right"])',
    'button[aria-label="Open Sidekick"]',
  ];
  // An <input> in the floating bar, a <textarea> in the open panel.
  const INPUT = '[name="sidekickMessage"]';
  const SETTINGS_LINK = '[data-sticky-bottom-nav] a[href$="/settings"]';
  const ITEM_ID = 'dropkick-nav-item';
  const LABEL = 'Sidekick';
  const STATE_CLASS = /selected|active/i;

  const root = document.documentElement;

  let mode = DEFAULT_MODE;
  let observer = null;
  let item = null;
  let itemLink = null;
  let template = ''; // className of the Settings link the current item was cloned from

  // ---------- Sidekick ----------

  function footerField() {
    return document.querySelector(`${FOOTER} ${FIELD}`);
  }

  function panelField() {
    for (const field of document.querySelectorAll(FIELD)) {
      if (!field.closest(FOOTER)) return field;
    }
    return null;
  }

  function openButton(field) {
    for (const selector of OPEN_BUTTONS) {
      const button = field.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  /**
   * The panel renders its own field. Sidekick flags the footer surface data-visible="false" as soon as
   * the panel opens; the footer field itself is only removed once the panel animation ends.
   */
  function panelOpen() {
    if (!panelField()) return false;
    const surface = document.querySelector(`${FOOTER} section`);
    return !footerField() || surface?.dataset.visible === 'false';
  }

  function openSidekick() {
    if (panelOpen()) {
      // Already open: just put the cursor in the panel.
      panelField().querySelector(INPUT)?.focus();
      return;
    }
    const field = footerField();
    const button = field && openButton(field);
    if (button) button.click();
  }

  // ---------- nav item ----------

  function buildItem(settingsLi, settingsLink) {
    const li = settingsLi.cloneNode(true);
    li.id = ITEM_ID;
    li.removeAttribute('style');

    for (const el of [li, ...li.querySelectorAll('*')]) {
      if (el !== li) el.removeAttribute('id');
      el.removeAttribute('aria-current');
      for (const name of [...el.classList]) {
        if (STATE_CLASS.test(name)) el.classList.remove(name);
      }
    }

    const link = li.querySelector('a[data-navitem="item"]') || li.querySelector('a');
    link.removeAttribute('href');
    link.removeAttribute('data-discover');
    link.setAttribute('role', 'button');
    link.setAttribute('tabindex', '0');
    link.setAttribute('aria-label', LABEL);
    link.setAttribute('aria-expanded', 'false');

    li.querySelector('s-internal-icon')?.setAttribute('type', 'sidekick');

    // Replace the (localized) "Settings" text wherever it sits in the clone.
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    let replaced = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      node.nodeValue = replaced ? '' : LABEL;
      replaced = true;
    }

    link.addEventListener('click', onActivate);
    link.addEventListener('keydown', onKeyDown);

    item = li;
    itemLink = link;
    template = settingsLink.className;
  }

  function removeItem() {
    if (!item) return;
    itemLink.removeEventListener('click', onActivate);
    itemLink.removeEventListener('keydown', onKeyDown);
    item.remove();
    item = null;
    itemLink = null;
    template = '';
  }

  function onActivate(event) {
    event.preventDefault();
    openSidekick();
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSidekick();
    }
  }

  /** Make the page match the sidebar mode. Idempotent and cheap; runs on every DOM change. */
  function sync() {
    if (mode !== 'sidebar') return;

    // Another copy of this script owns an item (one that didn't answer the takeover event): never
    // compete with it, since two copies each moving their own item above Settings would loop forever.
    // That copy keeps working until the page is next loaded.
    for (const other of document.querySelectorAll(`#${ITEM_ID}`)) {
      if (other !== item) {
        removeItem();
        return;
      }
    }

    const settingsLink = document.querySelector(SETTINGS_LINK);
    const settingsLi = settingsLink && settingsLink.closest('li');
    const available = Boolean(footerField() || panelField());
    if (!settingsLi || !available) {
      removeItem();
      return;
    }

    // Rebuild if Shopify restyled the Settings item (e.g. a new build or a changed nav state).
    if (item && template !== settingsLink.className) removeItem();
    if (!item) buildItem(settingsLi, settingsLink);

    if (item.nextElementSibling !== settingsLi) settingsLi.before(item);

    const expanded = String(panelOpen());
    if (itemLink.getAttribute('aria-expanded') !== expanded) itemLink.setAttribute('aria-expanded', expanded);
  }

  // ---------- lifecycle ----------

  function startSidebar() {
    if (observer) return;
    // childList catches the nav, Settings or Sidekick being inserted, removed or recreated (including
    // client-side navigation); data-visible flips when Sidekick's panel opens or closes.
    observer = new MutationObserver(sync);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-visible'],
    });
  }

  function stopSidebar() {
    if (observer) observer.disconnect();
    observer = null;
    removeItem();
  }

  function applyMode(next) {
    mode = MODES.includes(next) ? next : DEFAULT_MODE;
    if (mode === 'sidebar') {
      startSidebar();
      sync();
    } else {
      stopSidebar();
    }
    if (mode === DEFAULT_MODE) root.removeAttribute('data-dropkick-mode');
    else root.setAttribute('data-dropkick-mode', mode);
  }

  // ---------- settings ----------

  function onStorageChanged(changes, area) {
    if (area === 'sync' && changes.mode) applyMode(changes.mode.newValue);
  }

  /** Undo everything this copy did and stop reacting; a newer copy has taken over. */
  function retire() {
    document.removeEventListener(TAKEOVER, retire);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // Already disconnected from the extension.
    }
    applyMode(DEFAULT_MODE);
  }

  try {
    chrome.storage.sync.get({ mode: DEFAULT_MODE }, (items) => {
      if (chrome.runtime.lastError) return;
      // Retire any older copy and apply our mode in the same task, so nothing flickers between them.
      document.dispatchEvent(new CustomEvent(TAKEOVER));
      document.addEventListener(TAKEOVER, retire);
      applyMode(items.mode);
    });
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch {
    // Extension context gone (extension reloaded or removed): leave the page as Shopify made it.
  }
})();
