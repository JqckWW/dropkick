#!/usr/bin/env node
// DropKick end-to-end tests: load the unpacked extension in Chrome for Testing and run it against the
// Shopify Admin replica in test/fixture/. All requests are served locally; any other request fails.
//   npm test                         run everything
//   npm test -- --grep popup         only cases whose name matches /popup/i
//   npm test -- --headful            show the browser
//   npm test -- --ext path/to/ext    test another unpacked extension directory (default: extension/)
import fs from 'node:fs';
import path from 'node:path';
import { Harness, ROOT, ADMIN, OTHER, BASELINE, DEFAULT_VIEWPORT, until, sleep } from './lib/harness.mjs';
import {
  geometry, snapshot, frameGeometry, checkSidebar, checkHidden, checkOriginal, checkItemFollowsSettingsText,
} from './lib/checks.mjs';

// ---------- CLI ----------
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const GREP = opt('--grep') ? new RegExp(opt('--grep'), 'i') : null;
const HEADFUL = argv.includes('--headful');
const EXT_DIR = path.resolve(ROOT, opt('--ext') || 'extension');
const MANIFEST = path.join(EXT_DIR, 'manifest.json');
const EXT_FOUND = fs.existsSync(MANIFEST);

// Timing budgets (ms)
const T_APPLY = 1500;      // mode applied on load or after a setting change
const T_FRAME = 300;       // reaction to a DOM change: about one frame plus polling slack
const T_RESTORE = 2000;    // back to original
const T_EXPANDED = 2500;   // panel state settles (the footer field is removed ~1.5s after the panel opens)
const SMALL_VIEWPORT = { width: 1280, height: 640 };
const NARROW_VIEWPORT = { width: 700, height: 900 };
const ITEM = '#dropkick-nav-item a[data-navitem="item"]';

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const PASS = color(32, 'PASS'), FAIL = color(31, 'FAIL'), WARN = color(33, 'WARN');

// ---------- case registry ----------
const cases = [];
const test = (name, fn, { needsExtension = true } = {}) => cases.push({ name, fn, needsExtension });

let h; // Harness
const baselineCache = new Map();

/** Geometry and snapshot of the same fixture state on example.test, where the content script never runs. */
async function baseline({ page = 'orders', query = '', viewport = DEFAULT_VIEWPORT } = {}) {
  const key = JSON.stringify([page, query, viewport]);
  if (baselineCache.has(key)) return baselineCache.get(key);
  const p = await h.openPage(null, { viewport });
  await h.goto(p, `${BASELINE}${page ? '/' + page : ''}${query ? '?' + query : ''}`);
  await sleep(50);
  const val = { geo: await geometry(p), snap: await snapshot(p) };
  await p.close();
  baselineCache.set(key, val);
  return val;
}

/**
 * Waits until `page` is in state `kind` (original | hidden | sidebar), compared with baseline `base`.
 * expectItem and geometryOnly are passed to checkSidebar.
 */
async function expectState(page, kind, base, { timeout = T_APPLY, label, expectItem = true, geometryOnly = false } = {}) {
  if (kind === 'original') {
    return until(async () => checkOriginal(await snapshot(page), base.snap), { timeout, label: label || 'original', stable: 3 });
  }
  if (kind === 'hidden') return until(async () => checkHidden(await geometry(page), base?.geo), { timeout, label: label || 'hidden' });
  return until(async () => checkSidebar(await geometry(page), { base: base?.geo, expectItem, geometryOnly }), { timeout, label: label || (expectItem ? 'sidebar (item present)' : 'sidebar (no item)') });
}

async function openAdmin(sub = 'orders', { viewport, query = '' } = {}) {
  return h.openPage(`${ADMIN}${sub ? '/' + sub : ''}${query ? '?' + query : ''}`, { viewport });
}
const fx = (page, method, ...args) => page.evaluate((m, a) => window.__fixture[m](...a), method, args);
const fxState = (page) => page.evaluate(() => window.__fixture.state);

/** Activates the nav item by click, Enter or Space. */
async function activate(page, how) {
  if (how === 'click') return page.click(ITEM);
  await page.focus(ITEM);
  await page.keyboard.press(how === 'enter' ? 'Enter' : 'Space');
}

const ariaExpanded = (g) => g.item?.a?.attrs['aria-expanded'];

/** Waits until the nav item's aria-expanded is `value`. */
const expectExpanded = (page, value, label) => until(async () => {
  const v = ariaExpanded(await geometry(page));
  return v === value ? [] : [`aria-expanded = ${v}, expected ${value}`];
}, { timeout: T_EXPANDED, label });

/** With the panel closed, activation must click the footer's open button once and focus the panel input. */
async function expectActivationOpensPanel(page, how, fail, warn = () => {}) {
  const before = await fxState(page);
  const scrollBefore = await page.evaluate(() => scrollY);
  await activate(page, how).catch((e) => fail(`${how}: ${e.message}`));
  await until(async () => {
    const g = await geometry(page);
    const e = [];
    if (!g.fixture.panelOpen) e.push('panel not open');
    if (g.fixture.openClicks !== before.openClicks + 1) e.push(`footer open button clicked ${g.fixture.openClicks - before.openClicks}x (expected 1)`);
    if (g.fixture.activityClicks !== before.activityClicks) e.push('the "Sidekick activity" button was clicked');
    if (!g.panelInputFocused) e.push(`panel input not focused (activeElement ${g.activeElement})`);
    if (ariaExpanded(g) !== 'true') e.push(`aria-expanded = ${ariaExpanded(g)}`);
    if (g.path !== before.path) e.push(`navigated to ${g.path}`);
    return e;
  }, { timeout: T_EXPANDED, label: `${how} opens the panel` }).catch((e) => fail(e.message));
  const scrollAfter = await page.evaluate(() => scrollY);
  if (scrollAfter !== scrollBefore) warn(`${how} scrolled the page (${scrollBefore} → ${scrollAfter})`);
}

/** Closes the panel the way Shopify does; the item must report aria-expanded="false" and the sidebar state hold. */
async function closePanelAndExpectClosedState(page, base, fail) {
  await fx(page, 'closePanel');
  await expectExpanded(page, 'false', 'aria-expanded after closing the panel').catch((e) => fail(e.message));
  await expectState(page, 'sidebar', base, { timeout: T_EXPANDED, label: 'sidebar after closing the panel' }).catch((e) => fail(e.message));
}

