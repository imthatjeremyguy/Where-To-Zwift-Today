const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const B = BASE + '/?now=2026-09-30T15:00Z';
const routes = require(path.join(FIXTURES, 'routes.json')).routes;
const byName = Object.fromEntries(routes.map(r => [r.name, r]));
const totD = r => r.distanceMeters + r.leadinDistanceMeters, totC = r => r.ascentMeters + r.leadinAscentMeters;

const worldsTextOf = pg => pg.evaluate(() => { const lis = [...document.querySelectorAll('.world-chip')]; return lis.length ? "Today's worlds: " + lis.map(l => l.querySelector('span').textContent).join(', ') : document.getElementById('worlds').textContent; });
const unhidePanels = pg => pg.evaluate(() => document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = false; }));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const load = async () => { await page.goto(B); await page.waitForFunction(() => !document.getElementById('count').textContent === false); };
  const count = async () => parseInt(await page.textContent('#count')) || 0;
  const picks = async n => { const o = []; for (let i = 0; i < n; i++) { await page.click('#pick'); o.push(byName[await page.textContent('#result h2')]); } return o; };
  const active = new Set(['WATOPIA','SCOTLAND','MAKURIISLANDS']);
  const expected = f => routes.filter(r => active.has(r.map) && r.cycling && !r.eventOnly && (!r.publishedOn || r.publishedOn <= '2026-09-30') && f(r)).length;

  await load();
  check(await count() === expected(() => true), 'no filters: ' + await count());

  await page.fill('#min-distance', '20'); await page.fill('#max-distance', '40');
  check(await count() === expected(r => totD(r) >= 20000 && totD(r) <= 40000), '20-40 km count ' + await count());
  let p = await picks(40);
  check(p.every(r => totD(r) >= 20000 && totD(r) <= 40000), '40 picks all 20-40 km total');
  check((await page.textContent('#result')).includes('Total'), 'result shows Total row');

  await page.fill('#max-climbing', '200');
  check(await count() === expected(r => totD(r) >= 20000 && totD(r) <= 40000 && totC(r) <= 200), 'plus max 200 m climbing ' + await count());
  p = await picks(30);
  check(p.every(r => totC(r) <= 200), 'picks all <= 200 m climbing');

  // Filter change that excludes the shown route hides it.
  await page.fill('#max-climbing', '0.001'); await page.fill('#min-distance', ''); await page.fill('#max-distance', '');
  const shownHidden = await page.isHidden('#result');
  check(shownHidden, 'shown route hidden when it no longer matches');
  await page.fill('#max-climbing', '');

  await page.fill('#min-climbing', '500'); await page.fill('#max-climbing', '100');
  check((await page.textContent('#count')).includes('higher than its maximum') && await page.isDisabled('#pick'), 'min > max warns and disables pick');
  await page.click('#clear');
  check(await page.evaluate(() => [...document.querySelectorAll('#filters input')].every(i => i.value === '')), 'clear empties all boxes');
  check(await count() === expected(() => true), 'clear restores full count');

  await page.fill('#min-distance', '9999');
  check((await page.textContent('#count')).includes('No routes match') && await page.isDisabled('#pick'), 'impossible filter shows no-match message');
  await page.click('#clear');

  // Units: 10 km and 300 m become 6.2 mi and 984 ft; same count before and after.
  await page.fill('#min-distance', '10'); await page.fill('#max-climbing', '300');
  const before = await count();
  await page.click('input[value="imperial"] + label');
  check(await page.inputValue('#min-distance') === '6.2' && await page.inputValue('#max-climbing') === '984', 'switch to mi converts values: ' + await page.inputValue('#min-distance') + ' / ' + await page.inputValue('#max-climbing'));
  check((await page.textContent('#filters')).includes('Distance (mi)') && (await page.textContent('#filters')).includes('Climbing (ft)'), 'labels show mi and ft');
  check(Math.abs(await count() - before) <= 1, `count stable across units (${before} vs ${await count()})`);
  await page.click('#pick');
  check((await page.textContent('#result .stat .stat-value')).endsWith(' mi'), 'result shows miles first');

  await page.fill('#min-distance', '10');
  check(await count() === expected(r => totD(r) >= 16093.44 && totC(r) <= 300 / 1), 'typing 10 mi filters at 16.1 km');

  await load();
  check(await page.isChecked('input[value="imperial"]') && await page.inputValue('#min-distance') === '10', 'units and filters remembered after reload');
  await page.click('input[value="metric"] + label');
  check(await page.inputValue('#min-distance') === '16.1', 'back to km: ' + await page.inputValue('#min-distance'));
  await page.click('#clear');

  // Sport switch still works and hides result.
  await page.click('#pick'); await page.click('input[value="running"] + label');
  check(await page.isHidden('#result'), 'sport switch hides result');

  await page.setViewportSize({ width: 360, height: 900 });
  await page.click('input[value="cycling"] + label'); await page.fill('#max-distance', '30'); await page.click('#pick');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no horizontal scroll at 360px');
  await page.screenshot({ path: SHOTS + '/mobile2.png', fullPage: true });
  await page.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
