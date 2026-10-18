// Generates extension/icons/icon-{16,32,48,128}.png: an AI sparkle crossed out with a "no" symbol,
// black and white only. Rasterised with Puppeteer (already a dev dependency for the tests).
// Run with `npm run icons`.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const outDir = fileURLToPath(new URL('../extension/icons/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// A plain four-point sparkle, the generic "AI" symbol (16×16 viewBox). Original artwork.
const GLYPH = 'M8 0Q9.9 6.1 16 8Q9.9 9.9 8 16Q6.1 9.9 0 8Q6.1 6.1 8 0Z';

/**
 * 128-unit canvas: white disc (so it reads on dark toolbars), the glyph, a slash with a white halo
 * so it separates from the sparkle, and the black ring on top. `ring` is the stroke width, which is
 * heavier for the small sizes so the symbol survives downscaling.
 */
function svg({ ring, glyphSize }) {
  const r = 64 - ring / 2 - 2;
  const offset = 64 - glyphSize / 2;
  const scale = glyphSize / 16;
  const d = (45 * Math.PI) / 180;
  const x1 = 64 - Math.cos(d) * r, y1 = 64 - Math.sin(d) * r;
  const x2 = 64 + Math.cos(d) * r, y2 = 64 + Math.sin(d) * r;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><clipPath id="inside"><circle cx="64" cy="64" r="${r}"/></clipPath></defs>
  <circle cx="64" cy="64" r="63" fill="#fff"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="#000">
    <path d="${GLYPH}"/>
  </g>
  <g clip-path="url(#inside)" stroke-linecap="butt">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="${ring * 1.6}"/>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${ring}"/>
  </g>
  <circle cx="64" cy="64" r="${r}" fill="none" stroke="#000" stroke-width="${ring}"/>
</svg>`;
}

const VARIANTS = {
  16: svg({ ring: 16, glyphSize: 84 }),
  32: svg({ ring: 13, glyphSize: 84 }),
  48: svg({ ring: 11, glyphSize: 84 }),
  128: svg({ ring: 10, glyphSize: 84 }),
};

const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  for (const [size, markup] of Object.entries(VARIANTS)) {
    await page.setViewport({ width: Number(size), height: Number(size), deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    await page.screenshot({ path: `${outDir}icon-${size}.png`, omitBackground: true });
  }
} finally {
  await browser.close();
}