// =====================================================================================
// 1. Fixture fidelity (no extension; runs on the example.test copy)
// =====================================================================================
test('1. fixture: matches the admin structure DropKick relies on; fixture API works', async ({ fail }) => {
  const p = await h.openPage(`${BASELINE}/orders`);
  const r = await p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const cs = (el) => getComputedStyle(el);
    const out = [];
    const need = (cond, msg) => { if (!cond) out.push(msg); };
    const ribbon = q('#AppFrameChrome > [data-polaris-frame-global-ribbon]');
    need(ribbon && cs(ribbon).position === 'fixed' && cs(ribbon).zIndex === '100', 'ribbon fixed z-index 100 inside #AppFrameChrome');
    const root = q('[data-polaris-frame-global-ribbon] > [data-frame-footer-root]');
    need(root && cs(root).position === 'absolute' && cs(root).bottom === '0px' && cs(root).pointerEvents === 'none' && cs(root).containerType === 'inline-size', 'footer root absolute/bottom 0/pointer-events none/container-type inline-size');
    const outs = [...document.querySelectorAll('[data-frame-footer] > [data-frame-footer-outlet]')].map((e) => e.dataset.frameFooterOutlet);
    need(outs.join() === 'start,center,end', `3 outlets in order (got ${outs})`);
    const center = q('[data-frame-footer-outlet="center"]');
    need(cs(center).pointerEvents === 'none' && cs(center).justifyContent === 'center', 'center outlet pointer-events none + justify center');
    const layer = q('[data-frame-footer-outlet="center"] > div > div');
    need(layer && cs(layer).position === 'relative', 'slot > field layer position relative');
    const feather = layer && layer.querySelector(':scope > [data-floating-sidekick-page-feather]');
    need(feather && feather.getAttribute('aria-hidden') === 'true', 'feather aria-hidden inside field layer');
    const sec = layer && layer.querySelector(':scope > section[aria-label="Sidekick"]');
    need(sec && sec.dataset.visible === 'true' && sec.hasAttribute('data-frame-footer-visible') && sec.hasAttribute('data-generating'), 'section data-visible/data-frame-footer-visible/data-generating');
    need(sec && /transform 0\.7s/.test(cs(sec).transition), 'section transition transform 0.7s');
    const field = sec && sec.querySelector(':scope > div > [data-sidekick-field]');
    need(field && Math.round(field.getBoundingClientRect().width) === 376, 'field 376px');
    const input = field && field.querySelector('input[name="sidekickMessage"]');
    need(input && input.getAttribute('aria-label') === 'Work with Sidekick', 'input name/aria-label');
    const labels = field ? [...field.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) : [];
    need(labels.join('|') === 'Add files and more|Voice|Open Sidekick activity: 0 tasks running|Open Sidekick', `field buttons (${labels})`);
    const openBtn = q('[data-frame-footer-outlet="center"] [data-sidekick-field] button:has(s-internal-icon[type="layout-sidebar-right"])');
    need(openBtn && openBtn.getAttribute('aria-label') === 'Open Sidekick', 'open button found by icon selector');
    // Why the extension can't use an aria-label prefix to find the open button.
    need(document.querySelectorAll('[data-sidekick-field] button[aria-label^="Open Sidekick"]').length === 2, 'activity button shares the "Open Sidekick" label prefix');
    const nav = q('#AppFrameNav');
    need(nav && cs(nav).position === 'fixed' && nav.getBoundingClientRect().width === 220, 'nav fixed 220px');
    const sa = q('#AppFrameNav [data-sticky-bottom-nav] ul > li > div[data-navitem="item-wrapper"] > div[data-navitem="item-inner-wrapper"] > a[href$="/settings"]');
    need(!!sa, 'Settings li > item-wrapper > item-inner-wrapper > a');
    if (sa) {
      const li = sa.closest('li');
      need(li.getAttribute('style') === '--nav-enter-index: 0;', 'Settings li style --nav-enter-index: 0;');
      need(li.nextElementSibling && li.nextElementSibling.querySelector('button[aria-label^="Store"]'), 'store switcher li after Settings');
      const want = { 'data-polaris-unstyled': 'true', tabindex: '0', 'aria-disabled': 'false', 'data-navitem': 'item', 'data-discover': 'true', href: '/store/test/settings' };
      for (const [k, v] of Object.entries(want)) need(sa.getAttribute(k) === v, `Settings a[${k}=${v}]`);
      need(!/selected/i.test(sa.className) && !sa.hasAttribute('aria-current'), 'Settings not selected on /orders');
      const ic = sa.querySelector(':scope > div > s-internal-icon[type="settings"][tone="legacy-inherit"]');
      need(ic && ic.shadowRoot && Math.round(ic.getBoundingClientRect().width) === 20, 's-internal-icon[type=settings] 20px custom element');
      need(sa.querySelector(':scope > span > span.Polaris-Text--root.Polaris-Text--bodyMd')?.textContent === 'Settings', 'Settings text span');
      // A Settings clone without href (what the extension inserts) is ignored by the app's click handling.
      const clone = li.cloneNode(true);
      clone.querySelector('a').removeAttribute('href');
      li.before(clone);
      clone.querySelector('a').click();
      need(location.pathname === '/store/test/orders', 'clicking an href-less clone does not navigate');
      clone.remove();
    }
    need(/^_[A-Z]\w+_[a-z0-9]{5}_\d+$/.test(sec?.className || ''), 'hashed class names');
    const probe = window.__dkt.fixedProbe();
    need(probe && probe.left === 0 && probe.top === 0, `fixed probe inside footer root resolves to viewport (got ${JSON.stringify(probe)})`);
    return out;
  });
  r.forEach((m) => fail(`fixture structure: ${m}`));

  // Client-side navigation keeps the nav and footer nodes; remountFrame() replaces them.
  const nodeIds = () => p.evaluate(() => {
    window.__ids = window.__ids || new WeakMap(); let n = window.__idn || 0;
    const id = (el) => { if (!el) return null; if (!window.__ids.has(el)) window.__ids.set(el, ++n); window.__idn = n; return window.__ids.get(el); };
    return { section: id(document.querySelector('section[aria-label="Sidekick"]')), root: id(document.querySelector('[data-frame-footer-root]')), sticky: id(document.querySelector('[data-sticky-bottom-nav]')) };
  });
  const before = await nodeIds();
  await fx(p, 'navigate', '/store/test/products');
  if (JSON.stringify(before) !== JSON.stringify(await nodeIds())) fail('navigate() replaced nav/footer nodes');
  if (!(await p.evaluate(() => location.pathname === '/store/test/products' && document.querySelector('[data-fixture-page="products"]')))) fail('navigate() did not swap content/URL');
  await p.click('#AppFrameNav a[href="/store/test/settings"]');
  const sel = await p.evaluate(() => { const a = document.querySelector('#AppFrameNav a[href$="/settings"]'); return [location.pathname, a.className, a.getAttribute('aria-current')]; });
  if (!(sel[0] === '/store/test/settings' && /_Item-selected_/.test(sel[1]) && sel[2] === 'page')) fail(`Settings click/selected variant: ${JSON.stringify(sel)}`);
  await fx(p, 'navigate', '/store/test/orders');
  await fx(p, 'remountFrame');
  const afterRemount = await nodeIds();
  if (afterRemount.section === before.section || afterRemount.root === before.root || afterRemount.sticky === before.sticky) fail('remountFrame() did not create fresh nodes');
  await fx(p, 'removeSidekick');
  if (await p.$('section[aria-label="Sidekick"]')) fail('removeSidekick() left the section');
  await fx(p, 'insertSidekick');
  if (!(await p.$('[data-frame-footer-outlet="center"] section[aria-label="Sidekick"]'))) fail('insertSidekick() did not recreate the section');

  // Open button: the footer section hides at once, the panel field gets focus, and the footer field
  // is removed only after the panel animation.
  await p.click('[data-frame-footer] button[aria-label="Open Sidekick"]');
  const panel = await p.evaluate(() => {
    const s = document.querySelector('[data-frame-footer] section[aria-label="Sidekick"]');
    return {
      dv: s.dataset.visible, vis: getComputedStyle(s).visibility, h: s.getBoundingClientRect().height,
      footerFields: document.querySelectorAll('[data-frame-footer] [data-sidekick-field]').length,
      panelFields: document.querySelectorAll('[data-polaris-frame-sidebar] > aside#sidekick[aria-label="Sidekick"] [data-sidekick-field]').length,
      focused: document.activeElement === document.querySelector('aside#sidekick textarea[name="sidekickMessage"]'),
    };
  });
  if (!(panel.dv === 'false' && panel.vis === 'hidden' && panel.h === 0 && panel.footerFields === 1 && panel.panelFields === 1 && panel.focused)) fail(`open button / openPanel(): ${JSON.stringify(panel)}`);
  await p.waitForFunction(() => !document.querySelector('[data-frame-footer] [data-sidekick-field]'), { timeout: 2500 }).catch(() => fail('footer field not removed after the panel animation'));
  await fx(p, 'closePanel');
  if ((await p.evaluate(() => [document.querySelectorAll('[data-frame-footer] [data-sidekick-field]').length, document.querySelectorAll('[data-fixture-panel]').length].join())) !== '1,0') fail('closePanel() did not restore the footer field / remove the panel');

  await fx(p, 'removeSettings');
  if (await p.$('#AppFrameNav a[href$="/settings"]')) fail('removeSettings() left Settings');
  await fx(p, 'restoreSettings');
  if (!(await p.evaluate(() => document.querySelector('#AppFrameNav a[href$="/settings"]').closest('li').nextElementSibling?.querySelector('button')))) fail('restoreSettings() wrong position');
  await fx(p, 'collapseNav');
  await until(async () => {
    const g = await geometry(p);
    return g.nav.rect.width === 60 && g.settings.rect.width === 32 && !g.settings.textVisible ? [] : [`collapsed nav ${g.nav.rect.width}, settings w${g.settings.rect.width} text ${g.settings.textVisible}`];
  }, { timeout: 1000, label: 'collapse' }).catch((e) => fail(e.message));
  await fx(p, 'expandNav');
  await until(async () => ((await geometry(p)).nav.rect.width === 220 ? [] : ['nav not 220px']), { timeout: 1000, label: 'expand' }).catch((e) => fail(e.message));
  await p.close();

  const fr = await h.openPage(`${BASELINE}/orders?lang=fr`);
  const frl = await fr.evaluate(() => [
    document.querySelector('[data-frame-footer-outlet="center"] [data-sidekick-field] button:has(s-internal-icon[type="layout-sidebar-right"])')?.getAttribute('aria-label'),
    !!document.querySelector('button[aria-label="Open Sidekick"]'),
    document.querySelector('#AppFrameNav a[href$="/settings"]').textContent,
  ]);
  if (!(frl[0] === 'Ouvrir Sidekick' && !frl[1] && frl[2] === 'Paramètres')) fail(`?lang=fr: ${JSON.stringify(frl)}`);
  await fr.close();

  const late = await h.openPage(`${BASELINE}/orders?delay=600`);
  if (await late.$('section[aria-label="Sidekick"]')) fail('?delay: section present before the delay elapsed');
  await late.waitForSelector('[data-frame-footer-outlet="center"] section[aria-label="Sidekick"]', { timeout: 3000 }).catch(() => fail('?delay: section never inserted'));
  await late.close();
  const lateRoot = await h.openPage(`${BASELINE}/orders?delay=300&late=root`);
  if (await lateRoot.$('[data-frame-footer-root]')) fail('?late=root: footer root present early');
  await lateRoot.waitForSelector('[data-frame-footer-root] section[aria-label="Sidekick"]', { timeout: 3000 }).catch(() => fail('?late=root never inserted'));
  await lateRoot.close();

  const o = await h.openPage(OTHER);
  if (!(await o.evaluate(() => document.title.includes('Example')))) fail('other.html did not load');
  await o.close();
}, { needsExtension: false });

