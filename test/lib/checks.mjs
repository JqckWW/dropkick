// Assertions over the objects produced by inpage.js. Each check returns a list of failure messages
// (empty means pass) so it can be polled with until().

const TOL = 0.5; // px

const fmt = (b) => (b ? `[l${b.left.toFixed(1)} t${b.top.toFixed(1)} r${b.right.toFixed(1)} b${b.bottom.toFixed(1)}]` : 'null');
const overlap = (a, b) => {
  if (!a || !b) return 0;
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > TOL && h > TOL ? w * h : 0;
};
const rectEq = (a, b) => !!a && !!b && ['left', 'top', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= TOL);

export const geometry = (page) => page.evaluate(() => window.__dkt.geometry());
export const snapshot = (page) => page.evaluate(() => window.__dkt.snapshot());
export const frameGeometry = (frame) => frame.evaluate(() => window.__dkt.geometry());

/** hidden and sidebar: the floating bar and its feather are not rendered; the other footer outlets are unaffected. */
function checkBarHidden(g, base) {
  const e = [];
  if (g.section?.rendered) e.push(`footer Sidekick section still rendered ${fmt(g.section.rect)} display=${g.section.display}`);
  if (g.feather?.rendered) e.push(`[data-floating-sidekick-page-feather] still rendered ${fmt(g.feather.rect)}`);
  if (!base) return e;
  if (base.pagination) {
    if (!g.pagination) e.push('pagination (start outlet) missing');
    else {
      if (!rectEq(g.pagination.rect, base.pagination.rect)) e.push(`pagination ${fmt(g.pagination.rect)} != baseline ${fmt(base.pagination.rect)}`);
      if (!g.pagination.hit) e.push('pagination not hit-testable');
    }
  }
  for (const k of ['start', 'end']) {
    if (!rectEq(g.outlets[k], base.outlets[k])) e.push(`${k} outlet ${fmt(g.outlets[k])} != baseline ${fmt(base.outlets[k])}`);
  }
  return e;
}

/** hidden mode. `base` (optional) is the never-touched geometry of the same page. */
export function checkHidden(g, base) {
  const e = [];
  if (g.mode !== 'hidden') e.push(`html[data-dropkick-mode] = ${JSON.stringify(g.mode)}, expected "hidden"`);
  e.push(...checkBarHidden(g, base));
  if (g.itemCount) e.push(`#dropkick-nav-item present in hidden mode (${g.itemCount})`);
  if (base?.sticky && g.sticky && Math.abs(g.sticky.paddingTop - base.sticky.paddingTop) > TOL) e.push('sticky nav padding changed in hidden mode');
  if (base?.settings && g.settings && !rectEq(g.settings.rect, base.settings.rect)) e.push(`Settings moved in hidden mode ${fmt(g.settings.rect)} vs ${fmt(base.settings.rect)}`);
  return e;
}

/**
 * sidebar mode.
 *   base          never-touched geometry of the same page (outlets, Settings markup)
 *   expectItem    false when the page has no Settings item or no Sidekick, so no nav item may exist
 *   geometryOnly  skip visibility and hit-testing (for an off-canvas nav)
 */
