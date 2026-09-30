const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const routes = require(path.join(FIXTURES, 'routes.json')).routes;

const worldsTextOf = pg => pg.evaluate(() => { const lis = [...document.querySelectorAll('.world-chip')]; return lis.length ? "Today's worlds: " + lis.map(l => l.querySelector('span').textContent).join(', ') : document.getElementById('worlds').textContent; });
const unhidePanels = pg => pg.evaluate(() => document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = false; }));
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const one = name => page.route('**/data/routes.json', r => r.fulfill({ json: { routes: [routes.find(x => x.name === name)] } }));
  for (const [name, expect] of [['Tempus Fugit', 'https://zwiftinsider.com/route/tempus-fugit/'], ['Road to Sky Run', 'https://zwiftinsider.com/route/road-to-sky/']]) {
    await one(name); await page.goto(BASE + '/?now=2026-09-30T15:00Z');
    if (name.endsWith('Run')) await page.click('input[value="running"] + label');
    await page.click('#pick');
    const a = page.locator('#result a');
    check(await a.getAttribute('href') === expect && await a.getAttribute('target') === '_blank' && await a.getAttribute('rel') === 'noopener', `${name} links to ${await a.getAttribute('href')}`);
    await page.unroute('**/data/routes.json');
  }
  const rgv = routes.find(x => x.name === 'R.G.V.');
  await page.route('**/data/routes.json', r => r.fulfill({ json: { routes: [{ ...rgv, link: null, map: 'WATOPIA', eventOnly: false, cycling: true }] } }));
  await page.goto(BASE + '/?now=2026-09-30T15:00Z'); await page.click('input[value="cycling"] + label'); await page.click('#pick');
  check(await page.locator('#result a').count() === 0, 'route without a page shows no link');
  check(errors.length === 0, 'no page errors');
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
