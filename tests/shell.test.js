const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const B = BASE + '/?now=2026-09-30T15:00Z';
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ reducedMotion: 'reduce',  colorScheme: 'light' }); const page = await ctx.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(B); await page.waitForSelector('.world-chips');
  const settle = () => page.waitForFunction(() => { const h = location.hash.slice(1) || 'spin'; const t = document.getElementById('tab-' + h); return !t || t.getAttribute('aria-selected') === 'true'; }, null, { timeout: 3000 }).catch(() => {});
  const visible = async () => { await settle(); return { spin: await page.isVisible('#panel-spin'), completed: await page.isVisible('#panel-completed') }; };
  check((await visible()).spin && !(await visible()).completed, 'Spin tab shows by default');
  await page.click('#tab-completed');
  check((await visible()).completed && !(await visible()).spin && page.url().endsWith('#completed'), 'clicking Completed switches tab and URL');
  check(await page.getAttribute('#tab-completed', 'aria-selected') === 'true' && await page.getAttribute('#tab-spin', 'aria-selected') === 'false', 'aria-selected updates');
  await page.goBack();
  check((await visible()).spin, 'back button returns to Spin');
  await page.goto(B + '#completed'); await page.waitForSelector('#checklist details');
  check((await visible()).completed, 'bookmark to #completed opens that tab');
  await page.goto(B + '#nonsense'); await page.waitForSelector('.world-chips');
  check((await visible()).spin, 'unknown tab falls back to Spin');
  await page.click('.brand');
  check((await visible()).spin, 'logo returns to Spin');

  // Units live in the header and still drive the filters.
  await page.click('label[for="units-imperial"]');
  check((await page.textContent('#filters')).includes('Distance (mi)'), 'header units switch updates filters');
  await page.click('label[for="units-metric"]');

  // Theme toggle: follows device, then remembers explicit choice.
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await bg();
  await page.click('#theme-toggle');
  const darkBg = await bg();
  check(lightBg !== darkBg && await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', `toggle switches to dark (${lightBg} -> ${darkBg})`);
  check(await page.getAttribute('#theme-toggle', 'aria-label') === 'Switch to light mode', 'toggle label updates');
  await page.reload(); await page.waitForSelector('.world-chips');
  check(await bg() === darkBg, 'dark choice remembered after reload');
  await page.click('#theme-toggle');
  check(await bg() === lightBg, 'toggle back to light');
  await page.evaluate(() => localStorage.clear());

  const dctx = await b.newContext({ reducedMotion: 'reduce',  colorScheme: 'dark' }); const dp = await dctx.newPage({ reducedMotion: 'reduce' });
  await dp.goto(B); await dp.waitForSelector('.world-chips');
  check(await dp.evaluate(() => getComputedStyle(document.body).backgroundColor) === darkBg && await dp.getAttribute('#theme-toggle', 'aria-label') === 'Switch to light mode', 'dark device gets dark theme by default');

  // Data failure: tabs still work.
  await page.route('**/data/routes.json', r => r.fulfill({ status: 500 }));
  await page.goto(B); await page.waitForSelector('#worlds .notice');
  await page.click('#tab-completed');
  check((await visible()).completed, 'tabs work even when data fails');
  await page.unroute('**/data/routes.json');

  // Settings summary and Change link (phone width, where settings sit below).
  const phone = await (await b.newContext({ reducedMotion: 'reduce',  viewport: { width: 390, height: 700 } })).newPage(); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(B); await phone.waitForSelector('.world-chip');
  check(await phone.textContent('#settings-summary') === 'Ride · Any route · no limits', 'summary default: ' + await phone.textContent('#settings-summary'));
  await phone.fill('#min-distance', '20'); await phone.fill('#max-distance', '40'); await phone.fill('#max-climbing', '300');
  await phone.click('label[for="badges-undone"]');
  check(await phone.textContent('#settings-summary') === 'Ride · Not done yet · 20 to 40 km, up to 300 m climbing', 'summary: ' + await phone.textContent('#settings-summary'));
  await phone.click('label[for="units-imperial"]');
  check(await phone.textContent('#settings-summary') === 'Ride · Not done yet · 12.4 to 24.9 mi, up to 984 ft climbing', 'summary in miles: ' + await phone.textContent('#settings-summary'));
  await phone.evaluate(() => window.scrollTo(0, 0));
  await phone.click('.settings-jump'); await phone.waitForTimeout(800);
  const top = (await phone.locator('#settings').boundingBox()).y;
  check(top >= 0 && top < 250 && !(await phone.evaluate(() => location.hash)) && await phone.isVisible('#panel-spin'), `Change scrolls to settings (top ${Math.round(top)}) without changing tabs or URL`);
  check(await phone.isVisible('.settings-summary') && !(await page.isVisible('.settings-summary')), 'summary shows on phones only');
  check(await phone.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no sideways scroll on phone');
  await phone.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