export function checkSidebar(g, { base, expectItem = true, geometryOnly = false } = {}) {
  const e = [];
  if (g.mode !== 'sidebar') e.push(`html[data-dropkick-mode] = ${JSON.stringify(g.mode)}, expected "sidebar"`);
  e.push(...checkBarHidden(g, base));
  if (base?.settings && g.settings && g.settings.liHTML !== base.settings.liHTML) {
    e.push('Settings li differs from the never-touched baseline (attributes or children changed)');
  }
  if (!expectItem) {
    if (g.itemCount) e.push(`#dropkick-nav-item present (${g.itemCount}) without a Settings item or Sidekick`);
    return e;
  }
  if (g.itemCount !== 1) e.push(`expected exactly 1 #dropkick-nav-item, found ${g.itemCount}`);
  const it = g.item;
  if (!it) return e;
  if (it.tag !== 'li') e.push(`#dropkick-nav-item is <${it.tag}>, expected <li>`);
  if (!it.prevOfSettings) e.push('#dropkick-nav-item is not the sibling immediately before the Settings li');
  if (!it.a) return [...e, 'no <a> inside #dropkick-nav-item'];

  const A = it.a.attrs;
  if (A['data-navitem'] !== 'item') e.push(`a[data-navitem] = ${JSON.stringify(A['data-navitem'])}`);
  if ('href' in A) e.push(`a has href=${JSON.stringify(A.href)} (must have none)`);
  if (A.role !== 'button') e.push(`a role = ${JSON.stringify(A.role)}, expected "button"`);
  if (A.tabindex !== '0') e.push(`a tabindex = ${JSON.stringify(A.tabindex)}, expected "0"`);
  if (A['aria-label'] !== 'Sidekick') e.push(`a aria-label = ${JSON.stringify(A['aria-label'])}, expected "Sidekick"`);
  if (it.a.text !== 'Sidekick') e.push(`a text = ${JSON.stringify(it.a.text)}, expected "Sidekick"`);
  if (it.a.iconType !== 'sidekick') e.push(`s-internal-icon type = ${JSON.stringify(it.a.iconType)}, expected "sidekick"`);
  if (it.selectedish.length) e.push(`selected/active classes present: ${it.selectedish.join(' ')}`);
  if (it.ariaCurrent) e.push('aria-current present inside the item');
  if (it.innerIds.length) e.push(`ids inside the item: ${it.innerIds.join(', ')}`);
  const expanded = g.panelOpen ? 'true' : 'false';
  if (A['aria-expanded'] !== expanded) e.push(`aria-expanded = ${JSON.stringify(A['aria-expanded'])}, expected "${expanded}" (panel ${g.panelOpen ? 'open' : 'closed'})`);
  if (g.settings && it.structure !== g.settings.structure) e.push(`item is not a deep clone of the Settings li (${it.structure} vs ${g.settings.structure})`);

  // Same box as Settings, directly above it, not overlapping anything else in the nav.
  const s = g.settings?.rect, a = it.a.rect;
  if (!s) return [...e, 'Settings link missing'];
  if (Math.abs(a.left - s.left) > TOL || Math.abs(a.width - s.width) > TOL || Math.abs(a.height - s.height) > TOL) {
    e.push(`item link ${fmt(a)} (w${a.width} h${a.height}) does not match Settings ${fmt(s)} (w${s.width} h${s.height})`);
  }
  if (a.bottom > s.top + TOL) e.push(`item bottom ${a.bottom.toFixed(1)} > Settings top ${s.top.toFixed(1)}`);
  const hits = g.navItems.filter((n) => overlap(n.clipped, a) > 0).map((n) => `${n.tag} "${n.label}" ${fmt(n.clipped)}`);
  if (hits.length) e.push(`item overlaps nav items: ${hits.join('; ')}`);
  if (!geometryOnly) {
    if (!it.a.visible) e.push(`item link not visible ${fmt(a)}`);
    if (!it.a.hit) e.push('item link centre is not hit-testable');
  }
  return e;
}

/** The item's label is shown exactly when Settings' label is (it follows the collapsed-nav styling). */
export function checkItemFollowsSettingsText(g) {
  if (!g.item?.a) return ['no item'];
  const settings = g.settings?.textVisible;
  return g.item.a.textVisible === settings ? [] : [`item text visible=${g.item.a.textVisible}, Settings text visible=${settings}`];
}

/** original mode: the snapshot must equal the never-touched page's. */
export function checkOriginal(snap, base) {
  const e = [];
  const dk = snap.html.filter((a) => a.startsWith('data-dropkick'));
  if (dk.length) e.push(`<html> has ${dk.join(', ')}`);
  const diffList = (a, b, what) => {
    const extra = a.filter((x) => !b.includes(x)), missing = b.filter((x) => !a.includes(x));
    if (extra.length || missing.length) e.push(`${what} differ from baseline: +[${extra.join(', ')}] -[${missing.join(', ')}]`);
  };
  diffList(snap.html, base.html, '<html> attributes');
  diffList(snap.body, base.body, '<body> attributes');
  diffList(snap.bodyChildren, base.bodyChildren, '<body> children');
  if (snap.els.length !== base.els.length) {
    e.push(`element count under #app ${snap.els.length} != baseline ${base.els.length}`);
    return e;
  }
  let reported = 0;
  for (let i = 0; i < snap.els.length && reported < 8; i++) {
    const a = snap.els[i], b = base.els[i];
    const id = `${b.tag}#${i}(${b.attrs.filter((x) => /^(data-|aria-label|id|name)/.test(x)).join(' ').slice(0, 80)})`;
    if (a.tag !== b.tag) { e.push(`element ${i}: <${a.tag}> vs baseline <${b.tag}>`); reported++; continue; }
    if (a.attrs.join('|') !== b.attrs.join('|')) {
      const extra = a.attrs.filter((x) => !b.attrs.includes(x)), missing = b.attrs.filter((x) => !a.attrs.includes(x));
      e.push(`${id} attributes: +[${extra.join(', ')}] -[${missing.join(', ')}]`); reported++;
    }
    if (!rectEq(a.rect, b.rect)) { e.push(`${id} rect ${fmt(a.rect)} != baseline ${fmt(b.rect)}`); reported++; }
  }
  return e;
}
