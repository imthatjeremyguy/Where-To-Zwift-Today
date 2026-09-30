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
const today = '2026-09-30';
const badge = s => routes.filter(r => r[s] && !r.eventOnly && (!r.publishedOn || r.publishedOn <= today));

const worldsTextOf = pg => pg.evaluate(() => { const lis = [...document.querySelectorAll('.world-chip')]; return lis.length ? "Today's worlds: " + lis.map(l => l.querySelector('span').textContent).join(', ') : document.getElementById('worlds').textContent; });
const unhidePanels = pg => pg.evaluate(() => { document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = false; }); document.querySelectorAll('#checklist details').forEach(d => { d.open = true; }); });
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ reducedMotion: 'reduce',  permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const count = async () => parseInt(await page.textContent('#count')) || 0;
  const load = async (url = B) => { await page.goto(url); await page.waitForSelector('#checklist details', { state: 'attached' }); await unhidePanels(page); };

  await load();
  check(await page.isChecked('input[name="badges"][value="any"]'), 'default badge mode is Any route');
  const rideTotal = badge('cycling').length;
  check((await page.textContent('#progress-summary')) === `0 of ${rideTotal} Ride routes`, 'summary ' + await page.textContent('#progress-summary'));
  const legends = await page.$$eval('#checklist summary .world-name', ls => ls.map(l => l.textContent.trim()));
  check(legends[0].startsWith('Watopia'), 'Watopia listed first: ' + legends.slice(0, 3).join(' | '));
  const worldsWithRoutes = new Set(badge('cycling').map(r => r.map)).size;
  check(legends.length === worldsWithRoutes, `one group per world (${legends.length})`);

  // Tick all of Watopia, then untick one route.
  const full = await count();
  await page.check('#checklist details:first-of-type .all-row input');
  const watopiaRide = badge('cycling').filter(r => r.map === 'WATOPIA');
  check((await page.textContent('#progress-summary')).startsWith(`${watopiaRide.length} of`), 'all Watopia marked done');
  check(await count() === full, 'Any route mode: count unchanged');
  await page.click('input[name="badges"][value="undone"] + label');
  const activeNonWatopia = badge('cycling').filter(r => ['SCOTLAND', 'MAKURIISLANDS'].includes(r.map)).length;
  check(await count() === activeNonWatopia, `undone mode excludes done routes (${await count()})`);
  const tf = byName['Tempus Fugit'];
  await page.uncheck(`#checklist input[data-id="${tf.id}"]`);
  check(await count() === activeNonWatopia + 1, 'unticking a route adds it back');
  check(await page.evaluate(() => document.querySelector('#checklist details .all-row input').indeterminate), 'world box shows partial state');

  // Picks in undone mode never return done routes; Mark as done keeps the card.
  let okPicks = true;
  for (let i = 0; i < 25; i++) { await page.click('#pick'); const n = await page.textContent('#result h2'); if (byName[n].map === 'WATOPIA' && n !== 'Tempus Fugit') okPicks = false; }
  check(okPicks, '25 picks: no done routes');
  const before = await count();
  const picked = await page.textContent('#result h2');
  await page.click('#mark-done');
  check(await page.isVisible('#result') && (await page.textContent('#result h2')) === picked, 'card stays after Mark as done');
  check((await page.textContent('#mark-done')).includes('undo') && (await page.textContent('#result')).includes('Done'), 'button and Done tag update');
  check(await count() === before - 1, 'count drops by one');
  check(await page.isChecked(`#checklist input[data-id="${byName[picked].id}"]`), 'checklist ticked from card');
  await page.click('#mark-done');
  check(await count() === before && !(await page.textContent('#mark-done')).includes('undo'), 'undo restores');

  // Ride and Run are separate.
  await page.click('input[name="sport"][value="running"] + label');
  check((await page.textContent('#progress-summary')).startsWith('0 of') && (await page.textContent('#progress-summary')).endsWith('Run routes'), 'Run progress separate: ' + await page.textContent('#progress-summary'));
  check((await page.textContent('#clear-progress')) === 'Clear my Run progress', 'clear button names sport');
  await page.check(`#checklist input[data-id="${byName['Road to Sky Run'].id}"]`);
  await page.click('input[name="sport"][value="cycling"] + label');

  // Everything done -> friendly message.
  const doneState = await page.evaluate(() => localStorage.getItem('done'));
  await page.evaluate(() => { for (let i = 0; i < 20; i++) { const box = document.querySelector('#checklist .all-row input:not(:checked)'); if (!box) break; box.click(); } });
  check((await page.textContent('#count')).includes("You've done every route") && await page.isDisabled('#pick'), 'all done message');

  // Persistence.
  await load();
  check(await page.isChecked('input[name="badges"][value="undone"]') && (await page.textContent('#progress-summary')).startsWith(`${rideTotal} of`), 'mode and progress survive reload');

  // Progress link round trip into a fresh browser.
  await page.evaluate(s => localStorage.setItem('done', s), doneState); await load();
  await page.click('#copy-progress');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check(link.startsWith(BASE + '/#progress=v1.') && !link.includes('now='), 'link copied: ' + link.length + ' chars');
  check((await page.textContent('#progress-message')).includes('copied'), 'copy message shown');
  const expected = JSON.parse(doneState);
  const fresh = await (await b.newContext({ reducedMotion: 'reduce' })).newPage(); fresh.on('pageerror', e => errors.push(e.message));
  await fresh.goto(link.replace('#', '?now=2026-09-30T15:00Z#')); await fresh.waitForSelector('#checklist details', { state: 'attached' });
  const got = JSON.parse(await fresh.evaluate(() => localStorage.getItem('done')));
  const same = (a, c) => a.length === c.length && a.every(x => c.includes(x));
  check(same(got.cycling, expected.cycling) && same(got.running, expected.running), `fresh device got ${got.cycling.length} Ride + ${got.running.length} Run`);
  check(await fresh.evaluate(() => location.hash) === '#completed' && await fresh.isVisible('#panel-completed') && await fresh.isHidden('#panel-spin'), 'progress link opens Completed tab and cleans the address');
  check((await fresh.textContent('#progress-message')).includes('Progress loaded'), 'loaded message shown');

  // Existing progress -> confirm prompt; dismissing keeps old progress.
  page.removeAllListeners('dialog'); dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.evaluate(() => localStorage.setItem('done', JSON.stringify({ cycling: ['1'], running: [] })));
  await load(link.replace('#', '?now=2026-09-30T15:00Z#'));
  check(dialogs.length === 1 && dialogs[0].includes('replace'), 'asks before replacing');
  check(await page.evaluate(() => localStorage.getItem('done')) === JSON.stringify({ cycling: ['1'], running: [] }), 'declining keeps existing progress');

  await load(BASE + '/?now=2026-09-30T15:00Z#progress=v9.zzz');
  check((await page.textContent('#progress-message')).includes('damaged'), 'bad link shows message');

  // Clear with confirm.
  page.removeAllListeners('dialog'); page.on('dialog', d => d.accept());
  await page.evaluate(() => localStorage.setItem('done', JSON.stringify({ cycling: ['2128890027'], running: [] }))); await load();
  await page.click('#clear-progress');
  check((await page.textContent('#progress-summary')).startsWith('0 of'), 'clear progress works');

  await page.setViewportSize({ width: 360, height: 900 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'no horizontal scroll at 360px with checklist open');
  await page.screenshot({ path: SHOTS + '/mobile3.png' });
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
