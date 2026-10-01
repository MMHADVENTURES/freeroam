// FreeRoam smoke test — loads the unpacked extension in Playwright's Chromium,
// opens a real Street View pano and checks every control still does what it
// should. Google changes the Maps page from time to time; this is how you find
// out what broke.
//
//   npm i -D playwright && npx playwright install chromium   (once)
//   node scripts/smoke-test.mjs
//
// Needs a display (runs a visible browser window) and an internet connection.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=36.16222,-86.77444&heading=270';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'freeroam-smoke-'));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1400, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// URL state: @LAT,LNG,<n>a,<fov>y[,<heading>h][,<pitch>t] …!1s<panoId>
const state = () => {
    const url = page.url();
    const m = url.match(/@(-?[\d.]+),(-?[\d.]+),[\d.]+a,([\d.]+)y(?:,([\d.]+)h)?(?:,([\d.]+)t)?/);
    return m ? { fov: +m[3], heading: +(m[4] || 0), pitch: +(m[5] || 90), pano: (url.match(/!1s([A-Za-z0-9_-]+)/) || [])[1] } : null;
};
const wait = (ms) => page.waitForTimeout(ms);
const hold = async (key, ms) => { await page.keyboard.down(key); await wait(ms); await page.keyboard.up(key); await wait(1500); };

try {
    await page.goto(START, { waitUntil: 'domcontentloaded' });
    await wait(9000);

    const s0 = state();
    check('Street View loads', !!s0?.pano, s0 ? `pano ${s0.pano.slice(0, 8)}…` : page.url().slice(0, 80));
    check('Panel injected', await page.$('#sv-nav-sidebar') !== null);
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "FreeRoam Chakra"') && document.fonts.check('16px "FreeRoam Mono"'); });
    check('Bundled fonts load', fonts);
    const dock = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return Math.round(c.getBoundingClientRect().left); });
    check('Panel docked (map starts beside it)', dock === 280, `map left edge ${dock}px`);

    await page.keyboard.press('w'); await wait(2300);
    const s1 = state();
    check('W steps forward', s1?.pano && s1.pano !== s0.pano);
    await page.keyboard.press('s'); await wait(2300);
    check('S steps back', state()?.pano === s0.pano);
    await hold('d', 600);
    const s2 = state();
    check('D turns right', s2 && ((s2.heading - s0.heading + 360) % 360) > 10, `heading ${s0.heading} → ${s2?.heading}`);
    await hold('q', 600);
    const s3 = state();
    check('Q looks up', s3 && s3.pitch > s2.pitch + 3, `pitch ${s2?.pitch} → ${s3?.pitch}`);
    await hold('z', 600);
    const s4 = state();
    check('Z zooms in without tilting', s4 && s4.fov < s3.fov - 10 && Math.abs(s4.pitch - s3.pitch) < 2, `fov ${s3?.fov} → ${s4?.fov}, pitch ${s3?.pitch} → ${s4?.pitch}`);
    await hold('x', 400);
    check('X zooms out', state()?.fov > s4.fov);

    await page.mouse.move(900, 450); await page.mouse.down(); await page.mouse.up(); await wait(700);
    const locked = await page.evaluate(() => !!document.pointerLockElement);
    const hid = await page.evaluate(() => document.getElementById('sv-nav-sidebar').classList.contains('auto-hidden'));
    check('Click locks mouse-look', locked);
    check('Panel slides away in mouse-look', hid);
    const before = state();
    for (let i = 0; i < 20; i++) { await page.mouse.move(900 + i * 10, 450); await wait(16); }
    await wait(1200);
    check('Mouse turns the view', ((state()?.heading - before.heading + 360) % 360) > 5);
    const after = state();
    // Regression: the pointer used to be locked onto Google's canvas, which made
    // Street View fight the synthetic drag (flicker, or the view flipping upside
    // down). A purely sideways mouse move must leave the view level.
    check('Mouse-look stays level (no flip)', after && Math.abs(after.pitch - before.pitch) < 12, `pitch ${before.pitch} → ${after?.pitch}`);
    await page.keyboard.press('Escape'); await page.evaluate(() => document.exitPointerLock()); await wait(1000);
    check('Esc keeps you in Street View', !!state()?.pano);

    await page.keyboard.press('h'); await wait(500);
    check('H hides the panel', await page.evaluate(() => document.getElementById('sv-nav-sidebar').classList.contains('collapsed')));
    await page.keyboard.press('h'); await wait(500);

    check('No page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
    check('Test run completed', false, e.message);
} finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
