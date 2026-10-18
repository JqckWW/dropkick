// Browser, request routing, extension storage and polling helpers for the DropKick tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixture');
const INPAGE = fs.readFileSync(path.join(here, 'inpage.js'), 'utf8');

export const ADMIN = 'https://admin.shopify.com/store/test';
export const OTHER = 'https://example.test/';
/** The admin fixture on a host the content script does not match: the never-touched baseline. */
export const BASELINE = 'https://example.test/store/test';
const CONTROL = 'https://admin.shopify.com/__control';

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function fixtureFile(name) {
  const p = path.join(FIXTURE_DIR, name);
  if (!p.startsWith(FIXTURE_DIR) || !fs.existsSync(p)) return null;
  return { status: 200, contentType: MIME[path.extname(p)] || 'application/octet-stream', body: fs.readFileSync(p) };
}

/** Maps a request to a fixture response, or null if the fixtures never make that request. */
function route(urlStr, resourceType) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.host;
  if (host !== 'admin.shopify.com' && host !== 'example.test') return null;
  if (u.pathname === '/favicon.ico') return { status: 204, contentType: 'image/x-icon', body: '' };
  if (u.pathname.startsWith('/__fixture/')) return fixtureFile(u.pathname.slice('/__fixture/'.length));
  if (resourceType !== 'document') return null; // the fixture makes no XHR/fetch/image requests
  if (urlStr === CONTROL) return { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>DropKick test control</title>' };
  if (u.pathname === '/store/test' || u.pathname.startsWith('/store/test/')) return fixtureFile('admin.html');
  if (host === 'example.test' && u.pathname === '/') return fixtureFile('other.html');
  return null;
}

export class Harness {
  constructor({ extensionDir, headful = false }) {
    this.extensionDir = extensionDir;
    this.headful = headful;
    this.extensionId = null;
    /** Every request no fixture serves (it is aborted). The runner fails the case if this grows. */
    this.unexpected = [];
    this.pageSetups = new WeakMap();
    this.contexts = new WeakMap(); // page -> [{ id, origin, name, frameId }]
    this.exceptions = new WeakMap(); // page -> [{ contextId, text, url }]
  }

  async launch({ withExtension }) {
    this.browser = await puppeteer.launch({
      headless: !this.headful,
      pipe: true,
      enableExtensions: true,
      defaultViewport: DEFAULT_VIEWPORT,
      args: [`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height + 100}`, '--no-first-run', '--no-default-browser-check'],
    });
    this.browser.on('targetcreated', (t) => this.#onTarget(t).catch(() => {}));
    if (withExtension) this.extensionId = await this.browser.installExtension(this.extensionDir);
    // CDP's Extensions.*StorageItems only works from a target the extension runs in, so storage is
    // driven from a blank admin.shopify.com page that no test uses.
    this.control = await this.browser.newPage();
    await this.setupPage(this.control);
    if (withExtension) await this.control.goto(CONTROL, { waitUntil: 'load' });
    this.controlSession = await this.control.createCDPSession();
    return this;
  }

  async close() { await this.browser?.close().catch(() => {}); }

  async #onTarget(target) {
    const type = target.type();
    if (type === 'page') {
      const page = await target.page();
      if (page) await this.setupPage(page);
      return;
    }
    // Workers (including the extension's service worker) can't be intercepted; record their requests.
    if (['service_worker', 'shared_worker', 'background_page', 'other'].includes(type)) {
      try {
        const s = await target.createCDPSession();
        s.on('Network.requestWillBeSent', (e) => {
          const u = e.request.url;
          if (/^(chrome-extension|data|blob|chrome):/.test(u)) return;
          this.unexpected.push({ url: u, from: `${type} ${target.url()}` });
        });
        await s.send('Network.enable');
      } catch { /* target doesn't support the Network domain */ }
    }
  }

