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
const rideIn = w => routes.filter(r => r.map === w && r.cycling && !r.eventOnly && (!r.publishedOn || r.publishedOn <= '2026-09-30'));
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(B); await page.waitForSelector('.world-chip');
  const chip = w => page.locator(`.world-chip[data-world="${w}"]`);
  const chipCount = async w => parseInt(await chip(w).locator('.chip-count').textContent());
  const total = parseInt(await page.textContent('#count'));
  check(await chipCount('SCOTLAND') === rideIn('SCOTLAND').length && await chipCount('WATOPIA') === rideIn('WATOPIA').length, `chip counts right (Scotland ${await chipCount('SCOTLAND')}, Watopia ${await chipCount('WATOPIA')})`);
  check(await chipCount('SCOTLAND') + await chipCount('WATOPIA') + await chipCount('MAKURIISLANDS') === total, 'chip counts add up to total');
  check(await page.isHidden('#all-worlds'), 'All worlds link hidden with no selection');
  let ok;

  await chip('SCOTLAND').click();
  check(await chip('SCOTLAND').getAttribute('aria-pressed') === 'true' && await chip('WATOPIA').getAttribute('aria-pressed') === 'false', 'Scotland pressed');
  check((await page.textContent('#count')).includes(`${rideIn('SCOTLAND').length} routes to choose from in Scotland`), 'count says ' + await page.textContent('#count'));
  check(await page.isVisible('#all-worlds') && await chip('WATOPIA').evaluate(e => e.classList.contains('dimmed')), 'others dimmed, All worlds shown');
  ok = true; for (let i = 0; i < 15; i++) { await page.click('#pick'); if (byName[await page.textContent('#result h2')].map !== 'SCOTLAND') ok = false; }
  check(ok, '15 picks all from Scotland');

  // Multi-select: add Makuri, Watopia stays out.
  const shownScot = await page.textContent('#result h2');
  await chip('MAKURIISLANDS').click();
  const both = rideIn('SCOTLAND').length + rideIn('MAKURIISLANDS').length;
  check(await chip('MAKURIISLANDS').getAttribute('aria-pressed') === 'true' && await chip('SCOTLAND').getAttribute('aria-pressed') === 'true' && await chip('WATOPIA').getAttribute('aria-pressed') === 'false', 'Scotland and Makuri both selected');
  check((await page.textContent('#count')) === `${both} routes to choose from in Scotland and Makuri Islands.`, 'count: ' + await page.textContent('#count'));
  check(await page.isVisible('#result') && (await page.textContent('#result h2')) === shownScot, 'adding a world keeps the Scotland pick on screen');
  ok = true; const seen = new Set();
  for (let i = 0; i < 40; i++) { await page.click('#pick'); const m = byName[await page.textContent('#result h2')].map; seen.add(m); if (m === 'WATOPIA') ok = false; }
  check(ok && seen.has('SCOTLAND') && seen.has('MAKURIISLANDS'), '40 picks: both worlds appear, never Watopia (' + [...seen].join(', ') + ')');

  // Removing a world hides a pick from it.
  while (byName[await page.textContent('#result h2')].map !== 'SCOTLAND') await page.click('#pick');
  await chip('SCOTLAND').click();
  check(await page.isHidden('#result') && (await page.textContent('#count')).endsWith('in Makuri Islands.'), 'deselecting Scotland hides its pick');

  // Last one off returns to all worlds.
  await chip('MAKURIISLANDS').click();
  check(parseInt(await page.textContent('#count')) === total && await page.isHidden('#all-worlds') && !(await chip('WATOPIA').evaluate(e => e.classList.contains('dimmed'))), 'removing the last world returns to all');

  // Selecting all three is the same as all.
  for (const w of ['WATOPIA', 'SCOTLAND', 'MAKURIISLANDS']) await chip(w).click();
  check(await chip('WATOPIA').getAttribute('aria-pressed') === 'false' && await page.isHidden('#all-worlds') && parseInt(await page.textContent('#count')) === total, 'all three selected resets to neutral');

  await chip('WATOPIA').click(); await chip('SCOTLAND').click(); await page.click('#all-worlds');
  check(parseInt(await page.textContent('#count')) === total && await chip('SCOTLAND').getAttribute('aria-pressed') === 'false', 'All worlds link resets');

  // Counts follow filters and sport.
  await page.fill('#max-distance', '10');
  check(await chipCount('SCOTLAND') === rideIn('SCOTLAND').filter(r => r.distanceMeters + r.leadinDistanceMeters <= 10000).length, 'chip counts follow filters: Scotland ' + await chipCount('SCOTLAND'));
  await page.fill('#max-distance', '');
  await page.click('label[for="sport-running"]');
  const runScot = routes.filter(r => r.map === 'SCOTLAND' && r.running && !r.eventOnly).length;
  check(await chipCount('SCOTLAND') === runScot, 'chip counts follow sport: ' + await chipCount('SCOTLAND'));

  // Focus plus a filter that empties the world.
  await page.click('label[for="sport-cycling"]');
  await chip('SCOTLAND').click(); await page.fill('#min-distance', '500');
  check(await page.isDisabled('#pick') && await chipCount('SCOTLAND') === 0, 'empty focused world disables pick');
  check(await chip('SCOTLAND').getAttribute('aria-label') === 'Scotland, 0 routes', 'chip has accessible label');
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