// =====================================================================================
// 2. Manifest (static)
// =====================================================================================
test('2. manifest: MV3, minimal permissions, content script on admin.shopify.com top frame only', async ({ fail, warn }) => {
  let m;
  try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return fail(`manifest.json unreadable: ${e.message}`); }
  if (m.manifest_version !== 3) fail(`manifest_version = ${m.manifest_version}`);
  if (JSON.stringify(m.permissions) !== '["storage","scripting"]') fail(`permissions = ${JSON.stringify(m.permissions)}`);
  if (JSON.stringify(m.host_permissions) !== '["https://admin.shopify.com/*"]') fail(`host_permissions = ${JSON.stringify(m.host_permissions)}`);
  if (m.background?.service_worker !== 'background.js') fail(`background.service_worker = ${JSON.stringify(m.background?.service_worker)}`);
  if (m.background && Object.keys(m.background).some((k) => !['service_worker', 'type'].includes(k))) warn(`extra background keys: ${Object.keys(m.background)}`);
  if (m.optional_permissions?.length || m.optional_host_permissions?.length) fail('optional permissions declared');
  const cs = m.content_scripts || [];
  if (cs.length !== 1) fail(`expected 1 content_scripts entry, got ${cs.length}`);
  for (const c of cs) {
    if (JSON.stringify(c.matches) !== '["https://admin.shopify.com/*"]') fail(`content_scripts.matches = ${JSON.stringify(c.matches)}`);
    if (c.all_frames === true) fail('content_scripts.all_frames is true');
    if (c.match_about_blank || c.match_origin_as_fallback) fail('match_about_blank/match_origin_as_fallback set');
    if (c.include_globs || c.exclude_matches) warn(`content script has include_globs/exclude_matches: ${JSON.stringify({ i: c.include_globs, x: c.exclude_matches })}`);
    if (!(c.js || []).includes('content.js')) fail(`content_scripts.js = ${JSON.stringify(c.js)} (expected content.js)`);
    if (!(c.css || []).includes('content.css')) fail(`content_scripts.css = ${JSON.stringify(c.css)} (expected content.css)`);
    if (c.world === 'MAIN') warn('content script runs in the MAIN world');
  }
  if (m.action?.default_popup !== 'popup.html') fail(`action.default_popup = ${m.action?.default_popup}`);
  if (m.externally_connectable) fail('externally_connectable declared');
  if (m.web_accessible_resources?.length) warn(`web_accessible_resources declared: ${JSON.stringify(m.web_accessible_resources)}`);
  for (const f of ['content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', 'background.js', 'icons']) {
    if (!fs.existsSync(path.join(EXT_DIR, f))) fail(`missing extension/${f}`);
  }
  for (const icon of Object.values({ ...(m.icons || {}), ...(m.action?.default_icon || {}) })) {
    if (typeof icon === 'string' && !fs.existsSync(path.join(EXT_DIR, icon))) fail(`icon file missing: ${icon}`);
  }
  // Static scan for network APIs; every case also fails on any unexpected request at runtime.
  for (const f of ['content.js', 'background.js', 'popup.js', 'popup.html', 'content.css', 'popup.css']) {
    const p = path.join(EXT_DIR, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const hits = [...new Set(src.match(/\b(fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts)|(?:https?:)?\/\/(?!admin\.shopify\.com)[a-z0-9.-]+\.[a-z]{2,}\/?/gi) || [])];
    if (hits.length) warn(`${f} mentions network APIs/URLs: ${hits.slice(0, 5).join(', ')}`);
  }
});

