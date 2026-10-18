/*
 * DropKick service worker. Its only job: when the extension is installed, updated or reloaded, put
 * the new content script into Shopify Admin tabs that are already open. Chrome injects manifest
 * content scripts only on page load, and the copies left in open tabs are disconnected from the
 * extension (they stop receiving setting changes), so without this those tabs need a refresh.
 * The new copy tells the old one to remove itself (see "takeover" in content.js).
 */
'use strict';

const ADMIN = 'https://admin.shopify.com/*';

chrome.runtime.onInstalled.addListener(async () => {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ADMIN });
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null || tab.discarded) continue;
    const target = { tabId: tab.id };
    try {
      await chrome.scripting.insertCSS({ target, files: ['content.css'] });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    } catch {
      // Tab closed, still loading, or showing an error page: it will get the script on its next load.
    }
  }
});