  /** Request interception, inpage.js, and content-script context/exception tracking. Idempotent per page. */
  setupPage(page) {
    if (this.pageSetups.has(page)) return this.pageSetups.get(page);
    const p = (async () => {
      const contexts = [];
      const exceptions = [];
      this.contexts.set(page, contexts);
      this.exceptions.set(page, exceptions);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.isInterceptResolutionHandled()) return;
        const url = req.url();
        if (/^(chrome-extension|data|blob|about|chrome):/.test(url)) return req.continue();
        const res = route(url, req.resourceType());
        if (res) return req.respond(res);
        this.unexpected.push({ url, from: `page ${page.url()} (${req.resourceType()})` });
        return req.abort('blockedbyclient');
      });
      await page.evaluateOnNewDocument(INPAGE);
      // Content scripts run in isolated worlds whose origin is the extension's; see extensionContexts().
      const s = await page.createCDPSession();
      s.on('Runtime.executionContextCreated', ({ context }) => {
        contexts.push({ id: context.id, origin: context.origin, name: context.name, frameId: context.auxData?.frameId });
      });
      s.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        exceptions.push({ contextId: d.executionContextId, text: d.exception?.description || d.text, url: d.url });
      });
      await s.send('Runtime.enable');
    })();
    this.pageSetups.set(page, p);
    return p;
  }

  async openPage(url, { viewport } = {}) {
    const page = await this.browser.newPage();
    await this.setupPage(page);
    if (viewport) await page.setViewport(viewport);
    if (url) await this.goto(page, url);
    return page;
  }

  async goto(page, url) {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    if (/\/store\/test/.test(url)) {
      await page.waitForFunction(() => window.__fixture && window.__fixture.ready, { timeout: 5000 });
    }
  }

  // ---------- extension introspection ----------

  /** Content-script worlds created in `page` (optionally only in one frame). */
  extensionContexts(page, frameId) {
    const all = this.contexts.get(page) || [];
    return all.filter((c) => (c.origin || '').startsWith(`chrome-extension://${this.extensionId}`) && (!frameId || c.frameId === frameId));
  }

  /** Uncaught exceptions thrown by extension code in `page`. */
  extensionExceptions(page) {
    const ids = new Set(this.extensionContexts(page).map((c) => c.id));
    return (this.exceptions.get(page) || []).filter((e) => ids.has(e.contextId) || (e.url || '').startsWith('chrome-extension://'));
  }

  // ---------- chrome.storage.sync ----------

  async getStored() {
    const { data } = await this.controlSession.send('Extensions.getStorageItems', { id: this.extensionId, storageArea: 'sync' });
    return data;
  }

  /** Store `mode`, or clear storage entirely when `mode` is null (the extension then uses its default). */
  async setMode(mode) {
    const params = { id: this.extensionId, storageArea: 'sync' };
    if (mode == null) await this.controlSession.send('Extensions.clearStorageItems', params);
    else await this.controlSession.send('Extensions.setStorageItems', { ...params, values: { mode } });
  }
}

// ---------- waiting ----------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `check()` (async; returns a list of failure messages, empty = pass) until it passes on
 * `stable` consecutive polls. Resolves to { elapsed }, the time of the first passing poll; rejects
 * with the last failures after `timeout` ms.
 */
export async function until(check, { timeout = 2000, interval = 50, stable = 2, label = 'condition' } = {}) {
  const t0 = Date.now();
  let okCount = 0;
  let firstOk = null;
  let last = ['(never evaluated)'];
  for (;;) {
    let errs;
    try { errs = await check(); } catch (e) { errs = [`check threw: ${e.message}`]; }
    if (!errs.length) {
      if (firstOk == null) firstOk = Date.now() - t0;
      if (++okCount >= stable) return { elapsed: firstOk };
    } else {
      okCount = 0; firstOk = null; last = errs;
    }
    if (Date.now() - t0 > timeout) {
      throw new Error(`${label}: not satisfied within ${timeout}ms:\n      - ${last.join('\n      - ')}`);
    }
    await sleep(interval);
  }
}
