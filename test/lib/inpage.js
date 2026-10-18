/*
 * Measurement helpers, injected into the main world of every page the harness opens (before any page
 * script runs) and exposed as window.__dkt. They only read the page; fixedProbe() adds a probe element
 * and removes it in the same task.
 */
(() => {
  if (window.__dkt) return;

  const q = (s, root = document) => root.querySelector(s);
  const ITEM = '#dropkick-nav-item';
  const footerSection = () => q('[data-frame-footer-outlet="center"] section[aria-label="Sidekick"]');

  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  };
  const area = (b) => (b ? Math.max(0, b.width) * Math.max(0, b.height) : 0);
  const intersect = (a, b) => {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const viewportRect = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight });

  /** Painted and on screen: not hidden by display/visibility/opacity, non-empty, and not clipped away by an ancestor. */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const box = r(el);
    if (area(box) < 1) return false;
    if (!intersect(box, viewportRect())) return false;
    let clip = box;
    // A position:fixed box escapes ancestor overflow clipping unless an ancestor becomes its
    // containing block (transform, filter, contain, ...).
    let escaped = getComputedStyle(el).position === 'fixed';
    const isFixedCB = (cs) => cs.transform !== 'none' || cs.perspective !== 'none' || cs.filter !== 'none' ||
      /paint|layout|strict|content/.test(cs.contain) || /transform|perspective|filter/.test(cs.willChange);
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (escaped) {
        if (!isFixedCB(cs)) continue;
        escaped = false;
      }
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        clip = intersect(clip, r(p));
        if (!clip || area(clip) < 1) return false;
      }
      if (cs.position === 'fixed') escaped = true;
    }
    const cp = getComputedStyle(el).clipPath;
    if (cp && /inset\(\s*(50|100)%/.test(cp)) return false;
    return true;
  }

  /** Laid out at all: not display:none (on itself or an ancestor) and a non-empty box. */
  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    if (!el.checkVisibility()) return false;
    return area(r(el)) > 0;
  }

  /** Does a click at the centre of `box` land on `el` (or inside it)? */
  function hitInside(el, box) {
    if (!el || !box || area(box) < 1) return false;
    const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }

  /** Visible boxes of the nav's items (clipped by scroll containers and the nav), excluding `exclude`. */
  function navItemRects(nav, exclude) {
    if (!nav) return [];
    const navBox = r(nav);
    const out = [];
    for (const el of nav.querySelectorAll('a[data-navitem], button, [data-sticky-bottom-nav] > *, li')) {
      if (exclude && (exclude.contains(el) || el.contains(exclude))) continue;
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let clip = r(el);
      for (let p = el.parentElement; p && p !== nav.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') clip = intersect(clip, r(p));
        if (!clip) break;
      }
      clip = intersect(clip, navBox);
      if (!clip || area(clip) < 1) continue;
      out.push({ label: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40), tag: el.tagName.toLowerCase(), clipped: clip });
    }
    return out;
  }

  const describe = (el) => (el
    ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.name ? '[name=' + el.name + ']' : ''}` +
      `${el.closest('[data-fixture-panel]') ? '(in panel)' : el.closest('[data-frame-footer]') ? '(in footer)' : ''}`
    : null);

  const subtree = (el) => [el, ...el.querySelectorAll('*')];
  const structure = (el) => subtree(el).map((e) => e.tagName.toLowerCase()).join('>');

  function itemInfo(itemLi, settingsLi) {
    if (!itemLi) return null;
    const a = itemLi.querySelector('a[data-navitem="item"]') || itemLi.querySelector('a');
    const icon = a && a.querySelector('s-internal-icon');
    const box = r(a);
    const text = a && a.querySelector('span');
    return {
      tag: itemLi.tagName.toLowerCase(),
      prevOfSettings: !!settingsLi && settingsLi.previousElementSibling === itemLi,
      a: a ? {
        attrs: Object.fromEntries([...a.attributes].map((x) => [x.name, x.value])),
        text: a.textContent.trim(),
        iconType: icon ? icon.getAttribute('type') : null,
        rect: box,
        visible: isVisible(a),
        hit: hitInside(itemLi, box),
        textVisible: text ? isVisible(text) : null,
      } : null,
      selectedish: subtree(itemLi).flatMap((e) => [...e.classList]).filter((c) => /selected|active/i.test(c)),
      ariaCurrent: subtree(itemLi).filter((e) => e.hasAttribute('aria-current')).length,
      innerIds: [...itemLi.querySelectorAll('[id]')].map((e) => e.id),
      structure: structure(itemLi),
    };
  }

  /** Everything the checks in checks.mjs assert on. */
  function geometry() {
    const html = document.documentElement;
    const nav = q('#AppFrameNav');
    const sticky = q('#AppFrameNav [data-sticky-bottom-nav]');
    const settings = q('#AppFrameNav [data-sticky-bottom-nav] a[href$="/settings"]');
    const settingsLi = settings && settings.closest('li');
    const section = footerSection();
    const feather = q('[data-frame-footer-outlet="center"] [data-floating-sidekick-page-feather]');
    const items = document.querySelectorAll(ITEM);
    const itemLi = items[0] || null;
    const panel = q('[data-fixture-panel]');
    const panelInput = panel && q('[name="sidekickMessage"]', panel);
    const pagination = q('[data-frame-footer-outlet="start"] > *');
    return {
      mode: html.getAttribute('data-dropkick-mode'),
      htmlDropkickAttrs: [...html.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dropkick')),
      path: location.pathname,
      nav: nav ? { rect: r(nav) } : null,
      navItems: navItemRects(nav, itemLi),
      sticky: sticky ? { paddingTop: parseFloat(getComputedStyle(sticky).paddingTop) } : null,
      settings: settings ? {
        rect: r(settings),
        liHTML: settingsLi.outerHTML,
        structure: structure(settingsLi),
        textVisible: isVisible(settings.querySelector('span')),
      } : null,
      section: section ? { rect: r(section), display: getComputedStyle(section).display, rendered: isRendered(section) } : null,
      feather: feather ? { rect: r(feather), rendered: isRendered(feather) } : null,
      footerHasField: !!(section && q('[data-sidekick-field]', section)),
      panelOpen: !!panel,
      panelInputFocused: !!panelInput && document.activeElement === panelInput,
      activeElement: describe(document.activeElement),
      itemCount: items.length,
      item: itemInfo(itemLi, settingsLi),
      fixture: window.__fixture ? window.__fixture.state : null,
      pagination: pagination ? { rect: r(pagination), hit: hitInside(pagination, r(pagination)) } : null,
      outlets: Object.fromEntries(['start', 'center', 'end'].map((k) => [k, r(q(`[data-frame-footer-outlet="${k}"]`))])),
    };
  }

  /** Records the largest number of nav items that ever existed at once, until stop() is called. */
  function watchItemCount() {
    const rec = { max: document.querySelectorAll(ITEM).length };
    const mo = new MutationObserver(() => {
      rec.max = Math.max(rec.max, document.querySelectorAll(ITEM).length);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.__dktItemWatch = { rec, stop: () => { mo.disconnect(); return rec; } };
  }

  // Fixture bookkeeping attributes on <html>; never part of the comparison.
  const IGNORED_HTML_ATTRS = /^data-fixture-/;

  /** Attributes and boxes of every element under #app, plus <html>/<body> attributes and body children. */
  function snapshot() {
    const attrs = (el) => [...el.attributes]
      .filter((a) => !(el === document.documentElement && IGNORED_HTML_ATTRS.test(a.name)))
      .map((a) => `${a.name}=${a.value}`).sort();
    const root = document.getElementById('app');
    const els = root ? [...root.querySelectorAll('*')].map((el) => ({ tag: el.tagName.toLowerCase(), attrs: attrs(el), rect: r(el) })) : [];
    return {
      html: attrs(document.documentElement),
      body: attrs(document.body),
      bodyChildren: [...document.body.children].map((c) => `${c.tagName.toLowerCase()}${c.id ? '#' + c.id : ''}`),
      els,
    };
  }

  /** Records every animation frame in which the floating bar is painted, until stop() is called. */
  function startSampler() {
    const frames = [];
    let running = true;
    const tick = () => {
      if (!running) return;
      const s = footerSection();
      if (s && isVisible(s)) frames.push({ t: Math.round(performance.now()), rect: r(s) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__dktSampler = { frames, stop: () => { running = false; return frames; } };
  }

  /** Fixture fidelity: a position:fixed descendant of the footer root must resolve against the viewport. */
  function fixedProbe() {
    const root = q('[data-frame-footer-root]');
    if (!root) return null;
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px';
    root.append(p);
    const b = r(p);
    p.remove();
    return b;
  }

  window.__dkt = { geometry, snapshot, startSampler, watchItemCount, fixedProbe, isVisible };
})();
