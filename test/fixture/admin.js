/*
 * Test fixture: a replica of the Shopify Admin frame, limited to what DropKick depends on (the nav with
 * its sticky Settings item, the frame footer with the floating Sidekick bar, and Sidekick's side panel).
 * Element structure, data-* attributes, ids, names and aria attributes mirror the live admin; class
 * names are fake build hashes so nothing can depend on them. Tests drive it through window.__fixture.
 *
 * Query params:
 *   delay=N       insert the Sidekick footer slot N ms after the load event
 *   late=root     with delay: insert the whole [data-frame-footer-root] late, not just the slot
 *   collapsed=1   start with the nav collapsed
 *   panel=1       start with the Sidekick panel open
 *   nav=hidden    start without a nav (like full-screen editor pages)
 *   iframe=1      embed an admin.shopify.com iframe in the page content
 *   lang=fr       French labels (the extension must not rely on English text)
 *   panelDelay=N  ms between opening the panel and removing the footer field (default 1500; live, the
 *                 field goes once the panel animation ends)
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const STORE = 'test';
  const BASE = `/store/${STORE}`;
  const FR = params.get('lang') === 'fr';
  if (FR) document.documentElement.lang = 'fr';
  const T = FR ? {
    settings: 'Paramètres', addFiles: 'Ajouter des fichiers et plus', voice: 'Voix', open: 'Ouvrir Sidekick',
    activity: 'Ouvrir l’activité Sidekick : 0 tâche en cours', input: 'Travailler avec Sidekick', close: 'Fermer Sidekick',
  } : {
    settings: 'Settings', addFiles: 'Add files and more', voice: 'Voice', open: 'Open Sidekick',
    activity: 'Open Sidekick activity: 0 tasks running', input: 'Work with Sidekick', close: 'Close Sidekick',
  };

  // Stand-in for Shopify's <s-internal-icon> custom element.
  if (!customElements.get('s-internal-icon')) {
    customElements.define('s-internal-icon', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>:host{display:inline-block;width:20px;height:20px}div{width:100%;height:100%;border-radius:5px;background:#8a8a8a}</style><div part="glyph"></div>';
      }
    });
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const icon = (type) => h('s-internal-icon', { type, tone: 'legacy-inherit' });

  const state = {
    collapsed: params.get('collapsed') === '1',
    panelOpen: params.get('panel') === '1',
    path: location.pathname,
    activityClicks: 0,
    openClicks: 0,
  };

  // ---------- page model ----------
  const NAV_SECTIONS = [
    { items: [
      ['Home', '', 'home'], ['Orders', 'orders', 'order'], ['Products', 'products', 'product'], ['Customers', 'customers', 'person'],
      ['Marketing', 'marketing', 'target'], ['Discounts', 'discounts', 'discount'], ['Content', 'content', 'content'],
      ['Markets', 'markets', 'globe'], ['Finance', 'finance', 'bank'], ['Analytics', 'analytics', 'chart-vertical'],
    ] },
    { heading: 'Sales channels', items: [['Online Store', 'themes', 'store'], ['Point of Sale', 'pos', 'pos'], ['Shop', 'shop', 'shop']] },
    { heading: 'Apps', items: [['Flow', 'apps/flow', 'app'], ['Search & Discovery', 'apps/search', 'app'], ['Forms', 'apps/forms', 'app']] },
  ];

  function pageKey(pathname) {
    return pathname.replace(new RegExp(`^${BASE}/?`), '') || 'home';
  }
  const PAGINATED = new Set(['orders', 'products', 'customers']);
  const SELECTED = '_Item-selected_q2w7e_40';

  /** Anchors the app rendered itself. Like React, the app ignores clicks on copies made by anyone else. */
  const ownAnchors = new WeakSet();

  // ---------- builders ----------
  function buildNavItem(label, slug, iconType, index) {
    const href = slug ? `${BASE}/${slug}` : BASE;
    const current = pageKey(state.path) === (slug || 'home');
    const a = h('a', {
      'data-polaris-unstyled': 'true',
      class: current ? `_Item_q2w7e_35 ${SELECTED}` : '_Item_q2w7e_35',
      tabindex: '0', 'aria-disabled': 'false', 'data-navitem': 'item', 'data-discover': 'true', href,
      'aria-current': current ? 'page' : false,
    },
    h('div', { class: '_Icon_q2w7e_44' }, icon(iconType)),
    h('span', { class: '_Text_q2w7e_48' }, h('span', { class: 'Polaris-Text--root Polaris-Text--bodyMd' }, label)));
    ownAnchors.add(a);
    return h('li', { class: '_ListItem_q2w7e_31', style: `--nav-enter-index: ${index};` },
      h('div', { 'data-navitem': 'item-wrapper' }, h('div', { 'data-navitem': 'item-inner-wrapper' }, a)));
  }
  const buildSettingsLi = () => buildNavItem(T.settings, 'settings', 'settings', 0);

  function buildNav() {
    const primary = h('div', { class: '_PrimaryNavigation_q2w7e_12' },
      NAV_SECTIONS.map((s) => h('ul', { class: '_Section_q2w7e_20' },
        s.heading ? h('li', { class: '_SectionHeading_q2w7e_24' }, s.heading) : null,
        s.items.map(([l, slug, ic], i) => buildNavItem(l, slug, ic, i)))));
    const sticky = h('div', { class: '_StickyBottom_q2w7e_60', 'data-sticky-bottom-nav': '' },
      h('ul', { class: '_Section_q2w7e_20' },
        buildSettingsLi(),
        h('li', { class: '_ListItem_q2w7e_31', style: '--nav-enter-index: 1;' },
          h('button', { class: '_StoreSwitcher_m5n6b_9', type: 'button', 'aria-label': `Store: ${STORE}` },
            h('span', { class: '_Avatar_m5n6b_17' }, STORE[0].toUpperCase()),
            h('span', { class: '_StoreName_m5n6b_23' }, h('strong', {}, STORE), h('span', {}, 'dev'))))));
    return h('div', { id: 'AppFrameNav', class: '_NavWrapper_q2w7e_1' },
      h('nav', { class: '_Navigation_q2w7e_5', 'aria-label': 'Primary' }, primary, sticky));
  }

  /** The floating bar's field uses an <input>; the panel's uses a <textarea>. Both are name="sidekickMessage". */
  function buildSidekickField(inPanel) {
    return h('div', { class: '_Field_h7j8k_38', 'data-sidekick-field': '' },
      inPanel
        ? h('textarea', { class: '_Input_h7j8k_44', name: 'sidekickMessage', rows: '2', 'aria-label': T.input, placeholder: 'Ask anything…' })
        : h('input', {
          class: '_Input_h7j8k_44', name: 'sidekickMessage', type: 'text', autocomplete: 'off',
          'aria-label': T.input, placeholder: 'Ask anything…',
        }),
      h('button', { class: '_FieldButton_h7j8k_48', type: 'button', 'aria-label': T.addFiles }, icon('plus')),
      h('button', { class: '_FieldButton_h7j8k_48', type: 'button', 'aria-label': T.voice }, icon('microphone')),
      inPanel ? null : h('button', {
        class: '_FieldButton_h7j8k_48', type: 'button', 'aria-label': T.activity,
        onclick: () => { state.activityClicks++; },
      }, icon('clock')),
      inPanel ? null : h('button', {
        class: '_FieldButton_h7j8k_48', type: 'button', 'aria-label': T.open,
        onclick: () => {
          state.openClicks++;
          if (state.panelOpen) panel?.querySelector('[name="sidekickMessage"]').focus();
          else api.openPanel();
        },
      }, icon('layout-sidebar-right')));
  }

  function buildSidekickSlot() {
    const visible = state.panelOpen ? 'false' : 'true';
    return h('div', { class: '_Slot_h7j8k_2' },
      h('div', { class: '_FieldLayer_h7j8k_6' },
        h('div', { class: '_Feather_h7j8k_9', 'data-floating-sidekick-page-feather': '', 'aria-hidden': 'true' }),
        h('section', {
          class: '_Sidekick_h7j8k_14', 'aria-label': 'Sidekick',
          'data-visible': visible, 'data-frame-footer-visible': visible, 'data-generating': 'false',
        }, h('div', { class: '_FocusCapture_h7j8k_30' }, state.panelOpen ? null : buildSidekickField(false)))));
  }

  function buildPagination() {
    return h('div', { class: '_Pagination_r4t5y_3' },
      h('button', { class: '_PaginationButton_r4t5y_7', type: 'button', 'aria-label': 'Previous' }, '‹'),
      h('button', { class: '_PaginationButton_r4t5y_7', type: 'button', 'aria-label': 'Next' }, '›'));
  }

  function buildFooterRoot(withSidekick) {
    const key = pageKey(state.path);
    return h('div', { class: '_FooterRoot_c5v6b_1', 'data-frame-footer-root': '' },
      h('div', { class: '_Footer_c5v6b_8', 'data-frame-footer': '' },
        h('div', { class: '_Outlet_c5v6b_12', 'data-frame-footer-outlet': 'start' }, PAGINATED.has(key) ? buildPagination() : null),
        h('div', { class: '_Outlet_c5v6b_12 _Center_c5v6b_15', 'data-frame-footer-outlet': 'center' }, withSidekick ? buildSidekickSlot() : null),
        h('div', { class: '_Outlet_c5v6b_12', 'data-frame-footer-outlet': 'end' })));
  }

  function buildRibbon(withRoot, withSidekick) {
    return h('div', { class: '_GlobalRibbon_c5v6b_20', 'data-polaris-frame-global-ribbon': '' },
      withRoot ? buildFooterRoot(withSidekick) : null);
  }

  function buildPanel() {
    // data-fixture-panel is a test hook; the rest matches the live aside#sidekick.
    return h('aside', { id: 'sidekick', class: '_SidekickPanel_w2e3r_1', 'aria-label': 'Sidekick', 'data-fixture-panel': '' },
      h('div', {}, h('strong', {}, 'Sidekick'),
        h('button', { type: 'button', 'aria-label': T.close, onclick: () => api.closePanel() }, '×')),
      buildSidekickField(true));
  }

  function buildMain() {
    const key = pageKey(state.path);
    const title = key === 'home' ? 'Home' : key.split('/').pop().replace(/^./, (c) => c.toUpperCase());
    const rows = [];
    for (let i = 1; i <= 30; i++) {
      rows.push(h('div', { class: '_Row_z1x2c_20' }, h('span', {}, `${title} #${1000 + i}`), h('span', {}, 'Lorem ipsum')));
    }
    return h('div', { class: '_Page_z1x2c_8', 'data-fixture-page': key },
      h('h1', { class: '_PageTitle_z1x2c_12' }, title),
      params.get('iframe') === '1'
        ? h('iframe', { class: '_EmbeddedApp_z1x2c_30', src: `${BASE}/apps/embedded`, title: 'Embedded app' })
        : null,
      h('div', { class: '_Card_z1x2c_16' }, rows));
  }

  // ---------- mount ----------
  const app = document.getElementById('app');
  const frame = h('div', { class: '_Frame_k3j9d_1', 'data-polaris-frame': '' });
  const chrome = h('div', { id: 'AppFrameChrome', class: '_Chrome_k3j9d_9' });
  const topBar = h('div', { class: '_TopBar_p8x2a_3', 'data-polaris-top-bar': '' },
    h('button', {
      class: '_TopBarToggle_p8x2a_19', type: 'button', 'aria-label': 'Collapse navigation',
      onclick: () => (state.collapsed ? api.expandNav() : api.collapseNav()),
    }, '≡'),
    h('div', { class: '_TopBarSearch_p8x2a_27' }, 'Search'));
  const main = h('main', { id: 'AppFrameMain', class: '_Main_k3j9d_30' });
  const sidebar = h('div', { class: '_Sidebar_k3j9d_70', 'data-polaris-frame-sidebar': '' });
  const PANEL_DELAY = params.has('panelDelay') ? Math.max(0, Number(params.get('panelDelay')) || 0) : 1500;
  let footerFieldTimer = null;

  const lateMs = params.has('delay') ? Math.max(0, Number(params.get('delay')) || 0) : null;
  const lateRoot = params.get('late') === 'root';

  let nav = params.get('nav') === 'hidden' ? null : buildNav();
  let ribbon = buildRibbon(!(lateMs != null && lateRoot), lateMs == null);
  let panel = null;

  chrome.append(topBar);
  if (nav) chrome.append(nav);
  chrome.append(ribbon);
  frame.append(chrome, main, sidebar);
  app.append(frame);
  main.append(buildMain());

  function syncFrameClasses() {
    frame.classList.toggle('_NavCollapsed_k3j9d_44', state.collapsed);
    frame.classList.toggle('_PanelOpen_k3j9d_51', state.panelOpen);
    frame.classList.toggle('_NavHidden_k3j9d_60', !nav);
    topBar.querySelector('button').setAttribute('aria-label', state.collapsed ? 'Expand navigation' : 'Collapse navigation');
  }
  syncFrameClasses();
  if (state.panelOpen) { panel = buildPanel(); sidebar.append(panel); }

  // ---------- helpers ----------
  const q = (sel) => document.querySelector(sel);
  const footerSection = () => q('[data-frame-footer-outlet="center"] section[aria-label="Sidekick"]');
  const settingsLi = () => q('#AppFrameNav [data-sticky-bottom-nav] a[href$="/settings"]')?.closest('li') || null;

  /** Client-side navigation: page content and the start outlet change; nav and footer nodes persist, as live. */
  function render() {
    main.replaceChildren(buildMain());
    document.title = `${pageKey(state.path)} · ${STORE} · Shopify`;
    document.querySelectorAll('#AppFrameNav a[data-navitem]').forEach((a) => {
      if (!ownAnchors.has(a)) return;
      const current = pageKey(a.getAttribute('href')) === pageKey(state.path);
      if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.classList.toggle(SELECTED, current);
    });
    const start = q('[data-frame-footer-outlet="start"]');
    if (start) start.replaceChildren(...(PAGINATED.has(pageKey(state.path)) ? [buildPagination()] : []));
  }

  // Delegated nav click handling, like React's root listener.
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element && e.target.closest('a[data-navitem]');
    if (!a || !ownAnchors.has(a)) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    api.navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => { state.path = location.pathname; render(); });

  function insertSlot() {
    q('[data-frame-footer-outlet="center"]').replaceChildren(buildSidekickSlot());
  }

  const api = {
    get state() { return JSON.parse(JSON.stringify(state)); },
    ready: false,
    /** Sidekick disappears entirely: the footer slot and, if open, the panel. */
    removeSidekick() {
      q('[data-frame-footer-outlet="center"]')?.firstElementChild?.remove();
      if (panel) { panel.remove(); panel = null; state.panelOpen = false; syncFrameClasses(); }
    },
    insertSidekick() {
      if (!q('[data-frame-footer-root]')) ribbon.append(buildFooterRoot(false));
      insertSlot();
    },
    navigate(path) {
      const url = new URL(path, location.href);
      history.pushState({}, '', url.pathname + url.search);
      state.path = url.pathname;
      render();
    },
    back() { history.back(); },
    /** The frame re-renders from scratch: fresh nav and footer nodes. */
    remountFrame() {
      const newRibbon = buildRibbon(!!q('[data-frame-footer-root]'), !!footerSection());
      ribbon.replaceWith(newRibbon);
      ribbon = newRibbon;
      if (nav) {
        const newNav = buildNav();
        nav.replaceWith(newNav);
        nav = newNav;
      }
    },
    /**
     * As live: the footer section stays (data-visible="false") and its field is removed only after the
     * panel animation (PANEL_DELAY), so for a while both fields exist. The panel textarea gets focus.
     */
    openPanel() {
      if (state.panelOpen) return;
      state.panelOpen = true;
      const s = footerSection();
      if (s) { s.setAttribute('data-visible', 'false'); s.setAttribute('data-frame-footer-visible', 'false'); }
      clearTimeout(footerFieldTimer);
      footerFieldTimer = setTimeout(() => {
        if (state.panelOpen) footerSection()?.querySelector('[data-sidekick-field]')?.remove();
      }, PANEL_DELAY);
      panel = buildPanel();
      sidebar.append(panel);
      syncFrameClasses();
      panel.querySelector('[name="sidekickMessage"]').focus();
    },
    closePanel() {
      if (!state.panelOpen) return;
      state.panelOpen = false;
      clearTimeout(footerFieldTimer);
      const s = footerSection();
      if (s) {
        s.setAttribute('data-visible', 'true'); s.setAttribute('data-frame-footer-visible', 'true');
        const fc = s.firstElementChild;
        if (fc && !fc.querySelector('[data-sidekick-field]')) fc.append(buildSidekickField(false));
      }
      panel?.remove();
      panel = null;
      syncFrameClasses();
    },
    collapseNav() { state.collapsed = true; syncFrameClasses(); },
    expandNav() { state.collapsed = false; syncFrameClasses(); },
    removeNav() {
      if (!nav) return;
      nav.remove(); nav = null; syncFrameClasses();
    },
    restoreNav() {
      if (nav) return;
      nav = buildNav(); chrome.insertBefore(nav, ribbon); syncFrameClasses();
    },
    /** Remove only the Settings li; the store switcher stays. */
    removeSettings() { settingsLi()?.remove(); },
    restoreSettings() {
      if (settingsLi()) return;
      const ul = q('#AppFrameNav [data-sticky-bottom-nav] ul');
      ul.insertBefore(buildSettingsLi(), ul.lastElementChild); // before the store switcher
    },
    /** React re-rendering the Settings li: replaced in place by a fresh node. */
    remountSettings() { settingsLi()?.replaceWith(buildSettingsLi()); },
  };
  window.__fixture = api;

  window.addEventListener('load', () => {
    api.ready = true;
    if (lateMs == null) return;
    setTimeout(() => {
      if (lateRoot) ribbon.append(buildFooterRoot(true));
      else insertSlot();
      // Snapshots ignore data-fixture-* attributes on <html>.
      document.documentElement.setAttribute('data-fixture-late-inserted', '');
    }, lateMs);
  });
})();