// =====================================================================================
// 3. Modes
// =====================================================================================
test('3a. original: default (nothing stored) and explicit setting leave the page identical to the baseline', async ({ fail }) => {
  const base = await baseline();
  for (const mode of [null, 'original']) {
    await h.setMode(mode);
    const p = await openAdmin();
    await sleep(300); // give a misbehaving script time to act
    await expectState(p, 'original', base, { label: `original (${mode ?? 'nothing stored'})` }).catch((e) => fail(e.message));
    // Positive control for the "not injected" checks in case 11.
    if (h.extensionContexts(p).length === 0) fail('content script not injected on admin.shopify.com');
    await p.close();
  }
});

for (const vp of [DEFAULT_VIEWPORT, SMALL_VIEWPORT]) {
  test(`3b. sidebar: bar hidden, Sidekick item above Settings @${vp.width}x${vp.height}`, async ({ fail, info }) => {
    await h.setMode('sidebar');
    const base = await baseline({ viewport: vp });
    const p = await openAdmin('orders', { viewport: vp });
    const r = await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
    if (r) info(`applied after ${r.elapsed}ms`);
  });
}

test('3c. sidebar: item follows the collapsed and expanded nav styling', async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin('orders', { query: 'collapsed=1' });
  await expectState(p, 'sidebar', await baseline({ query: 'collapsed=1' })).catch((e) => fail(e.message));
  checkItemFollowsSettingsText(await geometry(p)).forEach((m) => fail(`collapsed: ${m}`));
  await fx(p, 'expandNav');
  await expectState(p, 'sidebar', await baseline(), { label: 'sidebar after expandNav' }).catch((e) => fail(e.message));
  checkItemFollowsSettingsText(await geometry(p)).forEach((m) => fail(`expanded: ${m}`));
  await fx(p, 'collapseNav');
  await expectState(p, 'sidebar', await baseline({ query: 'collapsed=1' }), { label: 'sidebar after collapseNav' }).catch((e) => fail(e.message));
});

test('3d. hidden: bar and feather not rendered, no nav item, rest of the footer and nav untouched', async ({ fail }) => {
  await h.setMode('hidden');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'hidden', base).catch((e) => fail(e.message));
});

test('3e. hidden and sidebar leave the Sidekick side panel visible', async ({ fail }) => {
  for (const mode of ['hidden', 'sidebar']) {
    await h.setMode(mode);
    const p = await openAdmin('orders', { query: 'panel=1' });
    await sleep(300);
    const ok = await p.evaluate(() => {
      const f = document.querySelector('[data-fixture-panel] [data-sidekick-field]');
      return !!f && window.__dkt.isVisible(f);
    });
    if (!ok) fail(`${mode}: the Sidekick side panel field is hidden`);
    await p.close();
  }
});

// =====================================================================================
// 4. Late insertion: Sidekick (or the whole footer root) appears after load
// =====================================================================================
const lateQuery = (late) => `delay=1500${late === 'root' ? '&late=root' : ''}`;

for (const late of ['slot', 'root']) {
  test(`4a. sidebar, late ${late}: item appears with Sidekick, bar never painted`, async ({ fail, warn, info }) => {
    await h.setMode('sidebar');
    const base = await baseline();
    const p = await openAdmin('orders', { query: lateQuery(late) });
    // No baseline yet: before a late root insertion there are no outlets to compare.
    await expectState(p, 'sidebar', null, { expectItem: false, timeout: 1000, label: 'no item before Sidekick exists' }).catch((e) => fail(e.message));
    await p.evaluate(() => window.__dkt.startSampler());
    await p.waitForSelector('html[data-fixture-late-inserted]', { timeout: 4000 });
    const r = await expectState(p, 'sidebar', base, { timeout: T_FRAME, label: 'item after late insertion' }).catch((e) => fail(e.message));
    if (r) info(`item ${r.elapsed}ms after insertion`);
    const frames = await p.evaluate(() => window.__dktSampler.stop());
    if (frames.length) warn(`floating bar was painted for ${frames.length} frame(s) after late insertion`);
  });
}

for (const late of ['slot', 'root']) {
  test(`4b. hidden, late ${late}: bar never painted`, async ({ fail, warn }) => {
    await h.setMode('hidden');
    const base = await baseline();
    const p = await openAdmin('orders', { query: lateQuery(late) });
    await p.evaluate(() => window.__dkt.startSampler());
    await p.waitForSelector('html[data-fixture-late-inserted]', { timeout: 4000 });
    await expectState(p, 'hidden', base, { timeout: T_FRAME }).catch((e) => fail(e.message));
    const frames = await p.evaluate(() => window.__dktSampler.stop());
    if (frames.length) warn(`floating bar was painted for ${frames.length} frame(s) after late insertion`);
  });
}

