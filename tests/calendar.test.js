const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const U = n => `${BASE}/?now=${n}#calendar`;
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const load = async n => { await page.goto('about:blank'); await page.goto(U(n)); await page.waitForSelector('.cal-week'); };
  const card = i => page.locator('.cal-card').nth(i);
  const dayWorlds = iso => page.$$eval(`.cal-day[data-date="${iso}"] .cal-world`, e => e.map(x => x.textContent).join(' + '));

  await load('2026-09-30T15:00Z');
  check(await page.isVisible('#panel-calendar') && await page.getAttribute('#tab-calendar', 'aria-selected') === 'true', '#calendar opens the Calendar tab');
  check((await card(0).textContent()).includes('Watopia') && (await card(0).textContent()).includes('Scotland') && (await card(0).textContent()).includes('Makuri Islands'), "today's worlds card");
  check((await card(1).locator('h3').textContent()) === 'Beach Island Loop' && (await card(1).textContent()).includes('250 XP') && (await card(1).textContent()).includes('Available today'), 'Route of the Week Sep 30: Beach Island Loop');
  check((await card(2).locator('h3').textContent()) === 'Col du Rosier', 'Climb of the Week Sep 30: Col du Rosier');
  check((await card(3).textContent()).includes('Rocacorba') && (await card(3).textContent()).includes('Next in France: Mon, Oct 5'), 'portal card: Rocacorba, France next Oct 5');
  check(await page.textContent('#cal-title') === 'September 2026' && await page.isDisabled('.cal-head .icon-button >> nth=0'), 'opens on September, previous disabled (first published month)');
  check(await dayWorlds('2026-09-03') === 'Innsbruck + Richmond' && await dayWorlds('2026-09-21') === 'Makuri Islands + New York' && await dayWorlds('2026-09-30') === 'Scotland + Makuri Islands', 'day worlds match the verified schedule');
  check(await page.$eval('.cal-day.today', d => d.dataset.date) === '2026-09-30', 'today highlighted');
  check((await page.textContent('.cal-day[data-date="2026-09-30"] .cal-day-portal')) === 'Portal: Rocacorba', 'portal climb in day cell');
  check((await page.$$eval('.cal-week', w => w.length)) === 5 && (await page.textContent('.cal-week >> nth=2')).includes('Volcano Flat'), 'five week rows with weekly bars');

  await page.click('.cal-head .icon-button >> nth=1');
  check(await page.textContent('#cal-title') === 'October 2026' && await page.isDisabled('.cal-head .icon-button >> nth=1'), 'next goes to October, then disabled (last published month)');
  check(await dayWorlds('2026-10-05') === 'France + Paris' && (await page.textContent('.cal-week >> nth=1')).includes('Loop de Loop'), 'October: Oct 5 France + Paris, Loop de Loop week');

  // Weekly switch at Monday noon Eastern (Oct 5, 2026 is a Monday; noon EDT = 16:00 UTC).
  await load('2026-10-05T15:30Z');
  check((await card(1).locator('h3').textContent()) === 'Beach Island Loop', 'Monday 11:30 ET: still last week\'s route');
  await load('2026-10-05T16:30Z');
  check((await card(1).locator('h3').textContent()) === 'Loop de Loop' && (await card(2).locator('h3').textContent()) === 'Mûr de Bretagne', 'Monday 12:30 ET: new route and climb');
  check((await card(3).textContent()).includes('Trollstigen') && (await card(3).textContent()).includes('Available today') && await page.textContent('#cal-title') === 'October 2026', 'Oct 5: France portal Trollstigen available, opens on October');

  // Units follow the header switch.
  await page.click('label[for="units-imperial"]');
  check((await card(1).textContent()).includes(' mi · ') && (await card(3).textContent()).includes(' ft'), 'miles and feet after unit switch');
  await page.click('label[for="units-metric"]');

  // Weekly and portal data failing leaves the rest working.
  await page.route('**/data/weekly.json', r => r.fulfill({ status: 500 }));
  await page.route('**/data/portal.json', r => r.fulfill({ status: 500 }));
  await load('2026-09-30T15:00Z');
  check((await card(1).textContent()).includes("Couldn't load") && (await card(3).textContent()).includes("Couldn't load") && await dayWorlds('2026-09-03') === 'Innsbruck + Richmond', 'failed weekly/portal data: cards say so, grid still shows worlds');
  await page.click('#tab-spin'); await page.click('#pick');
  check(await page.isVisible('#result'), 'spinning still works without calendar data');
  await page.unroute('**/data/weekly.json'); await page.unroute('**/data/portal.json');

  // Phone list view.
  const phone = await b.newPage({ viewport: { width: 360, height: 800 } }); phone.on('pageerror', e => errors.push(e.message));
  await phone.goto(U('2026-09-30T15:00Z')); await phone.waitForSelector('.cal-week');
  check(await phone.isHidden('.cal-dow') && await phone.isVisible('.cal-day[data-date="2026-09-01"] .d-long') && await phone.isHidden('.cal-day[data-date="2026-10-01"]'), 'phone: list view with long dates, other-month days hidden');
  check(await phone.evaluate(() => document.documentElement.scrollWidth) <= 360, 'phone: no sideways scroll at 360px');
  const tabsFit = await phone.evaluate(() => { const t = document.querySelector('.tabs'); return t.scrollWidth <= t.clientWidth; });
  check(tabsFit, 'phone: all three tabs fit at 360px');
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
