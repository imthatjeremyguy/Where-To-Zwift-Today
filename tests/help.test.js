const { chromium } = require('playwright');
// Run with: node tests/run.js (starts a local server with frozen data from tests/fixtures).
const path = require('path');
const os = require('os');
const BASE = process.env.BASE_URL || 'http://localhost:8765';
const FIXTURES = path.join(__dirname, 'fixtures', 'data');
const SHOTS = os.tmpdir();

let fails = 0; const check = (ok, m) => { console.log((ok ? 'PASS ' : 'FAIL ') + m); if (!ok) fails++; };
(async () => {
  const b = await chromium.launch(); const page = await b.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/?now=2026-09-30T15:00Z#help'); await page.waitForSelector('.faq');
  check(await page.isVisible('#panel-help') && await page.title() === 'Help · Where to Zwift Today', 'Help tab opens with its title');
  const n = await page.$$eval('.faq details', d => d.length);
  check(n === 11 && await page.$$eval('.faq details', d => d.every(x => !x.open)), `${n} questions, all collapsed`);
  await page.click('.faq details:nth-of-type(2) summary');
  check(await page.isVisible('.faq details:nth-of-type(2) p'), 'tapping a question shows its answer');
  const ai = page.locator('.faq details', { hasText: 'Was AI used to build this site?' });
  await ai.locator('summary').click();
  check(await ai.locator('p').isVisible() && (await ai.locator('p').textContent()).includes('Claude Code'), 'AI disclosure question present and opens');
  check(await page.getAttribute('.faq a[href*="/issues"]', 'target') === '_blank', 'report link opens GitHub issues in a new tab');
  check((await page.textContent('.site-footer')).includes('Source on GitHub') && (await page.textContent('.site-footer')).includes('Route and Climb of the Week'), 'footer credits updated');
  check(await page.getAttribute('meta[property="og:title"]', 'content') === 'Where to Zwift Today' && await page.$('meta[name="twitter:card"]') !== null, 'share preview tags present');
  const img = await page.request.get(BASE + '/assets/icon-180.png');
  check(img.ok(), 'share image exists');
  await page.focus('#tab-help'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150);
  check(await page.evaluate(() => location.hash) === '#completed' && await page.isVisible('#panel-completed'), 'ArrowLeft moves to Completed routes');
  await page.keyboard.press('Home'); await page.waitForTimeout(150);
  check(await page.evaluate(() => location.hash) === '#spin' && await page.title() === 'Where to Zwift Today', 'Home returns to Spin');
  const noJs = await (await b.newContext({ javaScriptEnabled: false })).newPage();
  await noJs.goto(BASE + '/');
  check((await noJs.textContent('main')).includes('needs JavaScript'), 'no-JavaScript message shows');
  check(errors.length === 0, 'no page errors ' + errors.join('; '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exitCode = fails ? 1 : 0;
})();