// =====================================================================================
// 5. Removal, recreation and remounting of Shopify's nodes
// =====================================================================================
test('5a. sidebar: item removed with Sidekick and back when Sidekick returns', async ({ fail, info }) => {
  await h.setMode('sidebar');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await fx(p, 'removeSidekick');
  await expectState(p, 'sidebar', base, { expectItem: false, timeout: T_FRAME, label: 'no item after removeSidekick' }).catch((e) => fail(e.message));
  await fx(p, 'insertSidekick');
  const r = await expectState(p, 'sidebar', base, { timeout: T_FRAME, label: 'item after insertSidekick' }).catch((e) => fail(e.message));
  if (r) info(`item back after ${r.elapsed}ms`);
});

test('5b. sidebar: frame/Settings/nav removed, restored or remounted → never more than one item', async ({ fail, info }) => {
  await h.setMode('sidebar');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await p.evaluate(() => window.__dkt.watchItemCount());
  const times = [];
  const step = async (label, method, expectItem, b = base) => {
    await fx(p, method);
    const r = await expectState(p, 'sidebar', b, { expectItem, timeout: T_FRAME, label }).catch((e) => fail(e.message));
    if (r) times.push(`${method} ${r.elapsed}ms`);
  };
  await step('item after remountFrame', 'remountFrame', true);
  await step('item after remountSettings', 'remountSettings', true);
  await step('no item after removeSettings', 'removeSettings', false);
  await step('item after restoreSettings', 'restoreSettings', true);
  await step('no item after removeNav', 'removeNav', false, await baseline({ query: 'nav=hidden' }));
  await step('item after restoreNav', 'restoreNav', true);
  await fx(p, 'collapseNav');
  await step('item after remountFrame (collapsed)', 'remountFrame', true, await baseline({ query: 'collapsed=1' }));
  info(times.join(', '));
  const rec = await p.evaluate(() => window.__dktItemWatch.stop());
  if (rec.max > 1) fail(`more than one #dropkick-nav-item existed at some point (max ${rec.max})`);

  const p2 = await openAdmin('orders', { query: 'nav=hidden' });
  await expectState(p2, 'sidebar', await baseline({ query: 'nav=hidden' }), { expectItem: false, label: 'loaded without nav' }).catch((e) => fail(e.message));
});

test('5c. hidden: stays hidden when Sidekick is recreated or the frame remounts', async ({ fail }) => {
  await h.setMode('hidden');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'hidden', base).catch((e) => fail(e.message));
  await fx(p, 'removeSidekick');
  await fx(p, 'insertSidekick');
  await expectState(p, 'hidden', base, { timeout: T_FRAME, label: 'hidden after re-insert' }).catch((e) => fail(e.message));
  await fx(p, 'remountFrame');
  await expectState(p, 'hidden', base, { timeout: T_FRAME, label: 'hidden after remount' }).catch((e) => fail(e.message));
});

// =====================================================================================
// 6. Client-side navigation
// =====================================================================================
test('6. SPA navigation keeps each mode applied; the real Settings link still works and is untouched', async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin();
  await expectState(p, 'sidebar', await baseline()).catch((e) => fail(e.message));
  const docId = await p.evaluate(() => (window.__docId = Math.random()));
  for (const [path, pg] of [['/store/test/products', 'products'], ['/store/test', ''], ['/store/test/orders', 'orders']]) {
    await fx(p, 'navigate', path);
    await expectState(p, 'sidebar', await baseline({ page: pg }), { timeout: T_FRAME, label: `sidebar after navigate(${path})` }).catch((e) => fail(e.message));
  }
  // On /settings the Settings item has its selected variant; the clone must not copy it.
  await p.click('#AppFrameNav [data-sticky-bottom-nav] a[href$="/settings"]');
  if ((await p.evaluate(() => location.pathname)) !== '/store/test/settings') fail('clicking the real Settings link did not navigate');
  await expectState(p, 'sidebar', await baseline({ page: 'settings' }), { timeout: T_FRAME, label: 'sidebar on /settings (Settings selected)' }).catch((e) => fail(e.message));
  await p.click('#AppFrameNav a[href="/store/test/customers"]');
  await expectState(p, 'sidebar', await baseline({ page: 'customers' }), { timeout: T_FRAME, label: 'sidebar after nav link click' }).catch((e) => fail(e.message));
  await fx(p, 'back');
  await expectState(p, 'sidebar', await baseline({ page: 'settings' }), { timeout: T_FRAME, label: 'sidebar after history.back()' }).catch((e) => fail(e.message));
  if ((await p.evaluate(() => window.__docId)) !== docId) fail('page reloaded during SPA navigation');

  const p2 = await openAdmin('settings');
  await expectState(p2, 'sidebar', await baseline({ page: 'settings' }), { label: 'loaded on /settings' }).catch((e) => fail(e.message));

  await h.setMode('hidden');
  await fx(p, 'navigate', '/store/test/orders');
  await expectState(p, 'hidden', await baseline()).catch((e) => fail(e.message));
  for (const [path, pg] of [['/store/test/products', 'products'], ['/store/test', '']]) {
    await fx(p, 'navigate', path);
    await expectState(p, 'hidden', await baseline({ page: pg }), { timeout: T_FRAME, label: `hidden after navigate(${path})` }).catch((e) => fail(e.message));
  }
});

// =====================================================================================
// 7. Mode changes on a live page and restoring the original page
// =====================================================================================
test('7a. sidebar → original restores the untouched page', async ({ fail, info }) => {
  await h.setMode('original');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'original', base).catch((e) => fail(`before: ${e.message}`));
  const own = { snap: await snapshot(p) };
  await h.setMode('sidebar');
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await h.setMode('original');
  const r = await expectState(p, 'original', own, { timeout: T_RESTORE }).catch((e) => fail(e.message));
  if (r) info(`restored in ${r.elapsed}ms`);
  await expectState(p, 'original', base, { timeout: 200, label: 'original vs baseline' }).catch((e) => fail(e.message));
});

test('7b. sidebar → original after using the item in the collapsed nav', async ({ fail, warn }) => {
  await h.setMode('sidebar');
  const base = await baseline({ query: 'collapsed=1' });
  const p = await openAdmin('orders', { query: 'collapsed=1' });
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await expectActivationOpensPanel(p, 'click', fail, warn);
  await closePanelAndExpectClosedState(p, base, fail);
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE }).catch((e) => fail(e.message));
});

test('7c. sidebar → original with the panel open leaves the panel alone', async ({ fail }) => {
  await h.setMode('sidebar');
  const base = await baseline({ query: 'panel=1' });
  const p = await openAdmin('orders', { query: 'panel=1' });
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE }).catch((e) => fail(e.message));
});

