const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const B = BASE + '/';
const routes = require(path.join(FIXTURES, 'routes.json')).routes;
const byName = Object.fromEntries(routes.map(r => [r.name, r]));

const worldsTextOf = pg => pg.evaluate(() => { const lis = [...document.querySelectorAll('.world-chip')]; return lis.length ? "Today's worlds: " + lis.map(l => l.querySelector('span').textContent).join(', ') : document.getElementById('worlds').textContent; });
const unhidePanels = pg => pg.evaluate(() => document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = false; }));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  async function load(q) { await page.goto(B + q); await page.waitForFunction(() => !document.getElementById('worlds').textContent.startsWith('Loading')); return worldsTextOf(page); }
  async function picks(n) { const out = []; for (let i = 0; i < n; i++) { await page.click('#pick'); out.push(await page.textContent('#result h2')); } return out; }

  let w = await load('?now=2026-09-30T15:00Z');
  check(w === "Today's worlds: Watopia, Scotland, Makuri Islands", 'Sep 30: ' + w);
  const p = await picks(60);
  const allowed = new Set(['WATOPIA', 'SCOTLAND', 'MAKURIISLANDS']);
  check(p.every(n => allowed.has(byName[n].map) && byName[n].cycling && !byName[n].eventOnly), '60 picks all cycling, not event-only, in active worlds');
  check(p.every((n, i) => i === 0 || n !== p[i - 1]), 'no route repeats back to back');
  check((await page.textContent('#pick')) === 'Spin again', 'button says Spin again');
  const rideCount = await page.textContent('#count');

  await page.click('input[value="running"] + label');
  check(await page.isHidden('#result'), 'switching sport clears result');
  const runCount = await page.textContent('#count');
  const rp = await picks(20);
  check(rp.every(n => byName[n].running), `run picks all running (${rideCount} vs ${runCount})`);
  await load('?now=2026-09-30T15:00Z');
  check(await page.isChecked('input[value="running"]'), 'sport choice remembered after reload');
  await page.click('input[value="cycling"] + label');

  check((await load('?now=2026-10-05T03:59Z')).includes('Makuri Islands, New York'), 'Oct 5 03:59 UTC still Makuri + New York');
  check((await load('?now=2026-10-05T04:02Z')).includes('France, Paris'), 'Oct 5 04:02 UTC switched to France + Paris');

  w = await load('?now=2026-11-10T12:00Z');
  check(w.includes("hasn't published") && w.includes('Watopia only'), 'Nov 10 (no schedule): ' + w);
  check((await picks(10)).every(n => byName[n].map === 'WATOPIA'), 'no-schedule picks only Watopia');

  // Fake an unreleased Watopia route and a just-released one.
  await page.route('**/data/routes.json', async route => {
    const data = { routes: [
      { ...byName['Tempus Fugit'], id: 'future', name: 'Future Route', publishedOn: '2026-10-20' },
      { ...byName['Tempus Fugit'], id: 'fresh', name: 'Fresh Route', publishedOn: '2026-09-25' },
    ] };
    await route.fulfill({ json: data });
  });
  await load('?now=2026-09-30T15:00Z');
  check((await page.textContent('#count')).startsWith('1 route'), 'future-dated route held back');
  await page.click('#pick');
  check((await page.textContent('#result')).includes('New'), 'fresh route shows New tag');
  await load('?now=2026-10-20T15:00Z');
  check((await page.textContent('#count')).startsWith('2 routes'), 'future route appears on its release day');
  await page.unroute('**/data/routes.json');

  await page.route('**/data/schedule.json', r => r.fulfill({ status: 500 }));
  check((await load('')).includes("Couldn't load"), 'data load failure shows message');
  await page.unroute('**/data/schedule.json');

  await page.setViewportSize({ width: 360, height: 740 });
  await load('?now=2026-09-30T15:00Z'); await page.click('#pick');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no horizontal scroll at 360px');
  await page.screenshot({ path: SHOTS + '/mobile.png', fullPage: true });

  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
