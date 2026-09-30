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
const terrain = r => { const k = r.ascentMeters / Math.max(r.distanceMeters / 1000, 0.1); return k < 5 ? 'Flat' : k < 10 ? 'Rolling' : 'Hilly'; };
const active = ['WATOPIA', 'SCOTLAND', 'MAKURIISLANDS'];
const pool = f => routes.filter(r => active.includes(r.map) && r.cycling && !r.eventOnly && (!r.publishedOn || r.publishedOn <= '2026-09-30') && f(r));
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ reducedMotion: 'reduce' }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(B); await page.waitForSelector('.world-chip');
  const count = async () => parseInt(await page.textContent('#count')) || 0;
  const pill = v => page.locator(`.pill-toggle[data-value="${v}"]`);
  check(await count() === pool(() => true).length, 'no pills pressed = everything');

  await pill('Flat').click();
  check(await count() === pool(r => terrain(r) === 'Flat').length && await pill('Flat').getAttribute('aria-pressed') === 'true', `Flat only: ${await count()}`);
  await pill('Rolling').click();
  check(await count() === pool(r => ['Flat', 'Rolling'].includes(terrain(r))).length, `Flat or Rolling: ${await count()}`);
  await pill('loop').click();
  const expect = pool(r => ['Flat', 'Rolling'].includes(terrain(r)) && r.loop);
  check(await count() === expect.length, `Flat or Rolling loops: ${await count()}`);
  let ok = true; for (let i = 0; i < 20; i++) { await page.click('#pick'); const r = byName[await page.textContent('#result h2')]; if (!['Flat', 'Rolling'].includes(terrain(r)) || !r.loop) ok = false; }
  check(ok, '20 picks all Flat/Rolling loops');
  const scot = await page.textContent('.world-chip[data-world="SCOTLAND"] .chip-count');
  check(parseInt(scot) === expect.filter(r => r.map === 'SCOTLAND').length, 'world chip counts follow pills: Scotland ' + scot);

  await page.setViewportSize({ width: 390, height: 800 });
  check(await page.textContent('#settings-summary') === 'Ride · Any route · Flat or Rolling, Loop', 'summary: ' + await page.textContent('#settings-summary'));
  await page.setViewportSize({ width: 1280, height: 800 });

  // A pill that excludes the shown route hides it; unpressing restores all.
  await pill('loop').click(); await pill('p2p').click();
  check(await count() === pool(r => ['Flat', 'Rolling'].includes(terrain(r)) && !r.loop).length && await page.isHidden('#result'), 'switch to point to point hides the loop pick');

  await page.reload(); await page.waitForSelector('.world-chip');
  check(await pill('Flat').getAttribute('aria-pressed') === 'true' && await pill('p2p').getAttribute('aria-pressed') === 'true' && await pill('Hilly').getAttribute('aria-pressed') === 'false', 'pills remembered after reload');
  await page.click('#clear');
  check(await count() === pool(() => true).length && await page.$$eval('.pill-toggle[aria-pressed="true"]', p => p.length) === 0, 'Clear filters resets pills');

  await pill('Hilly').click(); await pill('p2p').click(); await page.fill('#max-distance', '1');
  check(await page.isDisabled('#pick') && (await page.textContent('#count')).includes('No routes match'), 'impossible combo disables Spin');
  await page.click('#clear');

  // Spin length grows with the pool (real animation).
  const anim = await b.newPage(); anim.on('pageerror', e => errors.push(e.message));
  await anim.goto(B); await anim.waitForSelector('.world-chip');
  const spin = async () => { const t = Date.now(); await anim.click('#pick'); await anim.waitForTimeout(100); const n = await anim.evaluate(() => document.querySelectorAll('#reel-strip li').length); await anim.waitForFunction(() => !document.getElementById('pick').disabled, null, { timeout: 6000 }); return [Date.now() - t, n]; };
  const [bigMs, bigNames] = await spin();
  await anim.click('.world-chip[data-world="SCOTLAND"]');
  const [smallMs, smallNames] = await spin();
  check(bigMs > smallMs + 600 && bigNames > smallNames + 30, `148 routes: ${bigMs} ms, ${bigNames} names; 11 routes: ${smallMs} ms, ${smallNames} names`);
  check(bigMs < 3600, 'longest spin stays around 3 s at most');

  await page.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