test('7d. hidden → original → sidebar → hidden → sidebar → original', async ({ fail }) => {
  await h.setMode('hidden');
  const base = await baseline();
  const p = await openAdmin();
  await expectState(p, 'hidden', base).catch((e) => fail(e.message));
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE, label: 'hidden → original' }).catch((e) => fail(e.message));
  await h.setMode('sidebar');
  await expectState(p, 'sidebar', base, { label: 'original → sidebar' }).catch((e) => fail(e.message));
  await h.setMode('hidden');
  await expectState(p, 'hidden', base, { label: 'sidebar → hidden' }).catch((e) => fail(e.message));
  await h.setMode('sidebar');
  await expectState(p, 'sidebar', base, { label: 'hidden → sidebar' }).catch((e) => fail(e.message));
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE, label: 'sidebar → original' }).catch((e) => fail(e.message));
});

// =====================================================================================
// 8. Activating the nav item
// =====================================================================================
for (const how of ['click', 'enter', 'space']) {
  test(`8a. ${how} opens the panel via the footer button, aria-expanded follows open and close`, async ({ fail, warn }) => {
    await h.setMode('sidebar');
    const base = await baseline();
    const p = await openAdmin();
    await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
    await expectActivationOpensPanel(p, how, fail, warn);
    await expectState(p, 'sidebar', await baseline({ query: 'panel=1' }), { timeout: T_EXPANDED, label: 'sidebar with the panel open' }).catch((e) => fail(e.message));
    await closePanelAndExpectClosedState(p, base, fail);
  });
}

test('8b. with the panel open, activation focuses the panel input without clicking footer buttons', async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin('orders', { query: 'panel=1' });
  await expectState(p, 'sidebar', await baseline({ query: 'panel=1' })).catch((e) => fail(e.message));
  for (const how of ['enter', 'click', 'space']) {
    await p.evaluate(() => document.activeElement?.blur());
    const before = await fxState(p);
    await activate(p, how).catch((e) => fail(`${how}: ${e.message}`));
    await until(async () => {
      const g = await geometry(p);
      const e = [];
      if (!g.panelInputFocused) e.push(`panel input not focused (activeElement ${g.activeElement})`);
      if (!g.fixture.panelOpen) e.push('panel closed');
      if (g.fixture.openClicks !== before.openClicks || g.fixture.activityClicks !== before.activityClicks) e.push('a footer button was clicked');
      if (ariaExpanded(g) !== 'true') e.push(`aria-expanded = ${ariaExpanded(g)}`);
      return e;
    }, { timeout: T_EXPANDED, label: `${how} with panel open` }).catch((e) => fail(e.message));
  }
});

test('8c. activation while the panel is opening keeps it open and focuses it', async ({ fail, warn }) => {
  await h.setMode('sidebar');
  const p = await openAdmin('orders', { query: 'panelDelay=2000' });
  await expectState(p, 'sidebar', await baseline()).catch((e) => fail(e.message));
  await fx(p, 'openPanel');
  await p.evaluate(() => document.activeElement?.blur());
  await activate(p, 'enter').catch((e) => fail(e.message));
  // Only a warning: if the footer field is already gone the case no longer tests the overlap window.
  await until(async () => {
    const g = await geometry(p);
    const e = [];
    if (!g.footerHasField) e.push('footer field already removed; the panel-opening window was missed');
    if (!g.fixture.panelOpen) e.push('panel closed');
    if (!g.panelInputFocused) e.push(`panel textarea not focused (activeElement ${g.activeElement})`);
    return e;
  }, { timeout: 1000, label: 'activation during the panel animation' }).catch((e) => warn(e.message));
  await expectExpanded(p, 'true', 'aria-expanded while the panel is open').catch((e) => fail(e.message));
});

test('8d. aria-expanded follows the panel when Shopify opens or closes it', async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin();
  await expectState(p, 'sidebar', await baseline()).catch((e) => fail(e.message));
  // The footer bar isn't rendered in sidebar mode, so open through the fixture (the button's code path).
  await fx(p, 'openPanel');
  await expectExpanded(p, 'true', 'aria-expanded after openPanel').catch((e) => fail(e.message));
  await p.click('[data-fixture-panel] button[aria-label="Close Sidekick"]');
  await expectExpanded(p, 'false', 'aria-expanded after the panel close button').catch((e) => fail(e.message));
});

test('8e. French admin: the open button is found by its icon, not its label', async ({ fail, warn }) => {
  await h.setMode('sidebar');
  const base = await baseline({ query: 'lang=fr' });
  const p = await openAdmin('orders', { query: 'lang=fr' });
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await expectActivationOpensPanel(p, 'click', fail, warn);
});

test('8f. activation from the collapsed nav', async ({ fail, warn }) => {
  await h.setMode('sidebar');
  const base = await baseline({ query: 'collapsed=1' });
  const p = await openAdmin('orders', { query: 'collapsed=1' });
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await expectActivationOpensPanel(p, 'enter', fail, warn);
});

// =====================================================================================
// 9. Panel open at load, narrow viewport
// =====================================================================================
test('9a. loaded with the panel open (no footer field): item present, aria-expanded="true"', async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin('orders', { query: 'panel=1' });
  await expectState(p, 'sidebar', await baseline({ query: 'panel=1' })).catch((e) => fail(e.message));
  if ((await geometry(p)).footerHasField) fail('fixture: footer still has a field with the panel open');
  await closePanelAndExpectClosedState(p, await baseline(), fail);
});

test(`9b. narrow viewport (${NARROW_VIEWPORT.width}px, nav off-canvas): item still mirrors Settings`, async ({ fail }) => {
  await h.setMode('sidebar');
  const p = await openAdmin('orders', { viewport: NARROW_VIEWPORT });
  await expectState(p, 'sidebar', await baseline({ viewport: NARROW_VIEWPORT }), { geometryOnly: true }).catch((e) => fail(e.message));
  await p.setViewport(DEFAULT_VIEWPORT);
  await expectState(p, 'sidebar', await baseline(), { label: 'after widening' }).catch((e) => fail(e.message));
});

