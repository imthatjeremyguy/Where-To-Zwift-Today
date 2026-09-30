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
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(B); await page.waitForSelector('.world-chip');
  const middle = () => page.evaluate(() => document.querySelectorAll('#reel-strip li')[1].textContent);
  check(await middle() === 'Ready to ride?' && await page.textContent('#pick') === 'Spin', 'idle reel and Spin button');

  // Real animation.
  const t0 = Date.now(); await page.click('#pick');
  await page.waitForTimeout(300);
  check(await page.isDisabled('#pick') && await page.isHidden('#result') && await page.evaluate(() => document.getElementById('reel').classList.contains('spinning')), 'spinning: button locked, card waits');
  check(await page.evaluate(() => document.querySelectorAll('#reel-strip li').length) >= 25, 'reel strip filled with names');
  await page.click('#pick', { force: true }); // extra click mid-spin must be ignored
  await page.waitForFunction(() => !document.getElementById('result').hidden, null, { timeout: 5000 });
  const took = Date.now() - t0;
  check(took > 1400 && took < 3500, `spin takes about 1.7s (${took} ms)`);
  const name = await page.textContent('#result h2');
  check(await middle() === name, 'reel lands on the carded route: ' + name);
  check(await page.evaluate(() => [...document.querySelectorAll('#reel-strip li')].filter(l => l.textContent).length) === 3, 'neighbors visible after landing');
  check(!(await page.isDisabled('#pick')) && await page.textContent('#pick') === 'Spin again', 'button unlocks as Spin again');

  // Tags and stats.
  const r = byName[name];
  const tags = await page.$$eval('#result .tag', t => t.map(x => x.textContent));
  check(tags[0] === terrain(r) && tags[1] === (r.loop ? 'Loop' : 'Point to point'), `tags ${tags.join(', ')} match data`);
  check(await page.$$eval('#result .stat', s => s.length) === 4 && (await page.textContent('#result .result-world')) !== '', 'four stat tiles and world label');

  // Every spin respects filters and never repeats back to back (with animation on).
  await page.fill('#max-distance', '20');
  let ok = true, prev = null;
  for (let i = 0; i < 4; i++) {
    await page.click('#pick'); await page.waitForFunction(() => !document.getElementById('pick').disabled, null, { timeout: 5000 });
    const n = await page.textContent('#result h2'); const x = byName[n];
    if (x.distanceMeters + x.leadinDistanceMeters > 20000 || n === prev) ok = false; prev = n;
  }
  check(ok, '4 animated spins obey the 20 km filter, no repeats');

  // Filter change that excludes the shown route resets the reel.
  await page.fill('#max-distance', '0.01');
  check(await page.isHidden('#result') && await middle() === 'Ready to ride?' && await page.textContent('#pick') === 'Spin', 'reel resets when the pick no longer matches');
  await page.fill('#max-distance', '');

  // Mark as done from the new card.
  await page.click('#pick'); await page.waitForFunction(() => !document.getElementById('result').hidden, null, { timeout: 5000 });
  await page.click('#mark-done');
  check((await page.textContent('#mark-done')).includes('undo') && (await page.$$eval('#result .tag', t => t.map(x => x.textContent))).includes('Done'), 'Mark as done works on new card');
  await page.click('#mark-done');

  // Units flip the stat order.
  await page.click('label[for="units-imperial"]');
  check((await page.textContent('#result .stat-value')).endsWith(' mi') && (await page.textContent('#result .stat-sub')).endsWith(' km'), 'imperial shows miles first on the card');
  await page.click('label[for="units-metric"]');

  // Known terrain and loop examples.
  // Includes routes right at the 5 and 10 m/km boundaries, so a changed threshold is caught.
  for (const [n, t, loop] of [['Tempus Fugit', 'Flat', 'Loop'], ['Road to Sky', 'Hilly', 'Point to point'], ['Watopia Figure 8', 'Rolling', 'Loop'], ['Volcano Circuit', 'Flat', 'Loop'], ['Big Foot Hills', 'Hilly', 'Loop']]) {
    const p2 = await b.newPage({ reducedMotion: 'reduce' });
    await p2.route('**/data/routes.json', rt => rt.fulfill({ json: { routes: [byName[n]] } }));
    await p2.goto(B); await p2.waitForSelector('.world-chip'); await p2.click('#pick');
    const tg = await p2.$$eval('#result .tag', t => t.map(x => x.textContent));
    check(tg[0] === t && tg[1] === loop && await p2.evaluate(() => document.querySelectorAll('#reel-strip li')[1].textContent) === n, `${n}: ${tg.join(', ')} (reduced motion lands instantly)`);
    await p2.close();
  }
  // Route of the Week tag: Beach Island Loop is the route for the week of Sep 28.
  for (const [now, expected] of [['2026-09-30T15:00Z', 'Route of the Week +250 XP'], ['2026-10-05T17:00Z', null]]) {
    const p3 = await b.newPage({ reducedMotion: 'reduce' });
    await p3.route('**/data/routes.json', rt => rt.fulfill({ json: { routes: [byName['Beach Island Loop']] } }));
    await p3.goto(BASE + '/?now=' + now); await p3.waitForSelector('.world-chip'); await p3.click('#pick');
    const tg = await p3.$$eval('#result .tag', t => t.map(x => x.textContent));
    check(expected ? tg[0] === expected : !tg.some(t => t.startsWith('Route of the Week')), `Beach Island Loop on ${now}: ${tg.join(', ')}`);
    await p3.close();
  }
  // Badge XP tag: shown when Zwift gives one, absent otherwise.
  for (const [route, expected] of [[byName['Tempus Fugit'], '380 XP badge'], [{ ...byName['Tempus Fugit'], id: 'noxp', badgeXp: null }, null]]) {
    const p4 = await b.newPage({ reducedMotion: 'reduce' });
    await p4.route('**/data/routes.json', rt => rt.fulfill({ json: { routes: [route] } }));
    await p4.goto(B); await p4.waitForSelector('.world-chip'); await p4.click('#pick');
    const xpTags = await p4.$$eval('#result .tag-xp', t => t.map(x => x.textContent));
    check(expected ? xpTags.length === 1 && xpTags[0] === expected : xpTags.length === 0, `badge XP tag: ${xpTags.join(', ') || 'none'}`);
    await p4.close();
  }
  // Recent picks are skipped, up to 10 and never more than half the pool.
  {
    const p5 = await b.newPage({ reducedMotion: 'reduce' });
    await p5.goto(B); await p5.waitForSelector('.world-chip');
    await p5.evaluate(() => localStorage.removeItem('recent')); await p5.reload(); await p5.waitForSelector('.world-chip');
    const spinN = async n => { const out = []; for (let i = 0; i < n; i++) { await p5.click('#pick'); out.push(await p5.textContent('#result h2')); } return out; };
    const first10 = await spinN(10);
    check(new Set(first10).size === 10, '10 spins from 148 routes: all different');
    await p5.reload(); await p5.waitForSelector('.world-chip');
    const next5 = await spinN(5);
    check(next5.every(n => !first10.includes(n)), 'after a reload, the previous 10 picks are still skipped');
    await p5.click('.world-chip[data-world="SCOTLAND"]');
    const scot = await spinN(24);
    const windowsOk = scot.every((n, i) => !scot.slice(Math.max(0, i - 5), i).includes(n));
    check(windowsOk && new Set(scot).size >= 8, `Scotland (11 routes): no repeat within 5 spins, ${new Set(scot).size} different routes seen`);
    await p5.route('**/data/routes.json', rt => rt.fulfill({ json: { routes: ['Tempus Fugit', 'Volcano Circuit', 'Big Foot Hills'].map(n => byName[n]) } }));
    await p5.reload(); await p5.waitForSelector('.world-chip');
    const three = await spinN(20);
    check(three.every((n, i) => i === 0 || n !== three[i - 1]) && new Set(three).size === 3, '3-route pool: never twice in a row, all 3 still come up');
    await p5.evaluate(() => localStorage.clear()); await p5.close();
  }
  {
    // Deterministic version: with Math.random pinned to 0, a spin without the
    // recent-picks memory would bounce between the same two routes.
    const p6 = await b.newPage({ reducedMotion: 'reduce' });
    await p6.addInitScript(() => { Math.random = () => 0; try { localStorage.removeItem('recent'); } catch (e) {} });
    await p6.goto(B); await p6.waitForSelector('.world-chip');
    const picks = []; for (let i = 0; i < 8; i++) { await p6.click('#pick'); picks.push(await p6.textContent('#result h2')); }
    check(new Set(picks).size === 8, `pinned randomness: 8 different picks (${new Set(picks).size})`);
    await p6.close();
  }
  const other = await b.newPage({ reducedMotion: 'reduce' });
  await other.route('**/data/routes.json', rt => rt.fulfill({ json: { routes: [byName['Tempus Fugit']] } }));
  await other.goto(B); await other.waitForSelector('.world-chip'); await other.click('#pick');
  check(!(await other.$$eval('#result .tag', t => t.map(x => x.textContent))).some(t => t.startsWith('Route of the Week')), 'other routes get no Route of the Week tag');
  await other.close();

  await page.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
