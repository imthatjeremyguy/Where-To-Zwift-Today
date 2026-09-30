const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

const B = BASE + '/?now=2026-09-30T15:00Z';
const routes = require(path.join(FIXTURES, 'routes.json')).routes;
const badge = s => routes.filter(r => r[s] && !r.eventOnly && (!r.publishedOn || r.publishedOn <= '2026-09-30'));
let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ reducedMotion: 'reduce', viewport: { width: 390, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(B + '#completed'); await page.waitForSelector('#checklist details');
  const world = w => page.locator(`#checklist details[data-world="${w}"]`);
  check(await page.$$eval('#checklist details', d => d.every(x => !x.open)), 'all worlds start collapsed');
  check(await page.evaluate(() => document.documentElement.scrollHeight) < 1400, 'collapsed list fits in about 1.5 phone screens: ' + await page.evaluate(() => document.documentElement.scrollHeight) + 'px');

  await world('SCOTLAND').locator('summary').click();
  check(await world('SCOTLAND').evaluate(d => d.open) && await world('SCOTLAND').locator('li').first().isVisible(), 'tapping a world opens its list');
  const scot = badge('cycling').filter(r => r.map === 'SCOTLAND');
  await world('SCOTLAND').locator('.all-row input').check();
  check(await world('SCOTLAND').evaluate(d => d.open && d.classList.contains('complete')), 'world stays open after ticking, marked complete');
  check(await world('SCOTLAND').locator('.world-count').textContent() === `${scot.length} of ${scot.length}`, 'world count updates');
  const barW = await world('SCOTLAND').locator('.bar > span').evaluate(e => e.style.width);
  check(barW === '100%', 'world bar full: ' + barW);
  check((await page.textContent('#progress-summary')) === `${scot.length} of ${badge('cycling').length} Ride routes` && (await page.locator('#progress-bar').evaluate(e => e.style.width)) !== '0%', 'overall summary and bar update: ' + await page.textContent('#progress-summary'));
  await world('SCOTLAND').locator('summary').click();
  check(!(await world('SCOTLAND').evaluate(d => d.open)), 'tapping again collapses');

  // Sport switch on this tab stays in sync with Spin settings.
  await page.click('label[for="completed-running"]');
  check((await page.textContent('#progress-summary')).endsWith('Run routes') && await page.isChecked('#sport-running'), 'Run on Completed also sets Spin settings to Run');
  await page.click('#tab-spin');
  check((await page.textContent('#settings-summary')).startsWith('Run'), 'Spin tab shows Run');
  await page.click('label[for="sport-cycling"]'); await page.click('#tab-completed');
  check(await page.isChecked('#completed-cycling') && (await page.textContent('#progress-summary')).endsWith('Ride routes'), 'Ride on Spin tab updates Completed switch');
  await page.reload(); await page.waitForSelector('#checklist details');
  check(await page.isChecked('#completed-cycling') && (await page.textContent('#progress-summary')).startsWith(`${scot.length} of`), 'progress and sport survive reload');
  check(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no sideways scroll on phone');
  await page.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