// =====================================================================================
// 10. Popup
// =====================================================================================
test('10. popup: shows the stored mode, saves keyboard selection, updates open tabs, Reset → original', async ({ fail, warn }) => {
  const popupUrl = `chrome-extension://${h.extensionId}/popup.html`;
  const checkedValue = (pp) => pp.evaluate(() => document.querySelector('input[name="mode"]:checked')?.value ?? null);
  const waitChecked = (pp, v, label) => until(async () => { const c = await checkedValue(pp); return c === v ? [] : [`checked radio = ${c}, expected ${v}`]; }, { timeout: T_APPLY, label });
  const waitStored = (v, label) => until(async () => { const s = (await h.getStored()).mode; return s === v ? [] : [`storage mode = ${JSON.stringify(s)}, expected ${v}`]; }, { timeout: T_APPLY, label });

  await h.setMode(null);
  let pp = await h.openPage(popupUrl);
  await waitChecked(pp, 'original', 'popup default').catch((e) => fail(e.message));
  const order = await pp.evaluate(() => [...document.querySelectorAll('input[name="mode"]')].map((r) => r.value));
  if ([...order].sort().join() !== 'hidden,original,sidebar') fail(`radio values = ${JSON.stringify(order)}`);
  const unlabeled = await pp.evaluate(() => [...document.querySelectorAll('input[name="mode"]')].filter((r) => !r.labels?.length && !r.getAttribute('aria-label')).map((r) => r.value));
  if (unlabeled.length) warn(`radios without a label: ${unlabeled.join(', ')}`);
  if (!(await pp.$('#reset'))) fail('#reset missing');
  const storedAfterOpen = (await h.getStored()).mode;
  if (storedAfterOpen !== undefined && storedAfterOpen !== 'original') fail(`opening the popup wrote mode=${storedAfterOpen}`);
  await pp.close();
  for (const v of ['hidden', 'sidebar']) {
    await h.setMode(v);
    pp = await h.openPage(popupUrl);
    await waitChecked(pp, v, `popup reflects ${v}`).catch((e) => fail(e.message));
    await pp.close();
  }

  await h.setMode('original');
  const base = await baseline();
  const admin = await openAdmin();
  await expectState(admin, 'original', base).catch((e) => fail(e.message));
  pp = await h.openPage(popupUrl);
  await waitChecked(pp, 'original', 'popup shows original').catch((e) => fail(e.message));

  // Arrow keys move through the radio group in document order and save immediately.
  await pp.focus('input[name="mode"]:checked');
  await pp.keyboard.press('ArrowDown');
  const next = order[(order.indexOf('original') + 1) % order.length];
  await waitChecked(pp, next, 'ArrowDown moved selection').catch((e) => fail(e.message));
  await waitStored(next, 'ArrowDown saved immediately').catch((e) => fail(e.message));
  await admin.bringToFront();
  await expectState(admin, next, base, { label: `admin tab live-updated to ${next}` }).catch((e) => fail(e.message));

  await pp.bringToFront();
  await pp.focus('input[name="mode"]:checked');
  await pp.keyboard.press('ArrowUp');
  await waitStored('original', 'ArrowUp back to original').catch((e) => fail(e.message));

  await pp.focus('input[name="mode"][value="sidebar"]');
  await pp.keyboard.press('Space');
  await waitChecked(pp, 'sidebar', 'Space selects').catch((e) => fail(e.message));
  await waitStored('sidebar', 'Space saved').catch((e) => fail(e.message));
  await admin.bringToFront();
  await expectState(admin, 'sidebar', base, { label: 'admin tab live-updated to sidebar' }).catch((e) => fail(e.message));

  await pp.bringToFront();
  await pp.click('#reset').catch((e) => fail(`click #reset: ${e.message}`));
  await waitStored('original', '#reset stores original').catch((e) => fail(e.message));
  await waitChecked(pp, 'original', '#reset checks original').catch((e) => fail(e.message));
  await admin.bringToFront();
  await expectState(admin, 'original', base, { timeout: T_RESTORE, label: 'admin tab back to original after #reset' }).catch((e) => fail(e.message));

  await h.setMode('hidden');
  await waitChecked(pp, 'hidden', 'popup follows external storage change').catch(() => warn('open popup does not follow storage changes made elsewhere'));
  await h.setMode('original');
});

// =====================================================================================
// 11. Other sites and iframes
// =====================================================================================
test('11. not injected on other sites (including an admin look-alike) or in admin iframes', async ({ fail }) => {
  await h.setMode('sidebar');
  for (const url of [OTHER, `${BASELINE}/orders`]) {
    const p = await h.openPage(url);
    await sleep(400);
    const g = await p.evaluate(() => ({
      attrs: [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dropkick')),
      item: !!document.getElementById('dropkick-nav-item'),
      inline: [...document.querySelectorAll('[style]')].filter((e) => !/^--nav-enter-index: \d+;$/.test(e.getAttribute('style'))).map((e) => e.tagName + ':' + e.getAttribute('style')),
    }));
    if (g.attrs.length) fail(`${url}: <html> has ${g.attrs}`);
    if (g.item) fail(`${url}: #dropkick-nav-item present`);
    if (g.inline.length) fail(`${url}: inline styles present ${g.inline.slice(0, 3)}`);
    const ctx = h.extensionContexts(p);
    if (ctx.length) fail(`${url}: content script world created (${ctx.map((c) => c.name).join(', ')})`);
  }
  const p = await openAdmin('orders', { query: 'iframe=1' });
  await expectState(p, 'sidebar', null).catch((e) => fail(`top frame: ${e.message}`));
  const frame = p.frames().find((f) => f !== p.mainFrame() && f.url().includes('/apps/embedded'));
  if (!frame) return fail('fixture iframe not found');
  await frame.waitForFunction(() => window.__fixture?.ready, { timeout: 5000 });
  await sleep(300);
  const fg = await frameGeometry(frame);
  if (fg.htmlDropkickAttrs.length || fg.itemCount) fail(`iframe touched: ${fg.htmlDropkickAttrs} items=${fg.itemCount}`);
  if (h.extensionContexts(p, frame._id).length) fail('content script injected into the admin iframe');
  if (!h.extensionContexts(p, p.mainFrame()._id).length) fail('content script not found in the top frame (positive control)');
});

// =====================================================================================
// 12–13. Re-injection into open tabs (run last: 12 reloads the extension)
// =====================================================================================
/**
 * Updates the extension in place. chrome.runtime.reload() leaves a CDP-loaded unpacked extension
 * disabled in headless Chrome, and uninstall + install wipes chrome.storage, so load the same path
 * again instead: same id, storage kept, onInstalled fires with reason "update".
 */
async function reloadExtension() {
  const id = await h.browser.installExtension(EXT_DIR);
  if (id !== h.extensionId) throw new Error(`extension id changed (${h.extensionId} → ${id})`);
}

/** Runs `fn` in an extension page, where chrome.tabs and chrome.scripting are available. */
async function inExtensionPage(fn, ...args) {
  const pg = await h.openPage(`chrome-extension://${h.extensionId}/popup.html`);
  try { return await pg.evaluate(fn, ...args); } finally { await pg.close(); }
}

test('12. extension update without a page refresh: re-injected, old copy retired, one item, settings still live', async ({ fail, info }) => {
  await h.setMode('sidebar');
  const base = await baseline();
  const p = await openAdmin();
  const other = await h.openPage(OTHER);
  await p.bringToFront();
  await expectState(p, 'sidebar', base).catch((e) => fail(`before reload: ${e.message}`));
  const docId = await p.evaluate(() => { window.__dkt.watchItemCount(); return (window.__docId = Math.random()); });
  const ctxBefore = h.extensionContexts(p).length;
  try {
    await reloadExtension();
  } catch (e) {
    return fail(`could not reload the extension: ${e.message}`);
  }
  const r = await until(async () => (h.extensionContexts(p).length > ctxBefore ? [] : ['no new content-script world in the open admin tab']), { timeout: 5000, stable: 1, label: 're-injection' }).catch((e) => fail(e.message));
  if (r) info(`re-injected after ${r.elapsed}ms`);
  await expectState(p, 'sidebar', base, { label: 'sidebar after reload' }).catch((e) => fail(e.message));
  await sleep(300);
  await expectState(p, 'sidebar', base, { timeout: 200, label: 'sidebar settled after reload' }).catch((e) => fail(e.message));
  if ((await p.evaluate(() => window.__dktItemWatch.rec.max)) > 1) fail('more than one #dropkick-nav-item existed at once during takeover');
  if ((await p.evaluate(() => window.__docId)) !== docId) fail('admin page was reloaded');

  // Setting changes now reach the new copy.
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE, label: 'original after reload' }).catch((e) => fail(e.message));
  await h.setMode('hidden');
  await expectState(p, 'hidden', base, { label: 'hidden after reload' }).catch((e) => fail(e.message));
  await h.setMode('sidebar');
  await expectState(p, 'sidebar', base, { label: 'sidebar again after reload' }).catch((e) => fail(e.message));
  await expectActivationOpensPanel(p, 'click', fail);
  await fx(p, 'closePanel');
  const rec = await p.evaluate(() => window.__dktItemWatch.stop());
  if (rec.max > 1) fail(`more than one item at some point after reload (max ${rec.max})`);

  const og = await other.evaluate(() => ({
    attrs: [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dropkick')),
    item: !!document.getElementById('dropkick-nav-item'),
  }));
  if (og.attrs.length || og.item) fail(`example.test tab touched after reload: ${JSON.stringify(og)}`);
  if (h.extensionContexts(other).length) fail('content script injected into the example.test tab on reload');
});

test('13. content.js injected twice into one page: one item, settings still live', async ({ fail }) => {
  await h.setMode('sidebar');
  const base = await baseline();
  // The query string only marks the tab so chrome.tabs.query can find it; the fixture ignores it.
  const p = await openAdmin('orders', { query: 'double=1' });
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await p.evaluate(() => window.__dkt.watchItemCount());
  const res = await inExtensionPage(async () => {
    const tabs = (await chrome.tabs.query({ url: 'https://admin.shopify.com/*' })).filter((t) => (t.url || '').includes('double=1'));
    if (tabs.length !== 1) return `found ${tabs.length} tabs`;
    for (let i = 0; i < 2; i++) await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content.js'] });
    return 'ok';
  }).catch((e) => e.message);
  if (res !== 'ok') return fail(`executeScript x2: ${res}`);
  await sleep(300);
  await expectState(p, 'sidebar', base, { timeout: 500, label: 'sidebar after double injection' }).catch((e) => fail(e.message));
  await h.setMode('original');
  await expectState(p, 'original', base, { timeout: T_RESTORE, label: 'original after double injection' }).catch((e) => fail(e.message));
  await h.setMode('hidden');
  await expectState(p, 'hidden', base).catch((e) => fail(e.message));
  await h.setMode('sidebar');
  await expectState(p, 'sidebar', base).catch((e) => fail(e.message));
  await expectActivationOpensPanel(p, 'enter', fail);
  await fx(p, 'closePanel');
  const rec = await p.evaluate(() => window.__dktItemWatch.stop());
  if (rec.max > 1) fail(`more than one item at some point (max ${rec.max})`);
});

// =====================================================================================
// runner
// =====================================================================================
async function main() {
  console.log(`DropKick tests — extension dir: ${path.relative(ROOT, EXT_DIR) || '.'}${EXT_FOUND ? '' : '  (NOT FOUND)'}\n`);
  h = new Harness({ extensionDir: EXT_DIR, headful: HEADFUL });
  let launchError = null;
  try {
    await h.launch({ withExtension: EXT_FOUND });
    if (EXT_FOUND) console.log(`extension id ${h.extensionId}; ${await h.browser.version()}\n`);
  } catch (e) {
    launchError = e;
    // Fall back to a browser without the extension so the fixture case can still run.
    await h.close();
    h = new Harness({ extensionDir: EXT_DIR, headful: HEADFUL });
    await h.launch({ withExtension: false });
  }

  const results = [];
  for (const c of cases) {
    if (GREP && !GREP.test(c.name)) continue;
    const errors = [], warnings = [], infos = [];
    if (c.needsExtension && !EXT_FOUND) {
      errors.push(`extension not found: ${path.relative(ROOT, MANIFEST)} does not exist`);
    } else if (c.needsExtension && launchError) {
      errors.push(`extension failed to load: ${launchError.message}`);
    } else {
      const before = h.unexpected.length;
      const pagesBefore = new Set(await h.browser.pages());
      const t0 = Date.now();
      try {
        await withTimeout(c.fn({ fail: (m) => { errors.push(m); }, warn: (m) => { warnings.push(m); }, info: (m) => { infos.push(m); } }), 45000);
      } catch (e) {
        errors.push(`threw: ${e.stack?.split('\n').slice(0, 3).join(' | ') || e}`);
      }
      // Any request the fixtures don't serve fails the case.
      for (const u of h.unexpected.slice(before)) errors.push(`unexpected network request: ${u.url} (from ${u.from})`);
      // Fail on uncaught exceptions in extension code, then close the pages the case opened.
      for (const pg of await h.browser.pages()) {
        if (pagesBefore.has(pg)) continue;
        if (EXT_FOUND) for (const ex of h.extensionExceptions(pg)) errors.push(`uncaught exception in extension code: ${ex.text.split('\n')[0]}`);
        await pg.close().catch(() => {});
      }
      infos.push(`${Date.now() - t0}ms`);
    }
    const status = errors.length ? FAIL : PASS;
    console.log(`${status}  ${c.name}${infos.length ? color(90, `  (${infos.join('; ')})`) : ''}`);
    for (const e of errors) console.log(`      ✗ ${e}`);
    for (const w of warnings) console.log(`      ${WARN} ${w}`);
    results.push({ name: c.name, ok: !errors.length });
  }
  await h.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}`);
  if (!EXT_FOUND) console.log(`\n${FAIL} extension not found at ${MANIFEST}`);
  process.exitCode = failed.length ? 1 : 0;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`case timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t));
}

main().catch(async (e) => { console.error(e); await h?.close(); process.exit(2); });
